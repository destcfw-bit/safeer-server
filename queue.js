import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import {
  markQueued, markManyQueued, markProcessing, markProcessed, markFailed,
  saveDeadLetter, traceWebhookEvent, getWebhookPayload, markDeadLetterReplayed,
  getWhatsappLiveCutover, setWhatsappLiveCutover, createWhatsappRepairRun,
  listWhatsappRepairEvents, markWhatsappRepairQueued, markWhatsappRepairResult,
  latestWhatsappRepairRun, activeWhatsappRepairRun, addLateWhatsappRepairEvent,
  getWhatsappCutoverRepairStatus, cancelActiveWhatsappRepairRuns, resetWhatsappInventoryRange, getWhatsappRepairRun, cancelOtherWhatsappRepairRuns, stopActiveLegacyWeekBridgeRuns, reconcileWhatsappRepairRunForResume, listWhatsappRepairUnfinishedEvents
  ,getCleanStartState,setCleanStartAutomaticState,markWebhookIgnoredByCleanStart,markPendingWebhooksIgnoredBeforeCleanStart,
  getWebhookCleanStartReference,markWebhookIgnoredByCleanStartReference,listCleanStartReferenceIgnoredEvents
} from "./db.js";
import { processGreenEvent, repairWeeklyFloors, syncCaptainBalanceState } from "./features.js";

const redisUrl=process.env.REDIS_URL || "redis://127.0.0.1:6379";

export const redis = new IORedis(redisUrl, {
  maxRetriesPerRequest:null,
  connectTimeout:Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 8000),
  commandTimeout:Number(process.env.REDIS_COMMAND_TIMEOUT_MS || 8000),
  retryStrategy(times){ return Math.min(5000, Math.max(500, Number(times||1)*500)); }
});

const LIVE_QUEUE_NAME="abshir-whatsapp";
const REPAIR_QUEUE_NAME="abshir-whatsapp-repair";
const MODE_KEY="abshir:whatsapp:accounting_mode";
const CUTOVER_KEY="abshir:whatsapp:cutover_at";
const CLEAN_START_CUTOVER_KEY="abshir:whatsapp:clean_start_cutover_at";

const defaultOpts={
  attempts: Number(process.env.QUEUE_ATTEMPTS || 5),
  backoff: {type:"exponential", delay:Number(process.env.QUEUE_BACKOFF_MS || 1000), jitter:0.25},
  removeOnComplete: {age:3600,count:5000},
  removeOnFail: {age:86400,count:10000}
};

export const whatsappQueue = new Queue(LIVE_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: defaultOpts
});

export const repairQueue = new Queue(REPAIR_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts:Number(process.env.REPAIR_QUEUE_ATTEMPTS || 3),
    backoff:{type:"exponential",delay:Number(process.env.REPAIR_QUEUE_BACKOFF_MS || 750),jitter:0.15},
    removeOnComplete:{age:7200,count:30000},
    removeOnFail:{age:172800,count:30000}
  }
});

function payloadEventMs(payload){
  const raw=Number(payload?.timestamp||0);
  if(raw>0)return raw>1e11?raw:raw*1000;
  return Date.now();
}

function payloadReferenceIds(payload={}){
  const md=payload?.messageData||{};
  const candidates=[
    md?.extendedTextMessageData?.stanzaId,
    md?.reactionMessageData?.stanzaId,
    md?.reactionMessageData?.quotedStanzaId,
    md?.reactionMessageData?.idMessageQuoted,
    md?.deletedMessageData?.stanzaId,
    md?.deletedMessageData?.idMessage,
    md?.deletedMessageData?.messageId,
    md?.editedMessageData?.stanzaId,
    md?.quotedMessage?.stanzaId
  ];
  return [...new Set(candidates.map(x=>String(x||"").trim()).filter(Boolean))];
}

async function oldCleanStartReference(payload,cutoverAt){
  const cutoffMs=new Date(cutoverAt).getTime();
  const pending=payloadReferenceIds(payload).map(id=>({id,depth:0}));
  const visited=new Set();
  while(pending.length){
    const item=pending.shift();
    if(!item?.id||visited.has(item.id)||item.depth>3)continue;
    visited.add(item.id);
    const event=await getWebhookCleanStartReference(item.id);
    if(!event)continue;
    if(String(event.processing_mode||"")==="clean_start_ignored"||String(event.status||"")==="ignored")return item.id;
    const effectiveMs=event.effective_at?new Date(event.effective_at).getTime():0;
    if(effectiveMs&&effectiveMs<cutoffMs)return item.id;
    for(const id of payloadReferenceIds(event.raw_payload||{}))pending.push({id,depth:item.depth+1});
  }
  return null;
}

async function getCutoverMs(){
  let iso=await redis.get(CUTOVER_KEY);
  if(!iso){
    iso=await getWhatsappLiveCutover();
    if(iso)await redis.set(CUTOVER_KEY,iso);
  }
  const ms=iso?new Date(iso).getTime():0;
  return Number.isFinite(ms)?ms:0;
}

async function enqueueLive(payload){
  const idMessage=payload?.idMessage;
  const jobId=payload?._abshirReplayNonce?`recovery:${idMessage}:${payload._abshirReplayNonce}`:idMessage;
  await whatsappQueue.add("process-webhook",payload,{jobId,priority:1});
  await markQueued(idMessage,"live");
  await traceWebhookEvent(idMessage,"queue.live.enqueued",{jobId});
  return {lane:"live",jobId};
}

async function enqueueRepairPayload(payload,{runId=null,late=false}={}){
  const idMessage=payload?.idMessage;
  const nonce=payload?._abshirReplayNonce?`:recovery:${payload._abshirReplayNonce}`:"";
  const jobId=runId?`repair:${runId}:${idMessage}${nonce}`:`repair:late:${idMessage}${nonce}`;
  await repairQueue.add("repair-webhook",{...payload,_abshirRepairRunId:runId||null},{jobId});
  await markQueued(idMessage,"repair");
  if(late&&runId)await addLateWhatsappRepairEvent(runId);
  await traceWebhookEvent(idMessage,"queue.repair.enqueued",{jobId,runId:runId||null,late:Boolean(late)});
  return {lane:"repair",jobId};
}

