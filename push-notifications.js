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
