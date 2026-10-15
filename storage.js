import { db } from "./db.js";

export const DEFAULT_STORAGE_POLICY = Object.freeze({
  autoCleanup:true,
  transferImageDays:7,
  usedCodeDays:30,
  whatsappRawDays:30, // V-FIX: was 7 — too close to the 7-day WAHA history/recovery window; raised for a safety margin
  whatsappTextDays:30,
  whatsappTraceDays:14,
  deadLetterDays:30,
  repairRunDays:30,
  migrationStageDays:7,
  migrationSnapshotDays:30,
  resolvedIssueDays:90,
  auditLogDays:90
});

const POLICY_KEY="storage_retention_policy_v1";
const LAST_KEY="storage_last_cleanup_v1";
const DAY_FIELDS=Object.keys(DEFAULT_STORAGE_POLICY).filter(k=>k.endsWith("Days"));

function clampDays(v,def){
  const n=Math.trunc(Number(v));
  return Number.isFinite(n)?Math.min(3650,Math.max(1,n)):def;
}
function normalizePolicy(v={}){
  const p={...DEFAULT_STORAGE_POLICY,...(v&&typeof v==='object'?v:{})};
  p.autoCleanup=p.autoCleanup!==false;
  for(const k of DAY_FIELDS)p[k]=clampDays(p[k],DEFAULT_STORAGE_POLICY[k]);
  return p;
}
async function getSetting(key,fallback=null){
  const r=await db.query(`SELECT value FROM system_settings WHERE key=$1`,[key]);
  return r.rowCount?r.rows[0].value:fallback;
}
async function putSetting(key,value,userId=null){
  await db.query(`INSERT INTO system_settings(key,value,updated_by_user_id,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`,[key,JSON.stringify(value),userId||null]);
}
export async function getStoragePolicy(){return normalizePolicy(await getSetting(POLICY_KEY,DEFAULT_STORAGE_POLICY));}
export async function saveStoragePolicy(payload,userId=null){const p=normalizePolicy(payload);await putSetting(POLICY_KEY,p,userId);return p;}
export async function getLastStorageCleanup(){return await getSetting(LAST_KEY,null);}

function mb(bytes){return Math.round((Number(bytes||0)/1024/1024)*100)/100;}
async function relationSizes(){
  const tables=['recharge_requests','recharge_codes','whatsapp_events','whatsapp_event_traces','whatsapp_dead_letters','whatsapp_repair_runs','full_migration_stage_rows','migration_snapshots','system_issues','audit_logs','ledger_entries','weekly_settlements','weekly_settlement_items','captains','users'];
  const r=await db.query(`SELECT c.relname,pg_total_relation_size(c.oid)::bigint AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`,[tables]);
  return Object.fromEntries(r.rows.map(x=>[x.relname,Number(x.bytes||0)]));
}

const EVENT_TIME_SQL=`CASE WHEN e.event_timestamp IS NULL THEN e.webhook_received_at WHEN e.event_timestamp>100000000000 THEN to_timestamp(e.event_timestamp/1000.0) ELSE to_timestamp(e.event_timestamp::double precision) END`;
const SAFE_EVENT_STATUS=`e.status NOT IN ('received','queued','processing','failed','waiting_review','waiting_completion','waiting_reaction')`;
const NOT_ACTIVE_REPAIR=`NOT EXISTS (SELECT 1 FROM whatsapp_repair_runs r WHERE r.status IN ('QUEUING','RUNNING') AND ${EVENT_TIME_SQL}>=r.from_at AND ${EVENT_TIME_SQL}<r.cutoff_at)`;
// V-FIX: reactionMessage payloads (👍/🚫/1️⃣–5️⃣) are the ONLY source for historical reactions that
// never reached the webhook during an outage — WAHA chat history cannot reliably reconstruct them
// (see WAHA_RAILWAY_SETUP.md). They are tiny in size, so we keep them out of raw_payload cleanup
// entirely regardless of age, instead of racing the outage-recovery window.
const NOT_REACTION_MESSAGE=`e.message_type<>'reactionMessage'`;