export async function enqueueWebhook(payload) {
  const idMessage = payload?.idMessage;
  if (!idMessage) throw new Error("missing idMessage");
  // V68 ALWAYS-ON: every real-time webhook goes to the LIVE lane regardless of
  // historical cutover timestamps. Explicit historical rebuilds use their own
  // repair/reconciliation paths and ledger idempotency prevents duplicates.
  return await enqueueLive(payload);
}

export async function enqueueReplay(idMessage,userId=null) {
  const payload=await getWebhookPayload(idMessage);
  if(!payload) throw Object.assign(new Error("webhook_event_not_found"),{statusCode:404});
  const jobId=`replay:${idMessage}:${Date.now()}`;
  await whatsappQueue.add("process-webhook", payload, {
    jobId,
    attempts:Number(process.env.QUEUE_ATTEMPTS || 5),
    backoff:{type:"exponential",delay:Number(process.env.QUEUE_BACKOFF_MS || 1000),jitter:0.25},
    priority:1
  });
  await markQueued(idMessage,"live_replay");
  await markDeadLetterReplayed(idMessage,userId);
  await traceWebhookEvent(idMessage,"replay.enqueued",{jobId,userId:userId||null});
  return {jobId};
}

// LID repairs are deliberately replayed on the single-threaded repair lane.
// This preserves request -> reply -> reaction order while ledger/comparison
// idempotency remains the final duplicate guard.
export async function enqueueWahaIdentityRepair(idMessage,userId=null) {
  const payload=await getWebhookPayload(idMessage);
  if(!payload)throw Object.assign(new Error("webhook_event_not_found"),{statusCode:404});
  const jobId=`waha-identity:${idMessage}:${Date.now()}`;
  await repairQueue.add("repair-webhook",{...payload,_abshirIdentityRepair:true},{
    jobId,
    attempts:Number(process.env.REPAIR_QUEUE_ATTEMPTS || 3),
    backoff:{type:"exponential",delay:Number(process.env.REPAIR_QUEUE_BACKOFF_MS || 750),jitter:0.15},
    priority:1
  });
  await markQueued(idMessage,"waha_identity_repair");
  await markDeadLetterReplayed(idMessage,userId);
  await traceWebhookEvent(idMessage,"waha_identity.replay.enqueued",{jobId,userId:userId||null});
  return {jobId};
}

export async function getAccountingMode() {
  try{
    const v=await redis.get(MODE_KEY);
    return v || process.env.WHATSAPP_ACCOUNTING_MODE || "live";
  }catch{
    // Redis must never keep the accountant/captain login locked forever.
    // When Redis is temporarily unavailable we expose a safe paused state;
    // live queue processing starts automatically after Redis recovers.
    return "paused";
  }
}

export async function setAccountingMode(mode) {
  const clean=String(mode||"").toLowerCase();
  if(!["shadow","paused","live"].includes(clean)){
    throw Object.assign(new Error("invalid_accounting_mode"),{statusCode:400});
  }
  // V68 ALWAYS-ON: LIVE no longer depends on a cutover timestamp or a manual
  // "start from now" gate. Temporary pause is still allowed for atomic reset
  // operations, but normal boot and post-reset flow always return to LIVE.
  await redis.set(MODE_KEY,clean);
  if(clean==="paused") await whatsappQueue.pause();
  else await whatsappQueue.resume();
  return clean;
}

async function waitForQueueIdle(queue,{timeoutMs=30000}={}){
  const started=Date.now();
  let counts=await queue.getJobCounts("active","waiting","delayed","prioritized");
  while(Number(counts.active||0)>0&&Date.now()-started<Math.max(5000,Number(timeoutMs)||30000)){
    await new Promise(resolve=>setTimeout(resolve,250));
    counts=await queue.getJobCounts("active","waiting","delayed","prioritized");
  }
  if(Number(counts.active||0)>0){
    throw Object.assign(new Error(`تعذر إيقاف الطابور بأمان؛ يوجد ${counts.active} حدث قيد المعالجة`),{statusCode:409});
  }
  return counts;
}

export async function prepareQueuesForCleanSlateReset(){
  // This runs before the new process exposes login/webhook APIs or starts its
  // workers. Pause the shared queues first so an older deployment finishes its
  // active job but cannot claim another one while the database is being reset.
  await Promise.all([whatsappQueue.pause(),repairQueue.pause()]);
  const [liveBefore,repairBefore]=await Promise.all([
    waitForQueueIdle(whatsappQueue,{timeoutMs:60000}),
    waitForQueueIdle(repairQueue,{timeoutMs:60000})
  ]);
  await whatsappQueue.obliterate({force:true});
  await repairQueue.obliterate({force:true});
  await redis.del(CUTOVER_KEY,CLEAN_START_CUTOVER_KEY,FULL_WEEK_REBUILD_KEY);
  await redis.set(MODE_KEY,"paused");
  return {prepared:true,liveBefore,repairBefore};
}

async function discardLiveJobsBefore(cutoverAt){
  const cutoffMs=new Date(cutoverAt).getTime();
  const jobs=await whatsappQueue.getJobs(["waiting","delayed","prioritized","paused"],0,-1,false).catch(()=>[]);
  let removed=0,kept=0;
  for(const job of jobs||[]){
    const eventMs=payloadEventMs(job.data||{});
    if(eventMs<cutoffMs){
      await markWebhookIgnoredByCleanStart(job.data?.idMessage,cutoverAt).catch(()=>null);
      await job.remove().catch(()=>null);
      removed+=1;
    }else kept+=1;
  }
  return {removed,kept,scanned:(jobs||[]).length};
}

