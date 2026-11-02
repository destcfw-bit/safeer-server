// Persistent captain notification inbox. This module does not change accounting.
export function registerNotificationInbox(app,{db,requireRoles}){
  const ready=db.query(`CREATE TABLE IF NOT EXISTS captain_notification_inbox (
    id BIGSERIAL PRIMARY KEY,
    captain_id BIGINT NOT NULL REFERENCES captains(id) ON DELETE CASCADE,
    category VARCHAR(40) NOT NULL DEFAULT 'general',
    title VARCHAR(120) NOT NULL,
    body TEXT NOT NULL,
    link TEXT,
    dedupe_key VARCHAR(180),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ,
    UNIQUE(captain_id,dedupe_key)
  ); CREATE INDEX IF NOT EXISTS captain_notification_inbox_recent ON captain_notification_inbox(captain_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS captain_notification_preferences (
      captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
      optional_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Retention: delete only old read notifications; preserve unread records.
  app.post('/api/notifications/admin/cleanup',{preHandler:[requireRoles('admin')]},async(req,reply)=>{
    const days=Number(req.body?.days??90);
    if(!Number.isSafeInteger(days)||days<30||days>730)return reply.code(400).send({ok:false,error:'invalid_retention_days'});
    await ready;
    const {rowCount}=await db.query(`DELETE FROM captain_notification_inbox
      WHERE read_at IS NOT NULL AND created_at < NOW() - ($1::int * INTERVAL '1 day')`,[days]);
    return {ok:true,deleted:rowCount,retentionDays:days};
  });
  app.get('/api/notifications/admin/unread',{preHandler:[requireRoles('admin','accountant')]},async()=>{
    await ready;
    const {rows}=await db.query(`SELECT captain_id,COUNT(*)::int AS unread_count,MAX(created_at) AS latest_notification
      FROM captain_notification_inbox WHERE read_at IS NULL
      GROUP BY captain_id ORDER BY unread_count DESC LIMIT 100`);
    return {ok:true,captains:rows};
  });
  app.get('/api/notifications/admin/stats',{preHandler:[requireRoles('admin','accountant')]},async()=>{
    await ready;
    const {rows}=await db.query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread,
      COUNT(DISTINCT captain_id)::int AS captains,
      COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24_hours
      FROM captain_notification_inbox`);
    return {ok:true,...rows[0]};
  });
  app.get('/api/notifications/admin/unsubscribed',{preHandler:[requireRoles('admin','accountant')]},async(req)=>{
    await ready;
    const q=String(req.query?.q||'').trim().slice(0,80);
    const {rows}=await db.query(`SELECT c.id,c.name,c.phone FROM captains c
      WHERE NOT EXISTS (SELECT 1 FROM captain_push_subscriptions s WHERE s.captain_id=c.id)
      AND ($1='' OR c.name ILIKE '%'||$1||'%' OR c.phone LIKE '%'||regexp_replace($1,'[^0-9]','','g')||'%')
      ORDER BY c.name LIMIT 100`,[q]);
    return {ok:true,captains:rows};
  });
  app.get('/api/notifications/inbox',{preHandler:[requireRoles('captain')]},async(req)=>{
    await ready;
    const captainId=req.user.captainId;
    const limit=Math.min(100,Math.max(1,Number(req.query?.limit)||30));
    const {rows}=await db.query('SELECT id,category,title,body,link,created_at,read_at FROM captain_notification_inbox WHERE captain_id=$1 ORDER BY created_at DESC LIMIT $2',[captainId,limit]);
    const unread=await db.query('SELECT COUNT(*)::int AS count FROM captain_notification_inbox WHERE captain_id=$1 AND read_at IS NULL',[captainId]);
    return {ok:true,notifications:rows,unread:unread.rows[0].count};
  });
  app.post('/api/notifications/read',{preHandler:[requireRoles('captain')]},async(req,reply)=>{
    const id=Number(req.body?.id);
    if(!Number.isSafeInteger(id)||id<=0)return reply.code(400).send({ok:false,error:'invalid_id'});
    await ready;
    const {rowCount}=await db.query('UPDATE captain_notification_inbox SET read_at=COALESCE(read_at,NOW()) WHERE id=$1 AND captain_id=$2',[id,req.user.captainId]);
    return {ok:true,updated:rowCount};
  });
  app.post('/api/notifications/read-all',{preHandler:[requireRoles('captain')]},async(req)=>{
    await ready;
    const {rowCount}=await db.query('UPDATE captain_notification_inbox SET read_at=NOW() WHERE captain_id=$1 AND read_at IS NULL',[req.user.captainId]);
    return {ok:true,updated:rowCount};
  });
  app.get('/api/notifications/preferences',{preHandler:[requireRoles('captain')]},async(req)=>{
    await ready;
    await db.query(`CREATE TABLE IF NOT EXISTS captain_notification_preferences (captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,optional_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const {rows}=await db.query('SELECT optional_enabled FROM captain_notification_preferences WHERE captain_id=$1',[req.user.captainId]);
    return {ok:true,optionalEnabled:rows[0]?.optional_enabled??true};
  });
  app.put('/api/notifications/preferences',{preHandler:[requireRoles('captain')]},async(req,reply)=>{
    if(typeof req.body?.optionalEnabled!=='boolean')return reply.code(400).send({ok:false,error:'invalid_preference'});
    await ready;
    await db.query(`CREATE TABLE IF NOT EXISTS captain_notification_preferences (captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,optional_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await db.query('INSERT INTO captain_notification_preferences(captain_id,optional_enabled) VALUES($1,$2) ON CONFLICT(captain_id) DO UPDATE SET optional_enabled=EXCLUDED.optional_enabled,updated_at=NOW()',[req.user.captainId,req.body.optionalEnabled]);
    return {ok:true};
  });
}
