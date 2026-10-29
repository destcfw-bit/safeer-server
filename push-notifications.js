import webpush from "web-push";

export function registerPushRoutes(app,{db,requireRoles}){
  const publicKey=process.env.VAPID_PUBLIC_KEY||"";
  const privateKey=process.env.VAPID_PRIVATE_KEY||"";
  const ready=Boolean(publicKey&&privateKey);
  if(ready) webpush.setVapidDetails(process.env.VAPID_SUBJECT||"mailto:admin@dropcodejo.com",publicKey,privateKey);
  const init=db.query(`CREATE TABLE IF NOT EXISTS captain_push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    subscription JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  ); CREATE INDEX IF NOT EXISTS captain_push_by_captain ON captain_push_subscriptions(captain_id)`);
  app.get("/api/push/config",{preHandler:[requireRoles("captain","admin","accountant")]},async()=>({ok:true,enabled:ready,publicKey:ready?publicKey:null}));
  app.post("/api/push/subscribe",{preHandler:[requireRoles("captain")]},async(request,reply)=>{
    if(!ready)return reply.code(503).send({ok:false,error:"push_not_configured"});
    const subscription=request.body?.subscription;
    const endpoint=subscription?.endpoint;
    const keys=subscription?.keys;
    if(typeof endpoint!=="string"||endpoint.length>2048||!endpoint.startsWith("https://")||!keys||typeof keys.p256dh!=="string"||typeof keys.auth!=="string"||keys.p256dh.length>500||keys.auth.length>500)return reply.code(400).send({ok:false,error:"invalid_subscription"});
    await init;
    await db.query(`INSERT INTO captain_push_subscriptions(endpoint,captain_id,subscription) VALUES($1,$2,$3)
      ON CONFLICT(endpoint) DO UPDATE SET captain_id=EXCLUDED.captain_id,subscription=EXCLUDED.subscription,updated_at=NOW()`,[endpoint,request.user.captainId,JSON.stringify(subscription)]);
    return {ok:true};
  });
  app.get("/api/push/status",{preHandler:[requireRoles("captain")]},async(request)=>{
    await init;
    const {rows}=await db.query("SELECT COUNT(*)::int AS count FROM captain_push_subscriptions WHERE captain_id=$1",[request.user.captainId]);
    return {ok:true,enabled:ready,subscriptions:rows[0].count};
  });
  // Admin-only push composer: targeted, selected captains, or all subscribed captains.
  app.get("/api/push/recipients",{preHandler:[requireRoles("admin","accountant")]},async(request)=>{
    await init;
    const q=String(request.query?.q||"").trim().slice(0,100);
    const {rows}=await db.query(`SELECT c.id,c.name,c.phone,COUNT(s.endpoint)::int AS devices FROM captains c
      JOIN captain_push_subscriptions s ON s.captain_id=c.id
      WHERE ($1='' OR c.name ILIKE '%'||$1||'%' OR c.phone LIKE '%'||regexp_replace($1,'[^0-9]','','g')||'%')
      GROUP BY c.id,c.name,c.phone ORDER BY c.name LIMIT 250`,[q]);
    return {ok:true,captains:rows};
  });
  app.post("/api/push/send",{preHandler:[requireRoles("admin","accountant")]},async(request,reply)=>{
    if(!ready)return reply.code(503).send({ok:false,error:"push_not_configured"});
    const body=request.body||{};
    const title=String(body.title||"").trim(),message=String(body.message||"").trim();
    const mode=String(body.mode||"");
    if(!title||title.length>100||!message||message.length>220)return reply.code(400).send({ok:false,error:"invalid_notification_text"});
    if(!["all","selected"].includes(mode))return reply.code(400).send({ok:false,error:"invalid_mode"});
    const ids=Array.isArray(body.captainIds)?[...new Set(body.captainIds.map(Number))]:[];
    if(mode==="selected"&&(!ids.length||ids.length>250||ids.some(id=>!Number.isSafeInteger(id)||id<=0)))return reply.code(400).send({ok:false,error:"invalid_captains"});
    if(body.confirm!==true)return reply.code(400).send({ok:false,error:"confirmation_required"});
    await init;
    const {rows}=mode==="all"
      ?await db.query("SELECT endpoint,subscription,captain_id FROM captain_push_subscriptions")
      :await db.query("SELECT endpoint,subscription,captain_id FROM captain_push_subscriptions WHERE captain_id=ANY($1::bigint[])",[ids]);
    if(rows.length>10000)return reply.code(413).send({ok:false,error:"too_many_devices"});
    let sent=0,failed=0;
    const recipients=new Set(rows.map(row=>String(row.captain_id)));
    for(const row of rows){
      try{await webpush.sendNotification(row.subscription,JSON.stringify({title,body:message,tag:"admin-"+Date.now()+"-"+row.captain_id}),{TTL:3600});sent++}
      catch(e){failed++;if(e.statusCode===404||e.statusCode===410)await db.query("DELETE FROM captain_push_subscriptions WHERE endpoint=$1",[row.endpoint]);app.log.warn({err:e},"Admin push failed")}
    }
    app.log.info({actor:request.user.sub,mode,recipients:recipients.size,sent,failed},"Admin push broadcast completed");
    return {ok:sent>0,recipients:recipients.size,sent,failed,unsubscribed:mode==="selected"?ids.length-recipients.size:null};
  });
  app.post("/api/push/test",{preHandler:[requireRoles("admin","accountant")]},async(request,reply)=>{
    if(!ready)return reply.code(503).send({ok:false,error:"push_not_configured"});
    const captainId=Number(request.body?.captainId);
    if(!Number.isSafeInteger(captainId)||captainId<=0)return reply.code(400).send({ok:false,error:"invalid_captain"});
    await init;
    const {rows}=await db.query("SELECT endpoint,subscription FROM captain_push_subscriptions WHERE captain_id=$1 LIMIT 20",[captainId]);
    if(!rows.length)return {ok:false,error:"captain_has_no_subscription",sent:0};
    let sent=0,failed=0;
    for(const row of rows){
      try{await webpush.sendNotification(row.subscription,JSON.stringify({title:"🔔 إشعار تجريبي",body:"مبروك! إشعارات التطبيق شغالة 🎉",tag:"push-test-"+Date.now()}),{TTL:60});sent++}
      catch(e){failed++;if(e.statusCode===404||e.statusCode===410)await db.query("DELETE FROM captain_push_subscriptions WHERE endpoint=$1",[row.endpoint]);app.log.warn({err:e,captainId},"push test failed")}
    }
    return {ok:sent>0,sent,failed,acceptedByPushService:true};
  });
}