export async function enforceCleanStartBootGate(){
  // V68 ALWAYS-ON: a Railway restart must never leave WhatsApp accounting paused.
  // Historical repair remains paused unless explicitly requested, while the LIVE
  // queue resumes immediately. The old clean-start cutover key is retired.
  let state=await getCleanStartState();
  await repairQueue.pause();
  await redis.del(CLEAN_START_CUTOVER_KEY);
  await redis.set(MODE_KEY,"live");
  await whatsappQueue.resume();
  if(state.status==="COMPLETED"&&state.automaticStatus!=="LIVE"){
    try{
      state=await setCleanStartAutomaticState({
        status:"LIVE",cutoverAt:new Date().toISOString(),userId:null,
        details:{alwaysOn:true,source:"boot",cutoverFiltering:false}
      });
    }catch{}
  }

  // Recover ONLY events that were themselves new but got ignored because they
  // referenced an older request. Do not replay genuinely old pre-cutover base
  // messages. This restores missed reply/reaction work from the old gate safely.
  let recoveredReferenceEvents=0;
  try{
    const missed=await listCleanStartReferenceIgnoredEvents(5000);
    for(const row of missed){
      const payload=row?.raw_payload&&typeof row.raw_payload==='object'?row.raw_payload:null;
      if(!payload?.idMessage)continue;
      try{
        await enqueueLive({...payload,_abshirReplayNonce:`v68-always-on-${Date.now()}-${recoveredReferenceEvents}`,_abshirAlwaysOnRecovery:true});
        recoveredReferenceEvents++;
      }catch(error){
        if(!/Job.*already exists|duplicate/i.test(String(error?.message||error)))throw error;
      }
    }
  }catch{}
  return {mode:"live",state,alwaysOn:true,cutoverFiltering:false,recoveredReferenceEvents};
}

export async function prepareRechargeOnlyCleanStart(){
  // Pause intake first; already-active jobs are allowed to finish before the
  // financial snapshot is calculated so the reset has one deterministic target.
  await Promise.all([whatsappQueue.pause(),repairQueue.pause()]);
  const [liveBefore,repairBefore]=await Promise.all([
    waitForQueueIdle(whatsappQueue),waitForQueueIdle(repairQueue)
  ]);
  await redis.set(MODE_KEY,"paused");
  await redis.del(CLEAN_START_CUTOVER_KEY);
  await repairQueue.drain(true);
  const cancelled=await cancelActiveWhatsappRepairRuns("أُلغي الجرد التاريخي بطلب المحاسب قبل البداية الجديدة",null).catch(()=>[]);
  const bridges=await stopActiveLegacyWeekBridgeRuns("أُلغي جسر الجرد القديم بطلب المحاسب قبل البداية الجديدة",null).catch(()=>[]);
  return {mode:"paused",liveBefore,repairBefore,cancelled,bridges};
}

export async function startCleanStartLive({userId}={}){
  // V68 ALWAYS-ON: this function is now an idempotent "ensure LIVE" operation.
  // It never discards messages and never creates a boundary that rejects older
  // requests referenced by a new reply/reaction.
  let state=await getCleanStartState();
  if(state.status==="COMPLETED"){
    state=await setCleanStartAutomaticState({
      status:"LIVE",cutoverAt:new Date().toISOString(),userId,
      details:{alwaysOn:true,cutoverFiltering:false,noDiscard:true}
    });
  }
  await redis.del(CLEAN_START_CUTOVER_KEY);
  await redis.set(MODE_KEY,"live");
  await whatsappQueue.resume();
  return {state,cutoverAt:null,alwaysOn:true,cutoverFiltering:false,ignoredEvents:0,discarded:{removed:0,kept:0,scanned:0}};
}

export async function stopCleanStartLive({userId}={}){
  // V68: Always-On is protected from accidental/manual stop. Keep the API for
  // backward compatibility but turn it into an "ensure LIVE" no-op.
  const result=await startCleanStartLive({userId});
  return {...result,protectedAlwaysOn:true,mode:"live",counts:await whatsappQueue.getJobCounts("waiting","active","delayed","failed")};
}

export async function getCleanStartControlState(){
  const [state,mode,liveQueue,repairQueueCounts]=await Promise.all([
    getCleanStartState(),getAccountingMode(),
    whatsappQueue.getJobCounts("waiting","active","delayed","failed"),
    repairQueue.getJobCounts("waiting","active","delayed","failed")
  ]);
  return {state,mode,liveQueue,repairQueue:repairQueueCounts};
}

function ammanFridayStartIso(now=new Date()){
  // Jordan is UTC+3 year-round in the current deployment. Calculate using Amman calendar date.
  const local=new Date(now.getTime()+3*60*60*1000);
  const day=local.getUTCDay();
  const diff=(day-5+7)%7; // Friday=5
  local.setUTCDate(local.getUTCDate()-diff);
  local.setUTCHours(0,0,0,0);
  return new Date(local.getTime()-3*60*60*1000).toISOString();
}


export async function quiesceActiveRepairForFinalTakeover({timeoutMs=45000}={}){
  const active=await activeWhatsappRepairRun();
  if(!active)return {ok:true,changed:false,active:null};

  // Prevent any more historical jobs from starting while the final snapshot is taken.
  await repairQueue.pause();
  const started=Date.now();
  let counts=await repairQueue.getJobCounts("waiting","active","delayed","failed","completed");

  // Let the one currently executing historical event finish safely.
  while(Number(counts.active||0)>0 && Date.now()-started<Math.max(5000,Number(timeoutMs)||45000)){
    await new Promise(r=>setTimeout(r,300));
    counts=await repairQueue.getJobCounts("waiting","active","delayed","failed","completed");
  }
  if(Number(counts.active||0)>0){
    await repairQueue.resume();
    throw Object.assign(new Error(`تعذر إيقاف Repair القديم بأمان؛ ما زال ${counts.active} حدث قيد المعالجة`),{statusCode:409});
  }

  // Remove only not-yet-executed repair work. Completed history stays in PostgreSQL.
  await repairQueue.drain(true);
  const cancelled=await cancelActiveWhatsappRepairRuns(
    'تم إيقاف Repair القديم تلقائيًا قبل Final Takeover؛ سيبدأ Repair جديد من بداية الأسبوع بعد التحويل.',
    null
  );
  await repairQueue.resume();
  return {ok:true,changed:true,active,cancelled,countsBefore:counts};
}

export async function preflightLiveCutoverAndRepair({fromAt=null}={}){
  const active=await activeWhatsappRepairRun();
  if(active)throw Object.assign(new Error(`يوجد إصلاح تاريخي يعمل حاليًا (${active.processed_events||0}/${active.total_events||0})`),{statusCode:409});
  const probeCutoff=new Date();
  const parsed=fromAt?new Date(fromAt):null;
  if(parsed&&!Number.isFinite(parsed.getTime()))throw Object.assign(new Error("repair_start_invalid"),{statusCode:400});
  const fromIso=parsed?parsed.toISOString():ammanFridayStartIso(probeCutoff);
  if(new Date(fromIso)>=probeCutoff)throw Object.assign(new Error("repair_start_must_be_before_cutover"),{statusCode:400});
  return {ok:true,fromAt:fromIso};
}