async function cleanupCandidates(policy){
  const r=await db.query(`
    SELECT
      (SELECT COUNT(*)::int FROM recharge_requests WHERE image_data IS NOT NULL AND status<>'pending' AND COALESCE(reviewed_at,created_at)<NOW()-make_interval(days=>$1)) AS transfer_images,
      (SELECT COALESCE(SUM(octet_length(image_data)),0)::bigint FROM recharge_requests WHERE image_data IS NOT NULL AND status<>'pending' AND COALESCE(reviewed_at,created_at)<NOW()-make_interval(days=>$1)) AS transfer_image_bytes,
      (SELECT COUNT(*)::int FROM recharge_codes WHERE status='used' AND used_at<NOW()-make_interval(days=>$2) AND code NOT LIKE 'ARCHIVED-USED-%') AS used_codes,
      (SELECT COUNT(*)::int FROM whatsapp_events e WHERE raw_payload<>'{}'::jsonb AND ${SAFE_EVENT_STATUS} AND ${NOT_ACTIVE_REPAIR} AND ${NOT_REACTION_MESSAGE} AND ${EVENT_TIME_SQL}<NOW()-make_interval(days=>$3)) AS whatsapp_raw,
      (SELECT COALESCE(SUM(pg_column_size(raw_payload)),0)::bigint FROM whatsapp_events e WHERE raw_payload<>'{}'::jsonb AND ${SAFE_EVENT_STATUS} AND ${NOT_ACTIVE_REPAIR} AND ${NOT_REACTION_MESSAGE} AND ${EVENT_TIME_SQL}<NOW()-make_interval(days=>$3)) AS whatsapp_raw_bytes,
      (SELECT COUNT(*)::int FROM whatsapp_events e WHERE message_text IS NOT NULL AND ${SAFE_EVENT_STATUS} AND ${NOT_ACTIVE_REPAIR} AND ${EVENT_TIME_SQL}<NOW()-make_interval(days=>$4)) AS whatsapp_text,
      (SELECT COUNT(*)::int FROM whatsapp_event_traces WHERE created_at<NOW()-make_interval(days=>$5)) AS traces,
      (SELECT COUNT(*)::int FROM whatsapp_dead_letters WHERE status<>'pending' AND COALESCE(resolved_at,replayed_at,failed_at)<NOW()-make_interval(days=>$6)) AS dead_letters,
      (SELECT COUNT(*)::int FROM whatsapp_repair_runs WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND COALESCE(completed_at,updated_at)<NOW()-make_interval(days=>$7)) AS repair_runs,
      (SELECT COUNT(*)::int FROM full_migration_stage_rows sr JOIN full_migration_runs mr ON mr.id=sr.run_id WHERE mr.status='completed' AND mr.completed_at<NOW()-make_interval(days=>$8)) AS migration_stage,
      (SELECT COUNT(*)::int FROM migration_snapshots WHERE received_at<NOW()-make_interval(days=>$9) AND id NOT IN (SELECT id FROM migration_snapshots ORDER BY received_at DESC LIMIT 3)) AS migration_snapshots,
      (SELECT COUNT(*)::int FROM system_issues WHERE status IN ('RESOLVED','DISMISSED') AND COALESCE(resolved_at,updated_at)<NOW()-make_interval(days=>$10)) AS resolved_issues,
      (SELECT COUNT(*)::int FROM audit_logs WHERE created_at<NOW()-make_interval(days=>$11)) AS audit_logs
  `,[policy.transferImageDays,policy.usedCodeDays,policy.whatsappRawDays,policy.whatsappTextDays,policy.whatsappTraceDays,policy.deadLetterDays,policy.repairRunDays,policy.migrationStageDays,policy.migrationSnapshotDays,policy.resolvedIssueDays,policy.auditLogDays]);
  const x=r.rows[0]||{};
  return {...x,estimated_reclaim_bytes:Number(x.transfer_image_bytes||0)+Number(x.whatsapp_raw_bytes||0)};
}

