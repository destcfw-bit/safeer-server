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
  ); CREATE INDEX IF NOT EXISTS captain_notification_inbox_recent ON captain_notification_inbox(captain_id,created_at DESC)`);
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