async function queueRepairRun_(run){
  let offset=0,queued=0;
  while(true){
    const rows=await listWhatsappRepairEvents(run.id,offset,1000);
    if(!rows.length)break;
    const jobs=rows.map(x=>({
      name:"repair-webhook",
      data:{...(x.raw_payload||{}),idMessage:(x.raw_payload?.idMessage||x.id_message),_abshirRepairRunId:run.id},
      opts:{jobId:`repair:${run.id}:${x.id_message}`}
    }));
    await repairQueue.addBulk(jobs);
    await markManyQueued(rows.map(x=>x.id_message),"repair");
    queued+=rows.length;
    await markWhatsappRepairQueued(run.id,rows.length);
    offset+=rows.length;
  }
  return queued;
}

export async function startRepairForExistingCutover({fromAt,cutoffAt,userId=null,timeBasis='received'}={}){
  const active=await activeWhatsappRepairRun();
  if(active)throw Object.assign(new Error(`يوجد إصلاح تاريخي يعمل حاليًا (${active.processed_events||0}/${active.total_events||0})`),{statusCode:409});
  const fromIso=new Date(fromAt).toISOString();
  const cutoffIso=new Date(cutoffAt).toISOString();
  if(new Date(fromIso)>=new Date(cutoffIso))throw Object.assign(new Error('repair_start_must_be_before_cutover'),{statusCode:400});
  const run=await createWhatsappRepairRun({fromAt:fromIso,cutoffAt:cutoffIso,userId,timeBasis});
  const queued=await queueRepairRun_(run);
  await traceWebhookEvent(`REPAIR-RUN-${run.id}`,"repair.run.started",{runId:run.id,fromAt:fromIso,cutoffAt:cutoffIso,total:run.total_events,queued,timeBasis});
  return {ok:true,fromAt:fromIso,cutoffAt:cutoffIso,runId:run.id,total:Number(run.total_events||0),queued,timeBasis};
}

const FULL_WEEK_REBUILD_KEY='abshir:whatsapp:full_week_rebuild';

const FULL_WEEK_REBUILD_MONITOR_VERSION='3.8.5.14';

function repairMonitorEventTime(payload={}){
  const raw=Number(payload?.timestamp||0);
  if(raw>0){
    const ms=raw>1e11?raw:raw*1000;
    if(Number.isFinite(ms))return new Date(ms).toISOString();
  }
  return null;
}

function repairMonitorText(payload={}){
  const md=payload?.messageData||{};
  return String(
    md?.textMessageData?.textMessage||
    md?.extendedTextMessageData?.text||
    md?.editedMessageData?.textMessage||
    md?.fileMessageData?.caption||
    md?.imageMessageData?.caption||
    md?.videoMessageData?.caption||
    ''
  ).trim().slice(0,500);
}

function repairMonitorType(payload={}){
  const md=payload?.messageData||{};
  const type=String(md?.typeMessage||'');
  if(type==='reactionMessage'){
    const emoji=String(md?.reactionMessageData?.text||md?.reactionMessageData?.emoji||md?.extendedTextMessageData?.text||'').replace(/\uFE0F/g,'').trim();
    return emoji?`REACTION ${emoji}`:'REACTION_REMOVAL';
  }
  if(type==='deletedMessage')return 'DELETE';
  if(type==='editedMessage')return 'EDIT';
  if(type==='audioMessage')return 'AUDIO';
  if(type==='imageMessage')return 'IMAGE';
  if(type==='videoMessage')return 'VIDEO';
  if(type==='extendedTextMessage')return 'REPLY';
  return type||String(payload?.typeWebhook||'MESSAGE');
}

function repairMonitorResult(result={}){
  const r=result?.result||result||{};
  const tx=Array.isArray(r?.transactions)?r.transactions:[];
  if(tx.length){
    const production=tx.filter(x=>Number(x?.amount||0)>0).reduce((a,x)=>a+Number(x.amount||0),0);
    const consumption=tx.filter(x=>Number(x?.amount||0)<0).reduce((a,x)=>a+Math.abs(Number(x.amount||0)),0);
    const parts=[];
    if(production>0)parts.push(`إنتاج +${production.toFixed(3)}`);
    if(consumption>0)parts.push(`استهلاك -${consumption.toFixed(3)}`);
    return `تم إنشاء ${tx.length} حركة مالية${parts.length?` — ${parts.join(' / ')}`:''}`;
  }
  if(Number(r?.reversed||0)>0)return `تم عكس ${Number(r.reversed)} حركة`;
  if(r?.cancelled)return 'تم إلغاء الجرد';
  if(r?.duplicate)return 'مكرر — بدون حركة مالية جديدة';
  if(r?.waitingReview){
    const reason=String(r?.review?.reason||r?.reason||r?.error||'').trim();
    return reason?`تحتاج مراجعة محاسبية — ${reason}`:'تحتاج مراجعة محاسبية';
  }
  if(r?.preservedCompletedWork)return 'تم الحفاظ على الجرد المكتمل';
  if(r?.blocked)return `محظور${r?.reason?` — ${String(r.reason)}`:''}`;
  if(r?.edited)return Number(r?.corrected||0)>0?`تم تعديل الرسالة وتصحيح ${Number(r.corrected)} جرد`:'تم تحديث الرسالة';
  if(r?.ignored)return `تم التجاهل${r?.reason?` — ${String(r.reason)}`:''}`;
  if(r?.error)return `خطأ منطقي: ${String(r.error)}`;
  return 'تمت المعالجة بدون حركة مالية';
}

function repairMonitorReview(result={}){
  const r=result?.result||result||{};
  const review=r?.review||null;
  if(!review)return null;
  const normParty=p=>p?{id:String(p?.id||''),name:String(p?.name||''),phone:String(p?.phone||'')}:null;
  return {
    reasonCode:String(review?.reasonCode||r?.error||'review_required'),
    reason:String(review?.reason||'تحتاج مراجعة محاسبية'),
    producer:normParty(review?.producer),
    consumer:normParty(review?.consumer),
    requestText:String(review?.requestText||'').trim(),
    doneMessageId:String(review?.doneMessageId||''),
    reactionId:String(review?.reactionId||''),
    originalMessageId:String(review?.originalMessageId||'')
  };
}