export async function getStorageOverview(){
  const policy=await getStoragePolicy();
  const [dbSize,logical,rels,candidates,last]=await Promise.all([
    db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`).then(r=>Number(r.rows[0]?.bytes||0)),
    db.query(`SELECT
      COALESCE((SELECT SUM(octet_length(image_data)) FROM recharge_requests),0)::bigint AS transfer_image_bytes,
      COALESCE((SELECT SUM(pg_column_size(raw_payload)) FROM whatsapp_events),0)::bigint AS whatsapp_raw_bytes,
      COALESCE((SELECT SUM(octet_length(COALESCE(message_text,''))) FROM whatsapp_events),0)::bigint AS whatsapp_text_bytes,
      (SELECT COUNT(*)::int FROM whatsapp_events) AS whatsapp_events,
      (SELECT COUNT(*)::int FROM recharge_requests WHERE image_data IS NOT NULL) AS transfer_images,
      (SELECT COUNT(*)::int FROM recharge_codes WHERE status='used') AS used_codes,
      (SELECT COUNT(*)::int FROM full_migration_stage_rows) AS migration_stage_rows`).then(r=>r.rows[0]||{}),
    relationSizes(),cleanupCandidates(policy),getLastStorageCleanup()
  ]);
  const coreBytes=['ledger_entries','weekly_settlements','weekly_settlement_items','captains','users'].reduce((a,k)=>a+Number(rels[k]||0),0);
  return {
    generatedAt:new Date().toISOString(),policy,lastCleanup:last,
    database:{bytes:dbSize,mb:mb(dbSize)},
    logical:{
      transferImages:{bytes:Number(logical.transfer_image_bytes||0),mb:mb(logical.transfer_image_bytes),count:Number(logical.transfer_images||0)},
      whatsappRaw:{bytes:Number(logical.whatsapp_raw_bytes||0),mb:mb(logical.whatsapp_raw_bytes),count:Number(logical.whatsapp_events||0)},
      whatsappText:{bytes:Number(logical.whatsapp_text_bytes||0),mb:mb(logical.whatsapp_text_bytes)},
      migrationStage:{bytes:Number(rels.full_migration_stage_rows||0),mb:mb(rels.full_migration_stage_rows),rows:Number(logical.migration_stage_rows||0)},
      traces:{bytes:Number(rels.whatsapp_event_traces||0),mb:mb(rels.whatsapp_event_traces)},
      audit:{bytes:Number(rels.audit_logs||0),mb:mb(rels.audit_logs)},
      coreFinance:{bytes:coreBytes,mb:mb(coreBytes)}
    },
    candidates:{...candidates,estimatedReclaimMB:mb(candidates.estimated_reclaim_bytes)}
  };
}

async function vacuumSafe(){
  for(const t of ['recharge_requests','recharge_codes','whatsapp_events','whatsapp_event_traces','whatsapp_dead_letters','whatsapp_repair_runs','full_migration_stage_rows','migration_snapshots','system_issues','audit_logs']){
    try{await db.query(`VACUUM (ANALYZE) ${t}`);}catch{}
  }
}

export async function runStorageCleanup({userId=null,automatic=false,dryRun=false}={}){
  const policy=await getStoragePolicy();
  const before=await cleanupCandidates(policy);
  if(dryRun)return {ok:true,dryRun:true,policy,candidates:before};
  const client=await db.connect();
  const removed={};
  let locked=false;
  try{
    const lk=await client.query(`SELECT pg_try_advisory_lock(hashtext('abshir_storage_cleanup_v1')) AS ok`);
    locked=Boolean(lk.rows[0]?.ok);
    if(!locked)return {ok:true,skipped:true,message:'يوجد تنظيف تخزين يعمل حاليًا'};

    let q=await client.query(`UPDATE recharge_requests SET image_data=NULL,image_mime=NULL,image_token=NULL WHERE image_data IS NOT NULL AND status<>'pending' AND COALESCE(reviewed_at,created_at)<NOW()-make_interval(days=>$1)`,[policy.transferImageDays]);removed.transferImages=q.rowCount;
    q=await client.query(`UPDATE recharge_codes SET code='ARCHIVED-USED-'||id::text WHERE status='used' AND used_at<NOW()-make_interval(days=>$1) AND code NOT LIKE 'ARCHIVED-USED-%'`,[policy.usedCodeDays]);removed.usedCodes=q.rowCount;
    q=await client.query(`UPDATE whatsapp_events e SET raw_payload='{}'::jsonb WHERE raw_payload<>'{}'::jsonb AND ${SAFE_EVENT_STATUS} AND ${NOT_ACTIVE_REPAIR} AND ${NOT_REACTION_MESSAGE} AND ${EVENT_TIME_SQL}<NOW()-make_interval(days=>$1)`,[policy.whatsappRawDays]);removed.whatsappRaw=q.rowCount;
    q=await client.query(`UPDATE whatsapp_events e SET message_text=NULL WHERE message_text IS NOT NULL AND ${SAFE_EVENT_STATUS} AND ${NOT_ACTIVE_REPAIR} AND ${EVENT_TIME_SQL}<NOW()-make_interval(days=>$1)`,[policy.whatsappTextDays]);removed.whatsappText=q.rowCount;
    q=await client.query(`DELETE FROM whatsapp_event_traces WHERE created_at<NOW()-make_interval(days=>$1)`,[policy.whatsappTraceDays]);removed.traces=q.rowCount;
    q=await client.query(`DELETE FROM whatsapp_dead_letters WHERE status<>'pending' AND COALESCE(resolved_at,replayed_at,failed_at)<NOW()-make_interval(days=>$1)`,[policy.deadLetterDays]);removed.deadLetters=q.rowCount;
    q=await client.query(`DELETE FROM whatsapp_repair_runs WHERE status IN ('COMPLETED','FAILED','CANCELLED') AND COALESCE(completed_at,updated_at)<NOW()-make_interval(days=>$1)`,[policy.repairRunDays]);removed.repairRuns=q.rowCount;
    q=await client.query(`DELETE FROM full_migration_stage_rows sr USING full_migration_runs mr WHERE mr.id=sr.run_id AND mr.status='completed' AND mr.completed_at<NOW()-make_interval(days=>$1)`,[policy.migrationStageDays]);removed.migrationStage=q.rowCount;
    q=await client.query(`DELETE FROM migration_snapshots WHERE received_at<NOW()-make_interval(days=>$1) AND id NOT IN (SELECT id FROM migration_snapshots ORDER BY received_at DESC LIMIT 3)`,[policy.migrationSnapshotDays]);removed.migrationSnapshots=q.rowCount;
    q=await client.query(`DELETE FROM system_issues WHERE status IN ('RESOLVED','DISMISSED') AND COALESCE(resolved_at,updated_at)<NOW()-make_interval(days=>$1)`,[policy.resolvedIssueDays]);removed.resolvedIssues=q.rowCount;
    q=await client.query(`DELETE FROM audit_logs WHERE created_at<NOW()-make_interval(days=>$1)`,[policy.auditLogDays]);removed.auditLogs=q.rowCount;

    const report={at:new Date().toISOString(),automatic:Boolean(automatic),removed,estimatedReclaimedBytes:Number(before.estimated_reclaim_bytes||0),estimatedReclaimedMB:mb(before.estimated_reclaim_bytes)};
    await client.query(`INSERT INTO system_settings(key,value,updated_by_user_id,updated_at) VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()`,[LAST_KEY,JSON.stringify(report),userId||null]);
    return {ok:true,policy,report};
  }finally{
    if(locked){try{await client.query(`SELECT pg_advisory_unlock(hashtext('abshir_storage_cleanup_v1'))`);}catch{}}
    client.release();
    setTimeout(()=>vacuumSafe(),100).unref?.();
  }
}

let schedulerTimer=null;
export function startStorageCleanupScheduler(){
  if(schedulerTimer)return schedulerTimer;
  const tick=async()=>{
    try{
      const policy=await getStoragePolicy();if(!policy.autoCleanup)return;
      const last=await getLastStorageCleanup();
      const age=last?.at?Date.now()-new Date(last.at).getTime():Infinity;
      if(age<20*60*60*1000)return;
      await runStorageCleanup({automatic:true});
    }catch(err){console.error('Storage cleanup scheduler:',err?.message||err)}
  };
  setTimeout(tick,30000).unref?.();
  schedulerTimer=setInterval(tick,6*60*60*1000);schedulerTimer.unref?.();
  return schedulerTimer;
}