/**
 * Best-effort notifications for newly committed live inventory movements.
 * Never fail accounting when push delivery fails.
 */
export async function notifyInventoryMovement(db,{producer,consumer,components,doneMessageId}={}){
  if(!process.env.VAPID_PUBLIC_KEY||!process.env.VAPID_PRIVATE_KEY)return;
  const ids=[...new Set([producer?.id,consumer?.id].filter(Boolean).map(String))];
  if(!ids.length)return;
  const amount=(components||[]).reduce((sum,c)=>sum+Number(c.quantity||0)*(c.type==='ORDER'?1:0.75),0);
  const count=(components||[]).reduce((sum,c)=>sum+Number(c.quantity||0),0);
  try{
    const {rows}=await db.query("SELECT endpoint,subscription,captain_id FROM captain_push_subscriptions WHERE captain_id::text=ANY($1::text[])",[ids]);
    for(const row of rows){
      const producing=String(row.captain_id)===String(producer?.id);
      const other=producing?consumer:producer;
      const payload={title:producing?"🟢 تم إنتاج طلب":"🔴 تم استهلاك طلب",body:`${count} وحدة • عمولة ${amount.toFixed(2)} د.أ • ${other?.name||'كابتن'}`,tag:`inventory-${String(doneMessageId||'').slice(-100)}-${row.captain_id}`};
      try{await webpush.sendNotification(row.subscription,JSON.stringify(payload),{TTL:3600})}
      catch(e){if(e.statusCode===404||e.statusCode===410)await db.query("DELETE FROM captain_push_subscriptions WHERE endpoint=$1",[row.endpoint]);}
    }
  }catch(e){console.warn("Inventory push delivery failed:",e.message)}
}