function repairMonitorFinancial(result={}){
  const r=result?.result||result||{};
  const tx=Array.isArray(r?.transactions)?r.transactions:[];
  if(!tx.length)return null;
  const producer=r?.producer||{},consumer=r?.consumer||{};
  const production=tx.filter(x=>Number(x?.amount||0)>0).reduce((a,x)=>a+Number(x.amount||0),0);
  const consumption=tx.filter(x=>Number(x?.amount||0)<0).reduce((a,x)=>a+Math.abs(Number(x.amount||0)),0);
  const requestText=String(r?.requestText||tx.find(x=>x?.metadata?.requestText)?.metadata?.requestText||'').trim();
  return {
    producer:{id:String(producer?.id||''),name:String(producer?.name||''),phone:String(producer?.phone||''),amount:Number(production.toFixed(3))},
    consumer:{id:String(consumer?.id||''),name:String(consumer?.name||''),phone:String(consumer?.phone||''),amount:Number(consumption.toFixed(3))},
    requestText
  };
}

function repairMonitorJob(job,{includeResult=false}={}){
  if(!job)return null;
  const payload={...(job.data||{})};
  delete payload._abshirRepairRunId;
  const sd=payload?.senderData||{};
  return {
    idMessage:String(payload?.idMessage||''),
    senderName:String(sd?.senderName||sd?.chatName||'').trim(),
    sender:String(sd?.sender||sd?.senderPhone||'').trim(),
    eventAt:repairMonitorEventTime(payload),
    type:repairMonitorType(payload),
    text:repairMonitorText(payload),
    startedAt:job.processedOn?new Date(job.processedOn).toISOString():null,
    finishedAt:job.finishedOn?new Date(job.finishedOn).toISOString():null,
    result:includeResult?repairMonitorResult(job.returnvalue||{}):'قيد المعالجة الآن',
    financial:includeResult?repairMonitorFinancial(job.returnvalue||{}):null,
    review:includeResult?repairMonitorReview(job.returnvalue||{}):null
  };
}

async function fullWeekRebuildMonitor(runId,repair){
  const id=Number(runId||0);
  if(!id||!repair)return {current:null,recent:[],speedPerMinute:0,etaSeconds:null,estimatedFinishAt:null};
  const [activeJobs,completedJobs]=await Promise.all([
    repairQueue.getJobs(['active'],0,20,false).catch(()=>[]),
    repairQueue.getJobs(['completed'],0,199,false).catch(()=>[])
  ]);
  const active=(activeJobs||[]).find(j=>Number(j?.data?._abshirRepairRunId||0)===id)||null;
  const completed=(completedJobs||[]).filter(j=>Number(j?.data?._abshirRepairRunId||0)===id);
  const recent=completed.slice(0,10).map(j=>repairMonitorJob(j,{includeResult:true})).filter(Boolean);

  const done=Number(repair.processed_events||0)+Number(repair.failed_events||0);
  const total=Number(repair.total_events||0);
  const remaining=Math.max(0,total-done);
  let speedPerSecond=0;
  const timed=completed.filter(j=>Number(j?.finishedOn||0)>0).slice(0,120);
  if(timed.length>=3){
    const newest=Number(timed[0].finishedOn||0),oldest=Number(timed[timed.length-1].finishedOn||0);
    const seconds=Math.max(1,(newest-oldest)/1000);
    speedPerSecond=Math.max(0,(timed.length-1)/seconds);
  }
  if(!(speedPerSecond>0)&&done>0&&repair.started_at){
    const elapsed=Math.max(1,(Date.now()-new Date(repair.started_at).getTime())/1000);
    speedPerSecond=done/elapsed;
  }
  const etaSeconds=speedPerSecond>0?Math.ceil(remaining/speedPerSecond):null;
  return {
    version:FULL_WEEK_REBUILD_MONITOR_VERSION,
    current:repairMonitorJob(active),
    recent,
    speedPerMinute:Number((speedPerSecond*60).toFixed(2)),
    etaSeconds:Number.isFinite(etaSeconds)?etaSeconds:null,
    estimatedFinishAt:Number.isFinite(etaSeconds)?new Date(Date.now()+etaSeconds*1000).toISOString():null,
    remaining
  };
}

export async function startCurrentFridayFullRebuild({userId=null}={}){
  const active=await activeWhatsappRepairRun();
  if(active)throw Object.assign(new Error(`يوجد Repair يعمل حاليًا (${active.processed_events||0}/${active.total_events||0})`),{statusCode:409});
  // V3.8.5.10: a previous takeover/repair may leave the BullMQ repair queue globally paused.
  // With no active repair run it is safe to drop stale waiting historical jobs, then resume
  // before creating the deterministic full-week rebuild jobs.
  await repairQueue.drain(true).catch(()=>{});
  await repairQueue.resume();
  await setAccountingMode('paused');
  const drainDeadline=Date.now()+Math.min(120000,Math.max(10000,Number(process.env.REBUILD_DRAIN_TIMEOUT_MS||60000)));
  let counts=await whatsappQueue.getJobCounts('active');
  while(Number(counts.active||0)>0&&Date.now()<drainDeadline){await new Promise(r=>setTimeout(r,300));counts=await whatsappQueue.getJobCounts('active')}
  if(Number(counts.active||0)>0){await setAccountingMode('live');throw Object.assign(new Error('تعذر بدء إعادة البناء لأن بعض الحركات الحية ما زالت قيد التنفيذ'),{statusCode:409})}
  const cutoffAt=new Date().toISOString();
  const fromAt=ammanFridayStartIso(new Date(cutoffAt));
  try{
    await setWhatsappLiveCutover(cutoffAt,userId);await redis.set(CUTOVER_KEY,cutoffAt);
    const reset=await resetWhatsappInventoryRange({fromAt,cutoffAt,userId,reason:'إعادة بناء جرد الجمعة كاملًا'});
    const run=await createWhatsappRepairRun({fromAt,cutoffAt,userId,runKey:`full-week-rebuild:${Date.now()}`,timeBasis:'event'});
    await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify({phase:'REPLAYING',startedAt:new Date().toISOString(),fromAt,cutoffAt,runId:run.id,reversedCount:reset.reversedCount,captainIds:reset.captainIds,userId:userId||null}));
    const queued=await queueRepairRun_(run);
    if(Number(run.total_events||0)===0){
      await repairWeeklyFloors(userId).catch(()=>null);
      await Promise.all((reset.captainIds||[]).map(id=>syncCaptainBalanceState(id).catch(()=>null)));
      await setAccountingMode('live');
      await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify({phase:'COMPLETED',startedAt:new Date().toISOString(),completedAt:new Date().toISOString(),fromAt,cutoffAt,runId:run.id,reversedCount:reset.reversedCount,total:0,queued:0}));
    }
    return {ok:true,fromAt,cutoffAt,runId:run.id,total:Number(run.total_events||0),queued,reversedCount:reset.reversedCount,mode:'paused_until_rebuild_complete'};
  }catch(e){
    await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify({phase:'FAILED',failedAt:new Date().toISOString(),error:e.message||String(e)})).catch(()=>{});
    await setAccountingMode('live').catch(()=>{});
    throw e;
  }
}

export async function startCorrectedFridayFullRebuild({userId=null}={}){
  // V3.8.5.26 — cancel/drain any stale repair first, then start one clean deterministic rebuild
  // using the corrected quantity parser. No financial row is deleted; resetWhatsappInventoryRange
  // creates auditable reversals for old WhatsApp inventory before replay.
  await stopActiveLegacyWeekBridgeRuns('تم إيقاف الجسر القديم قبل إعادة بناء الجرد المصححة',userId).catch(()=>[]);
  await quiesceActiveRepairForFinalTakeover({timeoutMs:45000});
  await redis.del(FULL_WEEK_REBUILD_KEY).catch(()=>{});
  return await startCurrentFridayFullRebuild({userId});
}

export async function stabilizeCurrentFridayFullRebuild({userId=null,timeoutMs=45000}={}){
  let state={phase:'IDLE'};
  try{const raw=await redis.get(FULL_WEEK_REBUILD_KEY);if(raw)state=JSON.parse(raw)}catch{}
  if(String(state?.phase||'')!=='REPLAYING'||!Number(state?.runId||0)){
    throw Object.assign(new Error('لا توجد إعادة جرد الجمعة فعالة تحتاج تثبيت'),{statusCode:409});
  }
  const runId=Number(state.runId);
  const run=await getWhatsappRepairRun(runId);
  if(!run)throw Object.assign(new Error('لم يتم العثور على Repair الخاص بإعادة الجرد الحالية'),{statusCode:404});

  // Freeze the historical producer first so no more old Google jobs can arrive while the queue is rebuilt.
  await redis.set('abshir:legacy_week_bridge:disabled','1');
  const stoppedBridges=await stopActiveLegacyWeekBridgeRuns('تم إيقاف جسر Google القديم لتثبيت قائمة إعادة جرد الجمعة الحالية',userId);
  const cancelledRuns=await cancelOtherWhatsappRepairRuns(runId,'تم إلغاء Repair قديم زائد وترك Run إعادة جرد الجمعة الحالي فقط',userId);

  await repairQueue.pause();
  const started=Date.now();
  let counts=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
  while(Number(counts.active||0)>0 && Date.now()-started<Math.max(10000,Number(timeoutMs)||45000)){
    await new Promise(r=>setTimeout(r,300));
    counts=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
  }
  if(Number(counts.active||0)>0){
    await repairQueue.resume();
    throw Object.assign(new Error(`تعذر تنظيف الطابور بأمان؛ ما زال ${counts.active} حدث قيد المعالجة. جرّب بعد لحظات.`),{statusCode:409});
  }

  const before={...counts};
  // Remove waiting/delayed jobs from every stale repair. Financial rows in PostgreSQL are untouched.
  await repairQueue.drain(true);
  const requeued=await queueRepairRun_(run);
  await repairQueue.resume();
  const after=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
  const nextState={...state,stabilizedAt:new Date().toISOString(),stabilizedBy:userId||null,legacyBridgeDisabled:true,stoppedBridgeRuns:stoppedBridges.length,cancelledRepairRuns:cancelledRuns.length,lastQueueReset:{before,after,requeued}};
  await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify(nextState));
  await traceWebhookEvent(`REBUILD-RUN-${runId}`,'full_week_rebuild.stabilized',{runId,stoppedBridgeRuns:stoppedBridges.length,cancelledRepairRuns:cancelledRuns.length,before,after,requeued});
  return {ok:true,runId,stoppedBridges,cancelledRuns,before,after,requeued,state:nextState};
}


export async function resumeCurrentFridayFullRebuild({userId=null,timeoutMs=45000}={}){
  let state={phase:'IDLE'};try{const raw=await redis.get(FULL_WEEK_REBUILD_KEY);if(raw)state=JSON.parse(raw)}catch{}
  if(String(state?.phase||'')!=='REPLAYING'||!Number(state?.runId||0))throw Object.assign(new Error('لا توجد إعادة جرد معلقة قابلة للاستكمال'),{statusCode:409});
  const runId=Number(state.runId);
  let queueResumed=false;
  try{
    // Stop the repair worker only long enough to take an exact durable snapshot of what is missing.
    await repairQueue.pause();
    const started=Date.now();
    let counts=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
    while(Number(counts.active||0)>0 && Date.now()-started<Math.max(10000,Number(timeoutMs)||45000)){
      await new Promise(r=>setTimeout(r,300));
      counts=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
    }
    if(Number(counts.active||0)>0)throw Object.assign(new Error(`تعذر الاستكمال بأمان؛ ما زال ${counts.active} حدث قيد المعالجة`),{statusCode:409});

    // Remove only stale not-yet-running queue jobs. Completed financial records remain in PostgreSQL.
    await repairQueue.drain(true);
    const truth=await reconcileWhatsappRepairRunForResume(runId);
    const missing=Number(truth.truthMissing||0);
    const generation=Number(state.resumeGeneration||0)+1;

    if(missing<=0){
      const floorRepair=await repairWeeklyFloors(userId).catch(e=>({error:e.message}));
      await Promise.all((state.captainIds||[]).map(id=>syncCaptainBalanceState(id).catch(()=>null)));
      await setAccountingMode('live');
      const next={...state,phase:'COMPLETED',completedAt:new Date().toISOString(),resumeGeneration:generation,resumedAt:new Date().toISOString(),resumeMissing:0,floorRepair,total:Number(truth.total_events||0),processed:Number(truth.processed_events||0),failed:0};
      await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify(next));
      await repairQueue.resume();queueResumed=true;
      await traceWebhookEvent(`REBUILD-RUN-${runId}`,'full_week_rebuild.resume_already_complete',{runId,total:truth.total_events,completed:truth.processed_events,generation});
      return {ok:true,runId,missing:0,queued:0,alreadyComplete:true,state:next};
    }

    let offset=0,queued=0;
    while(true){
      const rows=await listWhatsappRepairUnfinishedEvents(runId,offset,1000);
      if(!rows.length)break;
      const jobs=rows.map(x=>({
        name:'repair-webhook',
        data:{...(x.raw_payload||{}),idMessage:(x.raw_payload?.idMessage||x.id_message),_abshirRepairRunId:runId},
        opts:{jobId:`repair-resume:${runId}:${generation}:${x.id_message}`}
      }));
      await repairQueue.addBulk(jobs);
      await markManyQueued(rows.map(x=>x.id_message),'repair_resume');
      queued+=rows.length;offset+=rows.length;
    }
    await repairQueue.resume();queueResumed=true;
    const after=await repairQueue.getJobCounts('waiting','active','delayed','failed','completed');
    const next={...state,phase:'REPLAYING',resumeGeneration:generation,resumedAt:new Date().toISOString(),resumeMissing:missing,resumeQueued:queued,lastResumeQueue:after};
    await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify(next));
    await traceWebhookEvent(`REBUILD-RUN-${runId}`,'full_week_rebuild.missing_resumed',{runId,generation,missing,queued,truthCompleted:Number(truth.truthCompleted||0),total:Number(truth.total_events||0),queue:after});
    return {ok:true,runId,generation,missing,queued,truthCompleted:Number(truth.truthCompleted||0),total:Number(truth.total_events||0),queue:after,state:next};
  }catch(err){
    if(!queueResumed)await repairQueue.resume().catch(()=>{});
    throw err;
  }
}

export async function getCurrentFridayFullRebuildStatus(){
  let state={phase:'IDLE'};try{const raw=await redis.get(FULL_WEEK_REBUILD_KEY);if(raw)state=JSON.parse(raw)}catch{}
  const repair=state?.runId?(await getWhatsappRepairRun(state.runId)):null;
  let repairQueuePaused=await repairQueue.isPaused().catch(()=>false);
  // Self-heal an already-created rebuild that was queued while BullMQ repair was paused.
  if(String(state?.phase||'')==='REPLAYING' && repair && String(repair.status||'')!=='COMPLETED' && repairQueuePaused){
    await repairQueue.resume();
    repairQueuePaused=false;
    await traceWebhookEvent(`REBUILD-RUN-${state.runId}`,'full_week_rebuild.repair_queue_resumed',{runId:state.runId});
  }
  const repairQueueCounts=await repairQueue.getJobCounts('waiting','active','completed','failed','delayed').catch(()=>({}));
  const done=Number(repair?.processed_events||0)+Number(repair?.failed_events||0),total=Number(repair?.total_events||0);
  const stalled=String(state?.phase||'')==='REPLAYING' && total>done && Number(repairQueueCounts.waiting||0)===0 && Number(repairQueueCounts.active||0)===0 && Number(repairQueueCounts.delayed||0)===0;
  const monitor=await fullWeekRebuildMonitor(state?.runId,repair).catch(()=>({current:null,recent:[],speedPerMinute:0,etaSeconds:null,estimatedFinishAt:null}));
  return {...state,repair,repairQueuePaused,repairQueueCounts,monitor,stalled,missingByCounter:Math.max(0,total-done),mode:await getAccountingMode()};
}

export async function startLiveCutoverAndRepair({fromAt=null,userId=null}={}){
  await preflightLiveCutoverAndRepair({fromAt});
  const cutoffAt=new Date().toISOString();
  const fromIso=fromAt?new Date(fromAt).toISOString():ammanFridayStartIso(new Date());

  await setWhatsappLiveCutover(cutoffAt,userId);
  await redis.set(CUTOVER_KEY,cutoffAt);
  await setAccountingMode("live");

  const run=await createWhatsappRepairRun({fromAt:fromIso,cutoffAt,userId,timeBasis:'event'});
  const queued=await queueRepairRun_(run);
  await traceWebhookEvent(`REPAIR-RUN-${run.id}`,"repair.run.started",{runId:run.id,fromAt:fromIso,cutoffAt,total:run.total_events,queued});
  return {ok:true,cutoverAt,fromAt:fromIso,runId:run.id,total:Number(run.total_events||0),queued,mode:"live"};
}

export async function commitFinalTakeoverLive({fromAt,cutoffAt,userId=null}={}){
  const cutoffIso=new Date(cutoffAt).toISOString();
  const fromIso=new Date(fromAt).toISOString();
  await setWhatsappLiveCutover(cutoffIso,userId);
  await redis.set(CUTOVER_KEY,cutoffIso);
  const repair=await startRepairForExistingCutover({fromAt:fromIso,cutoffAt:cutoffIso,userId,timeBasis:'received'});
  await setAccountingMode('live');
  return {...repair,cutoverAt:cutoffIso,mode:'live'};
}

export async function getLiveCutoverRepairStatus(){
  const base=await getWhatsappCutoverRepairStatus();
  const [liveQueue,repairQ]=await Promise.all([
    whatsappQueue.getJobCounts("waiting","active","completed","failed","delayed"),
    repairQueue.getJobCounts("waiting","active","completed","failed","delayed")
  ]);
  return {...base,liveQueue,repairQueue:repairQ,mode:await getAccountingMode()};
}

function resultCounters(result){
  const tx=Array.isArray(result?.transactions)?result.transactions.length:0;
  const repaired=(tx>0 || Number(result?.reversed||0)>0 || result?.restoredFromQuotedRequest || result?.preservedCompletedWork)?1:0;
  return {
    repaired,
    duplicate:result?.duplicate?1:0,
    preserved:result?.preservedCompletedWork?1:0
  };
}

async function waitForLiveAccountingResume(idMessage,attempt){
  let mode=await getAccountingMode();
  if(mode!=="paused")return mode;
  await traceWebhookEvent(idMessage,"worker.paused_guard",{
    attempt,note:"Active job retained until accounting resumes"
  });
  while(mode==="paused"){
    await new Promise(resolve=>setTimeout(resolve,500));
    mode=await getAccountingMode();
  }
  await traceWebhookEvent(idMessage,"worker.paused_guard.released",{attempt,mode});
  return mode;
}

export function startWorker() {
  const liveWorker = new Worker(LIVE_QUEUE_NAME, async job => {
    const idMessage = job.data?.idMessage;
    const attempt=(job.attemptsMade || 0) + 1;
    await markProcessing(idMessage, attempt,"live");

    // V68 ALWAYS-ON: do not ignore an event because its own timestamp, quoted
    // request, or reaction target predates a historical clean-start cutover.
    // Ledger/message idempotency is the only duplicate guard.
    let mode=await getAccountingMode();
    await traceWebhookEvent(idMessage,"worker.live.started",{attempt,mode,jobId:job.id});

    if(mode==="paused"){
      mode=await waitForLiveAccountingResume(idMessage,attempt);
    }

    if(mode==="shadow"){
      await traceWebhookEvent(idMessage,"shadow.processed",{
        note:"No financial movement written in shadow mode",
        typeWebhook:job.data?.typeWebhook||null
      });
      await markProcessed(idMessage,"shadow");
      return {ok:true,idMessage,mode:"shadow"};
    }

    const result=await processGreenEvent(job.data,{force:Boolean(job.data?._abshirOutageRecovery),userId:null,repairMode:false});
    await traceWebhookEvent(idMessage,"live.rules_engine_completed",{result});
    await markProcessed(idMessage,"live");
    return {ok:true,idMessage,mode:"live",result};
  }, {
    connection: redis,
    concurrency: Number(process.env.WORKER_CONCURRENCY || 20)
  });

  liveWorker.on("completed", async job => {
    const idMessage=job?.data?.idMessage;
    if(idMessage) await traceWebhookEvent(idMessage,"worker.live.completed",{jobId:job.id,attemptsMade:job.attemptsMade});
  });

  liveWorker.on("failed", async (job, err) => {
    const idMessage = job?.data?.idMessage;
    if (!idMessage) return;
    const attemptsMade=Number(job?.attemptsMade||0);
    const maxAttempts=Number(job?.opts?.attempts||1);
    await markFailed(idMessage, err?.stack || err?.message || err);
    if(attemptsMade>=maxAttempts){
      await saveDeadLetter({idMessage,payload:job.data,error:err?.stack||err?.message||String(err),attempts:attemptsMade});
      await traceWebhookEvent(idMessage,"dead_letter.created",{attempts:attemptsMade,error:err?.message||String(err)});
    }else{
      await traceWebhookEvent(idMessage,"retry.scheduled",{attemptsMade,maxAttempts,error:err?.message||String(err)});
    }
  });
  liveWorker.on("error", err => console.error("Live worker error:", err));

  // Historical repair is intentionally single-threaded so deletion/reaction ordering is deterministic.
  const repairWorker=new Worker(REPAIR_QUEUE_NAME,async job=>{
    const idMessage=job.data?.idMessage;
    const runId=job.data?._abshirRepairRunId||null;
    const attempt=(job.attemptsMade||0)+1;
    await markProcessing(idMessage,attempt,"repair");
    await traceWebhookEvent(idMessage,"worker.repair.started",{attempt,runId,jobId:job.id});
    try{
      const payload={...job.data};delete payload._abshirRepairRunId;
      const result=await processGreenEvent(payload,{force:true,userId:null,repairMode:true});
      await traceWebhookEvent(idMessage,"repair.rules_engine_completed",{result,runId});
      await markProcessed(idMessage,"repair");
      let runState=null;
      if(runId)runState=await markWhatsappRepairResult(runId,resultCounters(result));
      if(runState && String(runState.status)==='COMPLETED' && String(runState.run_key||'').startsWith('full-week-rebuild:')){
        let meta={};try{meta=JSON.parse(await redis.get(FULL_WEEK_REBUILD_KEY)||'{}')}catch{}
        const userId=meta.userId||null;
        const floorRepair=await repairWeeklyFloors(userId).catch(e=>({error:e.message}));
        await Promise.all((meta.captainIds||[]).map(id=>syncCaptainBalanceState(id).catch(()=>null)));
        await setAccountingMode('live');
        await redis.set(FULL_WEEK_REBUILD_KEY,JSON.stringify({...meta,phase:'COMPLETED',completedAt:new Date().toISOString(),floorRepair,total:Number(runState.total_events||0),processed:Number(runState.processed_events||0),failed:Number(runState.failed_events||0)}));
        await traceWebhookEvent(`REBUILD-RUN-${runId}`,'full_week_rebuild.completed',{runId,total:runState.total_events,processed:runState.processed_events,failed:runState.failed_events});
      }
      return {ok:true,idMessage,mode:"repair",result,runId};
    }catch(err){
      if(runId && Number(job.attemptsMade||0)+1>=Number(job.opts?.attempts||1)){
        await markWhatsappRepairResult(runId,{failed:1,error:err?.message||String(err)});
      }
      throw err;
    }
  },{
    connection:redis,
    concurrency:Number(process.env.REPAIR_WORKER_CONCURRENCY||1)
  });

  repairWorker.on("completed",async job=>{
    const idMessage=job?.data?.idMessage;
    if(idMessage)await traceWebhookEvent(idMessage,"worker.repair.completed",{jobId:job.id,runId:job.data?._abshirRepairRunId||null});
  });
  repairWorker.on("failed",async(job,err)=>{
    const idMessage=job?.data?.idMessage;if(!idMessage)return;
    const attemptsMade=Number(job?.attemptsMade||0),maxAttempts=Number(job?.opts?.attempts||1);
    await markFailed(idMessage,err?.stack||err?.message||err);
    if(attemptsMade>=maxAttempts){
      await saveDeadLetter({idMessage,payload:job.data,error:err?.stack||err?.message||String(err),attempts:attemptsMade});
      await traceWebhookEvent(idMessage,"repair.dead_letter.created",{attempts:attemptsMade,error:err?.message||String(err)});
    }
  });
  repairWorker.on("error",err=>console.error("Repair worker error:",err));

  return {liveWorker,repairWorker};
}
