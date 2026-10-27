import { randomUUID } from "node:crypto";
import {
  db, getBalance, createMovement, reverseLedgerEntry, ensureWeeklyFloorCharge, audit,
  getSystemSetting, setSystemSetting, createRechargeCode,
  listRechargeRequests, getDailyInventoryComparison, getCleanStartState, getCleanSlateResetState
} from "./db.js";
import { firstWhatsappEventTimestamp, normalizeWhatsappEventTimestamp } from "./whatsapp-timestamp.js";
import { extractWahaDirectPhoneId, isWahaLid, normalizeWahaPhoneJid } from "./waha-identity.js";
import { runStorageCleanup } from "./storage.js";

const DEFAULT_GUIDE=`📌 *طريقة تنزيل الطلب في القروب*\n\n1️⃣ ضع السعر بوضوح.\n2️⃣ أي طلب مكتوب بدون كلمة أوردر يُحسب راكب؛ وإذا كُتبت أوردر يُحسب أوردر، وراكب + أوردر مدعوم.\n3️⃣ للاستلام: رد بأي كلمة ثم يضع صاحب الطلب 👍 على الرد.\n\n*أبشر فزعة الشمال الكبرى*`;
const COMM={PASSENGER:.75,ORDER:1};
const FLOOR=1,RESERVE=1.5;
function n(v){const x=Number(v);return Number.isFinite(x)?x:0}
function money(v){return Number(n(v).toFixed(3))}
function normPhone(v){let d=String(v||"").replace(/\D/g,"");if(d.startsWith("00962"))d=d.slice(2);if(d.startsWith("962"))d=d.slice(3);if(d.startsWith("0"))d=d.slice(1);return d}
function displayPhone(v){if(isWahaLid(v))return 'بانتظار تحويل رقم WAHA';const d=normPhone(v);return d.length===9?"0"+d:String(v||"")}
function normText(v){return String(v||"").trim().toLowerCase().replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي").replace(/[ًٌٍَُِّْـ]/g,"").replace(/\s+/g," ")}
function arDigits(v){return String(v||"").replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/٫/g,".").replace(/٬/g,",")}
function msgText(md={}){return String(md?.textMessageData?.textMessage||md?.extendedTextMessageData?.text||md?.editedMessageData?.textMessage||md?.editedMessageData?.text||md?.fileMessageData?.caption||md?.fileMessageData?.captionText||"").trim()}
function targetId(md={}){return String(md?.extendedTextMessageData?.stanzaId||md?.reactionMessageData?.stanzaId||md?.reactionMessageData?.quotedStanzaId||md?.reactionMessageData?.idMessageQuoted||md?.quotedMessage?.stanzaId||"").trim()}
export function lowBalanceReplyPolicy(md={},balance=0){return Boolean(targetId(md))&&n(balance)<1}
export function northReplyBalancePolicy(md={},balance=0,components=[]){
  const amount=money(balance);
  const commission=money(components.reduce((sum,c)=>sum+n(c.quantity)*(COMM[c.type]||0),0));
  // Preserve at least 1.00 JOD AFTER the consumption commission, not only before it.
  const required=money(commission+1);
  const blocked=Boolean(targetId(md))&&(amount<=1||amount<required);
  const shortfall=blocked?money(Math.max(0,required-amount)):0;
  return {blocked,balance:amount,commission,shortfall,required,
    reason:amount<=1?"low_balance_reply":"insufficient_reply_commission"};
}
export function northReplyBalanceWarning(captain,policy){
  const phone=normPhone(captain.phone);
  const mention=/^7[789][0-9]{7}$/.test(phone)?`@962${phone}`:(captain.name||displayPhone(captain.phone));
  return [
    `⚠️ *تنبيه شحن* — ${mention}`,
    `💰 الرصيد: *${Number(policy.balance).toFixed(2)} د.أ* | العمولة: *${Number(policy.commission).toFixed(2)} د.أ*`,
    `💳 المطلوب للشحن: *${Number(policy.shortfall).toFixed(2)} د.أ*`,
    "❌ تم رفض الرد دون احتساب عمولة. اشحن رصيدك ثم أعد الرد."
  ].join("\n");
}
async function northPolicyApi(payload,path,method,body){
  const w=await wahaSettingsRaw();
  const base=String(process.env.DROPCODE_API_URL||w.apiUrl||'').replace(/\/$/,'');
  const apiKey=String(process.env.DROPCODE_API_KEY||w.apiKey||'');
  const session=String(payload?._dropcode?.session||process.env.DROPCODE_SESSION||w.session||'');
  if(!base||!apiKey||!session)throw new Error('NORTH_POLICY_NOT_CONFIGURED: اضبط DROPCODE_API_URL وDROPCODE_API_KEY لجلسة شمال');
  const response=await fetch(`${base}${path}`,{method,headers:{'X-Api-Key':apiKey,'Content-Type':'application/json'},
    body:JSON.stringify({...body,session}),signal:AbortSignal.timeout(25000)});
  if(!response.ok)throw new Error(`DropConnect policy failed (${response.status})`);
  const result=await response.json();
  if(result?.ok===false)throw new Error('DropConnect policy rejected');
  return result;
}
async function deleteNorthPolicyReply(payload){
  const participant=String(payload?._dropcode?.sender?.jid||payload?.senderData?.sender||'');
  if(!participant)throw new Error('North reply participant missing');
  await northPolicyApi(payload,'/api/message','DELETE',{chatId:payload.senderData.chatId,
    messageId:payload.idMessage,fromMe:false,participant});
  return {deleted:true};
}
function isCommissionLike(value){return /^👍[🏻🏼🏽🏾🏿]?$/.test(String(value||"").replace(/\uFE0F/g,"").trim())}
function reactionEmoji(md={}){return String(md?.extendedTextMessageData?.text||md?.reactionMessageData?.text||md?.reactionMessageData?.emoji||"").replace(/\uFE0F/g,"").trim()}
function deletedId(md={}){return String(md?.deletedMessageData?.stanzaId||md?.deletedMessageData?.idMessage||md?.deletedMessageData?.messageId||"").trim()}
function publicBase(){return String(process.env.PUBLIC_BASE_URL||process.env.RAILWAY_PUBLIC_DOMAIN||"").replace(/\/$/,"").replace(/^([^h])/,'https://$1')}
async function getSetting(key,fallback){return await getSystemSetting(key,fallback)}
async function putSetting(key,value,userId){return await setSystemSetting(key,value,userId)}

const PARALLEL_COMPARISON_KEY='whatsapp_parallel_comparison_v1';
let parallelComparisonCache={value:null,at:0};
async function captureManualComparisonBaseline(){
  const client=await db.connect();let q,capturedAt;
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    capturedAt=(await client.query('SELECT statement_timestamp() captured_at')).rows[0].captured_at;
    q=await client.query(`
      WITH manual AS (
        SELECT le.captain_id,le.entry_type,le.metadata,
          CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$'
            THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END qty
        FROM ledger_entries le
        WHERE le.reversed_at IS NULL AND le.entry_type IN ('PRODUCTION','CONSUMPTION')
          AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
          AND COALESCE(le.reference_type,'') NOT IN ('green_reaction','green_partial')
      )
      SELECT c.id,c.name,c.phone,COUNT(*)::int movement_entries,
        COALESCE(SUM(qty) FILTER(WHERE m.entry_type='PRODUCTION' AND m.metadata->>'type'='PASSENGER'),0)::numeric(14,3) production_passengers,
        COALESCE(SUM(qty) FILTER(WHERE m.entry_type='PRODUCTION' AND m.metadata->>'type'='ORDER'),0)::numeric(14,3) production_orders,
        COALESCE(SUM(qty) FILTER(WHERE m.entry_type='CONSUMPTION' AND m.metadata->>'type'='PASSENGER'),0)::numeric(14,3) consumption_passengers,
        COALESCE(SUM(qty) FILTER(WHERE m.entry_type='CONSUMPTION' AND m.metadata->>'type'='ORDER'),0)::numeric(14,3) consumption_orders
      FROM manual m JOIN captains c ON c.id=m.captain_id
      GROUP BY c.id,c.name,c.phone
    `);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
  const keys=['production_passengers','production_orders','consumption_passengers','consumption_orders'];
  const captains={},totals={movement_entries:0};for(const key of keys)totals[key]=0;
  for(const row of q.rows){
    const item={name:String(row.name||''),phone:String(row.phone||''),movement_entries:Number(row.movement_entries||0)};
    totals.movement_entries+=item.movement_entries;
    for(const key of keys){item[key]=Number(row[key]||0);totals[key]+=item[key]}
    captains[String(row.id)]=item;
  }
  return {capturedAt:new Date(capturedAt||Date.now()).toISOString(),captains,totals};
}
export async function getParallelComparisonMode(){
  // ERJA3NA FULL AUTO:
  // WhatsApp is the authoritative live inventory source. Historical comparison data
  // may still exist for audit/reporting, but it must never financially isolate live
  // reactions or suppress balance enforcement.
  if(parallelComparisonCache.value&&Date.now()-parallelComparisonCache.at<2000)return parallelComparisonCache.value;
  let saved=await getSetting(PARALLEL_COMPARISON_KEY,null);
  const now=new Date().toISOString();
  if(!saved||typeof saved!=='object'){
    saved={enabled:false,startedAt:now,updatedAt:now,updatedBy:null,endedAt:now,defaultSafeMode:false,manualBaseline:null,fullAuto:true};
    await putSetting(PARALLEL_COMPARISON_KEY,saved,null);
  }else if(saved.enabled!==false||saved.defaultSafeMode!==false||saved.fullAuto!==true){
    saved={...saved,enabled:false,defaultSafeMode:false,fullAuto:true,endedAt:now,updatedAt:now};
    await putSetting(PARALLEL_COMPARISON_KEY,saved,null);
  }
  const value={enabled:false,startedAt:saved.startedAt||saved.updatedAt||now,updatedAt:saved.updatedAt||'',updatedBy:saved.updatedBy||null,endedAt:saved.endedAt||now,defaultSafeMode:false,baselineCapturedAt:saved.manualBaseline?.capturedAt||'',outboundWhatsappSuppressed:false,balanceEnforcementSuppressed:false,fullAuto:true};
  parallelComparisonCache={value,at:Date.now()};return value;
}
export async function setParallelComparisonMode(value,userId=null){
  // Full automatic inventory is locked ON for this branch. Keep the endpoint
  // compatible with older UI calls, but never allow a comparison switch to
  // isolate live financial movements.
  const now=new Date().toISOString();
  const old=await getSetting(PARALLEL_COMPARISON_KEY,{});
  const next={...old,enabled:false,defaultSafeMode:false,fullAuto:true,endedAt:now,updatedAt:now,updatedBy:userId||null};
  await putSetting(PARALLEL_COMPARISON_KEY,next,userId);
  await audit(userId,'whatsapp.parallel_comparison.mode','system','whatsapp',{enabled:false,fullAuto:true,forcedLive:true});
  parallelComparisonCache={value:null,at:0};
  return await getParallelComparisonMode();
}
export async function getParallelComparisonBaseline(){
  await getParallelComparisonMode();const saved=await getSetting(PARALLEL_COMPARISON_KEY,{});
  return saved?.manualBaseline&&typeof saved.manualBaseline==='object'?saved.manualBaseline:{capturedAt:'',captains:{},totals:{}};
}
async function parallelComparisonEnabled(){return Boolean((await getParallelComparisonMode()).enabled)}
async function comparisonSuppressedMutation(action,details={}){
  const comparison=await getParallelComparisonMode();
  return comparison.enabled?{ok:true,suppressed:true,comparisonMode:true,action,details}:null;
}

let cleanSlateCutoverCache={value:0,at:0};
async function cleanSlateCutoverMs(){
  if(Date.now()-cleanSlateCutoverCache.at<5000)return cleanSlateCutoverCache.value;
  const state=await getCleanSlateResetState();
  const value=state?.status==="COMPLETED"?new Date(state.cutoverAt||state.resetAt||"").getTime():0;
  cleanSlateCutoverCache={value:Number.isFinite(value)?value:0,at:Date.now()};
  return cleanSlateCutoverCache.value;
}

let whatsappProviderCache={value:'',at:0};
async function whatsappProvider(){
  const env=String(process.env.WHATSAPP_PROVIDER||'').trim().toLowerCase();
  if(env==='waha'||env==='green')return env;
  if(whatsappProviderCache.value&&Date.now()-whatsappProviderCache.at<5000)return whatsappProviderCache.value;
  const saved=String(await getSetting('whatsapp_provider','green')||'green').trim().toLowerCase();
  const value=saved==='waha'?'waha':'green';
  whatsappProviderCache={value,at:Date.now()};
  return value;
}
function normalizeWahaApiUrl(value){
  let url;
  try{url=new URL(String(value||''))}catch{throw new Error('رابط WAHA غير صالح')}
  const host=String(url.hostname||'').toLowerCase();
  const local=host==='localhost'||host==='127.0.0.1'||host.endsWith('.railway.internal');
  if(!['https:','http:'].includes(url.protocol)||(!local&&url.protocol!=='https:')||url.username||url.password){
    throw new Error('استخدم رابط WAHA HTTPS العام، أو رابط Railway الداخلي للخدمات الخاصة');
  }
  return `${url.protocol}//${url.host}`.replace(/\/$/,'');
}
async function ensureWahaSecret(userId=null){
  let s=String(await getSetting('waha_webhook_secret','')||'');
  if(!s){s=randomUUID().replace(/-/g,'')+randomUUID().replace(/-/g,'');await putSetting('waha_webhook_secret',s,userId)}
  return s;
}
async function wahaSettingsRaw(){
  const x=await getSetting('waha_api',{});
  const envUrl=String(process.env.WAHA_API_URL||'').trim();
  const envKey=String(process.env.WAHA_API_KEY||'').trim();
  const envSession=String(process.env.WAHA_SESSION||'').trim();
  return {
    ...x,
    apiUrl:envUrl||x.apiUrl||'',
    apiKey:envKey||x.apiKey||'',
    session:envSession||x.session||'abshir',
    // V68: WAHA accounting is permanently enabled and clear movements are
    // automatically approved. UI switches cannot accidentally stop LIVE.
    enabled:true,
    autoApprove:true
  };
}
async function wahaRaw(path,httpMethod='GET',body=null,{allow404=false,timeoutMs=null}={}){
  const w=await wahaSettingsRaw();
  if(!w.apiUrl)throw new Error('أدخل رابط WAHA أولًا');
  if(!w.apiKey)throw new Error('أدخل WAHA API Key أولًا');
  const base=normalizeWahaApiUrl(w.apiUrl);
  const url=`${base}${String(path||'').startsWith('/')?'':'/'}${String(path||'')}`;
  const customTimeout=Number(timeoutMs);
  const signal=Number.isFinite(customTimeout)&&customTimeout>0
    ? AbortSignal.timeout(Math.min(180000,Math.max(1000,customTimeout)))
    : timeoutSignal('WAHA_API_TIMEOUT_MS',25000,120000);
  const opt={method:httpMethod,headers:{'X-Api-Key':String(w.apiKey),'accept':'application/json'},signal};
  if(body!==null){opt.headers['content-type']='application/json';opt.body=JSON.stringify(body)}
  const res=await fetch(url,opt);const text=await res.text();
  if(allow404&&res.status===404)return null;
  if(!res.ok)throw new Error(`WAHA رفض الطلب (${res.status}): ${text.slice(0,300)}`);
  if(!text)return {};
  try{return JSON.parse(text)}catch{return {raw:text}}
}
const WAHA_LID_CACHE_OK_MS=6*60*60*1000;
const WAHA_LID_CACHE_MISS_MS=1500;
const WAHA_LID_REFRESH_COOLDOWN_MS=Math.min(30*60*1000,Math.max(60*1000,Number(process.env.WAHA_LID_REFRESH_COOLDOWN_MS)||5*60*1000));
const wahaLidCache=new Map(),wahaLidPending=new Map();
let wahaLidRefreshPending=null,wahaLidLastRefreshAt=0;
function wahaLidRows(payload){
  if(Array.isArray(payload))return payload;
  for(const value of [payload?.data,payload?.items,payload?.results,payload?.lids,payload?.participants])if(Array.isArray(value))return value;
  return [];
}
function cacheWahaLidRows(payload){
  let mapped=0;
  for(const row of wahaLidRows(payload)){
    const lid=wahaIdString(row?.lid||row?.id||row?.participant||row?.jid).trim();
    const pn=normalizeWahaPhoneJid(row?.pn||row?.phoneNumber||row?.phone||row?.participantAlt||row?.id?.pn,{allowBare:true});
    if(isWahaLid(lid)&&pn){wahaLidCache.set(lid,{value:pn,resolved:true,expiresAt:Date.now()+WAHA_LID_CACHE_OK_MS});mapped++}
  }
  return mapped;
}
function clearWahaLidMisses(){for(const [key,value] of wahaLidCache)if(!value?.resolved)wahaLidCache.delete(key)}
async function refreshWahaLidDirectory({groupId='',force=false}={}){
  if(wahaLidRefreshPending)return await wahaLidRefreshPending;
  if(!force&&Date.now()-wahaLidLastRefreshAt<WAHA_LID_REFRESH_COOLDOWN_MS)return {ok:true,skipped:true,reason:'cooldown',mapped:0};
  wahaLidRefreshPending=(async()=>{
    const w=await wahaSettingsRaw();let successful=0,mapped=0;const errors=[];
    clearWahaLidMisses();
    try{const groups=await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/refresh`,'POST');successful++;mapped+=cacheWahaLidRows(groups)}catch(error){errors.push(String(error?.message||error))}
    if(groupId){
      try{const participants=await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(groupId)}/participants/v2`);successful++;mapped+=cacheWahaLidRows(participants)}catch(error){errors.push(String(error?.message||error))}
    }
    try{const lids=await wahaRaw(`/api/${encodeURIComponent(w.session)}/lids?limit=1000&offset=0`);successful++;mapped+=cacheWahaLidRows(lids)}catch(error){errors.push(String(error?.message||error))}
    if(!successful)throw new Error(`تعذر تحديث دليل أرقام WAHA: ${errors[0]||'فشل الاتصال'}`);
    wahaLidLastRefreshAt=Date.now();return {ok:true,mapped,errors};
  })();
  try{return await wahaLidRefreshPending}finally{wahaLidRefreshPending=null}
}
async function wahaDirectLidLookup(id){
  const w=await wahaSettingsRaw();
  const r=await wahaRaw(`/api/${encodeURIComponent(w.session)}/lids/${encodeURIComponent(id)}`,'GET',null,{allow404:true});
  return normalizeWahaPhoneJid(r?.pn||r?.phoneNumber||r?.phone,{allowBare:true});
}
async function wahaContactPhoneLookup(id){
  const w=await wahaSettingsRaw();
  const r=await wahaRaw(`/api/contacts?contactId=${encodeURIComponent(id)}&session=${encodeURIComponent(w.session)}`,'GET',null,{allow404:true});
  return normalizeWahaPhoneJid(r?.pn||r?.phoneNumber||r?.phone||r?.number||r?.id,{allowBare:true});
}
async function wahaResolveChatId(id,{groupId='',refreshOnMiss=false,force=false}={}){
  id=String(id||'').trim();
  if(!id)return '';
  const phone=normalizeWahaPhoneJid(id);if(phone)return phone;
  if(!isWahaLid(id))return id;
  const cached=wahaLidCache.get(id);
  if(!force&&cached&&cached.expiresAt>Date.now()&&(cached.resolved||!refreshOnMiss))return cached.value||id;
  if(wahaLidPending.has(id))return await wahaLidPending.get(id);
  const pending=(async()=>{try{
    let pn=await wahaDirectLidLookup(id);
    if(!pn&&refreshOnMiss){
      await refreshWahaLidDirectory({groupId,force:false});
      pn=normalizeWahaPhoneJid(wahaLidCache.get(id)?.value)||await wahaDirectLidLookup(id);
      if(!pn)pn=await wahaContactPhoneLookup(id).catch(()=>"");
    }
    const value=pn||id;
    wahaLidCache.set(id,{value,resolved:Boolean(pn),expiresAt:Date.now()+(pn?WAHA_LID_CACHE_OK_MS:WAHA_LID_CACHE_MISS_MS)});return value;
  }catch{
    wahaLidCache.set(id,{value:id,resolved:false,expiresAt:Date.now()+WAHA_LID_CACHE_MISS_MS});return id;
  }
  finally{wahaLidPending.delete(id)}})();
  wahaLidPending.set(id,pending);return await pending;
}
async function wahaPublicSettings(){
  const w=await wahaSettingsRaw();await ensureWahaSecret();const base=publicBase();
  const status=String(w.status||'NOT_CHECKED').toUpperCase();
  return {
    provider:'waha',apiUrl:w.apiUrl||'',idInstance:w.session||'abshir',session:w.session||'abshir',
    groupId:w.groupId||'',groupName:w.groupName||'',enabled:Boolean(w.enabled),voiceEnabled:w.voiceEnabled!==false,
    autoApprove:Boolean(w.autoApprove),hasToken:Boolean(w.apiKey),hasOpenAiKey:Boolean(w.openAiKey),connected:status==='WORKING',
    status,lastHealthCheckAt:w.lastHealthCheckAt||'',webhookUrl:base?`${base}/webhook/waha`:'',webhookAuthEnabled:true,webhookConfigured:Boolean(w.webhookConfigured),
    performance:w.performance||{},sessionState:status,statusInstance:'',lastStateChangeAt:w.lastStateChangeAt||'',lastAuthorizedAt:w.lastWorkingAt||'',lastSessionEventAt:w.lastSessionEventAt||'',
    sessionGuard:{enabled:true,deletePriority:true,provider:'WAHA',webhookRetries:true,deleteMinIntervalMs:WAHA_DELETE_INTERVAL_MS,otherMutationMinIntervalMs:WAHA_OTHER_INTERVAL_MS,stableWindowSeconds:Math.round(WAHA_SESSION_STABLE_MS/1000)}
  };
}
async function saveWahaSettings(payload,userId){
  const old=await getSetting('waha_api',{});payload=payload||{};
  const apiUrl=normalizeWahaApiUrl(payload.apiUrl||old.apiUrl||process.env.WAHA_API_URL||'');
  const session=String(payload.session||payload.idInstance||old.session||process.env.WAHA_SESSION||'abshir').trim();
  if(!/^[A-Za-z0-9_.-]{1,80}$/.test(session))throw new Error('اسم جلسة WAHA غير صالح');
  let gid=String(payload.groupId||'').trim();
  let groupName=String(payload.groupName||'').slice(0,200);
  if(gid&&!/@g\.us$/i.test(gid))throw new Error('معرّف القروب يجب أن ينتهي بـ @g.us');
  let next={...old,apiUrl,session,groupId:gid,groupName,enabled:true,voiceEnabled:payload.voiceEnabled!==false,autoApprove:true,alwaysOn:true};
  if(String(payload.apiToken||payload.apiKey||'').trim())next.apiKey=String(payload.apiToken||payload.apiKey).trim();
  if(String(payload.openAiKey||'').trim())next.openAiKey=String(payload.openAiKey).trim();
  await putSetting('waha_api',next,userId);await putSetting('whatsapp_provider','waha',userId);whatsappProviderCache={value:'waha',at:Date.now()};await ensureWahaSecret(userId);

  // V62: if the linked WAHA number currently sees exactly one WhatsApp group,
  // select it automatically. This prevents a healthy WAHA session from looking
  // connected while accounting never starts because groupId stayed empty.
  if(!gid){
    try{
      const groups=await listWahaGroups();
      if(groups.length===1){
        gid=String(groups[0].id||'');groupName=String(groups[0].name||'').slice(0,200);
        next={...next,groupId:gid,groupName};
        await putSetting('waha_api',next,userId);
      }
    }catch{}
  }

  await audit(userId,'waha.settings.save','system','whatsapp',{apiUrl,session,groupId:gid,enabled:next.enabled,voiceEnabled:next.voiceEnabled,autoApprove:next.autoApprove});

  // When the user has enabled WhatsApp accounting and a group is known, make the
  // session webhook self-healing. If it is already correct activateWahaWebhook
  // is a no-op; otherwise WAHA may restart once and return to WORKING.
  let webhookAuto=null;
  if(next.enabled&&gid){
    try{webhookAuto=await activateWahaWebhook(userId)}catch(error){webhookAuto={ok:false,error:String(error?.message||error)}}
  }
  return {...await wahaPublicSettings(),webhookAuto};
}
async function testWaha(){
  const w=await wahaSettingsRaw();const r=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
  const st=String(r?.status||'UNKNOWN').toUpperCase();if(st!=='WORKING')throw new Error(`حالة جلسة WAHA: ${st}. افتح لوحة WAHA واربط الرقم أولًا`);
  const now=new Date().toISOString();await putSetting('waha_api',{...w,connected:true,status:st,lastWorkingAt:w.lastWorkingAt||now,lastHealthCheckAt:now});return {state:st,provider:'waha'};
}
function wahaIdString(value){
  if(value==null)return '';
  if(typeof value==='string')return value;
  if(typeof value==='object')return String(value.pn||value.phoneNumber||value._serialized||value.serialized||value.id||value.chatId||value.jid||'');
  return String(value||'');
}
// V63: GREEN usually stores the raw WhatsApp message id while WAHA/WEBJS can
// expose a serialized id: false_<chatId>_<messageId>[_<participant>]. Treat both
// representations as the same logical WhatsApp message across providers.
function canonicalWhatsappMessageId(value){
  const id=wahaIdString(value).trim();
  if(!id)return '';
  const m=id.match(/^(?:true|false)_[^_]+_([^_]+)(?:_.*)?$/i);
  return m?String(m[1]||'').trim():id;
}
function sameWhatsappMessageId(a,b){
  const aa=canonicalWhatsappMessageId(a),bb=canonicalWhatsappMessageId(b);
  return Boolean(aa&&bb&&aa===bb);
}
function wahaGroupFromMessageId(value){
  const id=wahaIdString(value);
  const m=id.match(/^(?:true|false)_([^_]+@g\.us)_/i);
  return m?String(m[1]):'';
}
async function resolveWahaStoredMessageId(chatId,value){
  const target=wahaIdString(value).trim();
  if(!target)return '';
  const canonical=canonicalWhatsappMessageId(target);
  try{
    // Prefer the old/raw GREEN id when it already exists. That makes a WAHA replay
    // hit the same whatsapp_events row instead of creating a second provider-shaped id.
    const q=await db.query(`
      SELECT id_message FROM whatsapp_events
       WHERE ($1='' OR chat_id=$1)
         AND (
           id_message=$2 OR id_message=$3 OR
           POSITION($3 IN id_message)>0
         )
       ORDER BY CASE WHEN id_message=$3 THEN 0 WHEN id_message=$2 THEN 1 ELSE 2 END,id DESC
       LIMIT 1`,[String(chatId||''),target,canonical]);
    if(q.rowCount)return String(q.rows[0].id_message||target);
  }catch{}
  return target;
}
async function storedWhatsappEventChatId(value){
  const exact=wahaIdString(value).trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return '';
  try{
    const q=await db.query(`SELECT chat_id FROM whatsapp_events WHERE id_message=$1 OR id_message=$2 OR ($2<>'' AND POSITION($2 IN id_message)>0) ORDER BY id DESC LIMIT 1`,[exact,canonical]);
    return String(q.rows[0]?.chat_id||'');
  }catch{return ''}
}
function wahaGroupRows(payload){
  if(Array.isArray(payload))return payload;
  if(Array.isArray(payload?.groups))return payload.groups;
  if(Array.isArray(payload?.data))return payload.data;
  const candidates=[payload?.groups,payload?.data,payload];
  for(const obj of candidates){
    if(!obj||Array.isArray(obj)||typeof obj!=='object')continue;
    const rows=[];
    for(const [key,val] of Object.entries(obj)){
      if(val&&typeof val==='object')rows.push({...val,__mapKey:key});
      else if(/@g\.us$/i.test(String(key||'')))rows.push({id:key,subject:String(val||key)});
    }
    if(rows.length)return rows;
  }
  return [];
}
function normalizeWahaGroups(payload){
  const seen=new Set(),out=[];
  for(const x of wahaGroupRows(payload)){
    const id=wahaIdString(x?.id||x?.group?.id||x?.chatId||x?.jid||x?.__mapKey);
    if(!/@g\.us$/i.test(id)||seen.has(id))continue;
    seen.add(id);
    const subject=String(x?.subject||x?.name||x?.title||x?.group?.subject||x?.group?.name||id||'قروب بدون اسم').trim();
    out.push({id,name:subject||id});
  }
  return out;
}
async function listWahaGroups(){
  const w=await wahaSettingsRaw();
  const path=`/api/${encodeURIComponent(w.session)}/groups?limit=200&offset=0&exclude=participants&sortBy=subject&sortOrder=asc`;
  let r=await wahaRaw(path);
  let groups=normalizeWahaGroups(r);
  if(groups.length)return groups;

  // Some WAHA engines can report a non-zero group count while the first cached
  // groups response is empty/incomplete immediately after pairing. Refresh only
  // on explicit "جلب القروبات" and only when count proves groups exist.
  let count=0;
  try{
    const c=await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/count`);
    count=Number(c?.count??c?.total??0)||0;
  }catch{}
  if(count>0){
    try{await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/refresh`,'POST',{});}catch{}
    await new Promise(resolve=>setTimeout(resolve,900));
    r=await wahaRaw(path);
    groups=normalizeWahaGroups(r);
  }
  if(!groups.length&&count>0)throw new Error(`WAHA يرى ${count} قروب لكن تفاصيل القروبات لم تصل بعد. انتظر 10 ثوانٍ واضغط جلب القروبات مرة ثانية.`);
  return groups;
}

export async function wahaBridgeGroups(){
  const provider=await whatsappProvider();
  if(provider!=='waha')throw new Error('WAHA ليست المزود النشط حاليًا');
  const w=await wahaSettingsRaw();
  const sessionInfo=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
  const status=String(sessionInfo?.status||'UNKNOWN').toUpperCase();
  if(status!=='WORKING')throw new Error(`جلسة WAHA ليست WORKING (الحالة: ${status})`);
  const groups=await listWahaGroups();
  return {
    ok:true,
    provider:'WAHA',
    session:w.session,
    status,
    rows:groups.map(g=>({jid:g.id,name:g.name}))
  };
}

export async function wahaBridgeScanGroup(groupId){
  const provider=await whatsappProvider();
  if(provider!=='waha')throw new Error('WAHA ليست المزود النشط حاليًا');
  const gid=String(groupId||'').trim();
  if(!/@g\.us$/i.test(gid))throw new Error('معرّف القروب غير صحيح');

  const w=await wahaSettingsRaw();
  const sessionInfo=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
  const status=String(sessionInfo?.status||'UNKNOWN').toUpperCase();
  if(status!=='WORKING')throw new Error(`جلسة WAHA ليست WORKING (الحالة: ${status})`);

  const groups=await listWahaGroups();
  const known=groups.find(g=>String(g.id)===gid)||{id:gid,name:gid};

  let raw=await wahaRaw(
    `/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(gid)}/participants/v2`
  );
  let rows=Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.participants)
      ? raw.participants
      : Array.isArray(raw?.data)
        ? raw.data
        : [];

  // Refresh once if WAHA returned a stale/empty participant cache.
  if(!rows.length){
    try{
      await refreshWahaLidDirectory({groupId:gid,force:true});
      raw=await wahaRaw(
        `/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(gid)}/participants/v2`
      );
      rows=Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.participants)
          ? raw.participants
          : Array.isArray(raw?.data)
            ? raw.data
            : [];
    }catch{}
  }

  const out=[];
  const seen=new Set();
  for(const row of rows){
    const rawId=wahaIdString(
      row?.id||row?.participant||row?.jid||row?.contactId||row?._serialized
    ).trim();
    let phoneJid=normalizeWahaPhoneJid(
      row?.pn||row?.phoneNumber||row?.phone||row?.participantPn||row?.participantPhone,
      {allowBare:true}
    );
    if(!phoneJid&&rawId){
      const resolved=await wahaResolveChatId(rawId,{groupId:gid,refreshOnMiss:true});
      phoneJid=normalizeWahaPhoneJid(resolved,{allowBare:true});
    }
    const phone=String(phoneJid||'').replace(/@(?:c\.us|s\.whatsapp\.net)$/i,'').replace(/\D/g,'');
    if(!phone||seen.has(phone))continue;
    seen.add(phone);
    out.push({
      jid:phoneJid||rawId,
      phone,
      admin:row?.admin||row?.role||(row?.isSuperAdmin?'superadmin':row?.isAdmin?'admin':null)
    });
  }

  return {
    ok:true,
    provider:'WAHA',
    session:w.session,
    status,
    group:{jid:known.id,name:known.name,size:out.length},
    participants:out
  };
}

export async function wahaBridgeStatus(){
  const provider=await whatsappProvider();
  if(provider!=='waha')return {ok:false,provider:String(provider||'unknown').toUpperCase(),connected:false,status:'PROVIDER_DISABLED'};
  const w=await wahaSettingsRaw();
  try{
    const sessionInfo=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
    const status=String(sessionInfo?.status||'UNKNOWN').toUpperCase();
    return {ok:true,provider:'WAHA',session:w.session,connected:status==='WORKING',status};
  }catch(error){
    return {ok:false,provider:'WAHA',session:w.session,connected:false,status:'ERROR',error:String(error?.message||error)};
  }
}

function wahaHookMatches(sessionInfo,url,secret){
  const hooks=Array.isArray(sessionInfo?.config?.webhooks)?sessionInfo.config.webhooks:[];
  const need=['message','message.any','message.reaction','message.edited','message.revoked','session.status'];
  return hooks.some(h=>String(h?.url||'').replace(/\/$/,'')===String(url||'').replace(/\/$/,'')&&need.every(e=>(h.events||[]).includes(e))&&Array.isArray(h.customHeaders)&&h.customHeaders.some(x=>String(x?.name||'').toLowerCase()==='x-abshir-waha-secret'&&String(x?.value||'')===String(secret)));
}
async function wahaHealth(){
  const w=await wahaSettingsRaw();const sessionInfo=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);const pub=await wahaPublicSettings();
  const status=String(sessionInfo?.status||'UNKNOWN').toUpperCase();const secret=await ensureWahaSecret();const hookOk=wahaHookMatches(sessionInfo,pub.webhookUrl,secret);const now=new Date().toISOString();
  await putSetting('waha_api',{...w,connected:status==='WORKING',status,lastHealthCheckAt:now,webhookConfigured:hookOk,lastWorkingAt:status==='WORKING'?(w.lastWorkingAt||now):w.lastWorkingAt||''});
  return {ok:status==='WORKING'&&hookOk,remote:{status,engine:sessionInfo?.engine?.engine||sessionInfo?.engine||'',webhookConfigured:hookOk},settings:await wahaPublicSettings()};
}
async function activateWahaWebhook(userId){
  const pub=await wahaPublicSettings();if(!pub.webhookUrl)throw new Error('تعذر تحديد رابط Railway العام');if(!pub.groupId)throw new Error('اختر قروب واتساب أولًا');
  const w=await wahaSettingsRaw();const secret=await ensureWahaSecret(userId);const sessionPath=`/api/sessions/${encodeURIComponent(w.session)}`;const current=await wahaRaw(sessionPath);
  if(wahaHookMatches(current,pub.webhookUrl,secret)){
    const now=new Date().toISOString();await putSetting('waha_api',{...w,enabled:true,status:String(current.status||'').toUpperCase(),connected:String(current.status||'').toUpperCase()==='WORKING',webhookConfigured:true,lastHealthCheckAt:now},userId);
    return {skipped:true,alreadyConfigured:true,message:'Webhook WAHA مضبوط مسبقًا — لم يتم Restart للجلسة',settings:await wahaPublicSettings()};
  }
  const hook={url:pub.webhookUrl,events:['message','message.any','message.reaction','message.edited','message.revoked','session.status'],retries:{policy:'exponential',delaySeconds:2,attempts:20},customHeaders:[{name:'X-Abshir-Waha-Secret',value:secret}]};
  // Preserve the manual system's webhook on this same WAHA number. Replace only
  // Abshir's own hook so both systems can receive the same group safely.
  const currentHooks=Array.isArray(current?.config?.webhooks)?current.config.webhooks:[];
  const normalizedUrl=String(pub.webhookUrl||'').replace(/\/$/,'');
  const isAbshirHook=h=>String(h?.url||'').replace(/\/$/,'')===normalizedUrl||(Array.isArray(h?.customHeaders)&&h.customHeaders.some(x=>String(x?.name||'').toLowerCase()==='x-abshir-waha-secret'));
  const preservedHooks=currentHooks.filter(h=>!isAbshirHook(h));
  const config={...(current?.config||{}),webhooks:[...preservedHooks,hook],ignore:{...(current?.config?.ignore||{}),status:true,groups:false,channels:true,broadcast:true}};
  await wahaRaw(sessionPath,'PUT',{name:w.session,config});
  const now=new Date().toISOString();await putSetting('waha_api',{...w,enabled:true,webhookConfigured:true,lastWebhookConfiguredAt:now,status:'STARTING',connected:false},userId);
  await audit(userId,'waha.webhook.activate','system','whatsapp',{webhookUrl:pub.webhookUrl,session:w.session,events:hook.events,retries:hook.retries,preservedWebhookCount:preservedHooks.length});
  return {setSettingsApplied:true,restarted:true,preservedWebhookCount:preservedHooks.length,message:`تم ربط Webhook أبشر مع الحفاظ على ${preservedHooks.length} Webhook موجود. الجلسة قد تعمل Restart مرة واحدة ثم ترجع WORKING تلقائيًا.`,settings:await wahaPublicSettings()};
}
const WAHA_DELETE_INTERVAL_MS=Math.min(5000,Math.max(500,Number(process.env.WAHA_DELETE_MIN_INTERVAL_MS)||900));
const WAHA_OTHER_INTERVAL_MS=Math.min(15000,Math.max(1000,Number(process.env.WAHA_OTHER_MUTATION_MIN_INTERVAL_MS)||2200));
const WAHA_SESSION_STABLE_MS=Math.min(5*60*1000,Math.max(3000,Number(process.env.WAHA_SESSION_STABLE_MS)||15000));
let wahaMutationQueue=[],wahaMutationRunning=false,wahaMutationSeq=0,wahaLastMutationAt=0;
function wahaMutationPriority(kind){return kind==='delete'?0:10}
function wahaMutationInterval(kind){return kind==='delete'?WAHA_DELETE_INTERVAL_MS:WAHA_OTHER_INTERVAL_MS}
async function assertWahaMutationReady(kind){
  let w=await wahaSettingsRaw();
  // Delete remains mandatory/high-priority. Let WAHA return the real API error when
  // status is stale/unknown instead of silently skipping a policy deletion.
  if(kind==='delete')return;
  let status=String(w.status||'').toUpperCase();
  if(status!=='WORKING'){
    try{
      const remote=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
      status=String(remote?.status||status||'UNKNOWN').toUpperCase();
      const now=new Date().toISOString();
      if(status==='WORKING'){
        const existingSince=Date.parse(w.lastWorkingAt||'')||0;
        w={...w,status,connected:true,lastWorkingAt:existingSince?w.lastWorkingAt:now,lastHealthCheckAt:now};
        await putSetting('waha_api',w,null);
      }
    }catch{}
  }
  if(status!=='WORKING')throw new Error(`جلسة WAHA غير جاهزة للعمل (${status||'UNKNOWN'})`);
  const since=Date.parse(w.lastWorkingAt||'')||0;
  if(since&&Date.now()-since<WAHA_SESSION_STABLE_MS){
    const wait=WAHA_SESSION_STABLE_MS-(Date.now()-since);
    if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
  }
}
async function drainWahaMutationQueue(){
  if(wahaMutationRunning)return;
  wahaMutationRunning=true;
  try{
    while(wahaMutationQueue.length){
      wahaMutationQueue.sort((a,b)=>a.priority-b.priority||a.seq-b.seq);
      const item=wahaMutationQueue.shift();
      const remaining=Math.max(0,wahaMutationInterval(item.kind)-(Date.now()-wahaLastMutationAt));
      if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));
      try{await assertWahaMutationReady(item.kind);item.resolve(await item.task())}catch(error){item.reject(error)}finally{wahaLastMutationAt=Date.now()}
    }
  }finally{wahaMutationRunning=false;if(wahaMutationQueue.length)queueMicrotask(()=>drainWahaMutationQueue())}
}
function withWahaMutationSlot(kind,task){
  return new Promise((resolve,reject)=>{wahaMutationQueue.push({kind,task,resolve,reject,priority:wahaMutationPriority(kind),seq:++wahaMutationSeq});void drainWahaMutationQueue()});
}
async function wahaSend(chatId,message){return await withWahaMutationSlot('send',async()=>{const w=await wahaSettingsRaw();return await wahaRaw('/api/sendText','POST',{session:w.session,chatId:String(chatId),text:String(message||'')})})}
async function wahaGroupPosting(groupId,allowed){return await withWahaMutationSlot('group',async()=>{const w=await wahaSettingsRaw();return await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(groupId)}/settings/security/messages-admin-only`,'PUT',{adminsOnly:!Boolean(allowed)})})}
async function wahaRemoveGroupParticipant(groupId,phone){return await withWahaMutationSlot('group',async()=>{const w=await wahaSettingsRaw();const id=`962${normPhone(phone)}@c.us`;return await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(groupId)}/participants/remove`,'POST',{participants:[{id}]})})}
async function wahaAddGroupParticipant(groupId,phone){return await withWahaMutationSlot('group',async()=>{const w=await wahaSettingsRaw();const id=`962${normPhone(phone)}@c.us`;return await wahaRaw(`/api/${encodeURIComponent(w.session)}/groups/${encodeURIComponent(groupId)}/participants/add`,'POST',{participants:[{id}]})})}
async function wahaDelete(groupId,idMessage){return await withWahaMutationSlot('delete',async()=>{const w=await wahaSettingsRaw();return await wahaRaw(`/api/${encodeURIComponent(w.session)}/chats/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(idMessage)}`,'DELETE')})}
async function recentWhatsappEventIdMap(chatId,limit=30000){
  const map=new Map();
  if(!chatId)return map;
  try{
    const q=await db.query(`SELECT id_message FROM whatsapp_events WHERE chat_id=$1 ORDER BY id DESC LIMIT $2`,[String(chatId),Math.max(1000,Math.min(50000,Number(limit)||30000))]);
    for(const row of q.rows){
      const id=String(row.id_message||'');const canonical=canonicalWhatsappMessageId(id);if(!canonical)continue;
      const previous=map.get(canonical);
      // Prefer a raw/bare id (the common GREEN representation) over a serialized WAHA id.
      if(!previous||id===canonical)map.set(canonical,id);
    }
  }catch{}
  return map;
}
function firstArray(...values){for(const v of values)if(Array.isArray(v))return v;return []}
function wahaHistoryReactionRows(item){
  return firstArray(item?.reactions,item?._data?.reactions,item?._data?.message?.reactions,item?._data?.msg?.reactions,item?._data?.reactionList);
}
function wahaHistoryReactionText(row){
  const v=row?.text??row?.emoji??row?.reaction??row?.value??row?.reactionText??'';
  return String(v||'').replace(/\uFE0F/g,'').trim();
}
function wahaHistoryReactionSender(row){
  const candidates=[row?.senderId,row?.sender,row?.participant,row?.author,row?.user,row?.from,row?.key?.participant,row?.key?.participantAlt,row?.key?.remoteJid,row?.key?.remoteJidAlt];
  return candidates.map(wahaIdString).find(x=>x&&!/@g\.us$/i.test(x))||'';
}
function wahaHistoryReactionTimestamp(row,item){
  const raw=Number(row?.timestamp||row?.t||row?.senderTimestampMs||row?.senderTimestamp||row?.key?.timestamp||0);
  if(raw>0)return normalizeWhatsappEventTimestamp(raw)||0;
  return normalizeWhatsappEventTimestamp(item?.timestamp||item?.t)||0;
}
function isWahaBrowserTargetClosedError(error){
  const msg=String(error?.message||error||'');
  return /Target closed|TargetCloseError|Protocol error\s*\(Runtime\.callFunctionOn\)|Execution context was destroyed|browser has disconnected|Session closed|Most likely the page has been closed/i.test(msg);
}
async function waitForWahaWorking(session,{timeoutMs=90000,onProgress=null}={}){
  const started=Date.now();
  const report=async data=>{if(typeof onProgress==='function')try{await onProgress(data||{})}catch{}};
  let last='UNKNOWN';
  while(Date.now()-started<Math.max(10000,Number(timeoutMs)||90000)){
    try{
      const info=await wahaRaw(`/api/sessions/${encodeURIComponent(session)}`,'GET',null,{timeoutMs:15000});
      last=String(info?.status||'UNKNOWN').toUpperCase();
      if(last==='WORKING')return info;
      if(last==='SCAN_QR_CODE')throw new Error('جلسة WAHA تطلب QR جديد — لا يمكن إكمال الاسترجاع قبل إعادة الربط');
      if(last==='FAILED')throw new Error('جلسة WAHA دخلت FAILED أثناء الاسترجاع');
    }catch(error){
      if(/QR جديد|دخلت FAILED/.test(String(error?.message||error)))throw error;
    }
    await report({historySessionStatus:last,historyWaitingSession:true,message:`WAHA يعيد تجهيز الجلسة (${last}) — سأكمل تلقائيًا من آخر دفعة`});
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  throw new Error(`جلسة WAHA لم ترجع WORKING خلال مهلة الاسترجاع (آخر حالة: ${last})`);
}
async function probeWahaHistoryEngine(w,{timeoutMs=20000}={}){
  const params=new URLSearchParams({limit:'1',offset:'0',downloadMedia:'false'});
  try{
    await wahaRaw(`/api/${encodeURIComponent(w.session)}/chats/${encodeURIComponent(w.groupId)}/messages?${params.toString()}`,'GET',null,{timeoutMs});
    return {ok:true,mode:'chat'};
  }catch(firstError){
    // V67: /api/messages is an official WAHA history endpoint and can survive cases
    // where the WEBJS chat wrapper has lost its Puppeteer execution context.
    try{
      params.set('chatId',String(w.groupId));
      params.set('session',String(w.session));
      await wahaRaw(`/api/messages?${params.toString()}`,'GET',null,{timeoutMs});
      return {ok:true,mode:'messages'};
    }catch(secondError){
      return {ok:false,error:secondError||firstError};
    }
  }
}
async function recoverWahaBrowserForHistory(w,{onProgress=null,recoveryNumber=1}={}){
  const report=async data=>{if(typeof onProgress==='function')try{await onProgress(data||{})}catch{}};
  let info=null;
  try{info=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`,'GET',null,{timeoutMs:15000})}catch{}
  const before=String(info?.status||'UNKNOWN').toUpperCase();
  await report({historyBrowserRecovery:true,historySessionStatus:before,historyRecoveryAttempts:recoveryNumber,message:`استعادة محرك WAHA — المحاولة ${recoveryNumber}: إعادة تشغيل الجلسة بأمان بدون Logout`});
  try{await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}/restart`,'POST',{}, {timeoutMs:30000})}catch(error){
    const msg=String(error?.message||error);
    if(/SCAN_QR_CODE|not authorized|unauthori[sz]ed/i.test(msg))throw error;
  }
  await waitForWahaWorking(w.session,{timeoutMs:120000,onProgress});
  // WORKING only means the session state is up. Probe the actual history execution
  // context before declaring recovery successful, otherwise WEBJS can say WORKING
  // while Puppeteer still returns Target closed.
  for(let probeAttempt=1;probeAttempt<=3;probeAttempt++){
    const probe=await probeWahaHistoryEngine(w,{timeoutMs:20000});
    if(probe.ok){
      await report({historyBrowserRecovery:true,historyRecoveryAttempts:recoveryNumber,historyProbeMode:probe.mode,message:`WAHA رجعت WORKING وتم اختبار قراءة السجل بنجاح — المحاولة ${recoveryNumber}`});
      return probe;
    }
    const msg=String(probe.error?.message||probe.error||'');
    if(/SCAN_QR_CODE|not authorized|unauthori[sz]ed/i.test(msg))throw probe.error;
    await report({historyBrowserRecovery:true,historyRecoveryAttempts:recoveryNumber,historyProbeAttempt:probeAttempt,message:`WAHA WORKING لكن صفحة السجل لم تثبت بعد — اختبار ${probeAttempt}/3`});
    await new Promise(resolve=>setTimeout(resolve,2500));
  }
  throw new Error(`WAHA رجعت WORKING لكن محرك قراءة السجل بقي غير جاهز بعد محاولة الاستعادة ${recoveryNumber}`);
}
async function requestWahaHistoryPage(w,params,{timeoutMs=90000,preferredMode='chat'}={}){
  const chatPath=`/api/${encodeURIComponent(w.session)}/chats/${encodeURIComponent(w.groupId)}/messages?${params.toString()}`;
  const common=new URLSearchParams(params);
  common.set('chatId',String(w.groupId));
  common.set('session',String(w.session));
  const messagesPath=`/api/messages?${common.toString()}`;
  const modes=preferredMode==='messages'?['messages','chat']:['chat','messages'];
  let lastError=null;
  for(const mode of modes){
    try{
      const result=await wahaRaw(mode==='messages'?messagesPath:chatPath,'GET',null,{timeoutMs});
      return {rows:Array.isArray(result)?result:[],mode};
    }catch(error){
      lastError=error;
      const msg=String(error?.message||error);
      // Only fall through to the alternate official history endpoint for browser/5xx
      // failures. Authentication/validation errors should be surfaced immediately.
      if(!isWahaBrowserTargetClosedError(error)&&!/timeout|aborted|abort|500|502|503|504|ECONNRESET|UND_ERR/i.test(msg))throw error;
    }
  }
  throw lastError||new Error('تعذر جلب صفحة سجل WAHA');
}
async function wahaHistory(count=500,{fromAt=null,toAt=null,dependencyLookbackMs=12*60*60*1000,onProgress=null,beforePage=null}={}){
  const w=await wahaSettingsRaw();
  if(!w.groupId)throw new Error('اختر قروب واتساب أولًا');
  const maxLimit=Math.min(Math.max(Number(count)||500,1),20000);
  const fromMs=fromAt?new Date(fromAt).getTime():0,toMs=toAt?new Date(toAt).getTime():0;
  const queryFrom=Number.isFinite(fromMs)&&fromMs>0?Math.max(0,fromMs-Math.max(0,Number(dependencyLookbackMs)||0)):0;
  const queryTo=Number.isFinite(toMs)&&toMs>0?toMs+60000:0;
  const basePageSize=Math.min(200,Math.max(25,Number(process.env.WAHA_HISTORY_PAGE_SIZE)||100));
  const historyTimeoutMs=Math.min(180000,Math.max(30000,Number(process.env.WAHA_HISTORY_TIMEOUT_MS)||90000));
  const progress=async data=>{if(typeof onProgress==='function')try{await onProgress(data||{})}catch{}};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  let raw=[],offset=0,page=0,retries=0,filterFallback=false,recoveryAttempts=0,historyMode='chat';
  const maxRecoveryAttempts=Math.min(6,Math.max(1,Number(process.env.WAHA_HISTORY_RECOVERY_ATTEMPTS)||4));
  while(raw.length<maxLimit){
    // V68 LIVE PRIORITY: long history scans yield before every page whenever
    // fresh LIVE jobs are waiting/processing. This keeps request→reply→👍 fast.
    if(typeof beforePage==='function'){
      try{await beforePage({offset,historyFetched:raw.length,historyLimit:maxLimit});}catch{}
    }
    let requested=Math.min(basePageSize,maxLimit-raw.length);
    let batch=null,lastError=null,usedFilters=!filterFallback;
    // V67: read through either official WAHA history route. WEBJS can occasionally
    // lose the Puppeteer target; in that case recovery attempts are REAL and counted.
    for(let attempt=1;attempt<=4;attempt++){
      const take=Math.max(25,Math.min(requested,maxLimit-raw.length));
      const params=new URLSearchParams({limit:String(take),offset:String(offset),downloadMedia:'false'});
      if(usedFilters&&queryFrom)params.set('filter.timestamp.gte',String(Math.floor(queryFrom/1000)));
      if(usedFilters&&queryTo)params.set('filter.timestamp.lte',String(Math.ceil(queryTo/1000)));
      try{
        const pageResult=await requestWahaHistoryPage(w,params,{timeoutMs:historyTimeoutMs,preferredMode:historyMode});
        batch=pageResult.rows;
        historyMode=pageResult.mode;
        requested=take;
        break;
      }catch(error){
        lastError=error;retries++;
        const msg=String(error?.message||error);
        const browserTargetClosed=isWahaBrowserTargetClosedError(error);
        const retryable=browserTargetClosed||/timeout|aborted|abort|429|500|502|503|504|ECONNRESET|UND_ERR/i.test(msg);
        if(!retryable)throw error;
        if(browserTargetClosed){
          if(usedFilters){usedFilters=false;filterFallback=true;}
          requested=25;
          recoveryAttempts++;
          if(recoveryAttempts>maxRecoveryAttempts){
            throw new Error(`محرك WAHA WEBJS لم يستطع تثبيت صفحة واتساب بعد ${maxRecoveryAttempts} محاولات استعادة فعلية. الجلسة لم تُسجّل خروجًا، ولم يتم تكرار أي جرد.`);
          }
          await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyRetries:retries,historyRecoveryAttempts:recoveryAttempts,historyRecoveryMax:maxRecoveryAttempts,historyFilterFallback:filterFallback,historyRetrying:true,message:`استعادة سجل WAHA — المحاولة ${recoveryAttempts}/${maxRecoveryAttempts} من الرسالة ${offset.toLocaleString('en-US')}`});

          // First failure: allow an automatic WEBJS recovery, but verify the actual
          // message-history execution context rather than trusting WORKING alone.
          if(recoveryAttempts===1){
            await wait(3000);
            try{
              await waitForWahaWorking(w.session,{timeoutMs:45000,onProgress:progress});
              const probe=await probeWahaHistoryEngine(w,{timeoutMs:20000});
              if(probe.ok){
                historyMode=probe.mode;
                await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyRecoveryAttempts:recoveryAttempts,historyProbeMode:probe.mode,historyResumed:true,message:`تمت الاستعادة التلقائية لمحرك WAHA — متابعة من الرسالة ${offset.toLocaleString('en-US')}`});
                await wait(1200);
                continue;
              }
            }catch(autoError){
              const autoMsg=String(autoError?.message||autoError);
              if(/QR جديد|دخلت FAILED|not authorized|unauthori[sz]ed/i.test(autoMsg))throw autoError;
            }
          }

          // If the browser target is still broken, restart ONLY the WAHA session
          // engine. This is not logout/delete and the persisted session remains intact.
          try{
            const probe=await recoverWahaBrowserForHistory(w,{onProgress:progress,recoveryNumber:recoveryAttempts});
            if(probe?.mode)historyMode=probe.mode;
            await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyRecoveryAttempts:recoveryAttempts,historyResumed:true,message:`اكتملت محاولة الاستعادة ${recoveryAttempts}/${maxRecoveryAttempts} — متابعة من الرسالة ${offset.toLocaleString('en-US')} بدون إعادة الجرد الموجود`});
            await wait(1500);
          }catch(recoveryError){
            lastError=recoveryError;
            const recoveryMsg=String(recoveryError?.message||recoveryError);
            if(/QR جديد|دخلت FAILED|not authorized|unauthori[sz]ed/i.test(recoveryMsg))throw recoveryError;
            await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyRecoveryAttempts:recoveryAttempts,historyRecoveryMax:maxRecoveryAttempts,historyRetrying:true,message:`محاولة الاستعادة ${recoveryAttempts} لم تثبت صفحة السجل — سأعيد المحاولة تلقائيًا`});
            await wait(Math.min(7000,1800*recoveryAttempts));
          }
          continue;
        }
        await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyPage:page+1,historyPageSize:take,historyRetries:retries,historyRecoveryAttempts:recoveryAttempts,historyRetrying:true,message:`WAHA تأخر في جلب السجل — إعادة المحاولة بدفعة أصغر (${take} رسالة)`});
        requested=Math.max(25,Math.floor(take/2));
        await wait(Math.min(5000,600*attempt));
      }
    }
    // Some WEBJS builds are much slower when timestamp filters are applied. If the
    // first page still times out, fall back to newest-history pagination and let the
    // reconciliation window filter locally. This is still capped by maxLimit.
    if(batch===null&&offset===0&&usedFilters){
      filterFallback=true;usedFilters=false;requested=Math.min(50,maxLimit-raw.length);
      await progress({historyFetched:0,historyLimit:maxLimit,historyOffset:0,historyRetries:retries,historyFilterFallback:true,message:'WAHA تأخر مع فلترة الوقت — سأجلب السجل على دفعات ثم أحدد الفترة داخل أبشر'});
      continue;
    }
    if(batch===null){
      if(isWahaBrowserTargetClosedError(lastError))throw new Error(`محرك WAHA WEBJS لم يستطع تثبيت صفحة واتساب بعد ${Math.max(1,recoveryAttempts)} محاولة استعادة فعلية. الجلسة لم تُسجّل خروجًا، والجرد الموجود بقي محميًا من التكرار.`);
      throw lastError||new Error('تعذر جلب سجل WAHA بعد عدة محاولات');
    }
    if(!batch.length)break;
    raw.push(...batch);offset+=batch.length;page++;
    await progress({historyFetched:raw.length,historyLimit:maxLimit,historyOffset:offset,historyPage:page,historyPageSize:requested,historyRetries:retries,historyRecoveryAttempts:recoveryAttempts,historyFilterFallback:filterFallback,message:`جاري جلب سجل WAHA: ${raw.length.toLocaleString('en-US')} / ${maxLimit.toLocaleString('en-US')}${recoveryAttempts?` — استعادة WAHA ${recoveryAttempts}`:''}`});
    if(batch.length<requested)break;
    // A tiny pause protects the WAHA session and Railway container during long rebuilds.
    await wait(120);
  }
  let meId='';
  try{const me=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}/me`);meId=wahaIdString(me?.id||me)}catch{}
  const existingMap=await recentWhatsappEventIdMap(w.groupId,Math.max(30000,maxLimit*3));
  const batchMap=new Map();
  for(const item of raw){const rid=wahaIdString(item?.id||item?.idMessage).trim(),c=canonicalWhatsappMessageId(rid);if(c&&!batchMap.has(c))batchMap.set(c,rid)}
  const out=[];let syntheticReactions=0,reactionsWithoutSender=0,historyBaseMessages=0;
  for(const item of raw){
    const rawId=wahaIdString(item?.id||item?.idMessage).trim();
    if(!rawId)continue;
    const canonical=canonicalWhatsappMessageId(rawId);
    const idMessage=existingMap.get(canonical)||rawId;
    let sender=extractWahaDirectPhoneId(item,{me:{id:meId}})||wahaIdString(item?.participant||item?.author||item?.sender).trim();
    if(!sender&&!item?.fromMe&&!/@g\.us$/i.test(wahaIdString(item?.from)))sender=wahaIdString(item?.from);
    if(item?.fromMe&&!sender)sender=meId;
    sender=await wahaResolveChatId(sender,{groupId:w.groupId||''});
    const body=String(item?.body||item?.caption||'');
    const rawReply=wahaIdString(item?.replyTo?.id||item?.reply_to?.id||item?.reply_to).trim();
    const replyCanonical=canonicalWhatsappMessageId(rawReply);
    const replyId=rawReply?(existingMap.get(replyCanonical)||batchMap.get(replyCanonical)||rawReply):'';
    const media=item?.media||{};
    const mime=String(media?.mimetype||media?.mimeType||'').toLowerCase();
    let typeMessage='textMessage',messageData={typeMessage:'textMessage',textMessageData:{textMessage:body}};
    if(item?.hasMedia&&mime.startsWith('audio/')){
      typeMessage='audioMessage';
      messageData={typeMessage,fileMessageData:{downloadUrl:String(media?.url||''),url:String(media?.url||''),mimeType:mime||'audio/ogg',fileName:String(media?.filename||'')}};
      if(replyId)messageData.extendedTextMessageData={stanzaId:replyId,text:body};
    }else if(replyId){
      typeMessage='extendedTextMessage';
      messageData={typeMessage,extendedTextMessageData:{text:body,stanzaId:replyId},quotedMessage:{stanzaId:replyId,textMessage:String(item?.replyTo?.body||'')}};
    }
    out.push({
      idMessage,type:item?.fromMe?'outgoing':'incoming',typeWebhook:item?.fromMe?'outgoingMessageReceived':'incomingMessageReceived',typeMessage,
      senderId:sender,senderName:String(item?.pushName||item?.notifyName||item?.senderName||item?._data?.notifyName||item?._data?.pushName||''),
      timestamp:item?.timestamp||item?.t||null,messageData,text:body,_abshirProvider:'WAHA',_wahaHistoryRaw:item,_abshirCanonicalMessageId:canonical
    });
    historyBaseMessages++;

    // V63: WAHA history can expose the CURRENT reaction state on a message in
    // `reactions` / `_data.reactions`. Rebuild those active reactions as deterministic
    // synthetic reaction events. This restores missed 👍/🚫/1️⃣–🔟 without inventing
    // removed reactions, and ledger idempotency below prevents GREEN-covered jobs from repeating.
    for(const rx of wahaHistoryReactionRows(item)){
      const emoji=wahaHistoryReactionText(rx);if(!emoji)continue;
      let rxSender=wahaHistoryReactionSender(rx);if(!rxSender){reactionsWithoutSender++;continue}
      rxSender=await wahaResolveChatId(rxSender,{groupId:w.groupId||''});
      const rxTs=wahaHistoryReactionTimestamp(rx,item);
      const rxKey=`${canonical||canonicalWhatsappMessageId(idMessage)}:${canonicalWhatsappMessageId(rxSender)||normPhone(rxSender)}:${Buffer.from(emoji).toString('hex')}`;
      out.push({
        idMessage:`WAHA-HISTORY-RX-${rxKey}`,type:'incoming',typeWebhook:'incomingMessageReceived',typeMessage:'reactionMessage',
        senderId:rxSender,senderName:'',timestamp:rxTs||item?.timestamp||item?.t||null,
        reactionMessageData:{text:emoji,stanzaId:idMessage,quotedStanzaId:idMessage,idMessageQuoted:idMessage},
        messageData:{typeMessage:'reactionMessage',reactionMessageData:{text:emoji,stanzaId:idMessage,quotedStanzaId:idMessage,idMessageQuoted:idMessage}},
        _abshirProvider:'WAHA',_abshirSyntheticHistoryReaction:true,_abshirReactionTargetCanonical:canonical
      });
      syntheticReactions++;
    }
  }
  out._abshirHistoryStats={historyBaseMessages,syntheticReactions,reactionsWithoutSender,rawMessages:raw.length,queryFrom:queryFrom?new Date(queryFrom).toISOString():null,queryTo:queryTo?new Date(queryTo).toISOString():null};
  return out;
}

export async function recordWahaSessionWebhook(event={}){
  const status=String(event?.payload?.status||'UNKNOWN').toUpperCase();const now=new Date();const w=await wahaSettingsRaw();const previous=String(w.status||'');const changed=status&&status!==previous;
  const history=Array.isArray(w.sessionHistory)?w.sessionHistory.slice(-49):[];if(changed||status)history.push({at:now.toISOString(),status,engine:event?.engine||'',data:event?.payload?.data||null});
  const next={...w,status,connected:status==='WORKING',lastSessionEventAt:now.toISOString(),sessionHistory:history};if(changed)next.lastStateChangeAt=now.toISOString();if(status==='WORKING')next.lastWorkingAt=now.toISOString();
  await putSetting('waha_api',next,null);return {ok:true,status};
}
export async function convertWahaWebhookToGreen(event={}){
  const kind=String(event?.event||'');const p=event?.payload||{};const w=await wahaSettingsRaw();
  if(kind==='session.status')return null;

  const payloadId=wahaIdString(p?.id||event?.id);
  const possibleChatIds=[p?.chatId,p?.from,p?.to,p?.before?.chatId,p?.before?.from,p?.after?.chatId,p?.after?.from]
    .map(wahaIdString).filter(Boolean);
  // Never guess the configured group: private chats and other groups must stay
  // distinguishable so server.js can reject them before database storage.
  let chatId=possibleChatIds.find(x=>/@g\.us$/i.test(x))||wahaGroupFromMessageId(payloadId)||'';

  // WAHA 2026.x can expose participant identifiers as strings, @lid values or
  // structured objects carrying pn/id. Prefer a real participant over group `from`.
  const rawSenderCandidates=[
    p?.participant,p?.author,p?.sender,p?.participant?.pn,p?.participant?.id,
    p?._data?.author,p?._data?.participant,p?._data?.id?.participant,
    p?.before?.participant,p?.before?.author,p?.before?._data?.author,
    p?.after?.participant,p?.after?.author,p?.after?._data?.author,
    (!p?.fromMe&&!/@g\.us$/i.test(wahaIdString(p?.from))?p?.from:null),
    p?.fromMe?event?.me?.id:null
  ];
  const rawSender=rawSenderCandidates.map(wahaIdString).find(Boolean)||'';
  const senderLid=isWahaLid(rawSender)?rawSender:'';
  let sender=extractWahaDirectPhoneId(p,event)||rawSender;
  sender=await wahaResolveChatId(sender,{groupId:chatId});
  const senderName=String(p?.pushName||p?.notifyName||p?.senderName||p?._data?.notifyName||p?._data?.pushName||'');
  // V-FIX: WAHA sends payload.timestamp for message.reaction as a FLOAT
  // (e.g. 1788212610.343 — seconds with a millisecond fraction), unlike other
  // event types which are whole integers. event_timestamp is BIGINT in Postgres,
  // which rejects any decimal point outright ("invalid input syntax for type
  // bigint") — and with no try/catch around insertWebhookEvent's caller in
  // server.js, that exception was surfacing as an uncaught 500 to WAHA for
  // EVERY reaction, before any accounting logic ever ran. Round to an integer
  // here so every event type (and every future caller of `ts`) is protected,
  // regardless of whether the source value was in seconds or milliseconds.
  const ts=firstWhatsappEventTimestamp(p?.timestamp,p?._data?.revokeTimestamp,p?.after?._data?.revokeTimestamp,p?.after?.timestamp,p?.before?.timestamp,event?.timestamp,Date.now());

  if(kind==='message.reaction'){
    const id=payloadId||`waha-reaction-${ts}-${Math.random()}`;
    let target=await resolveWahaStoredMessageId(chatId,p?.reaction?.messageId||p?.reaction?.id||'');
    if(!chatId)chatId=wahaGroupFromMessageId(target)||await storedWhatsappEventChatId(target);
    return {typeWebhook:'incomingMessageReceived',idMessage:id,senderData:{chatId,sender,senderName,chatName:w.groupName||''},messageData:{typeMessage:'reactionMessage',reactionMessageData:{text:String(p?.reaction?.text||''),stanzaId:target,quotedStanzaId:target,idMessageQuoted:target}},timestamp:ts,_abshirProvider:'WAHA',_abshirSenderLid:senderLid,_waha:event};
  }
  if(kind==='message.revoked'){
    const target=await resolveWahaStoredMessageId(chatId,p?.revokedMessageId||p?.before?.id||p?.after?.id||'');
    if(!chatId)chatId=wahaGroupFromMessageId(target)||await storedWhatsappEventChatId(target);
    const revokeActionId=wahaIdString(p?.after?.id||p?._data?.id);
    const id=payloadId||revokeActionId||`waha-revoked-${canonicalWhatsappMessageId(target)||target}`;
    return {typeWebhook:'incomingMessageReceived',idMessage:id,senderData:{chatId,sender,senderName,chatName:w.groupName||''},messageData:{typeMessage:'deletedMessage',deletedMessageData:{stanzaId:target,idMessage:target,messageId:target}},timestamp:ts,_abshirProvider:'WAHA',_abshirSenderLid:senderLid,_waha:event};
  }
  if(kind==='message.edited'){
    const target=await resolveWahaStoredMessageId(chatId,p?.editedMessageId||p?.before?.id||'');
    if(!chatId)chatId=wahaGroupFromMessageId(target)||await storedWhatsappEventChatId(target);
    const id=payloadId||`waha-edited-${target}-${ts}`;
    return {typeWebhook:'incomingMessageReceived',idMessage:id,senderData:{chatId,sender,senderName,chatName:w.groupName||''},messageData:{typeMessage:'editedMessage',editedMessageData:{stanzaId:target,idMessage:target,textMessage:String(p?.body||'')}},timestamp:ts,_abshirProvider:'WAHA',_abshirSenderLid:senderLid,_waha:event};
  }
  if(kind!=='message'&&kind!=='message.any')return null;
  const id=payloadId;if(!id)return null;
  const body=String(p?.body||p?.caption||'');
  const replyId=await resolveWahaStoredMessageId(chatId,p?.replyTo?.id||p?.reply_to?.id||p?.reply_to||'');
  const media=p?.media||{};const mime=String(media?.mimetype||media?.mimeType||'').toLowerCase();let messageData;
  if(p?.hasMedia&&mime.startsWith('audio/')){
    messageData={typeMessage:'audioMessage',fileMessageData:{downloadUrl:String(media?.url||''),url:String(media?.url||''),mimeType:mime||'audio/ogg',fileName:String(media?.filename||'')}};
    if(replyId)messageData.extendedTextMessageData={stanzaId:replyId,text:body};
  }else if(replyId){
    messageData={typeMessage:'extendedTextMessage',extendedTextMessageData:{text:body,stanzaId:replyId},quotedMessage:{stanzaId:replyId,textMessage:String(p?.replyTo?.body||'')}};
  }else{
    messageData={typeMessage:'textMessage',textMessageData:{textMessage:body}};
    if(p?.hasMedia)messageData.fileMessageData={downloadUrl:String(media?.url||''),url:String(media?.url||''),mimeType:mime,fileName:String(media?.filename||''),caption:body};
  }
  return {typeWebhook:p?.fromMe?'outgoingMessageReceived':'incomingMessageReceived',idMessage:id,senderData:{chatId,sender,senderName,chatName:w.groupName||''},messageData,timestamp:ts,_abshirProvider:'WAHA',_abshirSenderLid:senderLid,_waha:event};
}
async function findCaptainByPhone(phone){const p=normPhone(phone);if(!p)return null;const r=await db.query(`SELECT c.*,COALESCE(SUM(le.amount),0)::numeric(12,3) balance FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id WHERE regexp_replace(c.phone,'[^0-9]','','g') LIKE $1 GROUP BY c.id LIMIT 1`,[`%${p}`]);return r.rows[0]||null}
async function captainById(id){const r=await db.query(`SELECT c.*,COALESCE(SUM(le.amount),0)::numeric(12,3) balance FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id WHERE c.id=$1 GROUP BY c.id`,[id]);return r.rows[0]||null}

async function ensureGreenSecret(userId=null){let s=await getSetting("green_webhook_secret","");if(!s){s=randomUUID().replace(/-/g,"")+randomUUID().replace(/-/g,"");await putSetting("green_webhook_secret",s,userId)}return String(s)}
function normalizeGreenApiUrl(value){
  let url;
  try{url=new URL(String(value||"https://api.greenapi.com"))}catch{throw new Error("رابط Green API غير صالح")}
  const host=String(url.hostname||"").toLowerCase();
  // GREEN-API may assign a dedicated apiUrl in the console, e.g.
  // https://7107.api.greenapi.com. The universal host is
  // https://api.greenapi.com. Keep HTTPS-only validation, but accept both
  // the universal and dedicated GREEN-API hosts supplied by the console.
  const officialHost = host==="api.greenapi.com" || host==="api.green-api.com" || /^[a-z0-9-]+\.api\.greenapi\.com$/.test(host);
  if(url.protocol!=="https:"||!officialHost||url.port||url.username||url.password){
    throw new Error("يجب استخدام apiUrl الرسمي الظاهر في لوحة GREEN API")
  }
  return `https://${host}`;
}
function timeoutSignal(envName,fallback,max){
  const ms=Math.min(max,Math.max(1000,Number(process.env[envName])||fallback));
  return AbortSignal.timeout(ms);
}
const GREEN_DELETE_INTERVAL_MS=Math.min(5000,Math.max(750,Number(process.env.GREEN_DELETE_MIN_INTERVAL_MS)||1200));
const GREEN_OTHER_INTERVAL_MS=Math.min(15000,Math.max(1500,Number(process.env.GREEN_OTHER_MUTATION_MIN_INTERVAL_MS)||3500));
const GREEN_SETSETTINGS_INTERVAL_MS=Math.min(30000,Math.max(5000,Number(process.env.GREEN_SETSETTINGS_MIN_INTERVAL_MS)||10000));
const GREEN_SESSION_STABLE_MS=Math.min(5*60*1000,Math.max(5000,Number(process.env.GREEN_SESSION_STABLE_MS)||45000));
const GREEN_SESSION_CACHE_MS=Math.min(120000,Math.max(5000,Number(process.env.GREEN_SESSION_CACHE_MS)||20000));

const greenSessionCache={hydrated:false,state:"",statusInstance:"",checkedAt:0,lastTransitionAt:0,authorizedSince:0,unstableSince:0,source:""};
async function hydrateGreenSessionCache(){
  if(greenSessionCache.hydrated)return;
  greenSessionCache.hydrated=true;
  try{
    const g=await getSetting("green_api",{});
    greenSessionCache.state=String(g.sessionState||"");
    greenSessionCache.statusInstance=String(g.statusInstance||"");
    greenSessionCache.lastTransitionAt=Date.parse(g.lastStateChangeAt||"")||0;
    greenSessionCache.authorizedSince=Date.parse(g.lastAuthorizedAt||"")||0;
    greenSessionCache.unstableSince=Date.parse(g.unstableSince||"")||0;
    greenSessionCache.source="persisted";
  }catch{}
}
function observeGreenSessionState(state,{statusInstance="",source="poll",at=Date.now()}={}){
  state=String(state||"").trim();
  if(!state)return;
  const previous=greenSessionCache.state;
  if(previous!==state){
    greenSessionCache.lastTransitionAt=at;
    if(state==="authorized"){greenSessionCache.authorizedSince=at;greenSessionCache.unstableSince=0}
    else if(!greenSessionCache.unstableSince)greenSessionCache.unstableSince=at;
  }
  greenSessionCache.state=state;
  if(statusInstance)greenSessionCache.statusInstance=String(statusInstance);
  greenSessionCache.checkedAt=at;
  greenSessionCache.source=source;
}
export async function recordGreenServiceWebhook(payload={}){
  const type=String(payload?.typeWebhook||"");
  const state=String(payload?.stateInstance||"").trim();
  const statusInstance=String(payload?.statusInstance||"").trim();
  const now=new Date();
  await hydrateGreenSessionCache();
  if(state)observeGreenSessionState(state,{statusInstance,source:`webhook:${type}`,at:now.getTime()});
  else if(statusInstance){greenSessionCache.statusInstance=statusInstance;greenSessionCache.checkedAt=now.getTime();greenSessionCache.source=`webhook:${type}`}
  try{
    const g=await getSetting("green_api",{});
    const previous=String(g.sessionState||"");
    const changed=Boolean(state&&state!==previous);
    const history=Array.isArray(g.sessionHistory)?g.sessionHistory.slice(-39):[];
    if(changed||statusInstance){history.push({at:now.toISOString(),type,state:state||previous,statusInstance:statusInstance||""})}
    const next={...g,sessionState:state||previous,statusInstance:statusInstance||g.statusInstance||"",lastSessionEventAt:now.toISOString(),sessionHistory:history};
    if(changed)next.lastStateChangeAt=now.toISOString();
    if(state==="authorized"){next.connected=true;next.status="AUTHORIZED";next.lastAuthorizedAt=(changed||!g.lastAuthorizedAt)?now.toISOString():g.lastAuthorizedAt;next.unstableSince=""}
    else if(state){next.connected=false;next.status=String(state).toUpperCase();next.unstableSince=(changed||!g.unstableSince)?now.toISOString():g.unstableSince}
    await putSetting("green_api",next,null);
  }catch{}
  return {ok:true,state:state||greenSessionCache.state,statusInstance:statusInstance||greenSessionCache.statusInstance};
}
export async function activeWhatsappProvider(){return await whatsappProvider()}
export async function greenPublicSettings(){
  if(await whatsappProvider()==='waha')return await wahaPublicSettings();
  const g=await getSetting("green_api",{});await ensureGreenSecret();const base=publicBase();
  return {provider:'green',apiUrl:g.apiUrl||"https://api.greenapi.com",idInstance:g.idInstance||"",groupId:g.groupId||"",groupName:g.groupName||"",enabled:Boolean(g.enabled),voiceEnabled:g.voiceEnabled!==false,autoApprove:true,fullAutoInventory:true,hasToken:Boolean(g.apiToken),hasOpenAiKey:Boolean(g.openAiKey),connected:Boolean(g.connected),status:g.status||"NOT_CHECKED",lastHealthCheckAt:g.lastHealthCheckAt||"",webhookUrl:base?`${base}/webhook/green-api`:"",webhookAuthEnabled:true,performance:g.performance||{},sessionState:g.sessionState||"",statusInstance:g.statusInstance||"",lastStateChangeAt:g.lastStateChangeAt||"",lastAuthorizedAt:g.lastAuthorizedAt||"",lastSessionEventAt:g.lastSessionEventAt||"",sessionGuard:{enabled:true,deletePriority:true,deleteMinIntervalMs:GREEN_DELETE_INTERVAL_MS,otherMutationMinIntervalMs:GREEN_OTHER_INTERVAL_MS,stableWindowSeconds:Math.round(GREEN_SESSION_STABLE_MS/1000)}};
}
const GREEN_MUTATING_METHODS=new Set([
  "sendmessage","deletemessage","editmessage","setsettings",
  "updategroupsettings","addgroupparticipant","removegroupparticipant"
]);
let greenMutationQueue=[];
let greenMutationRunning=false;
let greenMutationSeq=0;
let greenLastMutationAt=0;
function mutationPriority(method){return method==="deletemessage"?0:method==="setsettings"?20:10}
function mutationInterval(method){return method==="deletemessage"?GREEN_DELETE_INTERVAL_MS:method==="setsettings"?GREEN_SETSETTINGS_INTERVAL_MS:GREEN_OTHER_INTERVAL_MS}
async function drainGreenMutationQueue(){
  if(greenMutationRunning)return;
  greenMutationRunning=true;
  try{
    while(greenMutationQueue.length){
      greenMutationQueue.sort((a,b)=>a.priority-b.priority||a.seq-b.seq);
      const item=greenMutationQueue.shift();
      const remaining=Math.max(0,mutationInterval(item.method)-(Date.now()-greenLastMutationAt));
      if(remaining)await new Promise(resolve=>setTimeout(resolve,remaining));
      try{item.resolve(await item.task())}catch(error){item.reject(error)}finally{greenLastMutationAt=Date.now()}
    }
  }finally{greenMutationRunning=false;if(greenMutationQueue.length)queueMicrotask(()=>drainGreenMutationQueue())}
}
function withGreenMutationSlot(method,task){
  return new Promise((resolve,reject)=>{
    greenMutationQueue.push({method,task,resolve,reject,priority:mutationPriority(method),seq:++greenMutationSeq});
    void drainGreenMutationQueue();
  });
}
async function ensureGreenSessionStableForMutation(method){
  if(method==="deletemessage"||method==="setsettings")return; // deletion is mandatory; SetSettings already has its own explicit guard/cooldown.
  await hydrateGreenSessionCache();
  if(!greenSessionCache.checkedAt||Date.now()-greenSessionCache.checkedAt>GREEN_SESSION_CACHE_MS){
    const state=await greenRaw("getStateInstance");
    observeGreenSessionState(state?.stateInstance||"",{source:"guard_poll"});
  }
  const state=String(greenSessionCache.state||"");
  if(state!=="authorized")throw new Error(`حماية جلسة GREEN: تم تأجيل العملية ${method} لأن الحالة ${state||"unknown"}. حذف الرسائل يبقى مفعّلًا.`);
  const stableFor=greenSessionCache.authorizedSince?Date.now()-greenSessionCache.authorizedSince:GREEN_SESSION_STABLE_MS;
  if(stableFor<GREEN_SESSION_STABLE_MS){
    const waitSec=Math.max(1,Math.ceil((GREEN_SESSION_STABLE_MS-stableFor)/1000));
    throw new Error(`حماية جلسة GREEN: الجلسة عادت Authorized حديثًا. تم تأجيل ${method} لمدة تقريبية ${waitSec} ثانية؛ حذف الرسائل مستثنى.`);
  }
}
async function greenRaw(method,httpMethod="GET",body=null,query=""){
  const g=await getSetting("green_api",{});if(!g.idInstance||!g.apiToken)throw new Error("أدخل idInstance وapiTokenInstance أولًا");
  const base=normalizeGreenApiUrl(g.apiUrl);const url=`${base}/waInstance${g.idInstance}/${method}/${g.apiToken}${query||""}`;
  const methodKey=String(method||"").toLowerCase();
  const execute=async()=>{
    const opt={method:httpMethod,headers:{},signal:timeoutSignal("GREEN_API_TIMEOUT_MS",20000,120000)};if(body!==null){opt.headers["content-type"]="application/json";opt.body=JSON.stringify(body)}
    const res=await fetch(url,opt);const text=await res.text();if(!res.ok)throw new Error(`Green API رفض الطلب (${res.status}): ${text.slice(0,260)}`);let parsed;try{parsed=text?JSON.parse(text):{}}catch{parsed={raw:text}}
    if(methodKey==="getstateinstance")observeGreenSessionState(parsed?.stateInstance||"",{source:"poll"});
    return parsed;
  };
  if(!GREEN_MUTATING_METHODS.has(methodKey))return await execute();
  return await withGreenMutationSlot(methodKey,async()=>{await ensureGreenSessionStableForMutation(methodKey);return await execute()});
}
export async function saveGreenSettings(payload,userId){const requested=String(payload?.provider||'').trim().toLowerCase();if(requested==='waha'||(!requested&&await whatsappProvider()==='waha'))return await saveWahaSettings(payload,userId);await putSetting('whatsapp_provider','green',userId);whatsappProviderCache={value:'green',at:Date.now()};const old=await getSetting("green_api",{});payload=payload||{};const id=String(payload.idInstance||"").trim();if(id&&!/^\d+$/.test(id))throw new Error("idInstance يجب أن يحتوي أرقامًا فقط");const gid=String(payload.groupId||"").trim();if(gid&&!/@g\.us$/.test(gid))throw new Error("معرّف القروب يجب أن ينتهي بـ @g.us");const next={...old,apiUrl:normalizeGreenApiUrl(payload.apiUrl||old.apiUrl),idInstance:id,groupId:gid,groupName:String(payload.groupName||"").slice(0,200),enabled:Boolean(payload.enabled),voiceEnabled:payload.voiceEnabled!==false,autoApprove:Boolean(payload.autoApprove)};if(String(payload.apiToken||"").trim())next.apiToken=String(payload.apiToken).trim();if(String(payload.openAiKey||"").trim())next.openAiKey=String(payload.openAiKey).trim();await putSetting("green_api",next,userId);await ensureGreenSecret(userId);await audit(userId,"green.settings.save","system","green",{idInstance:id,groupId:gid,enabled:next.enabled,voiceEnabled:next.voiceEnabled,autoApprove:next.autoApprove});return await greenPublicSettings()}
export async function testGreen(){if(await whatsappProvider()==='waha')return await testWaha();const r=await greenRaw("getStateInstance");const st=r.stateInstance||"unknown";if(st!=="authorized")throw new Error(`حالة الربط: ${st}. افتح Green API واربط QR أولًا`);const g=await getSetting("green_api",{});const now=new Date().toISOString();await putSetting("green_api",{...g,connected:true,status:"AUTHORIZED",sessionState:"authorized",lastAuthorizedAt:g.lastAuthorizedAt||now,unstableSince:"",lastHealthCheckAt:now});return {state:st}}
export async function greenHealth(){if(await whatsappProvider()==='waha')return await wahaHealth();const remote=await greenRaw("getSettings");const pub=await greenPublicSettings();const cleanRemote=String(remote.webhookUrl||"").replace(/[?&]greenHook=[^&]*/g,"").replace(/[?&]$/g,"");const ok=Boolean(cleanRemote)&&cleanRemote===String(pub.webhookUrl);const g=await getSetting("green_api",{});await putSetting("green_api",{...g,connected:true,status:ok?"HEALTHY":"WEBHOOK_MISMATCH",lastHealthCheckAt:new Date().toISOString(),remoteWebhookUrl:remote.webhookUrl||"",remoteWebhookTokenConfigured:Boolean(remote.webhookUrlToken)});return {remote:{...remote,webhookUrlToken:remote.webhookUrlToken?"***configured***":""},settings:await greenPublicSettings(),ok}}
export async function listGreenGroups(){if(await whatsappProvider()==='waha')return await listWahaGroups();const a=await greenRaw("getContacts","GET",null,"?group=true");return (Array.isArray(a)?a:[]).filter(x=>x.type==="group"||/@g\.us$/.test(String(x.id||""))).map(x=>({id:x.id,name:x.name||x.contactName||x.id}))}
function greenFlagEnabled(v){
  if(v===true||v===1)return true;
  return ["yes","true","1","on","enabled"].includes(String(v??"").trim().toLowerCase());
}
function cleanGreenWebhookUrl(v){
  return String(v||"").trim().replace(/[?&]greenHook=[^&]*/g,"").replace(/[?&]$/g,"").replace(/\/$/,"");
}
function greenWebhookTokenMatches(remoteToken,expected){
  const r=String(remoteToken||"").trim(),e=String(expected||"").trim();
  if(!r||!e)return false;
  if(r===e)return true;
  // Some GREEN-API panels/API responses mask the token. A masked non-empty token
  // is treated as configured so we do not reboot a healthy instance just to
  // rewrite an unreadable secret.
  return /[*•]/.test(r)||/configured/i.test(r);
}
function greenWebhookSettingsMatch(remote,p,expectedToken){
  const urlOk=cleanGreenWebhookUrl(remote?.webhookUrl)===cleanGreenWebhookUrl(p.webhookUrl);
  const tokenOk=greenWebhookTokenMatches(remote?.webhookUrlToken,expectedToken);
  // V3.8.5.58: keep message/delete/edit/state webhooks, but disable outgoing delivery/read
  // status notifications. They are not used by accounting and can generate a large
  // amount of extra webhook traffic.
  const requiredYes=["incomingWebhook","outgoingMessageWebhook","outgoingAPIMessageWebhook","deletedMessageWebhook","editedMessageWebhook","stateWebhook"];
  const outgoingStatusOff=!greenFlagEnabled(remote?.outgoingWebhook);
  return urlOk&&tokenOk&&outgoingStatusOff&&requiredYes.every(k=>greenFlagEnabled(remote?.[k]));
}
export async function activateGreenWebhook(userId){
  if(await whatsappProvider()==='waha')return await activateWahaWebhook(userId);
  const p=await greenPublicSettings();
  if(!p.webhookUrl)throw new Error("تعذر تحديد رابط Railway العام");
  if(!p.groupId)throw new Error("اختر قروب واتساب أولًا");
  const webhookUrlToken=await ensureGreenSecret(userId);
  const lockClient=await db.connect();
  let locked=false;
  try{
    const lk=await lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,["abshir_green_setsettings"]);
    locked=Boolean(lk.rows?.[0]?.locked);
    if(!locked){
      return {skipped:true,reason:"activation_in_progress",message:"تفعيل GREEN قيد التنفيذ من طلب آخر؛ لم يتم عمل Reboot إضافي",settings:await greenPublicSettings()};
    }

    // Always inspect current GREEN settings first. getSettings does NOT reboot the instance.
    const remote=await greenRaw("getSettings");
    if(greenWebhookSettingsMatch(remote,p,webhookUrlToken)){
      const g=await getSetting("green_api",{});
      await putSetting("green_api",{...g,enabled:true,connected:true,requestedWebhookUrl:p.webhookUrl,webhookAuthMode:"authorization",status:"HEALTHY",lastHealthCheckAt:new Date().toISOString()},userId);
      await audit(userId,"green.webhook.activate.skip","system","green",{reason:"already_configured",webhookUrl:p.webhookUrl});
      return {skipped:true,alreadyConfigured:true,message:"ربط GREEN صحيح مسبقًا — لم يتم تنفيذ SetSettings ولم يتم عمل Reboot",settings:await greenPublicSettings()};
    }

    const current=await getSetting("green_api",{});
    const lastMs=Date.parse(current.lastSetSettingsAt||"")||0;
    const cooldownMs=10*60*1000;
    const remaining=Math.max(0,cooldownMs-(Date.now()-lastMs));
    if(lastMs&&remaining>0){
      const retryAfterSeconds=Math.ceil(remaining/1000);
      await audit(userId,"green.webhook.activate.skip","system","green",{reason:"cooldown",retryAfterSeconds,webhookUrl:p.webhookUrl});
      return {skipped:true,cooldown:true,retryAfterSeconds,message:`تم منع SetSettings متكرر لحماية جلسة GREEN. جرّب بعد ${Math.ceil(retryAfterSeconds/60)} دقيقة إذا بقي الربط غير مطابق.`,settings:await greenPublicSettings()};
    }

    const desired={webhookUrl:p.webhookUrl,webhookUrlToken,incomingWebhook:"yes",outgoingWebhook:"no",outgoingMessageWebhook:"yes",outgoingAPIMessageWebhook:"yes",deletedMessageWebhook:"yes",editedMessageWebhook:"yes",stateWebhook:"yes"};
    const r=await greenRaw("setSettings","POST",desired);
    const setAt=new Date().toISOString();
    const g=await getSetting("green_api",{});
    await putSetting("green_api",{...g,enabled:true,requestedWebhookUrl:p.webhookUrl,webhookAuthMode:"authorization",status:"WEBHOOK_PENDING",lastSetSettingsAt:setAt},userId);
    await audit(userId,"green.webhook.activate","system","green",{webhookUrl:p.webhookUrl,webhookAuthMode:"authorization",enabled:true,setSettingsAt:setAt});
    return {result:r,setSettingsApplied:true,message:"تم تحديث إعدادات GREEN مرة واحدة؛ انتظر المزامنة ولا تضغط التفعيل مجددًا",settings:await greenPublicSettings()};
  } finally {
    if(locked){try{await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`,["abshir_green_setsettings"])}catch{}}
    lockClient.release();
  }
}
export async function greenSend(chatId,message){const suppressed=await comparisonSuppressedMutation('send_message',{chatId});if(suppressed)return suppressed;if(await whatsappProvider()==='waha')return await wahaSend(chatId,message);return await greenRaw("sendMessage","POST",{chatId,message:String(message||"")})}
const INVENTORY_CANCELLATION_POLICY_KEY='inventory_delete_remove_policy_v2';
// Removing an active 👍 is also an accounting signal and reverses that completed job idempotently.
// Removing 1️⃣–🔟 or 🚫 does not implicitly reopen/cancel anything; those workflows stay explicit.
// A new settings key is used so the restored delete toggle starts safely OFF even if
// an older version had a stale enabled=true value. Explicit 🚫 cancellation remains separate.
export async function getInventoryDeleteRemovalPolicy(){
  const v=await getSetting(INVENTORY_CANCELLATION_POLICY_KEY,{enabled:false});
  return {enabled:v?.enabled===true,forced:false,updatedAt:v?.updatedAt||'',updatedBy:v?.updatedBy||null};
}
export async function setInventoryDeleteRemovalPolicy(enabled,userId=null){
  const next={enabled:Boolean(enabled),forced:false,updatedAt:new Date().toISOString(),updatedBy:userId||null};
  await putSetting(INVENTORY_CANCELLATION_POLICY_KEY,next,userId);
  await audit(userId,'whatsapp.inventory.delete_everyone_policy','system','whatsapp',next);
  return next;
}

export async function greenGroupPosting(groupId,allowed){const suppressed=await comparisonSuppressedMutation('group_posting',{groupId,allowed:Boolean(allowed)});if(suppressed)return suppressed;if(await whatsappProvider()==='waha')return await wahaGroupPosting(groupId,allowed);return await greenRaw("updateGroupSettings","POST",{groupId,allowParticipantsSendMessages:Boolean(allowed)})}
export async function greenRemoveGroupParticipant(groupId,phone){const suppressed=await comparisonSuppressedMutation('remove_participant',{groupId,phone:displayPhone(phone)});if(suppressed)return suppressed;if(await whatsappProvider()==='waha')return await wahaRemoveGroupParticipant(groupId,phone);const participantChatId=`962${normPhone(phone)}@c.us`;return await greenRaw("removeGroupParticipant","POST",{groupId,participantChatId})}
export async function greenAddGroupParticipant(groupId,phone){const suppressed=await comparisonSuppressedMutation('add_participant',{groupId,phone:displayPhone(phone)});if(suppressed)return suppressed;if(await whatsappProvider()==='waha')return await wahaAddGroupParticipant(groupId,phone);const participantChatId=`962${normPhone(phone)}@c.us`;return await greenRaw("addGroupParticipant","POST",{groupId,participantChatId})}
async function sendFreezePrivateAlert(captain,balance,strikeCount){
  const chatId=`962${normPhone(captain.phone)}@c.us`;
  const text=`⚠️ *تنبيه حساب أبشر*\n\nالكابتن: ${captain.name}\nرصيدك الحالي: ${money(balance).toFixed(2)} د.أ\nتم إيقاف رسائلك في القروب لأن الرصيد وصل إلى -0.75 د.أ أو أقل.\n\nيرجى شحن الرصيد للعودة للعمل تلقائيًا.${strikeCount>=2?'\nتمت إزالة الحساب من القروب بعد المخالفة الثانية.':''}\n\n*مؤسسة أبشر فزعة الشمال*`;
  try{return await greenSend(chatId,text)}catch(error){
    await openIssue({dedupKey:`FREEZE_PRIVATE_ALERT:${captain.id}:${strikeCount}`,origin:'WEBHOOK',issueType:'FREEZE_PRIVATE_ALERT_FAILED',severity:'WARNING',sourceId:String(captain.id),summary:'فشل إرسال تنبيه التجميد الخاص للكابتن',details:{phone:captain.phone,balance,error:String(error?.message||error)},suggestedAction:'افحص Green API ثم تواصل مع الكابتن يدويًا'}).catch(()=>{});
    return null;
  }
}

async function captainProtectedFromGroupRemoval(captain){
  const q=await db.query(`SELECT protect_from_group_removal FROM captains WHERE id=$1`,[captain.id]);
  if(q.rows[0]?.protect_from_group_removal)return {protected:true,reason:"MANUAL_PROTECTION"};
  // Captains with an active administration delegation are exempt from automatic group removal.
  const delegated=await db.query(`SELECT 1 FROM captain_admin_grants WHERE captain_id=$1 AND active=TRUE LIMIT 1`,[captain.id]);
  if(delegated.rowCount)return {protected:true,reason:"DELEGATED_ADMIN"};
  // Only a captain with positive production and no consumption in the current Jordan week.
  const weekly=await db.query(`
    SELECT COUNT(*) FILTER (WHERE entry_type='PRODUCTION' AND amount>0) AS produced,
           COUNT(*) FILTER (WHERE entry_type='CONSUMPTION' AND amount<0) AS consumed
    FROM ledger_entries
    WHERE captain_id=$1
      AND (created_at AT TIME ZONE 'Asia/Amman')::date >= date_trunc('week',NOW() AT TIME ZONE 'Asia/Amman')::date
      AND COALESCE(metadata->>'type','') NOT IN ('BALANCE_SET')
  `,[captain.id]);
  if(Number(weekly.rows[0]?.produced||0)>0&&Number(weekly.rows[0]?.consumed||0)===0)return {protected:true,reason:"PRODUCER_ONLY"};
  return {protected:false};
}
async function registerLowBalanceStrike(captain,idMessage,groupId){
  const exemption=await captainProtectedFromGroupRemoval(captain);
  if(exemption.protected)return {strikeCount:0,removed:false,protected:true,reason:exemption.reason};
  const current=await db.query(`SELECT * FROM captain_group_enforcement WHERE captain_id=$1`,[captain.id]);
  const old=current.rows[0]||{};
  if(String(old.last_message_id||'')===String(idMessage||''))return {strikeCount:Number(old.strike_count||0),removed:Boolean(old.removed_from_group),duplicate:true};
  const next=Math.min(2,Number(old.strike_count||0)+1);
  const row=(await db.query(`INSERT INTO captain_group_enforcement(captain_id,strike_count,last_message_id,first_strike_at,second_strike_at,updated_at) VALUES($1,$2,$3,CASE WHEN $2>=1 THEN NOW() ELSE NULL END,CASE WHEN $2>=2 THEN NOW() ELSE NULL END,NOW()) ON CONFLICT(captain_id) DO UPDATE SET strike_count=$2,last_message_id=$3,first_strike_at=COALESCE(captain_group_enforcement.first_strike_at,CASE WHEN $2>=1 THEN NOW() ELSE NULL END),second_strike_at=CASE WHEN $2>=2 THEN COALESCE(captain_group_enforcement.second_strike_at,NOW()) ELSE captain_group_enforcement.second_strike_at END,last_error=NULL,updated_at=NOW() RETURNING *`,[captain.id,next,String(idMessage||'')])).rows[0];
  await db.query(`UPDATE captains SET status='frozen',status_reason='AUTO_LOW_BALANCE',updated_at=NOW() WHERE id=$1 AND status<>'disabled'`,[captain.id]);
  if(next<2||row.removed_from_group)return {strikeCount:next,removed:Boolean(row.removed_from_group)};
  try{
    const result=await greenRemoveGroupParticipant(groupId,captain.phone);
    const removed=result?.removeParticipant!==false;
    await db.query(`UPDATE captain_group_enforcement SET removed_from_group=$2,removed_at=CASE WHEN $2 THEN NOW() ELSE removed_at END,last_error=$3,updated_at=NOW() WHERE captain_id=$1`,[captain.id,removed,removed?null:'GREEN returned removeParticipant=false']);
    return {strikeCount:next,removed,green:result};
  }catch(error){
    await db.query(`UPDATE captain_group_enforcement SET last_error=$2,updated_at=NOW() WHERE captain_id=$1`,[captain.id,String(error?.message||error)]);
    return {strikeCount:next,removed:false,error:String(error?.message||error)};
  }
}

export async function restoreCaptainToGroupIfEligible(captainId){
  const captain=await captainById(captainId);if(!captain)return {restored:false,reason:'captain_not_found'};
  if(await parallelComparisonEnabled())return {restored:false,comparisonMode:true,reason:'parallel_comparison_no_enforcement',balance:n(captain.balance)};
  if(captain.balance_mode==='OPEN_NEGATIVE'||n(captain.balance)<=-.75)return {restored:false,reason:'balance_still_low',balance:n(captain.balance)};
  const q=await db.query(`SELECT * FROM captain_group_enforcement WHERE captain_id=$1`,[captainId]);
  const enforcement=q.rows[0]||null;
  // Any successful recharge above the block threshold clears automatic strikes even if the
  // captain had not yet reached the second strike/removal.
  if(enforcement)await db.query(`UPDATE captain_group_enforcement SET strike_count=0,last_message_id=NULL,last_error=NULL,updated_at=NOW() WHERE captain_id=$1`,[captainId]);
  await db.query(`UPDATE captains SET status='active',status_reason=NULL,updated_at=NOW() WHERE id=$1 AND status='frozen' AND COALESCE(status_reason,'')='AUTO_LOW_BALANCE'`,[captainId]);
  if(!enforcement?.removed_from_group)return {restored:false,reset:true,reason:'not_removed',balance:n(captain.balance)};
  const g=await greenPublicSettings();if(!g.enabled||!g.groupId)return {restored:false,reset:true,reason:'whatsapp_not_ready'};
  try{
    const result=await greenAddGroupParticipant(g.groupId,captain.phone);
    const restored=result?.addParticipant!==false;
    if(restored)await db.query(`UPDATE captain_group_enforcement SET strike_count=0,removed_from_group=FALSE,last_message_id=NULL,restored_at=NOW(),last_error=NULL,updated_at=NOW() WHERE captain_id=$1`,[captainId]);
    else await db.query(`UPDATE captain_group_enforcement SET last_error='WhatsApp provider returned addParticipant=false',updated_at=NOW() WHERE captain_id=$1`,[captainId]);
    return {restored,reset:true,result,balance:n(captain.balance)};
  }catch(error){await db.query(`UPDATE captain_group_enforcement SET last_error=$2,updated_at=NOW() WHERE captain_id=$1`,[captainId,String(error?.message||error)]);return {restored:false,reset:true,error:String(error?.message||error),balance:n(captain.balance)}}
}

export async function syncCaptainBalanceState(captainId,{notify=true}={}){
  const captain=await captainById(captainId);if(!captain)return null;
  if(await parallelComparisonEnabled())return {comparisonMode:true,enforcementSuppressed:true,balance:n(captain.balance)};
  if(captain.balance_mode==='OPEN_NEGATIVE'){
    await restoreCaptainToGroupIfEligible(captainId).catch(()=>null);
    return {low:false,balance:n(captain.balance)};
  }
  const low=n(captain.balance)<=-.75;
  if(!low){await restoreCaptainToGroupIfEligible(captainId).catch(()=>null);return {low:false,balance:n(captain.balance)}}
  const changed=await db.query(`UPDATE captains SET status='frozen',status_reason='AUTO_LOW_BALANCE',updated_at=NOW() WHERE id=$1 AND status<>'disabled' AND NOT(status='frozen' AND COALESCE(status_reason,'')='AUTO_LOW_BALANCE') RETURNING id`,[captainId]);
  // V3.8.5.33: low-balance enforcement is delete-only. Do not send private warning messages.
  return {low:true,balance:n(captain.balance),newlyFrozen:Boolean(changed.rowCount)};
}
export async function greenDelete(groupId,idMessage){const suppressed=await comparisonSuppressedMutation('delete_message',{groupId,idMessage});if(suppressed)return suppressed;if(await whatsappProvider()==='waha')return await wahaDelete(groupId,idMessage);return await greenRaw("deleteMessage","POST",{chatId:groupId,idMessage})}
async function greenDeletePolicyMessage(groupId,idMessage,{reason="policy_block",captainId=null,balance=null}={}){
  if(!groupId||!idMessage)throw new Error("تعذر حذف الرسالة: القروب أو idMessage غير موجود");
  let lastError=null;
  for(let attempt=1;attempt<=2;attempt++){
    try{
      await greenDelete(groupId,idMessage);
      return {deleted:true,attempt,alreadyGone:false};
    }catch(e){
      const msg=String(e?.message||e||"");
      if(/message by id not found|already was deleted|already deleted|not found|\(404\)/i.test(msg)){
        return {deleted:true,attempt,alreadyGone:true};
      }
      lastError=e;
      // Do not hammer an unauthorised/restarting instance. Delete remains mandatory,
      // but a second immediate attempt cannot succeed until the session returns.
      if(/not.?authorized|unauthori[sz]ed|starting|sleep.?mode|blocked|suspended|\(401\)|\(403\)/i.test(msg))break;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,250));
    }
  }
  await openIssue({
    dedupKey:`WHATSAPP_POLICY_DELETE_FAILED:${idMessage}`,origin:"WEBHOOK",issueType:"WHATSAPP_POLICY_DELETE_FAILED",severity:"CRITICAL",
    sourceId:String(idMessage),relatedId:captainId?String(captainId):"",summary:"فشل حذف رسالة كابتن محظور من قروب واتساب",
    details:{reason,balance,groupId,error:String(lastError?.message||lastError||"unknown")},
    suggestedAction:"افحص اتصال مزود واتساب وصلاحية حذف الرسائل ثم أعد معالجة الحدث"
  }).catch(()=>{});
  throw new Error(`فشل حذف الرسالة المحظورة من القروب: ${String(lastError?.message||lastError||"unknown")}`);
}
export async function greenHistory(count=500,options={}){if(await whatsappProvider()==='waha')return await wahaHistory(count,options);const p=await greenPublicSettings();if(!p.groupId)throw new Error("اختر قروب واتساب أولًا");const h=await greenRaw("getChatHistory","POST",{chatId:p.groupId,count:Math.min(Math.max(Number(count)||500,1),5000)});return Array.isArray(h)?h:[]}

export async function groupGuidePublic(){const x=await getSetting("group_guide",{});return {enabled:Boolean(x.enabled),message:x.message||DEFAULT_GUIDE,lastSentAt:x.lastSentAt||"",lastError:x.lastError||""}}
export async function saveGroupGuide(payload,userId){const message=String(payload?.message||"").trim().slice(0,4000);if(message.length<20)throw new Error("رسالة الشرح قصيرة جدًا");const x={...(await getSetting("group_guide",{})),message,enabled:Boolean(payload?.enabled)};await putSetting("group_guide",x,userId);await audit(userId,"group_guide.save","system","group_guide",{enabled:x.enabled,length:message.length});return await groupGuidePublic()}
export async function sendGroupGuide(userId){const x=await groupGuidePublic();const g=await greenPublicSettings();if(!g.enabled)throw new Error("فعّل ربط واتساب أولًا");if(!g.groupId)throw new Error("اختر القروب أولًا");await greenSend(g.groupId,x.message);const next={...x,lastSentAt:new Date().toISOString(),lastError:""};await putSetting("group_guide",next,userId);await audit(userId,"group_guide.send","system","group_guide",{});return next}

function transferImageMime(buf,mime){
  const png=buf.length>=8&&buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  const jpeg=buf.length>=3&&buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff;
  const webp=buf.length>=12&&buf.toString("ascii",0,4)==="RIFF"&&buf.toString("ascii",8,12)==="WEBP";
  return (mime==="image/png"&&png)||(mime==="image/jpeg"&&jpeg)||(mime==="image/webp"&&webp);
}
export async function saveTransfer({captainId,payload}){payload=payload||{};const amount=n(payload.packageValue);if(![5,10,15,20,30].includes(amount))throw new Error("اختر فئة شحن صحيحة");const data=String(payload.imageData||"");if(!data)throw new Error("ارفع صورة الحوالة");const m=data.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);if(!m)throw new Error("يُسمح بصور PNG أو JPEG أو WebP فقط");const encoded=m[2].replace(/\s/g,"");if(!encoded||encoded.length%4===1)throw new Error("بيانات الصورة غير صالحة");const buf=Buffer.from(encoded,"base64");if(!buf.length||!transferImageMime(buf,m[1]))throw new Error("محتوى الملف لا يطابق نوع الصورة");if(buf.length>5*1024*1024)throw new Error("حجم الصورة أكبر من 5MB");const token=randomUUID();const r=await db.query(`INSERT INTO recharge_requests(captain_id,amount,method,reference_text,note,image_data,image_mime,image_token) VALUES($1,$2,'TRANSFER',$3,$4,$5,$6,$7) RETURNING *`,[captainId,amount,String(payload.fileName||"").slice(0,255),String(payload.note||"").slice(0,1000),buf,m[1],token]);return r.rows[0]}
export async function transferImage(token){const r=await db.query(`SELECT image_data,image_mime FROM recharge_requests WHERE image_token=$1`,[String(token)]);return r.rows[0]||null}
export async function transfersForBootstrap(captainId=null){const q=await db.query(`SELECT rr.*,c.name captain_name FROM recharge_requests rr JOIN captains c ON c.id=rr.captain_id WHERE ($1::bigint IS NULL OR rr.captain_id=$1) ORDER BY rr.created_at DESC LIMIT 250`,[captainId||null]);const base=publicBase();return q.rows.map(x=>({ID:String(x.id),CaptainID:String(x.captain_id),CaptainName:x.captain_name,PackageBalance:n(x.amount),PaidAmount:n(x.amount),ImageFileID:"",ImageURL:x.image_token&&base?`${base}/transfer-image/${x.image_token}`:(x.legacy_image_url||""),Status:x.status==="pending"?"PENDING":x.status==="approved"?"APPROVED":"REJECTED",AccountantNote:x.note||"",CreatedAt:x.created_at,ReviewedAt:x.reviewed_at,RechargeCode:x.legacy_code||""}))}
export async function reviewTransferNative({id,action,note,userId}){
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const q=await client.query(`SELECT * FROM recharge_requests WHERE id=$1 FOR UPDATE`,[id]);
    if(!q.rowCount)throw new Error("الحوالة غير موجودة");
    const r=q.rows[0];
    if(r.status!=="pending")throw new Error("الحوالة تمت مراجعتها مسبقًا");
    if(String(action)==="REJECT"){
      await client.query(`UPDATE recharge_requests SET status='rejected',note=$2,reviewed_at=NOW(),reviewed_by_user_id=$3 WHERE id=$1`,[id,String(note||""),userId]);
      await client.query("COMMIT");
      return {message:"تم رفض الحوالة"};
    }
    let codeRow=null;
    for(let i=0;i<8&&!codeRow;i++){
      const code=`SF-${randomUUID().replace(/-/g,'').slice(0,8).toUpperCase()}`;
      try{
        const ins=await client.query(`INSERT INTO recharge_codes(code,amount,created_by_user_id,assigned_captain_id) VALUES($1,$2,$3,$4) RETURNING *`,[code,n(r.amount),userId||null,r.captain_id]);
        codeRow=ins.rows[0];
      }catch(e){if(e?.code!=="23505")throw e;}
    }
    if(!codeRow)throw new Error("تعذر إنشاء كود شحن فريد");
    await client.query(`UPDATE recharge_requests SET status='approved',note=$2,reviewed_at=NOW(),reviewed_by_user_id=$3,legacy_code=$4 WHERE id=$1`,[id,String(note||""),userId,codeRow.code]);
    await client.query("COMMIT");
    await audit(userId,"transfer.approve","recharge_request",id,{code:codeRow.code,amount:n(r.amount)});
    await audit(userId,"recharge_code.create","recharge_code",codeRow.id,{code:codeRow.code,amount:n(r.amount),assignedCaptainId:r.captain_id,source:"transfer_approval"});
    return {message:"تم قبول الحوالة وإنشاء كود الشحن",code:codeRow.code};
  }catch(e){try{await client.query("ROLLBACK")}catch{}throw e}
  finally{client.release()}
}

function jordanParts(d=new Date()){const fmt=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Amman",year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",hourCycle:"h23"});const p=Object.fromEntries(fmt.formatToParts(d).map(x=>[x.type,x.value]));return p}
function dateKey(d){const p=jordanParts(d);return `${p.year}-${p.month}-${p.day}`}
function addDaysKey(key,days){const d=new Date(key+"T12:00:00+03:00");d.setUTCDate(d.getUTCDate()+days);return dateKey(d)}
function activeWeek(at=new Date()){const p=jordanParts(at);const today=`${p.year}-${p.month}-${p.day}`;const back={Fri:0,Sat:1,Sun:2,Mon:3,Tue:4,Wed:5,Thu:6}[p.weekday]??0;const start=addDaysKey(today,-back);return {start,end:addDaysKey(start,6)}}
function lastCompletedWeek(){const p=jordanParts();const today=`${p.year}-${p.month}-${p.day}`;const back={Fri:1,Sat:2,Sun:3,Mon:4,Tue:5,Wed:6,Thu:7}[p.weekday]??7;const end=addDaysKey(today,-back);return {start:addDaysKey(end,-6),end}}
function normalizeSettlementPeriodKey(value){const s=String(value||"").trim();const m=s.match(/^(\d{4}-\d{2}-\d{2})/);return m?m[1]:lastCompletedWeek().end}
export async function fridayPreview(periodKey=lastCompletedWeek().end){
  const end=normalizeSettlementPeriodKey(periodKey),start=addDaysKey(end,-6);
  // Use absolute Amman timestamps instead of reusing one PostgreSQL parameter as both DATE and TEXT.
  // This removes the entire class of "operator does not exist: text = date" failures on mixed/legacy schemas.
  const startAt=new Date(`${start}T00:00:00+03:00`).toISOString();
  const endExclusiveAt=new Date(new Date(`${end}T00:00:00+03:00`).getTime()+24*60*60*1000).toISOString();
  const q=await db.query(`
    WITH sums AS (
      SELECT c.id,c.name,c.phone,c.payout_name,c.payout_method,c.payout_identifier,
        COALESCE(SUM(ABS(le.amount)) FILTER(
          WHERE le.entry_type='PRODUCTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
            AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz
            AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) production,
        COALESCE(SUM(ABS(le.amount)) FILTER(
          WHERE le.entry_type='CONSUMPTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
            AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz
            AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) consumption,
        COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
          THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END)
          FILTER(WHERE le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) production_qty,
        COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.reference_type,'')<>'green_partial' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
          THEN CASE WHEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(le.metadata->>'workloadQuantity',le.metadata->>'quantity')::numeric ELSE 1 END ELSE 0 END)
          FILTER(WHERE le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) consumption_qty,
        COALESCE(SUM(-le.amount) FILTER(
          WHERE le.amount<0 AND COALESCE(le.metadata->>'type','')='WEEKLY_FLOOR'
            AND (COALESCE(le.metadata->>'weekEnd','')=$3::text OR (COALESCE(le.metadata->>'weekEnd','')='' AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz))
            AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) floor_paid,
        COALESCE(SUM(CASE WHEN COALESCE(le.metadata->>'type','')='WEEKLY_ORDER_BATCH' THEN -le.amount WHEN COALESCE(le.metadata->>'type','')='WEEKLY_ORDER_BATCH_REFUND' THEN -le.amount ELSE 0 END) FILTER(
          WHERE COALESCE(le.metadata->>'type','') IN ('WEEKLY_ORDER_BATCH','WEEKLY_ORDER_BATCH_REFUND')
            AND (COALESCE(le.metadata->>'weekEnd','')=$3::text OR (COALESCE(le.metadata->>'weekEnd','')='' AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz))
            AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'),0) batch_paid
      FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id GROUP BY c.id
    ), balances AS (
      SELECT c.id,COALESCE(SUM(le.amount) FILTER(
        WHERE le.created_at < $2::timestamptz
          OR (le.entry_type='REVERSAL' AND EXISTS(SELECT 1 FROM ledger_entries orig WHERE orig.id=le.reversed_entry_id AND orig.created_at < $2::timestamptz))
          OR (COALESCE(le.metadata->>'weekEnd','')=$3::text AND COALESCE(le.metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_ORDER_BATCH','WEEKLY_ORDER_BATCH_REFUND'))
      ),0) balance
      FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id GROUP BY c.id
    )
    SELECT s.*,b.balance FROM sums s JOIN balances b ON b.id=s.id ORDER BY s.name
  `,[startAt,endExclusiveAt,end]);
  const floorIssues=[],orderBatchIssues=[];
  const rows=q.rows.map(x=>{
    const prodQty=n(x.production_qty),consQty=n(x.consumption_qty),effectiveCount=Math.max(prodQty,consQty);
    const classification=n(x.production)>n(x.consumption)&&n(x.production)>0?"PRODUCER":((n(x.production)||n(x.consumption))?"CONSUMER":"NO_ACTIVITY");
    // V3.8.5.39: قاعدة 40 ملغاة، والأرضية الوحيدة 1.50 د.أ الخميس 21:00 عمّان.
    // الجمعة تعرض أي أرضية مفقودة للتدقيق فقط ولا تنشئ خصمًا بديلًا؛ هذا يمنع
    // نزول الأرضية في توقيت غير الخميس 9 مساءً.
    const floorPaid=money(x.floor_paid),batchPaid=money(x.batch_paid);
    const missingFloor=classification!=="NO_ACTIVITY"?money(Math.max(0,FLOOR-floorPaid)):0;
    const missingBatch=0;
    if(classification!=="NO_ACTIVITY"&&Math.abs(floorPaid-FLOOR)>.001)floorIssues.push({captainId:String(x.id),captainName:x.name,expected:FLOOR,actual:floorPaid,missing:missingFloor});
    const autoDed=0,before=money(n(x.balance)),due=classification==="PRODUCER"?money(Math.max(0,before-RESERVE)):0;
    return {captainId:String(x.id),captainName:x.name,phone:x.phone,classification,production:money(x.production),consumption:money(x.consumption),movementProduction:money(x.production),movementConsumption:money(x.consumption),productionMovementCount:prodQty,consumptionMovementCount:consQty,movementCount:effectiveCount,deductions:money(floorPaid+batchPaid),net:money(n(x.production)-n(x.consumption)),currentBalance:money(x.balance),cutoffBalance:money(x.balance),laterMovementDelta:0,laterRechargeTotal:0,laterNetChange:0,projectedCurrentAfterAutomaticDeductions:before,projectedActualBalanceAfterTransfer:money(before-due),projectedFloor:0,missingScheduledFloor:missingFloor,projectedOrderDeduction:0,projectedAutomaticDeductions:autoDed,balanceBefore:before,reserveAmount:classification==="PRODUCER"?RESERVE:0,amountDue:due,balanceAfter:money(before-due),payoutName:x.payout_name||x.name,payoutMethod:x.payout_method||"",payoutIdentifier:x.payout_identifier||""}
  });
  return {weekStart:start,weekEnd:end,reserveBalance:RESERVE,rows,producers:rows.filter(x=>x.classification==="PRODUCER").length,consumers:rows.filter(x=>x.classification==="CONSUMER").length,noActivity:rows.filter(x=>x.classification==="NO_ACTIVITY").length,projectedAutomaticDeductions:money(rows.reduce((a,x)=>a+x.projectedAutomaticDeductions,0)),totalDue:money(rows.reduce((a,x)=>a+x.amountDue,0)),ready:true,blockingIssues:[],reconciliation:{blockingIssues:[],floorIssues,orderBatchIssues}}
}
async function latestFridaySession(){const r=await db.query(`SELECT f.*,u.username FROM friday_group_sessions f LEFT JOIN users u ON u.id=f.requested_by_user_id ORDER BY f.id DESC LIMIT 1`);if(!r.rowCount)return {status:"IDLE"};const x=r.rows[0];return {id:String(x.id),status:x.status,periodKey:x.period_key,requestedBy:x.requested_by||x.username||"",groupOpen:x.group_open,startedAt:x.started_at,deadlineMs:x.deadline_at?new Date(x.deadline_at).getTime():0,cutoffAt:x.cutoff_at,closeAttempts:x.close_attempts,producers:x.producers,totalDue:n(x.total_due),cleanupRemoved:x.cleanup_removed,lastError:x.last_error||"",finalNote:x.final_note||""}}
export async function getFridaySession(){return await latestFridaySession()}
export async function startFridaySession(userId,username){const g=await greenPublicSettings();const p=await fridayPreview();let groupOpen=null,lastError="";if(g.enabled&&g.groupId){try{await greenSend(g.groupId,"🔒 *تنبيه إغلاق الجمعة*\n\nيرجى الانتظار دقائق قليلة. جاري تدقيق الجرد وترحيل أرصدة الأسبوع.\n\n*مؤسسة أبشر فزعة الشمال*");await greenGroupPosting(g.groupId,false);groupOpen=false}catch(e){lastError=e.message}}
const r=await db.query(`INSERT INTO friday_group_sessions(status,period_key,requested_by_user_id,requested_by,group_id,group_name,group_open,deadline_at,cutoff_at,close_attempts,producers,total_due,last_error) VALUES('READY',$1,$2,$3,$4,$5,$6,NOW()+INTERVAL '15 minutes',NOW(),1,$7,$8,$9) RETURNING id`,[p.weekEnd,userId,username,g.groupId||null,g.groupName||null,groupOpen,p.producers,p.totalDue,lastError||null]);await audit(userId,"friday.session.start","friday_session",r.rows[0].id,{periodKey:p.weekEnd,totalDue:p.totalDue});return await latestFridaySession()}
async function applyWeeklyDeductions(preview,userId){
  // V3.8.5.39: no Friday fallback charge.
  // Missing floors are audit issues only; the actual floor is created exclusively
  // by the Thursday 21:00 scheduler (with Friday restart catch-up using Thursday timestamp).
  return {applied:0,scheduledOnly:true,weekEnd:preview?.weekEnd||null};
}
export async function commitFriday(userId){
  const lockClient=await db.connect();let locked=false,ownsSession=false,preview=null,settlementId=null,commitError=null,openError="",noticeError="";
  try{
    const lk=await lockClient.query(`SELECT pg_try_advisory_lock(3855001) locked`);
    if(!lk.rows[0]?.locked)throw new Error("ترحيل الجمعة يعمل الآن من جلسة أخرى — انتظر حتى يكتمل");
    locked=true;
    await db.query(`UPDATE friday_group_sessions SET status='COMMITTING',updated_at=NOW(),last_error=NULL WHERE id=(SELECT id FROM friday_group_sessions ORDER BY id DESC LIMIT 1)`);
    ownsSession=true;
    try{
      await repairWeeklyFloors(userId);
      preview=await fridayPreview();
      await applyWeeklyDeductions(preview,userId);
      const ws=await db.query(`INSERT INTO weekly_settlements(week_start,week_end,status,created_by_user_id,closed_at) VALUES($1,$2,'closed',$3,NOW()) ON CONFLICT(week_start,week_end) DO UPDATE SET status='closed',closed_at=NOW() RETURNING *`,[preview.weekStart,preview.weekEnd,userId]);
      settlementId=ws.rows[0].id;
      for(const x of preview.rows){
        await db.query(`INSERT INTO weekly_settlement_items(settlement_id,captain_id,production,consumption,net,amount_due,reserve_amount,balance_before,balance_after,movement_count,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'due') ON CONFLICT(settlement_id,captain_id) DO UPDATE SET production=EXCLUDED.production,consumption=EXCLUDED.consumption,net=EXCLUDED.net,amount_due=EXCLUDED.amount_due,reserve_amount=EXCLUDED.reserve_amount,balance_before=EXCLUDED.balance_before,balance_after=EXCLUDED.balance_after,movement_count=EXCLUDED.movement_count WHERE weekly_settlement_items.status='due'`,[settlementId,x.captainId,x.production,x.consumption,x.net,x.amountDue,x.reserveAmount,x.balanceBefore,x.balanceAfter,Math.trunc(n(x.movementCount))]);
      }
    }catch(e){commitError=e;}

    if(ownsSession){
      const g=await greenPublicSettings().catch(()=>null);
      if(g?.enabled&&g.groupId){
        try{await greenGroupPosting(g.groupId,true)}catch(e){openError=String(e?.message||e)}
        if(!openError){try{await greenSend(g.groupId,commitError?"⚠️ *تم فتح القروب بعد تعذر ترحيل الجمعة*\n\nراجع لوحة المحاسب قبل إعادة المحاولة.\n*مؤسسة أبشر فزعة الشمال*":"✅ *تم الانتهاء من تدقيق وترحيل أرصدة الأسبوع*\n\nتم فتح القروب ويمكنكم العودة للعمل.\n*مؤسسة أبشر فزعة الشمال*")}catch(e){noticeError=String(e?.message||e)}}
      }
      if(commitError){
        await db.query(`UPDATE friday_group_sessions SET status='ERROR',group_open=$1,final_note=$2,last_error=$3,updated_at=NOW() WHERE id=(SELECT id FROM friday_group_sessions ORDER BY id DESC LIMIT 1)`,[openError?null:true,openError?"فشل الترحيل وتعذر تأكيد فتح القروب":"فشل الترحيل وتم فتح القروب بأمان",[String(commitError?.message||commitError),openError,noticeError].filter(Boolean).join(" | ")]);
        throw commitError;
      }
      await db.query(`UPDATE friday_group_sessions SET status=$1,group_open=$2,final_note=$3,last_error=$4,updated_at=NOW() WHERE id=(SELECT id FROM friday_group_sessions ORDER BY id DESC LIMIT 1)`,[openError?"EMERGENCY_LOCKED":"COMPLETED",openError?null:true,openError?"تم الترحيل لكن تعذر تأكيد فتح القروب":"تم الترحيل وفتح القروب",[openError,noticeError].filter(Boolean).join(" | ")||null]);
      await audit(userId,"friday.commit","weekly_settlement",settlementId,{totalDue:preview.totalDue,noticeError:noticeError||null});
      return {preview,settlementId,session:await latestFridaySession(),warning:Boolean(openError||noticeError)};
    }
  }finally{
    if(locked)await lockClient.query(`SELECT pg_advisory_unlock(3855001)`).catch(()=>{});
    lockClient.release();
  }
}
export async function forceOpenFriday(userId){const g=await greenPublicSettings();let err="";if(g.enabled&&g.groupId){try{await greenGroupPosting(g.groupId,true)}catch(e){err=e.message}}await db.query(`UPDATE friday_group_sessions SET status=$1,group_open=$2,last_error=$3,final_note=$4,updated_at=NOW() WHERE id=(SELECT id FROM friday_group_sessions ORDER BY id DESC LIMIT 1)`,[err?"EMERGENCY_LOCKED":"CANCELLED",err?null:true,err||null,err?"تعذر تأكيد الفتح":"تم فتح القروب يدويًا"]);await audit(userId,"friday.force_open","system","friday",{error:err});if(err)throw new Error(err);return await latestFridaySession()}
async function settlementItem(id){const r=await db.query(`SELECT wsi.*,c.name captain_name,ws.week_end FROM weekly_settlement_items wsi JOIN captains c ON c.id=wsi.captain_id JOIN weekly_settlements ws ON ws.id=wsi.settlement_id WHERE wsi.id=$1`,[id]);return r.rows[0]||null}
export async function reconcileFridaySettlementStates(){
  // V3.8.5.46: repair historical/stale rows that still say `due` even though
  // the one-time Friday debit already exists. The ledger reference is the
  // strongest proof that payment was committed, so the settlement row must
  // never reappear as pending after refresh.
  const r=await db.query(`
    WITH paid AS (
      SELECT DISTINCT ON (wsi.id)
        wsi.id AS item_id,le.id AS debit_id,le.created_at AS debit_at
      FROM weekly_settlement_items wsi
      JOIN ledger_entries le
        ON le.captain_id=wsi.captain_id
       AND le.entry_type='FRIDAY_SETTLEMENT'
       AND le.reference_type='friday_payment'
       AND le.reference_id=wsi.id::text
       AND le.reversed_at IS NULL
      WHERE wsi.status='due'
      ORDER BY wsi.id,le.created_at DESC,le.id DESC
    )
    UPDATE weekly_settlement_items wsi
       SET status='transferred',
           transferred_at=COALESCE(wsi.transferred_at,paid.debit_at),
           friday_debit_entry_id=COALESCE(wsi.friday_debit_entry_id,paid.debit_id),
           payment_note=CASE
             WHEN COALESCE(wsi.payment_note,'')='' THEN 'AUTO_REPAIRED_FROM_LEDGER'
             WHEN POSITION('AUTO_REPAIRED_FROM_LEDGER' IN wsi.payment_note)=0 THEN wsi.payment_note||' | AUTO_REPAIRED_FROM_LEDGER'
             ELSE wsi.payment_note
           END
      FROM paid
     WHERE wsi.id=paid.item_id
    RETURNING wsi.id
  `);
  return {repaired:r.rowCount||0,ids:r.rows.map(x=>String(x.id))};
}
export async function ensureFridaySettlement(captainId,periodKey,userId){
  const p=await fridayPreview(periodKey||lastCompletedWeek().end);
  const row=p.rows.find(x=>String(x.captainId)===String(captainId));
  if(!row)throw new Error("الكابتن غير موجود في معاينة الجمعة");
  const ws=await db.query(`INSERT INTO weekly_settlements(week_start,week_end,status,created_by_user_id) VALUES($1,$2,'open',$3) ON CONFLICT(week_start,week_end) DO UPDATE SET created_by_user_id=COALESCE(weekly_settlements.created_by_user_id,EXCLUDED.created_by_user_id) RETURNING *`,[p.weekStart,p.weekEnd,userId]);
  const settlementId=ws.rows[0].id;
  const q=await db.query(`INSERT INTO weekly_settlement_items(settlement_id,captain_id,production,consumption,net,amount_due,reserve_amount,balance_before,balance_after,movement_count,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'due') ON CONFLICT(settlement_id,captain_id) DO UPDATE SET production=EXCLUDED.production,consumption=EXCLUDED.consumption,net=EXCLUDED.net,amount_due=EXCLUDED.amount_due,reserve_amount=EXCLUDED.reserve_amount,balance_before=EXCLUDED.balance_before,balance_after=EXCLUDED.balance_after,movement_count=EXCLUDED.movement_count WHERE weekly_settlement_items.status='due' RETURNING *`,[settlementId,captainId,row.production,row.consumption,row.net,row.amountDue,row.reserveAmount,row.balanceBefore,row.balanceAfter,Math.trunc(n(row.movementCount))]);
  // ON CONFLICT ... WHERE returns no row when a terminal record already exists.
  // Resolve that canonical record instead of crashing or creating a duplicate.
  let item=q.rows[0];
  if(!item){
    const existing=await db.query(`SELECT id FROM weekly_settlement_items WHERE settlement_id=$1 AND captain_id=$2 LIMIT 1`,[settlementId,captainId]);
    item=existing.rows[0];
  }
  if(!item)throw new Error("تعذر تجهيز سجل تسوية الجمعة");
  return await settlementItem(item.id);
}
export async function payFridaySettlement(id,userId,note=""){const client=await db.connect();try{await client.query("BEGIN");const q=await client.query(`SELECT wsi.*,c.name captain_name FROM weekly_settlement_items wsi JOIN captains c ON c.id=wsi.captain_id WHERE wsi.id=$1 FOR UPDATE`,[id]);if(!q.rowCount)throw new Error("تسوية الجمعة غير موجودة");const x=q.rows[0];if(x.status==="transferred"){const balance=await getBalance(x.captain_id,client);await client.query("COMMIT");return {already:true,item:x,balance,paidAmount:n(x.amount_due ?? x.net ?? 0)};}if(x.status!=="due")throw new Error("حالة التسوية لا تسمح بالتحويل");const amt=money(n(x.amount_due ?? x.net ?? 0));let entryId=null;if(amt>0){const bal=n(await getBalance(x.captain_id,client));const ins=await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id) VALUES($1,$2,'FRIDAY_SETTLEMENT','debit','friday_payment',$3,$4,$5::jsonb,$6) ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING RETURNING id`,[x.captain_id,-amt,String(x.id),`خصم تحويل الجمعة — ${x.captain_name}`,JSON.stringify({type:"FRIDAY_SETTLEMENT",settlementItemId:x.id,balanceBefore:bal}),userId]);entryId=ins.rows[0]?.id||x.friday_debit_entry_id}
const u=await client.query(`UPDATE weekly_settlement_items SET status='transferred',transferred_at=NOW(),transferred_by_user_id=$2,payment_note=$3,friday_debit_entry_id=COALESCE($4,friday_debit_entry_id) WHERE id=$1 RETURNING *`,[id,userId,String(note||""),entryId||null]);const balance=await getBalance(x.captain_id,client);await client.query("COMMIT");await audit(userId,"friday.paid","weekly_settlement_item",id,{amount:amt,balance});return {item:u.rows[0],balance,paidAmount:amt,message:`تم تسجيل تحويل ${amt.toFixed(3)} د.أ إلى ${x.captain_name} — الرصيد الآن ${Number(balance).toFixed(3)} د.أ`}}catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}}
export async function returnFridaySettlement(id,userId,note=""){
  const returned=await db.query(`
    UPDATE weekly_settlement_items AS wsi
    SET status='archived',payment_note=$2
    FROM captains c,weekly_settlements ws
    WHERE wsi.id=$1 AND wsi.status='due'
      AND c.id=wsi.captain_id AND ws.id=wsi.settlement_id
    RETURNING wsi.*,c.name AS captain_name,ws.week_end,NOW() AS returned_at
  `,[id,`RETURNED: ${note||""}`]);
  let x=returned.rows[0];
  if(!x){
    x=await settlementItem(id);
    if(!x)throw new Error("التسوية غير موجودة");
    if(!(x.status==="archived"&&/^RETURNED:/i.test(String(x.payment_note||"")))){
      throw new Error("يمكن إرجاع التسوية المعلّقة فقط قبل تسجيل التحويل");
    }
    const balance=await getBalance(x.captain_id);
    return {already:true,balance,amount:n(x.amount_due),captainId:x.captain_id,weekEnd:x.week_end,returnedAt:"",message:`المبلغ مُعاد مسبقًا إلى رصيد ${x.captain_name}`};
  }
  await audit(userId,"friday.return","weekly_settlement_item",id,{amount:n(x.amount_due)});
  const balance=await getBalance(x.captain_id);
  return {balance,amount:n(x.amount_due),captainId:x.captain_id,weekEnd:x.week_end,returnedAt:x.returned_at,message:`تم إلغاء تحويل ${n(x.amount_due).toFixed(3)} د.أ وإبقاء المبلغ في رصيد ${x.captain_name}`};
}
export async function verifyFridaySettlement(id,userId){const x=await settlementItem(id);if(!x)throw new Error("التسوية غير موجودة");if(x.status!=="transferred")throw new Error("التسوية ليست مدفوعة");const e=await db.query(`SELECT id FROM ledger_entries WHERE reference_type='friday_payment' AND reference_id=$1 AND reversed_at IS NULL LIMIT 1`,[String(id)]);if(!e.rowCount){const client=await db.connect();try{await client.query("BEGIN");const amt=money(n(x.amount_due ?? x.net ?? 0));let entryId=null;if(amt>0){const ins=await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id) VALUES($1,$2,'FRIDAY_SETTLEMENT','debit','friday_payment',$3,$4,$5::jsonb,$6) ON CONFLICT(captain_id,entry_type,reference_type,reference_id) WHERE reference_id IS NOT NULL DO NOTHING RETURNING id`,[x.captain_id,-amt,String(x.id),`إصلاح خصم الجمعة — ${x.captain_name}`,JSON.stringify({type:'FRIDAY_SETTLEMENT',settlementItemId:x.id,repair:true}),userId]);entryId=ins.rows[0]?.id||null;}await client.query(`UPDATE weekly_settlement_items SET friday_debit_entry_id=COALESCE($2,friday_debit_entry_id) WHERE id=$1`,[id,entryId]);await client.query("COMMIT");return {message:"تم إصلاح خصم الجمعة",balance:await getBalance(x.captain_id),paidAmount:amt}}catch(err){await client.query("ROLLBACK");throw err}finally{client.release()}}return {message:"خصم الجمعة موجود وسليم؛ لم يتم تكرار الخصم",balance:await getBalance(x.captain_id)}}
export async function undoLastFriday(userId,reason){const ws=await db.query(`SELECT * FROM weekly_settlements WHERE status<>'archived' ORDER BY week_end DESC LIMIT 1`);if(!ws.rowCount)throw new Error("لا يوجد ترحيل سابق للتراجع");const items=await db.query(`SELECT * FROM weekly_settlement_items WHERE settlement_id=$1`,[ws.rows[0].id]);let reversed=0;for(const x of items.rows){if(x.friday_debit_entry_id){try{await reverseLedgerEntry({entryId:x.friday_debit_entry_id,createdBy:userId,reason:reason||"تراجع عن ترحيل الجمعة"});reversed++}catch(e){if(e.message!=="entry_already_reversed")throw e}}}await db.query(`UPDATE weekly_settlement_items SET status='archived',payment_note=COALESCE(payment_note,'')||' | REVERTED' WHERE settlement_id=$1`,[ws.rows[0].id]);await db.query(`UPDATE weekly_settlements SET status='archived' WHERE id=$1`,[ws.rows[0].id]);await audit(userId,"friday.revert","weekly_settlement",ws.rows[0].id,{reason,reversed});return {message:`تم التراجع عن آخر ترحيل وعكس ${reversed} خصم جمعة`,reversed}}

export async function openIssue({dedupKey,origin="SYSTEM",issueType,severity="WARNING",sourceId="",relatedId="",summary,details={},suggestedAction=""}){const r=await db.query(`INSERT INTO system_issues(dedup_key,origin,issue_type,severity,status,source_id,related_id,summary,details,suggested_action) VALUES($1,$2,$3,$4,'OPEN',$5,$6,$7,$8::jsonb,$9) ON CONFLICT(dedup_key) DO UPDATE SET origin=EXCLUDED.origin,issue_type=EXCLUDED.issue_type,severity=EXCLUDED.severity,status=CASE WHEN system_issues.status IN ('RESOLVED','DISMISSED') THEN system_issues.status ELSE 'OPEN' END,source_id=EXCLUDED.source_id,related_id=EXCLUDED.related_id,summary=EXCLUDED.summary,details=EXCLUDED.details,suggested_action=EXCLUDED.suggested_action,updated_at=NOW() RETURNING *`,[dedupKey||null,origin,issueType||"SYSTEM",severity,sourceId||null,relatedId||null,summary||issueType||"مشكلة",JSON.stringify(details||{}),suggestedAction||null]);return r.rows[0]}
export async function resolveIssueNative(id,action,note,userId){const status=String(action)==="DISMISS"?"DISMISSED":"RESOLVED";const r=await db.query(`UPDATE system_issues SET status=$2,resolution_note=$3,resolved_by_user_id=$4,resolved_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *`,[id,status,String(note||""),userId]);if(!r.rowCount)throw new Error("المشكلة غير موجودة");await audit(userId,"issue.resolve","system_issue",id,{status,note});return r.rows[0]}
export async function clearSystemIssuesNative(userId){const r=await db.query(`DELETE FROM system_issues`);await audit(userId,"issue.clear_all","system_issue","all",{deleted:Number(r.rowCount||0)});return {deleted:Number(r.rowCount||0)}}
export async function reprocessIssueNative(id,userId){const q=await db.query(`SELECT * FROM system_issues WHERE id=$1`,[id]);if(!q.rowCount)throw new Error("المشكلة غير موجودة");const x=q.rows[0];if(x.source_id){const ev=await db.query(`SELECT raw_payload FROM whatsapp_events WHERE id_message=$1`,[x.source_id]);if(ev.rowCount)return {replayPayload:ev.rows[0].raw_payload,issue:x}}await resolveIssueNative(id,"RESOLVE","تمت المراجعة ولا يوجد حدث قابل لإعادة المعالجة",userId);return {issue:x}}

export async function addCancellationNumber(payload,userId){const phone=displayPhone(payload?.phone);if(!normPhone(phone))throw new Error("أدخل رقم هاتف صحيح");const r=await db.query(`INSERT INTO inventory_cancellation_numbers(name,phone,status,created_by_user_id,updated_by_user_id) VALUES($1,$2,'ACTIVE',$3,$3) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,status='ACTIVE',updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW() RETURNING *`,[String(payload?.name||"مسؤول إلغاء").trim(),phone,userId]);await audit(userId,"cancellation_number.add","cancellation_number",r.rows[0].id,{phone});return r.rows[0]}
export async function setCancellationNumberStatus(id,status,userId){const st=["ACTIVE","DISABLED"].includes(String(status))?String(status):"DISABLED";const r=await db.query(`UPDATE inventory_cancellation_numbers SET status=$2,updated_by_user_id=$3,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,st,userId]);if(!r.rowCount)throw new Error("الرقم غير موجود");return r.rows[0]}
export async function removeCancellationNumberNative(id,userId){const r=await db.query(`UPDATE inventory_cancellation_numbers SET status='REMOVED',updated_by_user_id=$2,updated_at=NOW() WHERE id=$1 RETURNING *`,[id,userId]);if(!r.rowCount)throw new Error("الرقم غير موجود");return r.rows[0]}
async function cancellationAuthorized(phone){
  const digits=normPhone(phone);
  if(!/^7[789][0-9]{7}$/.test(digits))return null;
  // Staff whose login username is their WhatsApp number, or a captain with an
  // active delegated-admin grant, may manage reaction adjustments. Never infer
  // authorization from the WhatsApp display name.
  const staff=await db.query(`SELECT u.id,u.username FROM users u
    WHERE u.role IN ('admin','accountant') AND u.is_active=TRUE
      AND RIGHT(regexp_replace(u.username,'[^0-9]','','g'),9)=$1 LIMIT 1`,[digits]);
  if(staff.rowCount)return {name:staff.rows[0].username,phone:digits,source:"staff"};
  let grant;
  try{
    grant=await db.query(`SELECT c.name,c.phone FROM captain_admin_grants g
      JOIN captains c ON c.id=g.captain_id
      JOIN users u ON u.captain_id=c.id AND u.role='captain' AND u.is_active=TRUE
      WHERE g.active=TRUE AND jsonb_array_length(g.permissions)>0
      AND (RIGHT(regexp_replace(c.phone,'[^0-9]','','g'),9)=$1
           OR RIGHT(regexp_replace(u.username,'[^0-9]','','g'),9)=$1)
      LIMIT 1`,[digits]);
  }catch(e){if(e.code!=="42P01")throw e;}
  if(grant?.rowCount)return {name:grant.rows[0].name,phone:digits,source:"delegated_admin"};
  const r=await db.query(`SELECT * FROM inventory_cancellation_numbers
    WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=$1 AND status='ACTIVE' LIMIT 1`,[digits]);
  return r.rows[0]||null;
}
async function activeCancellationLock(doneId){const exact=String(doneId||'');const canonical=canonicalWhatsappMessageId(exact);const r=await db.query(`SELECT * FROM inventory_reaction_cancellations WHERE status='LOCKED' AND (done_message_id=$1 OR ($2<>'' AND (done_message_id=$2 OR POSITION($2 IN done_message_id)>0))) ORDER BY created_at DESC,id DESC LIMIT 1`,[exact,canonical]);return r.rows[0]||null}
export async function reopenCancellationNative(id,reason,userId){const picked=await db.query(`SELECT done_message_id FROM inventory_reaction_cancellations WHERE id=$1 LIMIT 1`,[id]);if(!picked.rowCount)throw new Error("الإلغاء غير موجود");const doneId=String(picked.rows[0].done_message_id||"");const r=await db.query(`UPDATE inventory_reaction_cancellations SET status='REOPENED',reopened_by_user_id=$2,reopened_at=NOW(),reopen_reason=$3 WHERE done_message_id=$1 AND status='LOCKED' RETURNING *`,[doneId,userId,String(reason||"")]);if(!r.rowCount)throw new Error("الجرد غير مقفل أو تمت إعادة فتحه مسبقًا");return r.rows[0]}

function parseFare(text){
  const lines=String(text||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);if(!lines.length)return null;
  const all=arDigits(text).replace(/[،,٫]/g,".");let token=null;
  const first=arDigits(lines[0]).replace(/[،,٫]/g,".");
  const labeled=all.match(/(?:السعر|سعر|المبلغ|مبلغ|الاجره|الاجرة|التوصيل|توصيل)\s*[:=\-]?\s*(\d+(?:\.\d+)?)/i);
  const compact=first.match(/^\s*(\d+(?:\.\d+)?)\s*(?:د(?:ينار|نانير)?|ليره|ليرة)?\s*$/i);
  const curr=all.match(/(\d+(?:\.\d+)?)\s*(?:دنانير|دينار|د\.?\s*ا?|ليرات|ليرة|ليره)/i);
  token=labeled?.[1]||compact?.[1]||curr?.[1]||null;
  if(!token)return null;
  const fare=n(token);return fare>=0?{fare}:null;
}
function explicitCount(text,terms){
  const t=normText(arDigits(text));
  for(const term of terms){
    let m=t.match(new RegExp(`(\\d+)\\s*(?:${term})(?!\\w)`));
    if(m)return Math.max(0,parseInt(m[1],10));
    m=t.match(new RegExp(`(?:${term})\\s*[:=\-]?\\s*(\\d+)(?!\\s*(?:د|دينار|دنانير|ليره|ليرة|ليرات))`));
    if(m)return Math.max(0,parseInt(m[1],10));
  }
  return null;
}
function passengerCountFromText(t){
  let q=explicitCount(t,["راكب(?:ين|ان|ات)?","ركاب","راكبات","بنت(?:ين|ان|ات)?","زلم(?:ه|ة|تين|تان)?"]);if(q!==null)return q;
  if(/(?:راكبين|راكبان|بنتين|بنتان|زلمتين|زلمتان)/.test(t))return 2;
  if(/(?:^|\s)(?:راكب|راكبه|بنت|زلمه|زلمة)(?:\s|$)/.test(t))return 1;
  // Unnumbered plurals are ambiguous: never guess their count from the fare.
  if(/(?:ركاب|راكبات|بنات|شباب)/.test(t))return null;
  return undefined;
}
function orderCountFromText(t){
  let q=explicitCount(t,["اوردر(?:ين|ان|ات)?","اردر(?:ين|ان|ات)?","طلب(?:ين|ان|ات)?","طلبي(?:ه|ات)"]);if(q!==null)return q;
  if(/(?:اوردرين|اوردران|اردرين|اردران|طلبين|طلبان)/.test(t))return 2;
  if(/(?:^|\s)(?:اوردر|اردر|طلب|طلبيه)(?:\s|$)/.test(t))return 1;
  if(/(?:اوردرات|اردرات|طلبات|طلبيات)/.test(t))return null;
  return undefined;
}
function fareDerivedQuantity(text){
  const fareInfo=parseFare(text);
  if(!fareInfo||!Number.isFinite(Number(fareInfo.fare))||Number(fareInfo.fare)<=0)return null;
  // Approved inventory rule: when no explicit quantity is written, quantity = rounded fare / 5.
  // Examples: 10 JOD => 2 units, 15 => 3, 25 => 5.
  return Math.max(1,Math.min(100,Math.round(Number(fareInfo.fare)/5)));
}
function passengerHasExplicitCount(t){
  if(explicitCount(t,["راكب(?:ين|ان|ات)?","ركاب","راكبات","بنت(?:ين|ان|ات)?","زلم(?:ه|ة|تين|تان)?"])!==null)return true;
  return /(?:راكبين|راكبان|بنتين|بنتان|زلمتين|زلمتان)/.test(t);
}
function orderHasExplicitCount(t){
  if(explicitCount(t,["اوردر(?:ين|ان|ات)?","اردر(?:ين|ان|ات)?","طلب(?:ين|ان|ات)?","طلبي(?:ه|ات)"])!==null)return true;
  return /(?:اوردرين|اوردران|اردرين|اردران|طلبين|طلبان)/.test(t);
}
// Only events accepted by the authenticated north bridge opt into fare / 5.
// Keep legacy bridge markers readable for stored events retried after registration.
export function inventoryOptions(payload={}){
  return {north:payload?._abshirInventoryMode==='north'
    || (payload?._dropcode?.schema==='dropcode.event.v1' && payload?._dropcode?.groupMode==='north')
    || payload?._waha?.dropcode?.mode==='north'};
}
export function inventorySourceAccess(payload={},greenSettings={},force=false){
  const north=Boolean(inventoryOptions(payload).north);
  const group=String(payload?.senderData?.chatId||'');
  if(!force&&!north&&!greenSettings?.enabled)return {allowed:false,reason:'green_disabled',north};
  if(!north&&greenSettings?.groupId&&group!==String(greenSettings.groupId))return {allowed:false,reason:'other_group',north};
  return {allowed:true,reason:null,north};
}
export function detectComponents(text,{north=false}={}){
  const t=normText(arDigits(text));
  if(!t)return [];
  // Strip the fare token before explicit-quantity parsing so the fare itself is never mistaken
  // for a written count. The fare is then used only as the fallback quantity source below.
  const countText=t
    .replace(/(?:السعر|سعر|المبلغ|مبلغ|الاجره|الاجرة|التوصيل|توصيل)\s*[:=\-]?\s*\d+(?:\.\d+)?/g,' ')
    .replace(/\d+(?:\.\d+)?\s*(?:دنانير|دينار|د\.?\s*ا?|ليرات|ليرة|ليره)/g,' ')
    .replace(/\s+/g,' ').trim();
  let p=passengerCountFromText(countText),o=orderCountFromText(countText);
  let hasP=p!==undefined,hasO=o!==undefined;
  const fareQty=north?fareDerivedQuantity(text):null;

  // ABSHIR V76 approved fallback:
  // Any non-empty written request that does not explicitly say ORDER is a PASSENGER request.
  // North only: "السعر 15 أي كلام" => 3 passengers; ordinary groups => 1.
  if(!hasP&&!hasO){
    p=fareQty!==null?fareQty:1;
    hasP=true;
  }

  const pExplicit=hasP&&passengerHasExplicitCount(countText);
  const oExplicit=hasO&&orderHasExplicitCount(countText);

  // Single-type request: explicit quantity wins; otherwise derive the quantity from fare / 5.
  // This also resolves unnumbered plurals such as "ركاب السعر 15" => PASSENGER x3.
  if(hasP&&!hasO&&!pExplicit&&fareQty!==null)p=fareQty;
  if(hasO&&!hasP&&!oExplicit&&fareQty!==null)o=fareQty;

  // NORTH POLICY: a written fare is the accounting source of truth for a single
  // passenger/order request. Never let inferred wording or numbers in locations/times
  // increase the charge above fare / 5. Regular groups retain their own behavior.
  if(north&&fareQty!==null&&hasP!==hasO){
    if(hasP)p=fareQty;
    else o=fareQty;
  }

  // Mixed requests accept clear singular/dual counts even without a numeric prefix.
  // Example: "السعر 10 راكب و اوردر" => PASSENGER x1 + ORDER x1.
  // If the fare implies a different total, keep it for review instead of guessing the split.
  if(hasP&&hasO){
    if(p===null||o===null)return [];
    if(fareQty!==null&&Number(p)+Number(o)!==fareQty)return [];
  }

  // If there is still no safe quantity (for example plural without fare), send it to review.
  if((hasP&&p===null)||(hasO&&o===null))return [];
  const out=[];
  if(hasP&&p>0)out.push({type:"PASSENGER",quantity:p});
  if(hasO&&o>0)out.push({type:"ORDER",quantity:o});
  return out;
}
export async function repairOrphanedWeeklyFloor({captainId,occurredAt,userId=null,reason="عكس آخر حركة فعلية في الأسبوع"}={}){
  if(!captainId||!occurredAt)return {reversed:0,reason:"missing_context"};
  const {start,end}=activeWeek(new Date(occurredAt));
  const weekStartAt=new Date(`${start}T00:00:00+03:00`);
  const cleanStart=await getCleanStartState();
  const resetAt=cleanStart.status==='COMPLETED'&&cleanStart.resetAt?new Date(cleanStart.resetAt):weekStartAt;
  const startAt=new Date(Math.max(weekStartAt.getTime(),Number.isFinite(resetAt.getTime())?resetAt.getTime():weekStartAt.getTime())).toISOString();
  const endExclusiveAt=new Date(new Date(`${end}T00:00:00+03:00`).getTime()+24*60*60*1000).toISOString();
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const captain=await client.query(`SELECT id FROM captains WHERE id=$1 FOR UPDATE`,[captainId]);
    if(!captain.rowCount)throw new Error("الكابتن غير موجود");
    const work=await client.query(`
      SELECT 1 FROM ledger_entries
       WHERE captain_id=$1 AND entry_type IN ('PRODUCTION','CONSUMPTION')
         AND COALESCE(reference_type,'')<>'green_partial'
         AND reversed_at IS NULL
         AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
       LIMIT 1
    `,[captainId,startAt,endExclusiveAt]);
    if(work.rowCount){await client.query("COMMIT");return {reversed:0,reason:"active_work_remains",weekStart:start,weekEnd:end}}
    const floors=await client.query(`
      SELECT * FROM ledger_entries
       WHERE captain_id=$1 AND entry_type='WEEKLY_DEDUCTION'
         AND COALESCE(metadata->>'type','')='WEEKLY_FLOOR'
         AND reversed_at IS NULL
         AND created_at >= $3::timestamptz AND created_at < $4::timestamptz
         AND (COALESCE(metadata->>'weekEnd','')=$2::text
           OR (COALESCE(metadata->>'weekEnd','')='' AND created_at >= $3::timestamptz AND created_at < $4::timestamptz))
       ORDER BY id FOR UPDATE
    `,[captainId,end,startAt,endExclusiveAt]);
    const reversedIds=[];
    for(const floor of floors.rows){
      const already=await client.query(`SELECT 1 FROM ledger_entries WHERE reversed_entry_id=$1 LIMIT 1`,[floor.id]);
      if(already.rowCount)continue;
      await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,reversed_entry_id) VALUES($1,$2,'REVERSAL','credit','ledger_entry',$3,$4,$5::jsonb,$6,$7)`,[captainId,-Number(floor.amount),`REV-${floor.id}`,`${reason} — رد أرضية ${end}`,JSON.stringify({originalEntryType:floor.entry_type,weeklyFloorRefund:true,weekEnd:end}),userId||null,floor.id]);
      await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,NOW()) WHERE id=$1`,[floor.id]);
      reversedIds.push(floor.id);
    }
    const balance=await getBalance(captainId,client);
    if(reversedIds.length)await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'weekly_floor.refund','captain',$2,$3::jsonb)`,[userId||null,String(captainId),JSON.stringify({weekStart:start,weekEnd:end,reversedEntryIds:reversedIds,balance,reason})]);
    await client.query("COMMIT");
    return {reversed:reversedIds.length,weekStart:start,weekEnd:end,balance};
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}

async function reverseEntriesAtomically(items,userId,metadataPatch={}){
  const unique=new Map();
  for(const item of items||[]){const id=Number(item?.entry?.id);if(Number.isInteger(id)&&id>0&&!unique.has(id))unique.set(id,item)}
  if(!unique.size)return {count:0,captainIds:[]};
  const ids=[...unique.keys()],client=await db.connect();
  try{
    await client.query("BEGIN");
    const preview=await client.query(`SELECT id,captain_id FROM ledger_entries WHERE id=ANY($1::bigint[])`,[ids]);
    const captainIds=[...new Set(preview.rows.map(x=>String(x.captain_id)))].sort((a,b)=>Number(a)-Number(b));
    if(captainIds.length)await client.query(`SELECT id FROM captains WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[captainIds]);
    const originals=await client.query(`SELECT * FROM ledger_entries WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[ids]);
    const existing=await client.query(`SELECT reversed_entry_id FROM ledger_entries WHERE reversed_entry_id=ANY($1::bigint[])`,[ids]);
    const already=new Set(existing.rows.map(x=>String(x.reversed_entry_id)));
    const reversedIds=[];
    for(const entry of originals.rows){
      if(entry.reversed_at||already.has(String(entry.id)))continue;
      const reason=String(unique.get(Number(entry.id))?.reason||`عكس الحركة ${entry.id}`);
      await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,reversed_entry_id) VALUES($1,$2,'REVERSAL',$3,'ledger_entry',$4,$5,$6::jsonb,$7,$8)`,[entry.captain_id,-Number(entry.amount),Number(entry.amount)>0?"debit":"credit",`REV-${entry.id}`,reason,JSON.stringify({originalEntryType:entry.entry_type,atomicReactionReversal:true,...(metadataPatch||{})}),userId||null,entry.id]);
      reversedIds.push(entry.id);
    }
    if(reversedIds.length){
      await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,NOW()) WHERE id=ANY($1::bigint[])`,[reversedIds]);
      await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'reaction.reverse.atomic','ledger_entries',$2,$3::jsonb)`,[userId||null,reversedIds.join(","),JSON.stringify({entryIds:reversedIds,captainIds})]);
    }
    // Normalize an older reversal that exists without its original's reversed_at marker.
    const older=[...already].map(Number).filter(Number.isInteger);
    if(older.length)await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,NOW()) WHERE id=ANY($1::bigint[])`,[older]);
    await client.query("COMMIT");
    return {count:reversedIds.length,captainIds};
  }catch(e){await client.query("ROLLBACK");throw e}finally{client.release()}
}

async function reverseReaction(doneId,userId,reason,{includeLegacy=false,preserveWeeklyFloor=false,suppressBalanceSync=false,outageRecoveryJobId=""}={}){
  doneId=String(doneId);const canonicalDoneId=canonicalWhatsappMessageId(doneId);
  const q=await db.query(`SELECT * FROM ledger_entries WHERE reference_type='green_reaction' AND (metadata->>'doneMessageId'=$1 OR metadata->>'canonicalDoneMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'doneMessageId',''))>0)) ORDER BY id`,[doneId,canonicalDoneId]);
  const floorCandidates=[...q.rows];
  const toReverse=q.rows.map(entry=>({entry,reason}));

  // Partial 1️⃣–🔟 adjustments belong to the same job. A full authorized cancellation,
  // Delete-for-everyone, or removal of the active 👍 must unwind those adjustments too,
  // otherwise a remainder would stay.
  const partialEntries=(await db.query(`SELECT * FROM ledger_entries WHERE reference_type='green_partial' AND (metadata->>'doneMessageId'=$1 OR metadata->>'canonicalDoneMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'doneMessageId',''))>0)) ORDER BY id`,[doneId,canonicalDoneId])).rows;
  toReverse.push(...partialEntries.map(entry=>({entry,reason:`${reason} — عكس تعديل جزئي`})));

  if(includeLegacy){
    const marker=`DONE:${doneId}`,canonicalMarker=`DONE:${canonicalDoneId}`;
    const originals=(await db.query(`
      SELECT id,captain_id,amount,created_at FROM ledger_entries
      WHERE reference_type='legacy_sheet'
        AND description ILIKE '%جرد واتساب تلقائي%'
        AND (POSITION($1 IN COALESCE(description,''))>0 OR ($2<>'' AND POSITION($2 IN COALESCE(description,''))>0))
      ORDER BY id
    `,[marker,canonicalMarker])).rows;
    const cancellations=(await db.query(`
      SELECT le.id,le.captain_id,le.amount,
        EXISTS(SELECT 1 FROM ledger_entries rr WHERE rr.reversed_entry_id=le.id) AS cancellation_restored
      FROM ledger_entries le
      WHERE le.reference_type='legacy_sheet'
        AND le.description ILIKE '%إلغاء Reaction%'
        AND (POSITION($1 IN COALESCE(le.description,''))>0 OR ($2<>'' AND POSITION($2 IN COALESCE(le.description,''))>0))
      ORDER BY le.id
    `,[marker,canonicalMarker])).rows;
    floorCandidates.push(...originals);
    const used=new Set();
    for(const orig of originals){
      // If Google already imported an effective cancellation that offsets this exact side,
      // the historical delete/remove is already represented and must not be applied twice.
      const ci=cancellations.findIndex((c,i)=>!used.has(i)
        &&String(c.captain_id)===String(orig.captain_id)
        &&Math.abs(Number(c.amount)+Number(orig.amount))<=.0005
        &&!c.cancellation_restored);
      if(ci>=0){used.add(ci);continue;}
      toReverse.push({entry:orig,reason:`${reason} — إصلاح تاريخي DONE:${doneId}`});
    }
  }
  const reversed=await reverseEntriesAtomically(toReverse,userId,{outageRecoveryJobId:String(outageRecoveryJobId||"")||null,doneMessageId:doneId,safeOutageRecovery:Boolean(outageRecoveryJobId)});
  const count=reversed.count;
  if(partialEntries.length&&count){
    await db.query(`UPDATE inventory_reaction_cancellations SET status='REOPENED',reopened_by_user_id=$3,reopened_at=NOW(),reopen_reason=$4 WHERE (done_message_id=$1 OR ($2<>'' AND POSITION($2 IN done_message_id)>0)) AND status='PARTIAL'`,[doneId,canonicalDoneId,userId||null,reason||'تم إلغاء الحركة الأصلية']);
  }
  if(count)await db.query(`UPDATE whatsapp_events SET status='reversed',processed_at=NOW() WHERE id_message=$1 OR ($2<>'' AND POSITION($2 IN id_message)>0)`,[doneId,canonicalDoneId]);
  if(count&&!preserveWeeklyFloor){
    const unique=new Map();
    for(const entry of floorCandidates){
      if(!entry.captain_id||!entry.created_at)continue;
      const week=activeWeek(new Date(entry.created_at));
      unique.set(`${entry.captain_id}:${week.end}`,entry);
    }
    for(const entry of unique.values()){
      await repairOrphanedWeeklyFloor({captainId:entry.captain_id,occurredAt:entry.created_at,userId,reason});
    }
  }
  const impacted=[...new Set([...q.rows,...partialEntries,...floorCandidates].map(x=>String(x.captain_id||'')).filter(Boolean))];
  if(!suppressBalanceSync)await Promise.all(impacted.map(id=>syncCaptainBalanceState(id).catch(()=>null)));
  return count;
}
async function deleteForEveryoneMarker(messageIds=[]){
  const exact=[...new Set((messageIds||[]).map(x=>String(x||'').trim()).filter(Boolean))];if(!exact.length)return null;
  const canonical=[...new Set(exact.map(canonicalWhatsappMessageId).filter(Boolean))];
  const q=await db.query(`SELECT * FROM whatsapp_delete_everyone_markers WHERE target_message_id=ANY($1::text[]) OR (cardinality($2::text[])>0 AND canonical_target_id=ANY($2::text[])) OR related_done_ids ?| $1::text[] ORDER BY updated_at DESC LIMIT 1`,[exact,canonical]);
  return q.rows[0]||null;
}
async function relatedDoneMessageIdsForDelete(target,comparisonMode=false){
  const exact=String(target||'').trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return [];
  const q=comparisonMode?await db.query(`SELECT done_message_id done FROM whatsapp_comparison_jobs WHERE done_message_id=$1 OR canonical_done_id=$2 OR original_message_id=$1 OR canonical_original_id=$2 OR ($2<>'' AND POSITION($2 IN done_message_id)>0) OR ($2<>'' AND POSITION($2 IN COALESCE(original_message_id,''))>0)`,[exact,canonical]):await db.query(`SELECT DISTINCT metadata->>'doneMessageId' done FROM ledger_entries WHERE reference_type='green_reaction' AND COALESCE(metadata->>'doneMessageId','')<>'' AND (metadata->>'doneMessageId'=$1 OR metadata->>'canonicalDoneMessageId'=$2 OR metadata->>'originalMessageId'=$1 OR metadata->>'canonicalOriginalMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'doneMessageId',''))>0) OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'originalMessageId',''))>0))`,[exact,canonical]);
  return [...new Set([exact,...q.rows.map(x=>String(x.done||'').trim())].filter(Boolean))];
}
async function saveDeleteForEveryoneMarker({target,eventId,doneIds,reversed,payload,comparisonMode}){
  const q=await db.query(`INSERT INTO whatsapp_delete_everyone_markers(target_message_id,canonical_target_id,first_delete_event_id,last_delete_event_id,delete_count,reversed_count,related_done_ids,comparison_mode,deleted_at,updated_at) VALUES($1,$2,$3,$3,1,$4,$5::jsonb,$6,$7::timestamptz,NOW()) ON CONFLICT(target_message_id) DO UPDATE SET last_delete_event_id=EXCLUDED.last_delete_event_id,delete_count=whatsapp_delete_everyone_markers.delete_count+1,reversed_count=GREATEST(whatsapp_delete_everyone_markers.reversed_count,EXCLUDED.reversed_count),related_done_ids=EXCLUDED.related_done_ids,comparison_mode=EXCLUDED.comparison_mode,updated_at=NOW() RETURNING *`,[String(target),canonicalWhatsappMessageId(target),String(eventId||''),Number(reversed||0),JSON.stringify(doneIds||[]),Boolean(comparisonMode),eventIsoFromPayload(payload)]);
  return q.rows[0];
}
function comparisonComponentTotals(components=[]){const out={PASSENGER:0,ORDER:0};for(const c of components||[]){const type=String(c?.type||'').toUpperCase();if(Object.hasOwn(out,type))out[type]+=Math.max(0,n(c?.quantity))}return out}
function comparisonComponentsFromJob(job,effective=true){const p=effective?'effective_':'';return [{type:'PASSENGER',quantity:n(job?.[`${p}passenger_quantity`])},{type:'ORDER',quantity:n(job?.[`${p}order_quantity`])}].filter(x=>x.quantity>0)}
function comparisonMessageKeys(...values){return [...new Set(values.flat().map(v=>{const e=String(v||'').trim();return canonicalWhatsappMessageId(e)||e}).filter(Boolean))].sort()}
async function lockComparisonMessageKeys(client,...values){for(const key of comparisonMessageKeys(...values))await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',[key])}
async function comparisonJobByDoneId(doneId,client=db,{lock=false}={}){
  const exact=String(doneId||'').trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return null;
  const q=await client.query(`SELECT j.*,p.name producer_name,p.phone producer_phone,c.name consumer_name,c.phone consumer_phone FROM whatsapp_comparison_jobs j JOIN captains p ON p.id=j.producer_id JOIN captains c ON c.id=j.consumer_id WHERE j.done_message_id=$1 OR j.canonical_done_id=$2 OR ($2<>'' AND POSITION($2 IN j.done_message_id)>0) ORDER BY j.updated_at DESC LIMIT 1${lock?' FOR UPDATE OF j':''}`,[exact,canonical]);return q.rows[0]||null;
}
async function recordComparisonReaction({producer,consumer,components,doneMessageId,reactionId,originalMessageId,requestText='',occurredAt=null}){
  const exactDone=String(doneMessageId||'').trim(),canonicalDone=canonicalWhatsappMessageId(exactDone),totals=comparisonComponentTotals(components),eventAt=occurredAt&&Number.isFinite(new Date(occurredAt).getTime())?new Date(occurredAt).toISOString():new Date().toISOString();
  const client=await db.connect();
  try{
    await client.query('BEGIN');await lockComparisonMessageKeys(client,exactDone,originalMessageId);
    const targets=[...new Set([exactDone,String(originalMessageId||'').trim()].filter(Boolean))],canonicalTargets=comparisonMessageKeys(targets);
    const blocked=await client.query(`SELECT 1 FROM whatsapp_comparison_locks WHERE target_message_id=ANY($1::text[]) OR canonical_target_id=ANY($2::text[]) UNION ALL SELECT 1 FROM whatsapp_delete_everyone_markers WHERE target_message_id=ANY($1::text[]) OR canonical_target_id=ANY($2::text[]) OR related_done_ids ?| $1::text[] LIMIT 1`,[targets,canonicalTargets]);
    if(blocked.rowCount){await client.query('COMMIT');return {duplicate:true,locked:true,comparisonOnly:true,transactions:[]}}
    const existing=await comparisonJobByDoneId(exactDone,client,{lock:true});
    if(existing?.status==='ACTIVE'){await client.query('COMMIT');return {duplicate:true,comparisonOnly:true,transactions:[],comparisonJob:existing}}
    if(['CANCELLED_AUTHORIZED','DELETED'].includes(String(existing?.status||''))){await client.query('COMMIT');return {duplicate:true,locked:true,comparisonOnly:true,transactions:[],comparisonJob:existing}}
    const metadata=JSON.stringify({isolatedFromLedger:true,manualInventoryUntouched:true,originalComponents:components});let row;
    if(existing)row=(await client.query(`UPDATE whatsapp_comparison_jobs SET reaction_message_id=$2,producer_id=$3,consumer_id=$4,passenger_quantity=$5,order_quantity=$6,effective_passenger_quantity=$5,effective_order_quantity=$6,partial_cancel_quantity=0,original_message_id=$7,canonical_original_id=$8,request_text=$9,event_at=$10::timestamptz,status='ACTIVE',cancel_reason=NULL,cancelled_by_event_id=NULL,cancelled_at=NULL,metadata=$11::jsonb,updated_at=NOW() WHERE done_message_id=$1 RETURNING *`,[existing.done_message_id,String(reactionId||''),producer.id,consumer.id,totals.PASSENGER,totals.ORDER,String(originalMessageId||''),canonicalWhatsappMessageId(originalMessageId),String(requestText||''),eventAt,metadata])).rows[0];
    else row=(await client.query(`INSERT INTO whatsapp_comparison_jobs(done_message_id,canonical_done_id,original_message_id,canonical_original_id,reaction_message_id,producer_id,consumer_id,passenger_quantity,order_quantity,effective_passenger_quantity,effective_order_quantity,request_text,event_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,$10,$11::timestamptz,$12::jsonb) RETURNING *`,[exactDone,canonicalDone,String(originalMessageId||''),canonicalWhatsappMessageId(originalMessageId),String(reactionId||''),producer.id,consumer.id,totals.PASSENGER,totals.ORDER,String(requestText||''),eventAt,metadata])).rows[0];
    await client.query('COMMIT');const transactions=[];for(const c of components||[]){transactions.push({comparisonOnly:true,captain_id:producer.id,entry_type:'PRODUCTION',type:c.type,quantity:c.quantity},{comparisonOnly:true,captain_id:consumer.id,entry_type:'CONSUMPTION',type:c.type,quantity:c.quantity})}
    return {duplicate:false,comparisonOnly:true,transactions,comparisonJob:row,producer:{id:String(producer.id),name:String(producer.name||''),phone:String(producer.phone||'')},consumer:{id:String(consumer.id),name:String(consumer.name||''),phone:String(consumer.phone||'')},requestText:String(requestText||'')};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});if(error?.code==='23505')return {duplicate:true,comparisonOnly:true,transactions:[]};throw error}finally{client.release()}
}
async function cancelComparisonReaction(doneId,{status='CANCELLED_REACTION_REMOVED',reason='',eventId=''}={}){
  const exact=String(doneId||'').trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return 0;const client=await db.connect();
  try{await client.query('BEGIN');await lockComparisonMessageKeys(client,exact);if(status==='DELETED')await client.query(`INSERT INTO whatsapp_comparison_locks(target_message_id,canonical_target_id,lock_type,event_id,reason) VALUES($1,$2,'DELETE_EVERYONE',$3,$4) ON CONFLICT DO NOTHING`,[exact,canonical,String(eventId||''),String(reason||'')]);const q=await client.query(`UPDATE whatsapp_comparison_jobs SET status=$3,cancel_reason=$4,cancelled_by_event_id=$5,cancelled_at=NOW(),updated_at=NOW() WHERE status='ACTIVE' AND (done_message_id=$1 OR canonical_done_id=$2 OR original_message_id=$1 OR canonical_original_id=$2 OR ($2<>'' AND POSITION($2 IN done_message_id)>0) OR ($2<>'' AND POSITION($2 IN COALESCE(original_message_id,''))>0)) RETURNING done_message_id`,[exact,canonical,String(status),String(reason||''),String(eventId||'')]);await client.query('COMMIT');return q.rowCount}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
async function comparisonCancellationLock(doneId){const exact=String(doneId||'').trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return null;const q=await db.query(`SELECT * FROM whatsapp_comparison_locks WHERE target_message_id=$1 OR canonical_target_id=$2 OR ($2<>'' AND POSITION($2 IN target_message_id)>0) ORDER BY updated_at DESC LIMIT 1`,[exact,canonical]);return q.rows[0]||null}
async function authorizeComparisonCancellation(doneId,{eventId='',reason=''}={}){
  const exact=String(doneId||'').trim(),canonical=canonicalWhatsappMessageId(exact);if(!exact)return {duplicate:true,reversed:0};const client=await db.connect();
  try{await client.query('BEGIN');await lockComparisonMessageKeys(client,exact);const ins=await client.query(`INSERT INTO whatsapp_comparison_locks(target_message_id,canonical_target_id,lock_type,event_id,reason) VALUES($1,$2,'AUTHORIZED_CANCEL',$3,$4) ON CONFLICT DO NOTHING RETURNING target_message_id`,[exact,canonical,String(eventId||''),String(reason||'')]);if(!ins.rowCount){await client.query('COMMIT');return {duplicate:true,reversed:0}}const rev=await client.query(`UPDATE whatsapp_comparison_jobs SET status='CANCELLED_AUTHORIZED',cancel_reason=$3,cancelled_by_event_id=$4,cancelled_at=NOW(),updated_at=NOW() WHERE status='ACTIVE' AND (done_message_id=$1 OR canonical_done_id=$2 OR ($2<>'' AND POSITION($2 IN done_message_id)>0)) RETURNING done_message_id`,[exact,canonical,String(reason||''),String(eventId||'')]);await client.query('COMMIT');return {duplicate:false,reversed:rev.rowCount}}catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
async function recordReaction({producer,consumer,components,doneMessageId,reactionId,originalMessageId,userId=null,requestText="",repairMode=false,safeRecovery=false,outageRecoveryJobId="",occurredAt=null,comparisonMode=false}){
  if(comparisonMode)return await recordComparisonReaction({producer,consumer,components,doneMessageId,reactionId,originalMessageId,requestText,occurredAt});
  const client=await db.connect();
  try{
    await client.query("BEGIN");

    // One original request may have only one ACTIVE 👍-approved consumer.
    // Lock by canonical request id across concurrent workers. A separate DONE reply
    // must not result in a second commission for the same original request.
    const originalKey=canonicalWhatsappMessageId(originalMessageId)||String(originalMessageId||"").trim();
    if(originalKey){
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",["abshir_request_like",originalKey]);
      const winner=await client.query(`
        SELECT le.metadata->>'doneMessageId' AS done_id,
               le.metadata->>'canonicalDoneMessageId' AS canonical_done_id
        FROM ledger_entries le
        WHERE le.reference_type='green_reaction'
          AND le.entry_type='CONSUMPTION'
          AND le.reversed_at IS NULL
          AND le.metadata->>'pairRole'='consumer'
          AND (
            le.metadata->>'canonicalOriginalMessageId'=$1
            OR le.metadata->>'originalMessageId'=$2
          )
        ORDER BY le.id ASC LIMIT 1
      `,[originalKey,String(originalMessageId||"")]);
      if(winner.rowCount){
        const previous=winner.rows[0];
        const existingDone=String(previous.done_id||previous.canonical_done_id||"");
        if(!sameWhatsappMessageId(existingDone,doneMessageId)){
          await client.query("COMMIT");
          return {ignored:true,reason:"original_request_already_approved",winnerDoneMessageId:existingDone,duplicate:false,transactions:[]};
        }
      }
    }

    // Idempotency across BOTH worlds:
    // 1) entries already written by Railway (green_reaction), and
    // 2) entries imported from the old Google Sheet (legacy_sheet).
    // Old automatic inventory notes carry DONE:<messageId>; matching them here prevents
    // Friday repair from charging the same completed job a second time after migration.
    const exactDoneId=String(doneMessageId),canonicalDoneId=canonicalWhatsappMessageId(exactDoneId);
    const marker=`DONE:${exactDoneId}`,canonicalMarker=`DONE:${canonicalDoneId}`;
    const accountingAt=occurredAt?new Date(occurredAt):new Date();
    const existing=await client.query(`
      SELECT le.*
      FROM ledger_entries le
      WHERE le.reversed_at IS NULL AND le.entry_type<>'REVERSAL' AND (
        (le.reference_type='green_reaction' AND (
          le.metadata->>'doneMessageId'=$1 OR
          le.metadata->>'canonicalDoneMessageId'=$3 OR
          ($3<>'' AND POSITION($3 IN COALESCE(le.metadata->>'doneMessageId',''))>0)
        ))
        OR
        (le.reference_type='legacy_sheet'
          AND le.description ILIKE '%جرد واتساب تلقائي%'
          AND (POSITION($2 IN COALESCE(le.description,''))>0 OR ($3<>'' AND POSITION($4 IN COALESCE(le.description,''))>0)))
      )
      ORDER BY CASE WHEN le.reference_type='green_reaction' THEN 0 ELSE 1 END, le.id
    `,[exactDoneId,marker,canonicalDoneId,canonicalMarker]);

    const used=new Set();
    const tx=[];
    let legacyCovered=0,railwayCovered=0,crossProviderCovered=0,repairedQuantityMismatch=0,reversedWrongQuantity=0;

    // V3.8.5.39 compatibility calls only: ensureWeeklyFloorCharge is a no-op.
    // The weekly 1.50 floor is scheduled Thursday 21:00, never on first movement.
    for(const cap of [producer,consumer].sort((a,b)=>Number(a.id)-Number(b.id))){
      await ensureWeeklyFloorCharge(client,{captainId:cap.id,createdBy:userId,at:accountingAt,sourceReference:`GREEN:${doneMessageId}`});
    }

    function covers(row,{cap,amount,entry,type,quantity,role}){
      if(String(row.captain_id)!==String(cap.id))return false;
      if(String(row.entry_type||'').toUpperCase()!==entry)return false;
      if(Math.abs(Number(row.amount)-Number(amount))>.0005)return false;
      const meta=row.metadata||{};
      if(meta.type&&String(meta.type).toUpperCase()!==String(type).toUpperCase())return false;
      if(meta.quantity!==undefined&&meta.quantity!==null&&meta.quantity!==''&&Math.abs(Number(meta.quantity)-Number(quantity))>.0005)return false;
      if(row.reference_type==='green_reaction'&&meta.pairRole&&String(meta.pairRole)!==String(role))return false;
      return true;
    }

    for(const c of components){
      const unit=COMM[c.type],amt=money(c.quantity*unit);
      const expected=[
        {cap:producer,amount:amt,entry:"PRODUCTION",role:"producer",type:c.type,quantity:c.quantity},
        {cap:consumer,amount:-amt,entry:"CONSUMPTION",role:"consumer",type:c.type,quantity:c.quantity}
      ];
      for(const x of expected){
        let idx=existing.rows.findIndex((row,i)=>!used.has(i)&&covers(row,x));
        if(idx>=0){
          used.add(idx);
          if(existing.rows[idx].reference_type==='legacy_sheet')legacyCovered++;
          else {
            railwayCovered++;
            const oldDone=String(existing.rows[idx]?.metadata?.doneMessageId||'');
            if(oldDone&&oldDone!==exactDoneId&&sameWhatsappMessageId(oldDone,exactDoneId))crossProviderCovered++;
          }
          continue;
        }

        // V3.8.5.57 repair: older V56 rows could have the correct type/party but the wrong
        // quantity because fare was treated as metadata only (e.g. ORDER 25 JOD posted as x1).
        // During outage/repair only, reverse those Railway rows and replace them with one
        // canonical row at the newly parsed quantity. Net effect is only the missing difference
        // (x1 -> x5 becomes +4/-4), and future replays become idempotent against the x5 row.
        if(repairMode||safeRecovery){
          const wrong=[];
          existing.rows.forEach((row,i)=>{
            if(used.has(i)||row.reference_type!=='green_reaction')return;
            const meta=row.metadata||{};
            if(String(row.captain_id)!==String(x.cap.id))return;
            if(String(row.entry_type||'').toUpperCase()!==x.entry)return;
            if(String(meta.type||'').toUpperCase()!==String(x.type).toUpperCase())return;
            if(String(meta.pairRole||'')!==String(x.role))return;
            wrong.push({row,i});
          });
          if(wrong.length){
            for(const {row,i} of wrong){
              used.add(i);
              const already=await client.query(`SELECT 1 FROM ledger_entries WHERE reversed_entry_id=$1 LIMIT 1`,[row.id]);
              if(!already.rowCount){
                await client.query(`
                  INSERT INTO ledger_entries(
                    captain_id,amount,entry_type,direction,reference_type,reference_id,
                    description,metadata,created_by_user_id,reversed_entry_id,created_at
                  ) VALUES($1,$2,'REVERSAL',$3,'ledger_entry',$4,$5,$6::jsonb,$7,$8,$9::timestamptz)
                `,[
                  row.captain_id,-Number(row.amount),Number(row.amount)>=0?'debit':'credit',
                  `QTY-REPAIR-${row.id}`,
                  `تصحيح كمية جرد واتساب من السعر — عكس القيد القديم DONE:${doneMessageId}`,
                  JSON.stringify({
                    originalEntryType:row.entry_type,doneMessageId,canonicalDoneMessageId:canonicalDoneId,reactionId,canonicalReactionMessageId:canonicalWhatsappMessageId(reactionId),originalMessageId,canonicalOriginalMessageId:canonicalWhatsappMessageId(originalMessageId),
                    type:x.type,pairRole:x.role,quantityBefore:Number(row.metadata?.quantity||0),quantityAfter:Number(x.quantity),
                    fareQuantityRepair:true,skipWeeklyFloor:true,safeOutageRecovery:Boolean(safeRecovery),
                    outageRecoveryJobId:String(outageRecoveryJobId||'')||null
                  }),userId||null,row.id,accountingAt.toISOString()
                ]);
                await client.query(`UPDATE ledger_entries SET reversed_at=COALESCE(reversed_at,NOW()) WHERE id=$1`,[row.id]);
                reversedWrongQuantity++;
              }
            }
            repairedQuantityMismatch++;
          }
        }

        const balanceBefore=money(await getBalance(x.cap.id,client));
        const balanceAfter=money(balanceBefore+x.amount);
        const r=await client.query(`
          INSERT INTO ledger_entries(
            captain_id,amount,entry_type,direction,reference_type,reference_id,
            description,metadata,created_by_user_id,created_at
          ) VALUES($1,$2,$3,$4,'green_reaction',$5,$6,$7::jsonb,$8,$9::timestamptz)
          RETURNING *
        `,[
          x.cap.id,x.amount,x.entry,x.amount>=0?"credit":"debit",
          `${reactionId}:${doneMessageId}:${c.type}:${x.role}`,
          `جرد تلقائي ${c.type==='ORDER'?'أوردر':'راكب'} — ${requestText.slice(0,300)}`,
          JSON.stringify({
            type:c.type,quantity:c.quantity,originalQuantity:c.quantity,workloadQuantity:c.quantity,unitCommission:unit,
            doneMessageId,reactionId,originalMessageId,pairRole:x.role,requestText,eventAt:accountingAt.toISOString(),
            canonicalDoneMessageId:canonicalDoneId,canonicalOriginalMessageId:canonicalWhatsappMessageId(originalMessageId),canonicalReactionMessageId:canonicalWhatsappMessageId(reactionId),
            balanceBefore,balanceAfter,
            repairFilledMissingLegacySide:legacyCovered>0,repairMode:Boolean(repairMode),safeOutageRecovery:Boolean(safeRecovery),
            outageRecoveryJobId:String(outageRecoveryJobId||"")||null
          }),userId,accountingAt.toISOString()
        ]);
        tx.push(r.rows[0]);
      }
    }

    await client.query("COMMIT");
    // Outage recovery must never add/remove group participants or send policy traffic.
    // Balances are ledger-derived and remain correct; normal LIVE traffic will refresh status later.
    if(!safeRecovery)await Promise.all([producer.id,consumer.id].map(id=>syncCaptainBalanceState(id).catch(()=>null)));
    return {
      transactions:tx,
      duplicate:tx.length===0,
      legacyCovered,
      railwayCovered,
      crossProviderCovered,
      repairedMissing:tx.length,
      repairedQuantityMismatch,
      reversedWrongQuantity,
      // V3.8.5.15 monitor-only context: expose both financial parties to the rebuild UI.
      // This does not change ledger writes or accounting calculations.
      producer:{id:String(producer.id),name:String(producer.name||''),phone:String(producer.phone||'')},
      consumer:{id:String(consumer.id),name:String(consumer.name||''),phone:String(consumer.phone||'')},
      requestText:String(requestText||'')
    };
  }catch(e){
    await client.query("ROLLBACK");
    // A concurrent/replayed event can hit the unique reference guard. Treat the exact
    // same reaction as idempotent instead of turning a harmless replay into a dead letter.
    if(e?.code==='23505')return {duplicate:true,transactions:[],legacyCovered:0,railwayCovered:0,crossProviderCovered:0,repairedMissing:0};
    throw e;
  }finally{client.release();}
}
async function issueSuspiciousReaction(details){
  const comparisonMode=await parallelComparisonEnabled();
  const safeDetails={...(details||{}),comparisonMode,financiallyIsolated:comparisonMode};
  return await openIssue({dedupKey:`SUSPICIOUS_REACTION:${safeDetails.reactionId}`,origin:"WEBHOOK",issueType:"SUSPICIOUS_REACTION",severity:"WARNING",sourceId:safeDetails.reactionId,relatedId:safeDetails.doneMessageId,summary:"حركة واتساب تحتاج تأكيد المحاسب قبل الجرد",details:safeDetails,suggestedAction:"راجع المنتج والمستهلك والعدد ثم اعتمد الحركة"})
}
async function eventById(id){const r=await db.query(`SELECT * FROM whatsapp_events WHERE id_message=$1`,[String(id)]);return r.rows[0]||null}
async function setEventStatus(id,status,error=""){await db.query(`UPDATE whatsapp_events SET status=$2,last_error=$3,processed_at=CASE WHEN $2 IN ('processed','ignored','reversed','blocked','error') THEN NOW() ELSE processed_at END WHERE id_message=$1`,[String(id),status,error||null])}
function wahaPayloadLid(payload={}){
  const raw=payload?._waha?.payload||{};
  const candidates=[payload?.senderData?.sender,payload?._abshirSenderLid,raw?.participant,raw?.author,raw?.sender,raw?.from,raw?._data?.author,raw?._data?.participant];
  return candidates.map(wahaIdString).find(isWahaLid)||'';
}
function wahaPayloadDirectPhone(payload={}){
  const current=normalizeWahaPhoneJid(payload?.senderData?.sender||payload?.senderData?.senderPhone);
  if(current)return current;
  const rawEvent=payload?._waha||{};
  return extractWahaDirectPhoneId(rawEvent?.payload||{},rawEvent);
}
function wahaIdentityError(lid,idMessage=''){
  const error=new Error(`WAHA_LID_UNRESOLVED:${String(lid||'missing')}:${String(idMessage||'')}`);
  error.code='WAHA_LID_UNRESOLVED';error.retryable=true;return error;
}
async function persistWahaEventIdentity(idMessage,payload,phone,lid=''){
  const next={...payload,senderData:{...(payload?.senderData||{}),sender:phone,senderPhone:phone},_abshirSenderLid:lid||payload?._abshirSenderLid||''};
  await db.query(`UPDATE whatsapp_events SET sender_id=$2,raw_payload=$3::jsonb WHERE id_message=$1`,[String(idMessage),phone,JSON.stringify(next)]);
  return next;
}
async function resolveWahaPayloadIdentity(idMessage,payload,{groupId='',refreshOnMiss=true,force=false,persist=true}={}){
  const direct=wahaPayloadDirectPhone(payload),lid=wahaPayloadLid(payload);
  const phone=direct||(lid?normalizeWahaPhoneJid(await wahaResolveChatId(lid,{groupId,refreshOnMiss,force})):"");
  if(!phone)return {payload,phone:'',lid,unresolved:Boolean(lid)||String(payload?._abshirProvider||'').toUpperCase()==='WAHA'};
  const next=persist&&idMessage?await persistWahaEventIdentity(idMessage,payload,phone,lid):{...payload,senderData:{...(payload?.senderData||{}),sender:phone,senderPhone:phone},_abshirSenderLid:lid||payload?._abshirSenderLid||''};
  return {payload:next,phone,lid,unresolved:false};
}
async function resolveStoredWahaEventIdentity(row,{groupId='',refreshOnMiss=false}={}){
  if(!row)return null;
  const existing=normalizeWahaPhoneJid(row.sender_id);
  if(existing)return {...row,sender_id:existing};
  const payload=row.raw_payload||{};
  if(!isWahaLid(row.sender_id)&&!wahaPayloadLid(payload))return row;
  const identity=await resolveWahaPayloadIdentity(row.id_message,payload,{groupId,refreshOnMiss,persist:true});
  return identity.phone?{...row,sender_id:identity.phone,raw_payload:identity.payload,_abshirIdentityResolved:true}:{...row,_abshirIdentityUnresolved:true};
}
async function quotedRequestContext(doneEv){
  const md=doneEv?.raw_payload?.messageData||{};
  const q=md?.quotedMessage||{};
  const originalId=targetId(md)||String(q?.stanzaId||"").trim();
  const text=String(q?.textMessageData?.textMessage||q?.textMessage||q?.extendedTextMessageData?.text||"").trim();
  const rawSender=String(q?.participant||q?.sender||q?.senderId||"").trim();
  const senderId=normalizeWahaPhoneJid(q?.pn||q?.phoneNumber||q?.participantAlt,{allowBare:true})||rawSender;
  return originalId&&text&&senderId?{id_message:originalId,message_text:text,sender_id:senderId,raw_payload:{messageData:q},synthetic:true}:null;
}

export async function repairWahaLidMappings(userId=null){
  const w=await wahaSettingsRaw();const groupId=String(w.groupId||'');
  if(!groupId)throw new Error('اختر قروب الجرد في إعدادات WAHA أولًا');
  const refresh=await refreshWahaLidDirectory({groupId,force:true});
  const q=await db.query(`
    SELECT id_message,sender_id,raw_payload,webhook_received_at
    FROM whatsapp_events
    WHERE status IN ('blocked','failed','waiting_identity','error')
      AND ($1='' OR chat_id=$1)
      AND (
        COALESCE(sender_id,'') LIKE '%@lid'
        OR COALESCE(raw_payload->>'_abshirSenderLid','') LIKE '%@lid'
        OR COALESCE(raw_payload->'senderData'->>'sender','') LIKE '%@lid'
      )
    ORDER BY webhook_received_at ASC,id ASC
    LIMIT 3000
  `,[groupId]);
  const lids=[...new Set(q.rows.map(row=>isWahaLid(row.sender_id)?String(row.sender_id):wahaPayloadLid(row.raw_payload||{})).filter(Boolean))];
  const resolvedByLid=new Map();
  for(const lid of lids){
    const resolved=await wahaResolveChatId(lid,{groupId,refreshOnMiss:false});
    const phone=normalizeWahaPhoneJid(resolved);if(phone)resolvedByLid.set(lid,phone);
  }
  const eventIds=[];let resolvedEvents=0;
  for(const row of q.rows){
    const payload=row.raw_payload||{},lid=isWahaLid(row.sender_id)?String(row.sender_id):wahaPayloadLid(payload);
    const phone=wahaPayloadDirectPhone(payload)||resolvedByLid.get(lid)||'';
    if(!phone)continue;
    if(lid&&!resolvedByLid.has(lid))resolvedByLid.set(lid,phone);
    await persistWahaEventIdentity(row.id_message,payload,phone,lid);
    await db.query(`UPDATE whatsapp_events SET status='received',last_error=NULL,processed_at=NULL,processing_started_at=NULL,attempts=0,processing_mode='waha_identity_repair' WHERE id_message=$1`,[row.id_message]);
    eventIds.push(String(row.id_message));resolvedEvents++;
  }
  const unresolvedLids=lids.filter(lid=>!resolvedByLid.has(lid));
  const result={scanned:q.rowCount,resolvedEvents,eventIds,uniqueLids:lids.length,resolvedLids:resolvedByLid.size,unresolvedLids,refresh};
  await audit(userId,'waha.lid_phone.repair','system','whatsapp',{scanned:result.scanned,resolvedEvents,uniqueLids:lids.length,resolvedLids:resolvedByLid.size,unresolvedCount:unresolvedLids.length,groupId});
  return result;
}

function eventMsFromPayload(payload){
  const raw=Number(payload?.timestamp||0);
  return raw>0?(raw>1e11?raw:raw*1000):0;
}
function eventDateFromPayload(payload,fallback=new Date()){
  const ms=eventMsFromPayload(payload);
  return ms?new Date(ms):fallback;
}
function eventIsoFromPayload(payload,fallback=new Date()){return eventDateFromPayload(payload,fallback).toISOString()}

function isSystemGeneratedDeletion(payload){
  const type=String(payload?.typeWebhook||'').toLowerCase();
  if(type.includes('outgoingapimessage'))return true;
  if(!type.includes('outgoing'))return false;
  const sender=normPhone(payload?.senderData?.sender||payload?.senderData?.chatId||'');
  const wid=normPhone(payload?.instanceData?.wid||'');
  return Boolean(sender&&wid&&sender===wid);
}

async function historicalDoneIdsForTarget(target){
  target=String(target||'').trim();if(!target)return [];
  const out=[];
  const targetEv=await eventById(target);
  // If the deleted target itself is a reply to an order, it is a DONE candidate.
  if(targetEv&&targetId(targetEv.raw_payload?.messageData||{}))out.push(target);
  // If the deleted target is the original request, collect all replies that quoted it.
  const replies=await db.query(`
    SELECT id_message FROM whatsapp_events
    WHERE COALESCE(
      raw_payload->'messageData'->'extendedTextMessageData'->>'stanzaId',
      raw_payload->'messageData'->'quotedMessage'->>'stanzaId'
    )=$1
    ORDER BY webhook_received_at ASC LIMIT 100
  `,[target]);
  for(const r of replies.rows){const id=String(r.id_message||'');if(id&&!out.includes(id))out.push(id)}
  return out;
}

async function reactionStateBefore(doneId,producerPhone,cutoffMs,excludeEventId=''){
  const q=await db.query(`
    SELECT id_message,sender_id,raw_payload,event_timestamp,webhook_received_at
    FROM whatsapp_events
    WHERE COALESCE(
      raw_payload->'messageData'->'reactionMessageData'->>'stanzaId',
      raw_payload->'messageData'->'reactionMessageData'->>'quotedStanzaId',
      raw_payload->'messageData'->'reactionMessageData'->>'idMessageQuoted',
      raw_payload->'messageData'->'extendedTextMessageData'->>'stanzaId'
    )=$1
      AND ($2='' OR id_message<>$2)
    ORDER BY webhook_received_at ASC LIMIT 200
  `,[String(doneId),String(excludeEventId||'')]);
  const rows=q.rows.map(x=>{
    const raw=Number(x.event_timestamp||x.raw_payload?.timestamp||0);
    const ms=raw>0?(raw>1e11?raw:raw*1000):new Date(x.webhook_received_at||0).getTime();
    return {...x,_ms:Number.isFinite(ms)?ms:0,_emoji:reactionEmoji(x.raw_payload?.messageData||{})};
  }).filter(x=>normPhone(x.sender_id)===normPhone(producerPhone)&&(!cutoffMs||!x._ms||x._ms<=cutoffMs+5000));
  rows.sort((a,b)=>a._ms-b._ms);
  if(!rows.length)return {known:false,active:false};
  const last=rows[rows.length-1];
  return {known:true,active:isCommissionLike(last._emoji),emoji:last._emoji,at:last._ms};
}

async function hasLegacyAutomaticInventory(doneId){
  const marker=`DONE:${String(doneId)}`;
  const q=await db.query(`
    SELECT 1 FROM ledger_entries
    WHERE reference_type='legacy_sheet'
      AND description ILIKE '%جرد واتساب تلقائي%'
      AND POSITION($1 IN COALESCE(description,''))>0
    LIMIT 1
  `,[marker]);
  return Boolean(q.rowCount);
}

async function historicalCompletedWorkForTarget(target,deletePayload){
  target=String(target||'').trim();if(!target)return {completed:false,doneIds:[]};
  const cutoffMs=eventMsFromPayload(deletePayload);
  const doneIds=await historicalDoneIdsForTarget(target);
  const activeDoneIds=[];

  for(const doneId of doneIds){
    const doneEv=await eventById(doneId);if(!doneEv)continue;
    const originalId=targetId(doneEv.raw_payload?.messageData||{})||target;
    const req=await eventById(originalId);
    const quoted=await quotedRequestContext(doneEv);
    const producerPhone=normPhone(req?.sender_id||quoted?.sender_id||'');
    if(!producerPhone)continue;

    // Strongest evidence: the producer's last reaction BEFORE the system deletion was 👍.
    const state=await reactionStateBefore(doneId,producerPhone,cutoffMs);
    if(state.known){if(state.active)activeDoneIds.push(doneId);continue;}

    // Fallback for history imported without a complete reaction event: a legacy automatic
    // inventory pair proves that this reply had already been accepted/accounted.
    if(await hasLegacyAutomaticInventory(doneId))activeDoneIds.push(doneId);
  }

  return {completed:activeDoneIds.length>0,doneIds:activeDoneIds};
}

async function restoreLegacyDelayCancellations(doneIds,userId){
  let restored=0;const restoredEntryIds=[];
  for(const doneId of [...new Set((doneIds||[]).map(String).filter(Boolean))]){
    const marker=`DONE:${doneId}`;
    const originals=(await db.query(`
      SELECT id,captain_id,amount,entry_type,metadata,created_at
      FROM ledger_entries
      WHERE reference_type='legacy_sheet'
        AND description ILIKE '%جرد واتساب تلقائي%'
        AND POSITION($1 IN COALESCE(description,''))>0
      ORDER BY id
    `,[marker])).rows;
    if(!originals.length)continue;

    const cancellations=(await db.query(`
      SELECT le.id,le.captain_id,le.amount,le.entry_type,le.metadata,le.created_at
      FROM ledger_entries le
      WHERE le.reference_type='legacy_sheet'
        AND le.description ILIKE '%إلغاء Reaction%'
        AND POSITION($1 IN COALESCE(le.description,''))>0
        AND NOT EXISTS(SELECT 1 FROM ledger_entries r WHERE r.reversed_entry_id=le.id)
      ORDER BY le.id
    `,[marker])).rows;
    if(!cancellations.length)continue;

    const used=new Set();
    for(const orig of originals){
      const idx=cancellations.findIndex((c,i)=>!used.has(i)
        &&String(c.captain_id)===String(orig.captain_id)
        &&Math.abs(Number(c.amount)+Number(orig.amount))<=.0005);
      if(idx<0)continue;
      used.add(idx);
      const cancel=cancellations[idx];
      try{
        await reverseLedgerEntry({
          entryId:cancel.id,
          createdBy:userId,
          reason:`إصلاح حذف نظام متأخر بعد أخذ الشغل — DONE:${doneId}`
        });
        restored++;restoredEntryIds.push(cancel.id);
      }catch(e){if(e?.message!=='entry_already_reversed')throw e;}
    }
  }
  return {restored,restoredEntryIds};
}

async function transcribeGreenAudio(md,idMessage){
  const provider=await whatsappProvider();
  const g=provider==='waha'?await getSetting('waha_api',{}):await getSetting("green_api",{});
  if(g.voiceEnabled===false)throw new Error("تحويل الصوت إلى نص غير مفعّل");
  const apiKey=String(g.openAiKey||"").trim();
  if(!apiKey)throw new Error("مفتاح OpenAI غير محفوظ لتحويل التسجيل الصوتي");
  const file=md?.fileMessageData||{};
  let downloadUrl=String(file.downloadUrl||file.url||"").trim();
  if(!downloadUrl)throw new Error(`${provider==='waha'?'WAHA':'Green API'} لم يرسل رابط تنزيل التسجيل الصوتي`);
  let parsedDownloadUrl;try{parsedDownloadUrl=new URL(downloadUrl)}catch{throw new Error("رابط التسجيل الصوتي غير صالح")}
  const headers={};
  if(provider==='waha'){
    const w=await wahaSettingsRaw();
    // WAHA may publish media URLs as localhost unless WAHA_BASE_URL is set.
    // Rewrite only WAHA's own /api/files path to the configured trusted WAHA origin.
    if((parsedDownloadUrl.hostname==='localhost'||parsedDownloadUrl.hostname==='127.0.0.1')&&parsedDownloadUrl.pathname.startsWith('/api/files/')){
      const apiBase=new URL(normalizeWahaApiUrl(w.apiUrl));
      parsedDownloadUrl=new URL(parsedDownloadUrl.pathname+parsedDownloadUrl.search,apiBase);
    }
    const apiBase=new URL(normalizeWahaApiUrl(w.apiUrl));
    const trustedHost=parsedDownloadUrl.host===apiBase.host||parsedDownloadUrl.hostname.endsWith('.railway.internal');
    if(!trustedHost)throw new Error("رابط تسجيل WAHA لا يطابق خادم WAHA المحفوظ");
    if(parsedDownloadUrl.protocol!=="https:"&&!(parsedDownloadUrl.protocol==="http:"&&parsedDownloadUrl.hostname.endsWith('.railway.internal'))){
      throw new Error("اضبط WAHA_BASE_URL على رابط HTTPS العام حتى يعمل تحويل الصوت");
    }
    headers['X-Api-Key']=String(w.apiKey||'');
  }else if(parsedDownloadUrl.protocol!=="https:"){
    throw new Error("رابط التسجيل الصوتي يجب أن يكون HTTPS");
  }
  const media=await fetch(parsedDownloadUrl,{headers,signal:timeoutSignal("GREEN_MEDIA_TIMEOUT_MS",30000,120000)});
  if(!media.ok)throw new Error(`تعذر تنزيل التسجيل الصوتي من ${provider==='waha'?'WAHA':'Green API'} (${media.status})`);
  const buf=Buffer.from(await media.arrayBuffer());
  if(!buf.length)throw new Error("التسجيل الصوتي فارغ");
  if(buf.length>25*1024*1024)throw new Error("التسجيل الصوتي أكبر من 25MB");
  const mime=String(file.mimeType||media.headers.get("content-type")||"audio/ogg").split(";")[0];
  const ext=(mime.split("/")[1]||"ogg").replace(/[^a-z0-9]/gi,"")||"ogg";
  const form=new FormData();
  form.append("file",new Blob([buf],{type:mime}),`voice-${String(idMessage||Date.now())}.${ext}`);
  form.append("model","gpt-4o-mini-transcribe");
  form.append("language","ar");
  const res=await fetch("https://api.openai.com/v1/audio/transcriptions",{method:"POST",headers:{Authorization:`Bearer ${apiKey}`},body:form,signal:timeoutSignal("OPENAI_TRANSCRIBE_TIMEOUT_MS",60000,180000)});
  const raw=await res.text();
  let body={};try{body=raw?JSON.parse(raw):{}}catch{body={raw}}
  if(!res.ok)throw new Error(`فشل تحويل الصوت إلى نص (${res.status}): ${String(body?.error?.message||raw).slice(0,240)}`);
  const t=String(body.text||"").trim();
  if(!t)throw new Error("خدمة تحويل الصوت رجعت نصًا فارغًا");
  return t;
}
function partialEmojiQuantity(emoji){const e=String(emoji||"");return ({"1⃣":1,"2⃣":2,"3⃣":3,"4⃣":4,"5⃣":5,"6⃣":6,"7⃣":7,"8⃣":8,"9⃣":9,"🔟":10,"1️⃣":1,"2️⃣":2,"3️⃣":3,"4️⃣":4,"5️⃣":5,"6️⃣":6,"7️⃣":7,"8️⃣":8,"9️⃣":9})[e]||0}
function partialPlan(components,target){
  target=Math.max(0,Math.trunc(n(target)));const total=components.reduce((a,x)=>a+Math.max(0,Math.trunc(n(x.quantity))),0);
  const p=components.find(x=>x.type==="PASSENGER"),o=components.find(x=>x.type==="ORDER");
  if(p&&o){if(target>n(p.quantity))return {error:`الطلب المختلط فيه ${n(p.quantity)} راكب فقط؛ 1️⃣–🔟 تخصم من الركاب فقط`};return {mixed:true,total,cancelled:{PASSENGER:target,ORDER:0},remaining:Math.max(0,total-target),movementType:"PASSENGER"}}
  const one=components[0];if(!one)return {error:"لا توجد حركة أصلية"};if(target>n(one.quantity))return {error:`لا يمكن إلغاء ${target} من أصل ${n(one.quantity)}`};return {mixed:false,total,cancelled:{PASSENGER:one.type==="PASSENGER"?target:0,ORDER:one.type==="ORDER"?target:0},remaining:Math.max(0,total-target),movementType:one.type}
}
async function applyComparisonPartialReaction(doneId,reactionId,targetQuantity,senderPhone){
  const auth=await cancellationAuthorized(senderPhone);if(!auth)return {ignored:true,reason:"unauthorized"};
  const exact=String(doneId||'').trim();const client=await db.connect();
  try{
    await client.query('BEGIN');await lockComparisonMessageKeys(client,exact);
    const job=await comparisonJobByDoneId(exact,client,{lock:true});
    if(!job||job.status!=='ACTIVE')throw new Error("لا توجد حركة مقارنة فعالة مرتبطة بهذا الرد");
    const originals=comparisonComponentsFromJob(job,false),plan=partialPlan(originals,targetQuantity);if(plan.error)throw new Error(plan.error);
    const previous=n(job.partial_cancel_quantity);if(previous===Number(targetQuantity)){await client.query('COMMIT');return {duplicate:true,comparisonOnly:true,targetQuantity,remaining:plan.remaining}}
    const effectivePassenger=Math.max(0,n(job.passenger_quantity)-n(plan.cancelled.PASSENGER));
    const effectiveOrder=Math.max(0,n(job.order_quantity)-n(plan.cancelled.ORDER));
    await client.query(`UPDATE whatsapp_comparison_jobs SET effective_passenger_quantity=$2,effective_order_quantity=$3,partial_cancel_quantity=$4,reaction_message_id=$5,metadata=metadata||$6::jsonb,updated_at=NOW() WHERE done_message_id=$1`,[job.done_message_id,effectivePassenger,effectiveOrder,targetQuantity,String(reactionId||''),JSON.stringify({lastPartialReactionId:String(reactionId||''),lastPartialBy:displayPhone(senderPhone),lastPartialAt:new Date().toISOString()})]);
    await client.query('COMMIT');return {partial:true,comparisonOnly:true,targetQuantity,previousTarget:previous,remaining:plan.remaining,authorizedName:auth.name};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
async function applyPartialReaction(doneId,reactionId,targetQuantity,senderPhone,userId,occurredAt=null,safeRecovery=false,outageRecoveryJobId="",comparisonMode=false){
  if(comparisonMode)return await applyComparisonPartialReaction(doneId,reactionId,targetQuantity,senderPhone);
  const auth=await cancellationAuthorized(senderPhone);if(!auth)return {ignored:true,reason:"unauthorized"};
  const pair=await reactionPair(doneId);if(!pair?.complete)throw new Error("لا توجد حركة مكتملة مرتبطة بهذا الرد");
  const originals=pair.originalComponents?.length?pair.originalComponents:pair.components;
  const plan=partialPlan(originals,targetQuantity);if(plan.error)throw new Error(plan.error);
  const at=occurredAt||pair.occurredAt||new Date().toISOString();
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    const captainIds=[...new Set([String(pair.producerId),String(pair.consumerId)])].sort((a,b)=>Number(a)-Number(b));
    const locked=await client.query(`SELECT id FROM captains WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,[captainIds]);
    if(locked.rowCount!==captainIds.length)throw new Error("تعذر تثبيت حسابات الكباتن");
    const canonicalDoneId=canonicalWhatsappMessageId(doneId);
    const prevQ=await client.query(`SELECT * FROM inventory_reaction_cancellations WHERE (done_message_id=$1 OR ($2<>'' AND POSITION($2 IN done_message_id)>0)) AND status='PARTIAL' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,[doneId,canonicalDoneId]);
    const previous=prevQ.rows[0]?n(prevQ.rows[0].cancel_quantity):0,prevPlan=partialPlan(originals,previous);if(prevPlan.error)throw new Error(prevPlan.error);
    if(previous===targetQuantity){await client.query("COMMIT");return {duplicate:true,targetQuantity,remaining:plan.remaining}}
    const ids=[];
    for(const type of ["PASSENGER","ORDER"]){
      const delta=n(plan.cancelled[type])-n(prevPlan.cancelled[type]);if(!delta)continue;const qty=Math.abs(delta),amt=money(qty*COMM[type]);
      const moves=delta>0
        ? [{captainId:pair.producerId,amount:-amt,entryType:"CONSUMPTION",direction:"debit",role:"producer"},{captainId:pair.consumerId,amount:amt,entryType:"PRODUCTION",direction:"credit",role:"consumer"}]
        : [{captainId:pair.producerId,amount:amt,entryType:"PRODUCTION",direction:"credit",role:"producer"},{captainId:pair.consumerId,amount:-amt,entryType:"CONSUMPTION",direction:"debit",role:"consumer"}];
      for(const m of moves){
        const inserted=await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id,created_at) VALUES($1,$2,$3,$4,'green_partial',$5,$6,$7::jsonb,$8,$9::timestamptz) RETURNING id`,[m.captainId,m.amount,m.entryType,m.direction,`${reactionId}:${doneId}:${type}:${m.role}`,`تعديل جزئي واتساب — PARTIAL_CANCEL:DONE:${doneId}`,JSON.stringify({type,quantity:qty,doneMessageId:doneId,canonicalDoneMessageId:canonicalDoneId,reactionId,canonicalReactionMessageId:canonicalWhatsappMessageId(reactionId),partialTarget:targetQuantity,partialDelta:delta,pairRole:m.role,skipWeeklyFloor:true,excludeFromWorkload:true,safeOutageRecovery:Boolean(safeRecovery),outageRecoveryJobId:String(outageRecoveryJobId||"")||null}),userId||null,new Date(at).toISOString()]);
        ids.push(inserted.rows[0].id);
      }
    }
    // Keep accounting adjustments separate, while workload counters use the effective quantity.
    for(const type of ["PASSENGER","ORDER"]){
      const orig=originals.find(x=>x.type===type);if(!orig)continue;
      const remaining=Math.max(0,n(orig.quantity)-n(plan.cancelled[type]));
      await client.query(`UPDATE ledger_entries SET metadata=jsonb_set(metadata,'{workloadQuantity}',to_jsonb($4::numeric),true) WHERE reference_type='green_reaction' AND (metadata->>'doneMessageId'=$1 OR metadata->>'canonicalDoneMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'doneMessageId',''))>0)) AND metadata->>'type'=$3 AND reversed_at IS NULL`,[doneId,canonicalDoneId,type,remaining]);
    }
    await client.query(`UPDATE inventory_reaction_cancellations SET status='REOPENED',reopened_at=NOW(),reopen_reason='تم استبدال التعديل الجزئي بتعديل أحدث' WHERE (done_message_id=$1 OR ($2<>'' AND POSITION($2 IN done_message_id)>0)) AND status='PARTIAL'`,[doneId,canonicalDoneId]);
    await client.query(`INSERT INTO inventory_reaction_cancellations(done_message_id,original_message_id,reaction_message_id,authorized_phone,authorized_name,status,mode,producer_id,consumer_id,movement_type,original_quantity,cancel_quantity,remaining_quantity,delta_quantity,reversed_ledger_ids) VALUES($1,$2,$3,$4,$5,'PARTIAL',$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,[doneId,pair.originalMessageId||null,reactionId,displayPhone(senderPhone),auth.name,plan.mixed?'PARTIAL_MIXED_PASSENGER':'PARTIAL',pair.producerId||null,pair.consumerId||null,plan.movementType,plan.total,targetQuantity,plan.remaining,targetQuantity-previous,JSON.stringify(ids)]);
    await client.query("COMMIT");
    if(!safeRecovery)await Promise.all(captainIds.map(id=>syncCaptainBalanceState(id).catch(()=>null)));
    return {partial:true,targetQuantity,previousTarget:previous,remaining:plan.remaining,adjustmentIds:ids,authorizedName:auth.name};
  }catch(e){
    await client.query("ROLLBACK");
    if(e?.code==="23505")return {duplicate:true,targetQuantity,remaining:plan.remaining};
    throw e;
  }finally{client.release()}
}

async function recalculateComparisonEditedRequest(target,newText,editPayload,options){
  const components=detectComponents(newText,options);if(!components.length)return {changed:false,reason:'not_accounting_text',comparisonOnly:true};
  const exact=String(target||'').trim(),canonical=canonicalWhatsappMessageId(exact),totals=comparisonComponentTotals(components),client=await db.connect();
  try{
    await client.query('BEGIN');await lockComparisonMessageKeys(client,exact);
    const q=await client.query(`SELECT * FROM whatsapp_comparison_jobs WHERE original_message_id=$1 OR canonical_original_id=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(original_message_id,''))>0) ORDER BY updated_at FOR UPDATE`,[exact,canonical]);
    let corrected=0,deferred=0;
    for(const job of q.rows){
      if(n(job.partial_cancel_quantity)>0){deferred++;continue}
      const changed=n(job.passenger_quantity)!==totals.PASSENGER||n(job.order_quantity)!==totals.ORDER;
      await client.query(`UPDATE whatsapp_comparison_jobs SET passenger_quantity=$2,order_quantity=$3,effective_passenger_quantity=$2,effective_order_quantity=$3,request_text=$4,metadata=metadata||$5::jsonb,updated_at=NOW() WHERE done_message_id=$1`,[job.done_message_id,totals.PASSENGER,totals.ORDER,String(newText||''),JSON.stringify({lastEditEventId:String(editPayload?.idMessage||''),lastEditAt:new Date().toISOString()})]);
      if(changed)corrected++;
    }
    await client.query('COMMIT');return {changed:corrected>0,corrected,deferred,comparisonOnly:true};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}finally{client.release()}
}
async function recalculateEditedRequest(target,newText,editPayload,userId,repairMode,safeRecovery=false,outageRecoveryJobId="",comparisonMode=false){
  const original=await eventById(target);
  const options=inventoryOptions(original?.raw_payload||editPayload);
  if(comparisonMode)return await recalculateComparisonEditedRequest(target,newText,editPayload,options);
  const components=detectComponents(newText,options);if(!components.length)return {changed:false,reason:'not_accounting_text'};
  const exactTarget=String(target||''),canonicalTarget=canonicalWhatsappMessageId(exactTarget);const q=await db.query(`SELECT DISTINCT metadata->>'doneMessageId' done FROM ledger_entries WHERE reference_type='green_reaction' AND reversed_at IS NULL AND (metadata->>'originalMessageId'=$1 OR metadata->>'canonicalOriginalMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'originalMessageId',''))>0))`,[exactTarget,canonicalTarget]);
  let corrected=0,deferred=0;
  for(const row of q.rows){
    const done=String(row.done||'');if(!done)continue;const pair=await reactionPair(done);if(!pair?.complete)continue;
    const canonicalDone=canonicalWhatsappMessageId(done);const partial=await db.query(`SELECT 1 FROM inventory_reaction_cancellations WHERE status='PARTIAL' AND (done_message_id=$1 OR ($2<>'' AND (done_message_id=$2 OR POSITION($2 IN done_message_id)>0))) LIMIT 1`,[done,canonicalDone]);
    if(partial.rowCount){await openIssue({dedupKey:`EDIT_WITH_PARTIAL:${done}`,origin:'WEBHOOK',issueType:'EDIT_WITH_PARTIAL',severity:'WARNING',sourceId:String(editPayload?.idMessage||target),relatedId:done,summary:'تم تعديل طلب عليه إلغاء جزئي؛ يحتاج مراجعة قبل إعادة الحساب',details:{target,newText},suggestedAction:'راجع الجرد والتعديل الجزئي من مركز الأخطاء'}).catch(()=>{});deferred++;continue;}
    const oldSig=JSON.stringify((pair.originalComponents||pair.components||[]).map(x=>[x.type,n(x.quantity)]).sort());
    const newSig=JSON.stringify(components.map(x=>[x.type,n(x.quantity)]).sort());
    if(oldSig===newSig){await db.query(`UPDATE ledger_entries SET metadata=jsonb_set(metadata,'{requestText}',to_jsonb($3::text),true) WHERE reference_type='green_reaction' AND reversed_at IS NULL AND (metadata->>'doneMessageId'=$1 OR metadata->>'canonicalDoneMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(metadata->>'doneMessageId',''))>0))`,[done,canonicalDone,newText]);continue;}
    const producer=await captainById(pair.producerId),consumer=await captainById(pair.consumerId);if(!producer||!consumer){deferred++;continue;}
    await reverseReaction(done,userId,'تصحيح بعد تعديل نص الطلب',{includeLegacy:repairMode,preserveWeeklyFloor:true,suppressBalanceSync:safeRecovery,outageRecoveryJobId});
    await recordReaction({producer,consumer,components,doneMessageId:done,reactionId:`EDIT-${String(editPayload?.idMessage||randomUUID())}-${done}`,originalMessageId:target,userId,requestText:newText,repairMode,safeRecovery,outageRecoveryJobId,occurredAt:pair.occurredAt||eventIsoFromPayload(editPayload)});
    corrected++;
  }
  return {changed:corrected>0,corrected,deferred};
}

function reviewParty(c=null,fallbackPhone=""){
  const phone=displayPhone(c?.phone||fallbackPhone||"");
  if(!c&&!phone)return null;
  return {id:c?.id?String(c.id):"",name:String(c?.name||"").trim(),phone};
}
function reviewContext(reasonCode,reason,{producer=null,consumer=null,producerPhone="",consumerPhone="",requestText="",doneMessageId="",reactionId="",originalMessageId=""}={}){
  return {
    reasonCode:String(reasonCode||"review_required"),
    reason:String(reason||"تحتاج مراجعة محاسبية"),
    producer:reviewParty(producer,producerPhone),
    consumer:reviewParty(consumer,consumerPhone),
    requestText:String(requestText||"").trim(),
    doneMessageId:String(doneMessageId||""),
    reactionId:String(reactionId||""),
    originalMessageId:String(originalMessageId||"")
  };
}
function componentReviewReason(text){
  const t=normText(arDigits(text));
  const hasPassenger=/(?:راكب|راكبه|راكبين|راكبان|ركاب|بنت|بنتين|بنات|زلمه|زلمة|شباب)/.test(t);
  const hasOrder=/(?:اوردر|اردر|طلب|طلبيه|طلبات|اوردرات|اردرات|طلبيات)/.test(t);
  if(hasPassenger&&hasOrder)return {code:"mixed_quantity_mismatch",reason:"الطلب مختلط — يجب ذكر عدد الركاب والأوردرات صراحة وأن يطابق مجموعهما العدد المستنتج من السعر"};
  const ambiguousPlural=/(?:ركاب|راكبات|بنات|شباب|اوردرات|اردرات|طلبات|طلبيات)/.test(t);
  if(ambiguousPlural&&!parseFare(text))return {code:"ambiguous_quantity",reason:"العدد غير واضح — لا يوجد عدد صريح ولا سعر يمكن استنتاج العدد منه"};
  if(hasPassenger||hasOrder)return {code:"quantity_not_parsed",reason:"تعذر تحديد العدد من النص أو السعر بشكل آمن"};
  return {code:"movement_type_unknown",reason:"نوع الحركة غير واضح — لم يتم التعرف على راكب أو أوردر"};
}

export async function processGreenEvent(payload,{force=false,userId=null,repairMode=false,safeRecovery=false}={}){
  payload=payload||{};
  safeRecovery=Boolean(safeRecovery||payload._abshirOutageRecovery);
  const outageRecoveryJobId=String(payload._abshirOutageRecoveryJobId||"");
  const hardCutoverMs=await cleanSlateCutoverMs();
  const payloadMs=eventMsFromPayload(payload);
  if(hardCutoverMs&&!payloadMs&&(payload._abshirHistoryRecovery||payload._abshirOutageRecovery)){
    return {ignored:true,reason:"historical_event_without_timestamp_after_clean_slate",cutoverAt:new Date(hardCutoverMs).toISOString()};
  }
  if(hardCutoverMs&&payloadMs&&payloadMs<hardCutoverMs){
    const oldId=String(payload.idMessage||"");
    if(oldId)await setEventStatus(oldId,"ignored","تجاهل تلقائي: الحدث أقدم من تصفير البداية الجديدة").catch(()=>{});
    return {ignored:true,reason:"before_clean_slate_cutover",cutoverAt:new Date(hardCutoverMs).toISOString()};
  }
  const sd=payload.senderData||{},md=payload.messageData||{};
  const group=String(sd.chatId||"");
  const g=await greenPublicSettings();
  // North enters through its own authenticated DropConnect webhook. Its accounting
  // must not depend on Green being enabled or on Green's configured group id.
  const sourceAccess=inventorySourceAccess(payload,g,force);
  if(!sourceAccess.allowed)return {ignored:true,reason:sourceAccess.reason};
  const comparisonMode=Boolean((await getParallelComparisonMode()).enabled);
  const id=String(payload.idMessage||"");
  if(!id)return {ignored:true,reason:"missing_id"};
  const type=md.typeMessage||"";
  if(sourceAccess.north&&payload?._dropcode?.sender?.fromMe&&type!=="reactionMessage"){
    await setEventStatus(id,'ignored','رسالة البوت الصادرة');
    return {ignored:true,reason:'north_own_message'};
  }

  // Self-service recharge instructions: available even to unregistered group members.
  // Only informational; never credit a wallet or accept a receipt automatically.
  if((type==="textMessage"||type==="extendedTextMessage") && /^!شحن\s*$/u.test(msgText(md))){
    if(safeRecovery||repairMode||payload._abshirHistoryRecovery){
      await setEventStatus(id,"ignored","أمر شحن قديم/استرجاع — بدون إرسال");
      return {ignored:true,reason:"recharge_help_history"};
    }
    const prior=await db.query("SELECT status FROM whatsapp_events WHERE id_message=$1 LIMIT 1",[id]);
    if(prior.rows[0]?.status==="processed")return {duplicate:true,reason:"recharge_help_sent"};
    const help="💳 *شحن رصيد أبشر*\n\n🏦 التحويل: كليك — بنك الاتحاد\n🔑 معرّف كليك: *Ebsher74*\n📸 أرسل صورة فاتورة التحويل على واتساب: *0796229162*\n\n⚠️ يتم تأكيد الشحن بعد مراجعة الفاتورة.";
    try{
      if(payload._abshirProvider==="DROPCODE_CONNECT"){
        // WAHA-compatible group mentions: the provider expands "all" to members.
        await northPolicyApi(payload,"/api/sendText","POST",{chatId:group,text:help,mentions:["all"]});
      }else if(await whatsappProvider()==="waha"){
        await withWahaMutationSlot('send',async()=>{
          const w=await wahaSettingsRaw();
          return await wahaRaw('/api/sendText','POST',{session:w.session,chatId:String(group),text:help,mentions:["all"]});
        });
      }else{
        // Green API sendMessage has no verified "mention everyone" support.
        // Send the correct instructions without presenting a fake @all tag.
        await greenSend(group,help);
      }
      await setEventStatus(id,"processed","تم إرسال تعليمات !شحن");
      return {handled:true,command:"recharge_help"};
    }catch(e){
      await setEventStatus(id,"error","فشل إرسال تعليمات الشحن: "+e.message);
      throw e;
    }
  }

  if(type==="deletedMessage"){
    const target=deletedId(md);
    if(!target){await setEventStatus(id,'ignored','حذف لدى الجميع بدون معرّف الرسالة');return {ignored:true,reason:'missing_deleted_target'}}
    const policy=await getInventoryDeleteRemovalPolicy();
    if(!policy.enabled){await setEventStatus(id,'ignored',`حذف لدى الجميع ${target} — زر التأثير موقوف`);return {ignored:true,reason:'delete_everyone_policy_off',target}}
    const doneIds=await relatedDoneMessageIdsForDelete(target,comparisonMode);let reversed=0;
    for(const done of doneIds){reversed+=comparisonMode?await cancelComparisonReaction(done,{status:'DELETED',reason:'حذف لدى الجميع',eventId:id}):await reverseReaction(done,userId,'حذف لدى الجميع',{includeLegacy:repairMode,suppressBalanceSync:safeRecovery,outageRecoveryJobId})}
    await saveDeleteForEveryoneMarker({target,eventId:id,doneIds,reversed,payload,comparisonMode});
    await setEventStatus(id,reversed?'reversed':'duplicate',reversed?`حذف لدى الجميع — أُلغي ${reversed} جرد${comparisonMode?' تجريبي':''}`:'حذف لدى الجميع — لا يوجد جرد فعّال أو أُلغي مسبقًا');
    return {deleted:true,target,doneIds,reversed,comparisonOnly:comparisonMode};
  }

  if(type==="editedMessage"){
    const target=String(md?.editedMessageData?.stanzaId||md?.editedMessageData?.idMessage||"");
    if(target){
      const newText=msgText(md);
      await db.query(`UPDATE whatsapp_events SET message_text=$2 WHERE id_message=$1`,[target,newText]);
      const recalc=await recalculateEditedRequest(target,newText,payload,userId,repairMode,safeRecovery,outageRecoveryJobId,comparisonMode);
      await setEventStatus(id,"processed",recalc.corrected?`تم تحديث الرسالة وتصحيح ${recalc.corrected} جرد`:`تم تحديث الرسالة${recalc.deferred?` — ${recalc.deferred} تحتاج مراجعة`:''}`);
      return {edited:true,...recalc};
    }
    return {edited:true,changed:false};
  }

  const wahaEvent=String(payload._abshirProvider||'').toUpperCase()==='WAHA'||isWahaLid(sd.sender)||Boolean(payload._abshirSenderLid);
  let senderIdentity=sd.sender||sd.senderPhone||'';
  if(wahaEvent){
    const identity=await resolveWahaPayloadIdentity(id,payload,{groupId:group||g.groupId||'',refreshOnMiss:true,persist:true});
    if(!identity.phone){
      const note=`بانتظار تحويل معرّف WAHA ${identity.lid||'@lid'} إلى رقم الهاتف الحقيقي — لم تُحذف الرسالة ولم تُحسب`;
      await setEventStatus(id,'waiting_identity',note);
      throw wahaIdentityError(identity.lid,id);
    }
    payload=identity.payload;senderIdentity=identity.phone;sd.sender=identity.phone;sd.senderPhone=identity.phone;
  }
  const sender=normPhone(senderIdentity||sd.chatId||"");
  // Only replace the imported placeholder with an observed WhatsApp push name.
  if(type!=="reactionMessage"&&!payload._abshirHistoryRecovery){
    const waName=String(sd.senderName||sd.senderContactName||payload.senderName||"").trim();
    if(waName&&waName.length<=90&&!/^كابتن مستورد\s/i.test(waName)
        &&!/^[+\d\s-]+$/.test(waName)&&/^7[789]\d{7}$/.test(sender)){
      await db.query("UPDATE captains SET name=$2,updated_at=NOW() WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=$1 AND name LIKE 'كابتن مستورد %'",[sender,waName]).catch(()=>{});
    }
  }
  const captain=await findCaptainByPhone(sender);
  // Authorized accountant/admin accounts may not have a captain wallet.
  // Allow only 🚫 and numbered corrections to proceed without one.
  const adminReaction=type==="reactionMessage"&&(
    reactionEmoji(md)==="🚫"||partialEmojiQuantity(reactionEmoji(md))>0);
  const authorizedAdminReaction=!captain&&adminReaction
    ?Boolean(await cancellationAuthorized(sender)):false;
  if(!captain&&!authorizedAdminReaction){
    if(!comparisonMode&&!repairMode&&!safeRecovery){try{if(g.groupId)await greenDelete(g.groupId,id)}catch{}}
    await setEventStatus(id,"blocked","رقم غير مسجل");
    return {blocked:true,reason:"unregistered"};
  }

  // Reactions are accounting signals, not ordinary chat messages. Process them before the
  // visible-message balance gate so a producer can still approve/cancel an already posted job
  // and the inventory cannot get stuck just because the account became frozen in the meantime.
  if(type==="reactionMessage"){
    const emoji=reactionEmoji(md),rawDone=targetId(md);
    if(inventoryOptions(payload).north && emoji && !isCommissionLike(emoji)){
      // North permits manager cancellations and partial adjustments only.
      // Other reactions remain ignored, as before.
      if(emoji!=="🚫"&&!partialEmojiQuantity(emoji)){
        await setEventStatus(id,"ignored","قروب شمال: هذا الريأكشن غير محاسبي");
        return {ignored:true,reason:"north_reaction_not_allowed"};
      }
      if(!(await cancellationAuthorized(sender))){
        await setEventStatus(id,"ignored","قروب شمال: 🚫 والأرقام للإدارة المخوّلة فقط");
        return {ignored:true,reason:"north_manager_only"};
      }
    }
    if(!rawDone)return {ignored:true};
    // V3.8.5.79: Green/WAHA/WEBJS may send the reaction target as a serialized
    // WhatsApp id such as false_<group>_<messageId>_<participant@lid>, while the
    // original reply is stored under the raw messageId. Resolve the logical
    // reference to the actually stored whatsapp_events id before accounting.
    // Without this, the 👍 is visible in LIVE but eventById() cannot find the
    // reply, so the commission is held in waiting_review / never posted.
    const done=await resolveWahaStoredMessageId(group||g.groupId||wahaGroupFromMessageId(rawDone)||'',rawDone);
    if((isCommissionLike(emoji)||partialEmojiQuantity(emoji))&&await deleteForEveryoneMarker([done])){await setEventStatus(id,'ignored','الرسالة محذوفة لدى الجميع — لا يعاد احتسابها');return {ignored:true,reason:'delete_everyone_locked',comparisonOnly:comparisonMode}}
    if(emoji==="🚫"){
      const auth=await cancellationAuthorized(sender);
      if(!auth){await setEventStatus(id,"ignored","🚫 غير مصرح");return {ignored:true};}
      if(comparisonMode){const out=await authorizeComparisonCancellation(done,{eventId:id,reason:'إلغاء بواسطة 🚫'});await setEventStatus(id,out.duplicate?'duplicate':'processed',out.duplicate?'الجرد التجريبي مقفل مسبقًا':`تم إلغاء ${out.reversed} جرد تجريبي`);return {cancelled:true,comparisonOnly:true,...out}}
      const locked=await activeCancellationLock(done);
      if(locked){await setEventStatus(id,"duplicate","الجرد مقفل مسبقًا بواسطة 🚫 — لم يتم تكرار الإلغاء");return {duplicate:true,cancelled:true,locked:true};}
      const pair=await reactionPair(done);
      const snapshotLedgerIds=[...(pair?.ledgerIds||[])];
      const snapshotQuantity=Number(pair?.originalQuantity||pair?.quantity||0);
      const rev=await reverseReaction(done,userId,"إلغاء بواسطة 🚫",{includeLegacy:repairMode,suppressBalanceSync:safeRecovery,outageRecoveryJobId});
      await db.query(`INSERT INTO inventory_reaction_cancellations(done_message_id,original_message_id,reaction_message_id,authorized_phone,authorized_name,status,mode,producer_id,consumer_id,movement_type,original_quantity,cancel_quantity,remaining_quantity,reversed_ledger_ids) VALUES($1,$2,$3,$4,$5,'LOCKED','FULL',$6,$7,$8,$9,$9,0,$10::jsonb)`,[done,pair?.originalMessageId||null,id,displayPhone(sender),auth.name,pair?.producerId||null,pair?.consumerId||null,pair?.type||null,snapshotQuantity,JSON.stringify(snapshotLedgerIds)]);
      await setEventStatus(id,"processed",`تم الإلغاء وعكس ${rev}`);
      return {cancelled:true,reversed:rev};
    }
    if(!emoji){
      // V3.8.5.50: Green API sends an empty reaction when a reaction is removed.
      // Reverse money ONLY when the immediately previous reaction from this same producer
      // on this same DONE message was 👍. This prevents removing 1️⃣–🔟 or 🚫 from
      // accidentally cancelling the whole job. Excluding the current event also makes
      // replay/recovery idempotent.
      const previous=await reactionStateBefore(done,sender,eventMsFromPayload(payload),id);
      if(previous.known&&isCommissionLike(previous.emoji)){
        if(comparisonMode){const locked=await comparisonCancellationLock(done);if(locked){await setEventStatus(id,'duplicate','الجرد التجريبي مقفل مسبقًا');return {duplicate:true,comparisonOnly:true}}const rev=await cancelComparisonReaction(done,{reason:'إزالة 👍',eventId:id});await setEventStatus(id,rev?'reversed':'duplicate',rev?'تم إلغاء الجرد التجريبي بعد إزالة 👍':'ملغي مسبقًا');return {reversed:rev,likeRemoved:true,comparisonOnly:true}}
        const locked=await activeCancellationLock(done);
        if(locked){
          await setEventStatus(id,"duplicate","إزالة 👍 وصلت بعد إلغاء 🚫 مقفل — الجرد ملغى أصلًا");
          return {duplicate:true,reversed:0,reason:"already_locked_cancelled",kind:"likeRemoval"};
        }
        const rev=await reverseReaction(done,userId,"إزالة 👍",{includeLegacy:repairMode,suppressBalanceSync:safeRecovery,outageRecoveryJobId});
        await setEventStatus(id,rev?"reversed":"duplicate",rev?`إزالة 👍 — تم عكس ${rev} حركة وإرجاع العمولة`:`إزالة 👍 — العمولة ملغاة مسبقًا ولا يوجد خصم مكرر`);
        return {reversed:rev,likeRemoved:true,kind:"likeRemoval"};
      }
      await setEventStatus(id,"ignored",previous.known?`تمت إزالة ${previous.emoji||'Reaction'} — لا يوجد إلغاء مالي إلا عند إزالة 👍`:`إزالة Reaction بدون 👍 سابق مؤكد — لم يتغير أي مبلغ`);
      return {ignored:true,reason:"removed_reaction_was_not_like",previousEmoji:previous.emoji||"",kind:"reactionRemoval"};
    }
    const partialQty=partialEmojiQuantity(emoji);
    if(partialQty||isCommissionLike(emoji)){
      const locked=comparisonMode?await comparisonCancellationLock(done):await activeCancellationLock(done);
      if(locked){
        await setEventStatus(id,"ignored",`الجرد مقفل بواسطة 🚫 (${locked.authorized_name||"مسؤول الإلغاء"}) — أعد فتحه من لوحة المحاسب أولًا`);
        return {ignored:true,reason:"inventory_locked",locked:true,doneMessageId:done};
      }
    }
    if(partialQty){
      try{
        const out=await applyPartialReaction(done,id,partialQty,sender,userId,eventIsoFromPayload(payload),safeRecovery,outageRecoveryJobId,comparisonMode);
        if(out.ignored){await setEventStatus(id,"ignored","1️⃣–🔟 غير مصرح لهذا الرقم");return out}
        await setEventStatus(id,out.duplicate?"duplicate":"processed",out.duplicate?`التعديل الجزئي أصلًا ${partialQty}`:`تعديل جزئي: أُلغي ${partialQty} والمتبقي ${out.remaining}`);
        return out;
      }catch(e){await setEventStatus(id,"error",e.message);throw e}
    }
    if(!isCommissionLike(emoji)){
      await setEventStatus(id,"ignored",`Reaction ${emoji} ليس إشارة محاسبية — بدون تغيير مالي`);
      return {ignored:true,reason:"non_accounting_reaction",emoji};
    }

    let doneEv=await eventById(done);
    if(sourceAccess.north&&doneEv?.raw_payload?._abshirReplyBalanceBlocked){
      await setEventStatus(id,'ignored','الرد مرفوض لعدم كفاية الرصيد — يجب إرسال رد جديد بعد الشحن');
      return {ignored:true,reason:'reply_balance_blocked'};
    }
    if(!doneEv){
      const review=reviewContext("missing_reply","الرد المستهدف غير موجود — لا يمكن تحديد المستهلك تلقائيًا بدون الرد",{producer:captain,doneMessageId:done,reactionId:id});
      await issueSuspiciousReaction({reactionId:id,doneMessageId:done,producerId:String(captain.id),producerName:captain.name,producerPhone:displayPhone(captain.phone),consumerName:"غير محدد",reasons:[review.reason]});
      await setEventStatus(id,"waiting_review",review.reason);
      return {waitingReview:true,error:"missing_reply",review};
    }
    doneEv=await resolveStoredWahaEventIdentity(doneEv,{groupId:group||g.groupId||'',refreshOnMiss:false});
    if(doneEv?._abshirIdentityUnresolved){
      await setEventStatus(doneEv.id_message,'waiting_identity','بانتظار تحويل هوية WAHA للرد إلى رقم هاتف');
      await setEventStatus(id,'waiting_identity','بانتظار تحويل هوية WAHA للرد قبل احتساب 👍');
      throw wahaIdentityError(doneEv.sender_id,doneEv.id_message);
    }

    const rawOriginal=targetId(doneEv.raw_payload?.messageData||{});
    let original=rawOriginal?await resolveWahaStoredMessageId(group||doneEv.chat_id||g.groupId||wahaGroupFromMessageId(rawOriginal)||'',rawOriginal):'';
    let req=original?await eventById(original):null;
    let restoredFromQuotedRequest=false;
    if(!req){
      const synthetic=await quotedRequestContext(doneEv);
      if(synthetic){
        req=synthetic;original=synthetic.id_message;restoredFromQuotedRequest=true;
      }
    }
    if(req?.synthetic&&isWahaLid(req.sender_id)){
      const resolved=await wahaResolveChatId(req.sender_id,{groupId:group||g.groupId||'',refreshOnMiss:false});
      if(isWahaLid(resolved)){
        await setEventStatus(id,'waiting_identity','بانتظار تحويل هوية WAHA للطلب المقتبس قبل احتساب 👍');
        throw wahaIdentityError(req.sender_id,req.id_message);
      }
      req={...req,sender_id:resolved};
    }else if(req){
      req=await resolveStoredWahaEventIdentity(req,{groupId:group||g.groupId||'',refreshOnMiss:false});
      if(req?._abshirIdentityUnresolved){
        await setEventStatus(req.id_message,'waiting_identity','بانتظار تحويل هوية WAHA للطلب إلى رقم هاتف');
        await setEventStatus(id,'waiting_identity','بانتظار تحويل هوية WAHA للطلب قبل احتساب 👍');
        throw wahaIdentityError(req.sender_id,req.id_message);
      }
    }
    if(await deleteForEveryoneMarker([done,original])){await setEventStatus(id,'ignored','الطلب أو الرد محذوف لدى الجميع — الجرد مقفل');return {ignored:true,reason:'delete_everyone_locked',comparisonOnly:comparisonMode}}
    if(!req){
      const tentativeConsumer=await findCaptainByPhone(doneEv.sender_id);
      const review=reviewContext("missing_request","الطلب الأصلي غير موجود ولم يمكن استعادته من الاقتباس",{producer:captain,consumer:tentativeConsumer,consumerPhone:doneEv.sender_id,doneMessageId:done,reactionId:id,originalMessageId:original||""});
      await issueSuspiciousReaction({reactionId:id,doneMessageId:done,originalMessageId:original||"",producerId:String(captain.id),producerName:captain.name,producerPhone:displayPhone(captain.phone),consumerId:tentativeConsumer?.id?String(tentativeConsumer.id):"",consumerName:tentativeConsumer?.name||"غير محدد",consumerPhone:displayPhone(tentativeConsumer?.phone||doneEv.sender_id),reasons:[review.reason]});
      await setEventStatus(id,"waiting_review",review.reason);
      return {waitingReview:true,error:"missing_request",review};
    }

    const requestText=req.message_text||msgText(req.raw_payload?.messageData||{});
    const producer=await findCaptainByPhone(req.sender_id),consumer=await findCaptainByPhone(doneEv.sender_id);
    if(!producer||!consumer){
      // Surface every unmapped participant in the accountant's "أرقام غير مسجلة" screen.
      // That screen is sourced from blocked WhatsApp events with last_error='رقم غير مسجل'.
      if(!producer && req?.id_message){
        await setEventStatus(req.id_message,"blocked","رقم غير مسجل");
      }
      if(!consumer && doneEv?.id_message){
        await setEventStatus(doneEv.id_message,"blocked","رقم غير مسجل");
      }
      const review=reviewContext("captain_mapping","تعذر ربط المنتج أو المستهلك بحساب كابتن مسجل",{producer,consumer,producerPhone:req.sender_id,consumerPhone:doneEv.sender_id,requestText,doneMessageId:done,reactionId:id,originalMessageId:original});
      await issueSuspiciousReaction({reactionId:id,doneMessageId:done,originalMessageId:original,requestText,producerId:producer?.id?String(producer.id):"",producerName:producer?.name||"غير محدد",producerPhone:displayPhone(producer?.phone||req.sender_id),consumerId:consumer?.id?String(consumer.id):"",consumerName:consumer?.name||"غير محدد",consumerPhone:displayPhone(consumer?.phone||doneEv.sender_id),reasons:[review.reason]});
      await setEventStatus(id,"waiting_review",review.reason);
      return {waitingReview:true,error:"captain_mapping",review};
    }
    // The reaction can carry the authenticated North group mode even when the
    // stored/quoted request was imported without its bridge mode marker.
    // Never reinterpret a North fare as a raw passenger count on approval.
    const requestMode=inventoryOptions(req.synthetic?doneEv.raw_payload:req.raw_payload);
    const components=detectComponents(requestText,{north:requestMode.north||sourceAccess.north});
    if(!components.length){
      const why=componentReviewReason(requestText);
      const review=reviewContext(why.code,why.reason,{producer,consumer,requestText,doneMessageId:done,reactionId:id,originalMessageId:original});
      await issueSuspiciousReaction({reactionId:id,doneMessageId:done,originalMessageId:original,requestText,producerId:String(producer.id),producerName:producer.name,producerPhone:displayPhone(producer.phone),consumerId:String(consumer.id),consumerName:consumer.name,consumerPhone:displayPhone(consumer.phone),reasons:[review.reason]});
      await setEventStatus(id,"waiting_review",review.reason);
      return {waitingReview:true,review};
    }
    if(normPhone(producer.phone)!==sender){await setEventStatus(id,"ignored","الاعتماد يجب أن يكون من صاحب الطلب");return {ignored:true};}
    if(String(producer.id)===String(consumer.id)){await setEventStatus(id,"error","المنتج والمستهلك نفس الكابتن");return {error:"same_captain"};}

    const qty=components.reduce((a,x)=>a+x.quantity,0);
    if(qty>50){
      const review=reviewContext("large_quantity",`عدد كبير (${qty}) — يحتاج تأكيد المحاسب قبل الجرد`,{producer,consumer,requestText,doneMessageId:done,reactionId:id,originalMessageId:original});
      await issueSuspiciousReaction({reactionId:id,doneMessageId:done,originalMessageId:original,producerId:String(producer.id),producerName:producer.name,producerPhone:displayPhone(producer.phone),consumerId:String(consumer.id),consumerName:consumer.name,consumerPhone:displayPhone(consumer.phone),components,type:components.length>1?"MIXED":components[0].type,quantity:qty,requestText,reasons:[review.reason]});
      await setEventStatus(id,"waiting_review",review.reason);
      return {waitingReview:true,review};
    }
    // ERJA3NA FULL AUTO: every clear validated 👍 movement posts directly to the ledger.
    // Only genuinely ambiguous or broken mappings remain in waiting_review.

    const result=await recordReaction({producer,consumer,components,doneMessageId:done,reactionId:id,originalMessageId:original,userId,requestText,repairMode,safeRecovery,outageRecoveryJobId,occurredAt:eventIsoFromPayload(payload),comparisonMode});
    await setEventStatus(done,"processed","تم اعتماد الرد بواسطة 👍");
    if(!req.synthetic)await setEventStatus(original,"processed","تم احتساب الطلب");
    await setEventStatus(id,result.ignored?"ignored":result.duplicate?"duplicate":"processed",result.ignored?"الطلب الأصلي محسوب لرد آخر — أزل 👍 السابق أولًا ثم اعتمد هذا الرد":result.duplicate?"محسوب سابقًا":restoredFromQuotedRequest?"تم الجرد بعد استعادة الطلب المحذوف من الاقتباس":"تم الجرد تلقائيًا");
    return {ok:true,...result,restoredFromQuotedRequest};
  }

  // A plain WhatsApp @mention is conversation, not an acceptance of a job.
  // Mentions (including quoted mentions) must not trigger the low-balance
  // reply deletion or any financial charge. Do not exempt a real "تم" acceptance.
  const incomingText=msgText(md);
  const isPlainMention=/(?:^|\s)@(?:\S+)/u.test(incomingText)
    && !/(?:^|\s)تم(?:\s|$|[.!؟،])/u.test(incomingText);
  if(isPlainMention){
    await setEventStatus(id,"ignored","منشن عادي — بدون حذف أو عمولة");
    return {ignored:true,reason:"plain_mention_no_accounting"};
  }

  // North checks the complete request commission before accepting a live reply.
  if(sourceAccess.north&&targetId(md)&&!comparisonMode&&!repairMode){
    const originalId=await resolveWahaStoredMessageId(group,targetId(md));
    const original=await eventById(originalId);
    const quoted=md.quotedMessage||{};
    const requestText=original?.message_text||msgText(original?.raw_payload?.messageData||{})
      ||String(quoted.textMessageData?.textMessage||quoted.textMessage||quoted.extendedTextMessageData?.text||'');
    const components=detectComponents(requestText,{north:true});
    const storedReply=await eventById(id);
    const policy=storedReply?.raw_payload?._abshirReplyBalanceBlocked||northReplyBalancePolicy(md,captain.balance,components);
    if(policy.blocked){
      // Persist rejection before I/O, so deletion failure or a later recharge cannot
      // allow a delayed thumbs-up to charge this rejected reply.
      await db.query(`UPDATE whatsapp_events SET raw_payload=COALESCE(raw_payload,'{}'::jsonb)||jsonb_build_object('_abshirReplyBalanceBlocked',$2::jsonb) WHERE id_message=$1`,[id,JSON.stringify(policy)]);
      await setEventStatus(id,'blocked',`شمال: ${policy.reason}; الرصيد ${policy.balance}; العمولة ${policy.commission}`);
      if(safeRecovery||payload._abshirHistoryRecovery)return {blocked:true,...policy,deleted:false,warningSent:false,safeRecovery:true};
      const deletion=policy.deleted?{deleted:true}:payload._abshirProvider==='DROPCODE_CONNECT'
        ?await deleteNorthPolicyReply(payload)
        :await greenDeletePolicyMessage(group,id,{reason:policy.reason,captainId:captain.id,balance:policy.balance});
      policy.deleted=Boolean(deletion.deleted);
      await db.query(`UPDATE whatsapp_events SET raw_payload=jsonb_set(raw_payload,'{_abshirReplyBalanceBlocked}',$2::jsonb) WHERE id_message=$1`,[id,JSON.stringify(policy)]);
      const warning=northReplyBalanceWarning(captain,policy);
      if(!policy.warningSent){
        if(payload._abshirProvider==='DROPCODE_CONNECT')await northPolicyApi(payload,'/api/sendText','POST',{chatId:group,text:warning});
        else await greenSend(group,warning);
        policy.warningSent=true;
        await db.query(`UPDATE whatsapp_events SET raw_payload=jsonb_set(raw_payload,'{_abshirReplyBalanceBlocked}',$2::jsonb) WHERE id_message=$1`,[id,JSON.stringify(policy)]);
      }
      return {blocked:true,...policy,deleted:deletion.deleted,deletion,warningSent:true,replyOnly:true,removedFromGroup:false};
    }
  }

  // LIVE policy for visible group messages.
  // ABSHIR manual rule: low-balance deletion applies ONLY to a WhatsApp Reply/quoted message.
  // Ordinary messages remain untouched even when the captain balance is below 1.00 JOD.
  // A reply is allowed only when the captain has at least 1.00 JOD at the moment it arrives.
  // Disabled accounts keep the previous delete-only protection.
  const captainStatus=String(captain.status||"").toLowerCase();
  const replyTargetForPolicy=targetId(md);
  const lowBalanceReply=lowBalanceReplyPolicy(md,captain.balance);
  const disabled=captainStatus==="disabled";
  if(!comparisonMode&&!repairMode&&(lowBalanceReply||disabled)){
    const reason=disabled?"account_disabled":"low_balance_reply";
    if(safeRecovery){
      const note=disabled
        ?"استرجاع فترة انقطاع: الحساب معطل — تم منع الحركة بدون حذف رسالة قديمة"
        :`استرجاع فترة انقطاع: Reply برصيد ${n(captain.balance).toFixed(2)} د.أ (< 1.00) — تم منع الحركة بدون حذف رسالة قديمة`;
      await setEventStatus(id,"blocked",note);
      return {blocked:true,reason,balance:n(captain.balance),replyOnly:!disabled,deleted:false,safeRecovery:true,deleteOnly:true,warningSent:false,removedFromGroup:false};
    }
    const deletion=await greenDeletePolicyMessage(g.groupId,id,{reason,captainId:captain.id,balance:n(captain.balance)});
    const note=disabled
      ?"الحساب معطل — تم حذف الرسالة فقط"
      :`Reply برصيد ${n(captain.balance).toFixed(2)} د.أ (< 1.00) — تم حذف الـ Reply فقط؛ الرسائل العادية لا تُحذف`;
    await setEventStatus(id,"blocked",note);
    return {blocked:true,reason,balance:n(captain.balance),replyOnly:!disabled,deleted:true,deletion,deleteOnly:true,warningSent:false,removedFromGroup:false};
  }

  let text=msgText(md);
  if(type==="audioMessage"){
    if(!g.voiceEnabled){await setEventStatus(id,"ignored","تحويل التسجيل الصوتي إلى نص غير مفعّل");return {ignored:true,reason:"voice_disabled"}}
    try{
      text=await transcribeGreenAudio(md,id);
      await db.query(`UPDATE whatsapp_events SET message_text=$2 WHERE id_message=$1`,[id,text]);
      const reply=targetId(md);
      if(reply){
        const orig=await eventById(reply);const originalText=orig?.message_text||msgText(orig?.raw_payload?.messageData||{});
        if(detectComponents(originalText,inventoryOptions(orig?.raw_payload||payload)).length){await setEventStatus(id,"waiting_reaction",`صوت → نص: ${text.slice(0,180)} — بانتظار 👍`);return {audio:true,transcript:text,reply:true}}
      }
      if(detectComponents(text,inventoryOptions(payload)).length){await setEventStatus(id,"waiting_completion",`صوت → نص: ${text.slice(0,180)} — بانتظار الرد ثم 👍`);return {audio:true,transcript:text,request:true}}
      await setEventStatus(id,"ignored",`تم تحويل الصوت لكن النص غير محاسبي: ${text.slice(0,180)}`);return {audio:true,transcript:text,ignored:true};
    }catch(e){
      await openIssue({dedupKey:`VOICE_TRANSCRIPTION:${id}`,origin:"WEBHOOK",issueType:"VOICE_TRANSCRIPTION_FAILURE",severity:"WARNING",sourceId:id,summary:"تعذر تحويل تسجيل صوتي إلى نص",details:{error:e.message},suggestedAction:"افحص OpenAI Key ورابط تنزيل Green API"}).catch(()=>{});
      await setEventStatus(id,"error",e.message);throw e;
    }
  }
  // V3.8.5.54: GREEN can deliver ordinary visible text under more than one
  // typeMessage (notably quotedMessage and some text-bearing wrapper types).
  // Classify by the actual text payload after special accounting event types have
  // already been handled above. This prevents a valid request such as
  // "السعر 15 دينار 3 ركاب" from being marked "نوع رسالة غير محاسبي" merely
  // because GREEN used a different message type wrapper.
  const visibleText=msgText(md);
  if(type==="textMessage"||type==="extendedTextMessage"||type==="quotedMessage"||Boolean(visibleText)){
    text=visibleText||text;
    const reply=targetId(md);
    if(reply){
      const orig=await eventById(reply);
      const originalText=orig?.message_text||msgText(orig?.raw_payload?.messageData||{})||String(md?.quotedMessage?.textMessageData?.textMessage||md?.quotedMessage?.textMessage||"");
      if(detectComponents(originalText,inventoryOptions(orig?.raw_payload||payload)).length){
        await setEventStatus(id,"waiting_reaction","رد محفوظ — بانتظار 👍");
        return {reply:true};
      }
    }
    if(detectComponents(text,inventoryOptions(payload)).length){await setEventStatus(id,"waiting_completion","طلب محفوظ — بانتظار الرد ثم 👍");return {request:true};}
    await setEventStatus(id,"ignored","رسالة غير محاسبية");return {ignored:true};
  }

  await setEventStatus(id,"ignored",`نوع رسالة غير محاسبي (${type||"غير معروف"})`);
  return {ignored:true,reason:"unsupported_message_type",messageType:type||"unknown"};
}

export async function reactionPair(doneId){
  const exact=String(doneId),canonical=canonicalWhatsappMessageId(exact);
  const q=await db.query(`SELECT le.*,c.name captain_name,c.phone captain_phone FROM ledger_entries le JOIN captains c ON c.id=le.captain_id WHERE le.reference_type='green_reaction' AND (le.metadata->>'doneMessageId'=$1 OR le.metadata->>'canonicalDoneMessageId'=$2 OR ($2<>'' AND POSITION($2 IN COALESCE(le.metadata->>'doneMessageId',''))>0)) ORDER BY le.id`,[exact,canonical]);
  if(!q.rowCount)return null;
  const active=q.rows.filter(x=>!x.reversed_at&&String(x.entry_type)!=='REVERSAL');
  const allOriginal=q.rows.filter(x=>String(x.entry_type)!=='REVERSAL');
  const latestReactionId=String([...allOriginal].reverse().find(x=>x.metadata?.reactionId)?.metadata?.reactionId||'');
  const latestGeneration=latestReactionId?allOriginal.filter(x=>String(x.metadata?.reactionId||'')===latestReactionId):allOriginal.slice(-2);
  const basis=active.length?active:latestGeneration;
  const prod=active.find(x=>x.metadata?.pairRole==='producer'),cons=active.find(x=>x.metadata?.pairRole==='consumer');
  const anyProd=prod||[...basis].reverse().find(x=>x.metadata?.pairRole==='producer');
  const anyCons=cons||[...basis].reverse().find(x=>x.metadata?.pairRole==='consumer');
  const collect=(rows,key)=>{const out={};rows.filter(x=>x.metadata?.pairRole==='producer').forEach(x=>{const t=x.metadata?.type||'PASSENGER';const qn=n(x.metadata?.[key]??x.metadata?.quantity??1);out[t]=(out[t]||0)+qn});return Object.entries(out).map(([type,quantity])=>({type,quantity}))};
  const components=collect(active,'workloadQuantity');
  const originalComponents=collect(basis,'originalQuantity');
  const base=anyProd||anyCons;
  return {doneMessageId:String(doneId),producerId:anyProd?String(anyProd.captain_id):'',producerName:anyProd?.captain_name||'',producerPhone:anyProd?.captain_phone||'',consumerId:anyCons?String(anyCons.captain_id):'',consumerName:anyCons?.captain_name||'',consumerPhone:anyCons?.captain_phone||'',components,originalComponents,type:components.length>1?'MIXED':components[0]?.type||'',quantity:components.reduce((a,x)=>a+x.quantity,0),originalQuantity:originalComponents.reduce((a,x)=>a+x.quantity,0),originalMessageId:base?.metadata?.originalMessageId||'',requestText:base?.metadata?.requestText||'',reactionId:base?.metadata?.reactionId||'',occurredAt:base?.metadata?.eventAt||base?.created_at||null,ledgerIds:active.map(x=>x.id),complete:Boolean(prod&&cons),everComplete:Boolean(anyProd&&anyCons)}
}
export async function reactionPairs(){
  const q=await db.query(`SELECT le.*,c.name captain_name,c.phone captain_phone FROM ledger_entries le JOIN captains c ON c.id=le.captain_id WHERE le.reference_type='green_reaction' AND le.metadata ? 'doneMessageId' ORDER BY le.id DESC LIMIT 4000`);
  const groups=new Map();for(const r of q.rows){const d=String(r.metadata?.doneMessageId||'');if(!d)continue;if(!groups.has(d))groups.set(d,[]);groups.get(d).push(r)}
  const out=[];for(const [done,rows0] of groups){const rows=rows0.slice().sort((a,b)=>Number(a.id)-Number(b.id));const active=rows.filter(x=>!x.reversed_at&&String(x.entry_type)!=='REVERSAL');const all=rows.filter(x=>String(x.entry_type)!=='REVERSAL');const prod=active.find(x=>x.metadata?.pairRole==='producer'),cons=active.find(x=>x.metadata?.pairRole==='consumer'),anyProd=prod||all.find(x=>x.metadata?.pairRole==='producer'),anyCons=cons||all.find(x=>x.metadata?.pairRole==='consumer');const comps={};active.filter(x=>x.metadata?.pairRole==='producer').forEach(x=>{const t=x.metadata?.type||'PASSENGER';comps[t]=(comps[t]||0)+n(x.metadata?.workloadQuantity??x.metadata?.quantity??1)});const components=Object.entries(comps).map(([type,quantity])=>({type,quantity}));if(anyProd||anyCons)out.push({doneMessageId:done,producerId:anyProd?String(anyProd.captain_id):'',producerName:anyProd?.captain_name||'',producerPhone:anyProd?.captain_phone||'',consumerId:anyCons?String(anyCons.captain_id):'',consumerName:anyCons?.captain_name||'',consumerPhone:anyCons?.captain_phone||'',components,type:components.length>1?'MIXED':components[0]?.type||'',quantity:components.reduce((a,x)=>a+x.quantity,0),originalMessageId:anyProd?.metadata?.originalMessageId||'',requestText:anyProd?.metadata?.requestText||'',ledgerIds:active.map(x=>x.id),complete:Boolean(prod&&cons)})}
  return out.slice(0,500)
}
function reviewedComponents(payload={}){const passenger=Number(payload.passengerQuantity||0),order=Number(payload.orderQuantity||0);if(!Number.isInteger(passenger)||!Number.isInteger(order)||passenger<0||order<0||passenger>100||order>100)throw new Error("الكميات يجب أن تكون أعدادًا صحيحة من 0 إلى 100");const total=passenger+order;if(total<1)throw new Error("أدخل العدد");if(total>10&&payload.confirmLarge!==true)throw new Error("الحركة الكبيرة تحتاج تأكيدًا صريحًا");const components=[];if(passenger)components.push({type:"PASSENGER",quantity:passenger});if(order)components.push({type:"ORDER",quantity:order});return components}
export async function approveSuspicious(issueId,payload,userId){payload=payload||{};const iq=await db.query(`SELECT * FROM system_issues WHERE id=$1`,[issueId]);if(!iq.rowCount)throw new Error("المشكلة غير موجودة");const d=iq.rows[0].details||{};const producer=await captainById(payload.producerId),consumer=await captainById(payload.consumerId);if(!producer||!consumer)throw new Error("اختر المنتج والمستهلك");if(String(producer.id)===String(consumer.id))throw new Error("المنتج والمستهلك يجب أن يكونا كابتنين مختلفين");const components=reviewedComponents(payload);const reactionId=d.reactionId||iq.rows[0].source_id;const ev=reactionId?await eventById(reactionId):null;const comparisonMode=Boolean(d.comparisonMode);await recordReaction({producer,consumer,components,doneMessageId:d.doneMessageId||iq.rows[0].related_id,reactionId,originalMessageId:d.originalMessageId||"",userId,requestText:d.requestText||"",occurredAt:ev?.raw_payload?eventIsoFromPayload(ev.raw_payload):null,comparisonMode});await resolveIssueNative(issueId,"RESOLVE",payload.reason||"تمت مراجعة الحركة",userId);return {message:comparisonMode?"تم اعتماد الحركة داخل المقارنة فقط — بدون تغيير الأرصدة":"تم اعتماد الجرد بعد مراجعة المحاسب",comparisonOnly:comparisonMode}}
export async function undoReactionPairNative(doneId,reason,userId){const r=await reverseReaction(doneId,userId,reason||"إلغاء من المحاسب");return {reversed:r,message:`تم إلغاء ${r} حركة وإعادة الأرصدة`}}
export async function correctReaction(doneId,payload,userId){payload=payload||{};const pair=await reactionPair(doneId);if(!pair?.complete)throw new Error("لا توجد حركة مكتملة للتصحيح");const producer=await captainById(payload.producerId),consumer=await captainById(payload.consumerId);if(!producer||!consumer)throw new Error("اختر المنتج والمستهلك");if(String(producer.id)===String(consumer.id))throw new Error("المنتج والمستهلك يجب أن يكونا كابتنين مختلفين");const components=reviewedComponents(payload);await reverseReaction(doneId,userId,payload.reason||"تصحيح من المحاسب",{preserveWeeklyFloor:true});await recordReaction({producer,consumer,components,doneMessageId:doneId,reactionId:`CORR-${randomUUID()}`,originalMessageId:pair.originalMessageId||"",userId,requestText:pair.requestText||"",occurredAt:pair.occurredAt||null});for(const captainId of [pair.producerId,pair.consumerId]){await repairOrphanedWeeklyFloor({captainId,occurredAt:pair.occurredAt,userId,reason:"تغيير أطراف حركة مصححة"});await syncCaptainBalanceState(captainId).catch(()=>null)}return {message:`تم تصحيح الجرد: ${producer.name} / ${consumer.name}`}}

export async function reviewPendingMovement(id,action,patch,userId){patch=patch||{};const decision=String(action||"").toUpperCase();if(!["APPROVE","REJECT"].includes(decision))throw new Error("قرار المراجعة غير صالح");const q=await db.query(`SELECT * FROM whatsapp_pending_movements WHERE id=$1`,[id]);if(!q.rowCount)throw new Error("الحركة المعلقة غير موجودة");const x=q.rows[0];if(decision==="REJECT"){await db.query(`UPDATE whatsapp_pending_movements SET status='REJECTED',reviewed_by_user_id=$2,reviewed_at=NOW(),error=$3 WHERE id=$1`,[id,userId,String(patch.reason||"رفض المحاسب").slice(0,500)]);return {message:"تم رفض الحركة"}}const captainId=patch.captainId||x.captain_id;if(!captainId)throw new Error("اختر الكابتن");const dir=String(patch.direction||x.direction||"").toUpperCase();const type=String(patch.type||x.movement_type||"").toUpperCase();if(!["PRODUCTION","CONSUMPTION"].includes(dir))throw new Error("اتجاه الحركة غير صالح");if(!["PASSENGER","ORDER"].includes(type))throw new Error("نوع الحركة غير صالح");const qty=Number(patch.quantity??x.quantity);if(!Number.isInteger(qty)||qty<1||qty>100)throw new Error("الكمية يجب أن تكون عددًا صحيحًا من 1 إلى 100");if(qty>10&&patch.confirmLarge!==true)throw new Error("الحركة الكبيرة تحتاج تأكيدًا صريحًا");const unit=type==="ORDER"?1:.75;const sourceEvent=x.whatsapp_message_id?await eventById(x.whatsapp_message_id):null;const result=await createMovement({captainId,kind:dir==="PRODUCTION"?"production":"consumption",amount:qty*unit,referenceType:"whatsapp_review",referenceId:String(x.whatsapp_message_id||x.id),description:`اعتماد حركة واتساب — ${x.transcript||""}`,metadata:{type,quantity:qty,unitCommission:unit},createdBy:userId,occurredAt:sourceEvent?.raw_payload?eventIsoFromPayload(sourceEvent.raw_payload):null});await db.query(`UPDATE whatsapp_pending_movements SET status='APPROVED',captain_id=$2,direction=$3,movement_type=$4,quantity=$5,reviewed_by_user_id=$6,reviewed_at=NOW(),ledger_entry_ids=$7::jsonb WHERE id=$1`,[id,captainId,dir,type,qty,userId,JSON.stringify([result.entry.id])]);return {message:"تم اعتماد حركة واتساب",balance:result.balance}}

export async function safetyReconcile(){const balances=await db.query(`SELECT c.id,c.name,c.phone,COALESCE(SUM(le.amount),0)::numeric(12,3) balance,COUNT(le.id) FILTER(WHERE le.reversed_entry_id IS NOT NULL)::int reversals FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id GROUP BY c.id ORDER BY c.name`);const duplicate=await db.query(`SELECT reference_type,reference_id,COUNT(*)::int n FROM ledger_entries WHERE reference_id IS NOT NULL AND reversed_entry_id IS NULL GROUP BY reference_type,reference_id HAVING COUNT(*)>8 LIMIT 50`);return {ok:duplicate.rows.length===0,checked:balances.rowCount,issues:duplicate.rows,message:duplicate.rows.length?`تم الفحص ووجد ${duplicate.rows.length} مرجع يحتاج مراجعة`:`تم فحص ${balances.rowCount} كابتن — السجل المالي متوازن`}}
export async function repairWeeklyFloors(userId){const q=await db.query(`SELECT captain_id,COALESCE(NULLIF(metadata->>'weekEnd',''),((created_at AT TIME ZONE 'Asia/Amman')::date+(((4-EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Amman')::int)+7)%7))::int)::text) week_end,array_agg(id ORDER BY id) ids FROM ledger_entries WHERE entry_type='WEEKLY_DEDUCTION' AND metadata->>'type'='WEEKLY_FLOOR' AND reversed_at IS NULL GROUP BY captain_id,COALESCE(NULLIF(metadata->>'weekEnd',''),((created_at AT TIME ZONE 'Asia/Amman')::date+(((4-EXTRACT(DOW FROM created_at AT TIME ZONE 'Asia/Amman')::int)+7)%7))::int)::text) HAVING COUNT(*)>1`);let duplicateRepaired=0,orphanRepaired=0,errors=[];const changedCaptains=new Set();for(const x of q.rows){for(const id of x.ids.slice(1)){try{await reverseLedgerEntry({entryId:id,createdBy:userId,reason:"إصلاح أرضية أسبوعية مكررة"});duplicateRepaired++;changedCaptains.add(String(x.captain_id))}catch(e){errors.push(e.message)}}}const active=(await db.query(`SELECT captain_id,created_at,COALESCE(metadata->>'weekEnd','') week_end FROM ledger_entries WHERE entry_type='WEEKLY_DEDUCTION' AND metadata->>'type'='WEEKLY_FLOOR' AND reversed_at IS NULL ORDER BY id`)).rows;const seen=new Set();for(const x of active){const key=`${x.captain_id}:${x.week_end||activeWeek(new Date(x.created_at)).end}`;if(seen.has(key))continue;seen.add(key);try{const r=await repairOrphanedWeeklyFloor({captainId:x.captain_id,occurredAt:x.created_at,userId,reason:"إصلاح أرضية أسبوعية بلا حركة فعلية"});orphanRepaired+=r.reversed;if(r.reversed)changedCaptains.add(String(x.captain_id))}catch(e){errors.push(e.message)}}await Promise.all([...changedCaptains].map(id=>syncCaptainBalanceState(id).catch(()=>null)));const repaired=duplicateRepaired+orphanRepaired;return {repaired,duplicateRepaired,orphanRepaired,errors,message:repaired?`تم إصلاح ${duplicateRepaired} أرضية مكررة و${orphanRepaired} أرضية بلا حركة`:`الأرضيات الأسبوعية سليمة`}}
export async function reconcileMixed40(userId){
  // V3.8.5.18: the per-40 rule is retired. Remove any still-active legacy per-40
  // deductions/refunds from the CURRENT open week only. Historical closed weeks
  // are left untouched. Reversal rows are auditable and make this operation idempotent.
  const week=activeWeek(new Date());
  const startAt=new Date(`${week.start}T00:00:00+03:00`).toISOString();
  const endExclusiveAt=new Date(new Date(`${week.end}T00:00:00+03:00`).getTime()+24*60*60*1000).toISOString();
  const q=await db.query(`
    SELECT id,captain_id,amount,entry_type,reference_type,reference_id,description,metadata,created_at
      FROM ledger_entries
     WHERE reversed_at IS NULL
       AND entry_type<>'REVERSAL'
       AND (
         COALESCE(metadata->>'type','') IN ('WEEKLY_ORDER_BATCH','WEEKLY_ORDER_BATCH_REFUND')
         OR COALESCE(description,'') ILIKE '%40 حركة%'
         OR COALESCE(description,'') ILIKE '%WEEKLY_ORDER_BATCH%'
       )
       AND (
         COALESCE(metadata->>'weekEnd','')=$1::text
         OR (COALESCE(metadata->>'weekEnd','')='' AND created_at >= $2::timestamptz AND created_at < $3::timestamptz)
       )
     ORDER BY id
  `,[week.end,startAt,endExclusiveAt]);
  let adjusted=0,netAdjustment=0;const errors=[];const captainIds=new Set();const reversedEntryIds=[];
  for(const e of q.rows){
    try{
      await reverseLedgerEntry({entryId:e.id,createdBy:userId,reason:'إلغاء اقتطاع 40 حركة القديم — القاعدة الجديدة أرضية 1.50 الخميس 9م فقط'});
      adjusted++;
      netAdjustment=money(netAdjustment-Number(e.amount||0));
      captainIds.add(String(e.captain_id));
      reversedEntryIds.push(Number(e.id));
    }catch(err){
      if(err?.message==='entry_already_reversed')continue;
      errors.push(`#${e.id}: ${err?.message||err}`);
    }
  }
  await Promise.all([...captainIds].map(id=>syncCaptainBalanceState(id).catch(()=>null)));
  await audit(userId,'weekly.legacy40.retire_current_week','system',week.end,{weekStart:week.start,weekEnd:week.end,found:q.rowCount,adjusted,netAdjustment,reversedEntryIds,errors});
  return {netAdjustment,adjusted,found:q.rowCount,errors,weekStart:week.start,weekEnd:week.end,disabled:true,rule:'اقتطاع 40 حركة ملغى — أرضية 1.50 الخميس 9م فقط'};
}

// ----- Weekly floor: Thursday 16:00 (Asia/Amman), exactly once per captain/week -----
let thursdayDeductionTimer=null;
function ammanThursdayFloorScheduledAt(weekEnd){return new Date(`${weekEnd}T16:00:00+03:00`)}

function scheduledFloorWeek(now=new Date()){
  const p=jordanParts(now);
  const today=`${p.year}-${p.month}-${p.day}`;
  if(p.weekday==="Thu"&&Number(p.hour)>=21){
    const week=activeWeek(now);
    return {...week,scheduledAt:ammanThursdayFloorScheduledAt(week.end),catchup:false};
  }
  // Restart fail-safe: Friday may catch up the just-completed Thursday.
  if(p.weekday==="Fri"){
    const end=addDaysKey(today,-1);
    const start=addDaysKey(end,-6);
    return {start,end,scheduledAt:ammanThursdayFloorScheduledAt(end),catchup:true};
  }
  return null;
}

export async function rollbackFloorChargesForDate(targetDate="2026-08-27",createdBy=null){
  const day=String(targetDate||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error("invalid_floor_cleanup_date");
  const settingKey=`floor_cleanup_${day.replace(/-/g,"_")}_v38539`;
  const previous=await getSetting(settingKey,{});
  if(previous?.status==="COMPLETED")return {ok:true,skipped:true,...previous};

  const q=await db.query(`
    SELECT id,captain_id,amount,metadata
      FROM ledger_entries
     WHERE reversed_at IS NULL
       AND entry_type='WEEKLY_DEDUCTION'
       AND amount<0
       AND (created_at AT TIME ZONE 'Asia/Amman')::date=$1::date
       AND COALESCE(metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_THURSDAY_DEDUCTION')
     ORDER BY id
  `,[day]);

  let reversed=0,already=0,failed=0;const errors=[],captainIds=new Set(),entryIds=[];
  for(const e of q.rows){
    try{
      await reverseLedgerEntry({entryId:e.id,createdBy:createdBy||null,reason:`إلغاء أرضيات ${day} قبل اعتماد قاعدة الخميس 9 مساءً`});
      reversed++;entryIds.push(Number(e.id));captainIds.add(String(e.captain_id));
    }catch(err){
      if(err?.message==="entry_already_reversed"){already++;continue}
      failed++;errors.push(`#${e.id}: ${err?.message||err}`);
    }
  }
  await Promise.all([...captainIds].map(id=>syncCaptainBalanceState(id).catch(()=>null)));
  const state={status:failed?"PARTIAL":"COMPLETED",targetDate:day,found:q.rowCount,reversed,already,failed,entryIds,completedAt:new Date().toISOString(),errors};
  await putSetting(settingKey,state,createdBy||null);
  await audit(createdBy||null,"weekly.floor.cleanup_date","system",day,state);
  return {ok:failed===0,...state};
}

export async function applyThursdayFixedDeduction(now=new Date(),createdBy=null){
  if(await parallelComparisonEnabled())return {ok:true,skipped:true,comparisonMode:true,reason:"parallel_comparison_financial_isolation"};
  const cleanStart=await getCleanStartState();
  if(cleanStart.status!=="COMPLETED"||cleanStart.automaticStatus!=="LIVE")return {ok:true,skipped:true,reason:"clean_start_not_live"};
  const target=scheduledFloorWeek(now);
  if(!target)return {ok:true,skipped:true,reason:"outside_thursday_21_or_friday_catchup"};

  const {start,end,scheduledAt,catchup}=target;
  const lockClient=await db.connect();
  let locked=false;
  try{
    const lockKey=`abshir_weekly_floor_21:${end}`;
    const lk=await lockClient.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,[lockKey]);
    if(!lk.rows[0]?.locked)return {ok:true,skipped:true,reason:"scheduler_already_running",weekEnd:end};
    locked=true;

    const repair=await db.query(`SELECT id FROM whatsapp_repair_runs WHERE status IN ('QUEUING','RUNNING') ORDER BY id DESC LIMIT 1`);
    if(repair.rowCount)return {ok:true,skipped:true,reason:"repair_running",weekEnd:end};

    const weekStartAt=new Date(`${start}T00:00:00+03:00`);
    const resetAt=cleanStart.resetAt?new Date(cleanStart.resetAt):weekStartAt;
    const startAt=new Date(Math.max(weekStartAt.getTime(),Number.isFinite(resetAt.getTime())?resetAt.getTime():weekStartAt.getTime())).toISOString();
    const endExclusive=new Date(new Date(`${end}T00:00:00+03:00`).getTime()+24*60*60*1000).toISOString();

    const caps=await db.query(`
      SELECT DISTINCT c.id,c.name
        FROM captains c
        JOIN ledger_entries le ON le.captain_id=c.id
       WHERE c.status<>'disabled'
         AND le.entry_type IN ('PRODUCTION','CONSUMPTION')
         AND COALESCE(le.reference_type,'')<>'green_partial'
         AND le.reversed_at IS NULL
         AND le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz
         AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
    `,[startAt,endExclusive]);

    let applied=0,duplicates=0,duplicateRepairs=0,failed=0;const errors=[];
    for(const c of caps.rows){
      try{
        // Guard 1: any active floor for this captain/week means do not charge again.
        const existing=await db.query(`
          SELECT id FROM ledger_entries
           WHERE captain_id=$1
             AND entry_type='WEEKLY_DEDUCTION'
             AND reversed_at IS NULL
             AND COALESCE(metadata->>'type','')='WEEKLY_FLOOR'
             AND (
               COALESCE(metadata->>'weekEnd','')=$2::text
               OR (COALESCE(metadata->>'weekEnd','')='' AND created_at >= $3::timestamptz AND created_at < $4::timestamptz)
             )
           ORDER BY id
        `,[c.id,end,startAt,endExclusive]);
        if(existing.rowCount){
          // If legacy/race history already contains more than one active floor, keep the
          // oldest valid one and reverse every extra entry. This is the weekly duplicate audit.
          if(existing.rowCount>1){
            for(const extra of existing.rows.slice(1)){
              try{
                await reverseLedgerEntry({entryId:extra.id,createdBy:createdBy||null,reason:`إصلاح تلقائي: أرضية مكررة للأسبوع ${end}`});
                duplicateRepairs++;
              }catch(err){if(err?.message!=="entry_already_reversed")errors.push(`duplicate #${extra.id}: ${err?.message||err}`)}
            }
            await syncCaptainBalanceState(c.id).catch(()=>null);
          }
          duplicates++;
          continue;
        }

        // Guard 2: deterministic reference + DB unique index protects concurrent/replayed ticks.
        await createMovement({
          captainId:c.id,kind:"weekly_deduction",amount:FLOOR,
          referenceType:"weekly_floor_thursday_21",referenceId:`${end}:${c.id}:thu21:100`,
          description:`أرضية أسبوعية 1.00 د.أ — الخميس 9:00 مساءً — الأسبوع ${end}`,
          metadata:{type:"WEEKLY_FLOOR",weekStart:start,weekEnd:end,source:"THURSDAY_21_SCHEDULER",scheduledAt:scheduledAt.toISOString(),amount:FLOOR,catchup:Boolean(catchup)},
          createdBy:createdBy||null,occurredAt:scheduledAt.toISOString()
        });
        applied++;await syncCaptainBalanceState(c.id).catch(()=>null);
      }catch(e){
        if(e?.message==="duplicate_movement"){duplicates++;continue}
        failed++;errors.push(`${c.name}: ${e?.message||e}`);
      }
    }
    const details={weekStart:start,weekEnd:end,scheduledAt:scheduledAt.toISOString(),catchup:Boolean(catchup),eligible:caps.rowCount,applied,duplicates,duplicateRepairs,failed,amount:FLOOR,errors};
    await audit(createdBy||null,"weekly.floor.thursday_21","system",end,details);
    return {ok:failed===0,...details};
  }finally{
    if(locked){try{await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`,[`abshir_weekly_floor_21:${target.end}`])}catch{}}
    lockClient.release();
  }
}

export function startThursdayFixedDeductionScheduler(){
  if(thursdayDeductionTimer)return thursdayDeductionTimer;
  const tick=()=>applyThursdayFixedDeduction(new Date(),null).catch(err=>console.error("Thursday 1.50 floor scheduler:",err?.message||err));
  setTimeout(tick,5000).unref?.();
  thursdayDeductionTimer=setInterval(tick,60*1000);
  thursdayDeductionTimer.unref?.();
  return thursdayDeductionTimer;
}

export async function repairCancelled(userId){const q=await db.query(`SELECT * FROM inventory_reaction_cancellations WHERE status='LOCKED'`);let reversed=0,errors=[];for(const x of q.rows){try{reversed+=await reverseReaction(x.done_message_id,userId,"إصلاح طلب ملغى")}catch(e){errors.push(e.message)}}return {cancelledOrders:q.rowCount,reversed,errors,message:`تم فحص ${q.rowCount} طلب ملغى وعكس ${reversed} حركة فعالة متبقية`}}

function historyPayload(item,g,selfChatId=""){
  const md={};let type=String(item.typeMessage||item.messageData?.typeMessage||"");
  const rawMd=item.messageData||{};
  const rawExt=item.extendedTextMessageData||rawMd.extendedTextMessageData||{};
  const rawReaction=item.reactionMessageData||rawMd.reactionMessageData||{};
  const rawQuoted=item.quotedMessage||rawMd.quotedMessage||{};
  const rawReactionText=String(rawExt?.text??rawReaction?.text??rawReaction?.emoji??"").replace(/\uFE0F/g,"").trim();
  const rawReactionTarget=String(rawExt?.stanzaId||rawReaction?.stanzaId||rawReaction?.quotedStanzaId||rawReaction?.idMessageQuoted||rawQuoted?.stanzaId||"").trim();
  // V3.8.5.55: some GREEN history rows can arrive with a wrapper/unknown type while
  // still carrying reaction-shaped data. Only normalize UNKNOWN wrappers here so a
  // normal quoted reply whose text happens to be an emoji is never misclassified.
  const knownHistoryTypes=new Set(["textMessage","extendedTextMessage","quotedMessage","audioMessage","reactionMessage","deletedMessage","editedMessage"]);
  const accountingReactionEmoji=isCommissionLike(rawReactionText)||rawReactionText==="🚫"||Boolean(partialEmojiQuantity(rawReactionText));
  const explicitReactionShape=Boolean(Object.keys(rawReaction||{}).length)||/reaction/i.test(type);
  if(!knownHistoryTypes.has(type)&&rawReactionTarget&&(explicitReactionShape||accountingReactionEmoji))type="reactionMessage";
  if(type==="textMessage"){
    md.textMessageData=item.textMessageData||{textMessage:item.textMessage||item.text||""};
  }else if(type==="extendedTextMessage"||type==="quotedMessage"){
    const ext=item.extendedTextMessageData||item.extendedTextMessage||item.messageData?.extendedTextMessageData||{};
    md.extendedTextMessageData={...ext,text:ext.text||item.textMessage||item.text||"",stanzaId:ext.stanzaId||item.stanzaId||item.quotedMessage?.stanzaId||""};
    md.quotedMessage=item.quotedMessage||item.messageData?.quotedMessage||{};
    // The live rules engine treats a quoted text as an extended text reply.
    type="extendedTextMessage";
  }else if(type==="audioMessage"){
    md.fileMessageData=item.fileMessageData||item.messageData?.fileMessageData||{downloadUrl:item.downloadUrl||"",fileName:item.fileName||"",caption:item.caption||"",mimeType:item.mimeType||""};
  }else if(type==="reactionMessage"){
    md.reactionMessageData={...rawReaction};
    md.extendedTextMessageData={...rawExt};
    md.quotedMessage={...rawQuoted};
    if(!md.extendedTextMessageData.text&&rawReactionText)md.extendedTextMessageData.text=rawReactionText;
    if(!md.extendedTextMessageData.stanzaId&&rawReactionTarget)md.extendedTextMessageData.stanzaId=rawReactionTarget;
  }else if(type==="deletedMessage"){
    md.deletedMessageData=item.deletedMessageData||item.messageData?.deletedMessageData||{stanzaId:item.stanzaId||item.deletedMessageId||item.idMessageDeleted||""};
  }else if(type==="editedMessage"){
    md.editedMessageData=item.editedMessageData||item.messageData?.editedMessageData||{stanzaId:item.stanzaId||item.editedMessageId||"",textMessage:item.text||item.textMessage||""};
  }else{
    // V3.8.5.54: history sometimes wraps visible text in a type not present in
    // the small documented set. Preserve any real text/caption and normalize it
    // to a normal/quoted text message so the accounting parser can inspect it.
    const genericText=String(
      rawMd?.textMessageData?.textMessage||rawMd?.extendedTextMessageData?.text||
      rawMd?.editedMessageData?.textMessage||rawMd?.editedMessageData?.text||
      rawMd?.fileMessageData?.caption||rawMd?.fileMessageData?.captionText||
      item?.textMessageData?.textMessage||item?.extendedTextMessageData?.text||
      item?.fileMessageData?.caption||item?.fileMessageData?.captionText||
      item?.textMessage||item?.text||item?.caption||""
    ).trim();
    if(!genericText)return null;
    const stanza=String(
      rawMd?.extendedTextMessageData?.stanzaId||item?.extendedTextMessageData?.stanzaId||
      item?.stanzaId||item?.quotedMessage?.stanzaId||rawMd?.quotedMessage?.stanzaId||""
    ).trim();
    if(stanza){
      md.extendedTextMessageData={text:genericText,stanzaId:stanza};
      md.quotedMessage=item.quotedMessage||rawMd.quotedMessage||{};
      type="extendedTextMessage";
    }else{
      md.textMessageData={textMessage:genericText};
      type="textMessage";
    }
  }
  md.typeMessage=type;
  const outgoing=String(item.type||item.typeWebhook||"").toLowerCase().includes("outgoing");
  return {typeWebhook:outgoing?"outgoingMessageReceived":"incomingMessageReceived",idMessage:item.idMessage,senderData:{chatId:g.groupId,sender:item.senderId||item.sender||item.senderData?.sender||(outgoing?selfChatId:"")||"",senderName:item.senderName||item.senderData?.senderName||"",chatName:g.groupName||""},messageData:md,timestamp:item.timestamp||item.event_timestamp||null,_abshirHistoryRecovery:true}
}
export async function recoverHistory(count,enqueue,{hours=null,requeueExisting=false}={}){
  const g=await greenPublicSettings(),h=await greenHistory(count);const cutoff=hours?Date.now()-Number(hours)*3600000:0;
  const hardCutoverMs=await cleanSlateCutoverMs();
  let inserted=0,existing=0,requeued=0,skippedOld=0,missingTimestamp=0,errors=[];
  const selected=[];
  for(const item of h){const p=historyPayload(item,g);if(!p?.idMessage)continue;const ms=eventMsFromPayload(p);if((hours||hardCutoverMs)&&(!ms)){missingTimestamp++;continue}if((hours&&ms<cutoff)||(hardCutoverMs&&ms<hardCutoverMs)){skippedOld++;continue}selected.push(p)}
  selected.sort((a,b)=>eventMsFromPayload(a)-eventMsFromPayload(b));
  for(const p of selected){try{
    const eventTimestamp=normalizeWhatsappEventTimestamp(p.timestamp);
    const r=await db.query(`INSERT INTO whatsapp_events(id_message,webhook_type,chat_id,sender_id,sender_name,message_type,message_text,event_timestamp,raw_payload,status,webhook_received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'received',COALESCE(to_timestamp(CASE WHEN $8::bigint>100000000000 THEN $8::bigint/1000.0 ELSE $8::bigint::double precision END),NOW())) ON CONFLICT(id_message) DO NOTHING RETURNING id`,[p.idMessage,p.typeWebhook,p.senderData.chatId,p.senderData.sender,p.senderData.senderName,p.messageData.typeMessage,msgText(p.messageData),eventTimestamp,JSON.stringify(p)]);
    if(r.rowCount){inserted++;await enqueue(p)}else{existing++;if(requeueExisting){const st=await db.query(`SELECT status FROM whatsapp_events WHERE id_message=$1`,[p.idMessage]);if(['ignored','error','failed','received','waiting_review','waiting_reaction','waiting_completion','legacy_pending','reversed'].includes(String(st.rows[0]?.status||''))){try{await enqueue({...p,_abshirReplayNonce:Date.now()});requeued++}catch(e){if(!/already exists|duplicate/i.test(String(e.message)))errors.push(e.message)}}}}
  }catch(e){errors.push(String(e.message||e))}}
  const oldestMs=selected.length?Math.min(...selected.map(eventMsFromPayload).filter(Boolean)):0;
  const truncated=Boolean(hours&&h.length>=5000&&oldestMs>cutoff);
  return {inserted,existing,requeued,errors,total:h.length,selected:selected.length,skippedOld,missingTimestamp,hours,truncated,oldestRecoveredAt:oldestMs?new Date(oldestMs).toISOString():null}
}

// Safe gap recovery after GREEN-API was Not Authorized.
// It restores only the requested time window, stores quoted-message dependencies first,
// and marks every replay so historical messages never trigger delete/add/remove/send calls.
export async function recoverOutageWindow(payload,enqueue,userId=null,onProgress=null,runtime=null){
  payload=payload||{};
  const report=async data=>{if(typeof onProgress==="function")try{await onProgress(data||{})}catch{}};
  const requestedFrom=new Date(payload.fromAt||"");
  const requestedTo=payload.toAt?new Date(payload.toAt):new Date();
  const now=new Date();
  const to=new Date(Math.min(requestedTo.getTime(),now.getTime()));
  if(!Number.isFinite(requestedFrom.getTime())||!Number.isFinite(to.getTime()))throw new Error("أدخل وقت بداية ونهاية صحيحين لفترة الانقطاع");
  const hardCutoverMs=await cleanSlateCutoverMs();
  if(hardCutoverMs&&to.getTime()<=hardCutoverMs)throw new Error("الفترة المطلوبة أقدم من تصفير البداية الجديدة ولا يجوز إرجاع جردها");
  const from=new Date(Math.max(requestedFrom.getTime(),hardCutoverMs||0));
  if(from>=to)throw new Error("وقت بداية الانقطاع يجب أن يكون قبل وقت النهاية");
  if(to.getTime()-from.getTime()>7*24*60*60*1000)throw new Error("الاسترجاع الآمن يدعم فترة لا تتجاوز 7 أيام في العملية الواحدة");

  const provider=await whatsappProvider();
  const recoveryEngine=provider==='waha'?"V68_WAHA_ALWAYS_ON_SAFE_REBUILD":"V68_GREEN_ALWAYS_ON_SAFE_REBUILD";
  let selfChatId='';
  if(provider==='waha'){
    const w=await wahaSettingsRaw();
    const session=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}`);
    const status=String(session?.status||'UNKNOWN').toUpperCase();
    if(status!=='WORKING')throw new Error(`لا يمكن الاسترجاع قبل عودة WAHA إلى WORKING (الحالة الحالية: ${status})`);
    try{const me=await wahaRaw(`/api/sessions/${encodeURIComponent(w.session)}/me`);selfChatId=String(me?.id||'')}catch{}
    await report({stage:"WHATSAPP_READY",directReconciliation:true,recoveryEngine,message:"WAHA WORKING — جاري تجهيز سجل القروب"});
  }else{
    const state=await greenRaw("getStateInstance");
    if(String(state?.stateInstance||"")!=="authorized")throw new Error(`لا يمكن الاسترجاع قبل عودة GREEN إلى Authorized (الحالة الحالية: ${state?.stateInstance||"unknown"})`);
    const wa=await greenRaw("getWaSettings").catch(()=>({}));
    const selfDigits=String(wa?.phone||"").replace(/\D/g,"");
    selfChatId=selfDigits?`${selfDigits}@c.us`:String(wa?.chatId||"");
    await report({stage:"WHATSAPP_READY",directReconciliation:true,recoveryEngine:recoveryEngine,message:"GREEN Authorized — جاري تجهيز سجل القروب"});
  }

  const g=await greenPublicSettings();
  if(!g.groupId)throw new Error("اختر قروب واتساب أولًا");
  const count=provider==='waha'?Math.min(20000,Math.max(100,Number(payload.count)||20000)):Math.min(5000,Math.max(100,Number(payload.count)||5000));
  await report({stage:"FETCHING_HISTORY",count,directReconciliation:true,recoveryEngine,provider,message:provider==='waha'?`جاري جلب كل سجل WAHA المتاح داخل الفترة (حد حماية ${count})`:`جاري جلب آخر ${count} رسالة من GREEN`});
  const history=await greenHistory(count,{
    fromAt:from.toISOString(),toAt:to.toISOString(),dependencyLookbackMs:12*60*60*1000,
    onProgress:provider==='waha'?async hp=>{
      await report({stage:'FETCHING_HISTORY',count,directReconciliation:true,recoveryEngine,provider,...hp,message:hp?.message||`جاري جلب سجل WAHA ${Number(hp?.historyFetched||0)}/${count}`});
    }:null,
    beforePage:provider==='waha'&&typeof runtime?.waitForLivePriority==='function'?runtime.waitForLivePriority:null
  });
  const historyStats=history?._abshirHistoryStats||{};
  const rawHistoryTypeCounts={};
  for(const item of history){const k=String(item?.typeMessage||item?.messageData?.typeMessage||"UNKNOWN");rawHistoryTypeCounts[k]=(rawHistoryTypeCounts[k]||0)+1;}
  await report({stage:"HISTORY_FETCHED",historyFetched:history.length,count,rawHistoryTypeCounts,directReconciliation:true,recoveryEngine:recoveryEngine,message:`تم جلب ${history.length} رسالة من ${provider==='waha'?'WAHA':'GREEN'} — جاري تحديد الفترة المطلوبة`});

  const all=[];
  let normalizedReactionCandidates=0;
  for(const item of history){
    const p=historyPayload(item,g,selfChatId);
    if(p?.idMessage){all.push(p);if(String(p?.messageData?.typeMessage||"")==="reactionMessage")normalizedReactionCandidates++;}
  }
  function recoveryEventKey(p){
    const type=String(p?.messageData?.typeMessage||'');
    const id=canonicalWhatsappMessageId(p?.idMessage)||String(p?.idMessage||'');
    const family=type==='reactionMessage'?'reaction':type==='deletedMessage'?'delete':type==='editedMessage'?'edit':'message';
    return `${family}:${id}`;
  }
  function payloadScore(p){
    const md=p?.messageData||{};let score=0;
    if(msgText(md))score+=2;if(targetId(md))score+=3;if(md?.quotedMessage&&Object.keys(md.quotedMessage).length)score+=2;
    if(String(md?.typeMessage||'')==='reactionMessage')score+=4;if(String(p?._abshirProvider||'').toUpperCase()==='WAHA')score+=1;
    return score;
  }
  const byId=new Map();
  for(const p of all){
    const key=recoveryEventKey(p),prev=byId.get(key);
    if(!prev||payloadScore(p)>payloadScore(prev))byId.set(key,p);
  }

  // V63: merge EVERY durable local WhatsApp event from the exact window, not just
  // reactions. This combines already-received GREEN events with WAHA history before
  // reconciliation. Cross-provider message ids are canonicalized above, so the same
  // WhatsApp message is staged once while GREEN-covered ledger rows remain untouched.
  let localReactionSupplemented=0,localEventsSupplemented=0,localGreenEvents=0,localWahaEvents=0;
  let localPayloadCleared=0,localReactionPayloadCleared=0; // V-FIX: visibility into rows storage cleanup already emptied
  try{
    const lookbackFrom=new Date(Math.max(hardCutoverMs||0,from.getTime()-12*60*60*1000)).toISOString();
    const local=await db.query(`
      SELECT raw_payload,message_type
        FROM whatsapp_events
       WHERE chat_id=$1
         AND (CASE WHEN event_timestamp IS NULL THEN webhook_received_at
                   WHEN event_timestamp>100000000000 THEN to_timestamp(event_timestamp/1000.0)
                   WHEN event_timestamp>0 THEN to_timestamp(event_timestamp::double precision)
                   ELSE webhook_received_at END) >= $2::timestamptz
         AND (CASE WHEN event_timestamp IS NULL THEN webhook_received_at
                   WHEN event_timestamp>100000000000 THEN to_timestamp(event_timestamp/1000.0)
                   WHEN event_timestamp>0 THEN to_timestamp(event_timestamp::double precision)
                   ELSE webhook_received_at END) <= $3::timestamptz
       ORDER BY webhook_received_at
       LIMIT 30000`,[g.groupId,lookbackFrom,to.toISOString()]);
    for(const row of local.rows){
      const lp=row?.raw_payload;
      if(!lp?.idMessage){
        // Row exists locally for this window but carries no payload — almost always means
        // storage cleanup already cleared it (see storage.js NOT_REACTION_MESSAGE). Surface
        // this instead of silently under-counting supplemented events like before.
        localPayloadCleared++;
        if(String(row?.message_type||'')==='reactionMessage')localReactionPayloadCleared++;
        continue;
      }
      const key=recoveryEventKey(lp),prev=byId.get(key),isRx=String(lp?.messageData?.typeMessage||'')==='reactionMessage';
      if(!prev){byId.set(key,lp);localEventsSupplemented++;if(isRx)localReactionSupplemented++;}
      else if(payloadScore(lp)>payloadScore(prev))byId.set(key,lp);
      const providerName=String(lp?._abshirProvider||'').toUpperCase();
      if(providerName==='WAHA')localWahaEvents++;else localGreenEvents++;
    }
  }catch(e){/* provider history still works if local supplement query fails */}
  const selected=[...byId.values()].filter(p=>{
    const ms=eventMsFromPayload(p);
    return ms>=from.getTime()&&ms<=to.getTime();
  }).sort((a,b)=>eventMsFromPayload(a)-eventMsFromPayload(b));
  const outageRecoveryJobId=String(payload._abshirOutageRecoveryJobId||"");
  if(runtime&&typeof runtime==="object"){
    runtime.selectedIds=selected.map(p=>String(p.idMessage)).filter(Boolean);
    runtime.queuedIds=[];
    runtime.groupId=String(g.groupId||"");
    runtime.directReconciliation=true;
  }
  const clearedWarning=localReactionPayloadCleared>0
    ?` — ⚠️ ${localReactionPayloadCleared} تفاعل (👍/🚫/1️⃣-🔟) محلي بهذه الفترة كان قد مُسح مسبقًا بتنظيف التخزين ولا يمكن استرجاعه`
    :(localPayloadCleared>0?` — ⚠️ ${localPayloadCleared} حدث محلي بهذه الفترة بلا بيانات (على الأغلب مُسح سابقًا بتنظيف التخزين)`:'');
  await report({stage:"WINDOW_SELECTED",historyFetched:history.length,selected:selected.length,rawHistoryTypeCounts,normalizedReactionCandidates,localReactionSupplemented,localEventsSupplemented,localGreenEvents,localWahaEvents,localPayloadCleared,localReactionPayloadCleared,wahaSyntheticReactions:Number(historyStats.syntheticReactions||0),wahaHistoryBaseMessages:Number(historyStats.historyBaseMessages||0),wahaReactionsWithoutSender:Number(historyStats.reactionsWithoutSender||0),directReconciliation:true,recoveryEngine,message:`داخل الفترة ${selected.length} حدث فريد — تم دمج GREEN + WAHA بدون تكرار — Reaction تاريخية مستخرجة ${Number(historyStats.syntheticReactions||0)} — أحداث محلية أضيفت ${localEventsSupplemented}${clearedWarning}`});

  // Pull request/reply dependencies that may start just before the outage window.
  // Lookup by canonical WhatsApp id so WAHA serialized ids can resolve a GREEN-stored request.
  const messageByCanonical=new Map();
  for(const p of byId.values()){
    const type=String(p?.messageData?.typeMessage||'');
    if(['reactionMessage','deletedMessage','editedMessage'].includes(type))continue;
    const c=canonicalWhatsappMessageId(p?.idMessage);if(c&&!messageByCanonical.has(c))messageByCanonical.set(c,p);
  }
  const selectedIds=new Set(selected.map(p=>canonicalWhatsappMessageId(p.idMessage)).filter(Boolean));
  const dependencies=new Map();
  const frontier=[...selected];
  while(frontier.length){
    const p=frontier.shift();
    const md=p?.messageData||{};
    const ref=targetId(md)||deletedId(md)||String(md?.editedMessageData?.stanzaId||"");
    const canonicalRef=canonicalWhatsappMessageId(ref);
    if(!canonicalRef||selectedIds.has(canonicalRef)||dependencies.has(canonicalRef))continue;
    const dep=messageByCanonical.get(canonicalRef);
    if(dep&&hardCutoverMs&&eventMsFromPayload(dep)<hardCutoverMs)continue;
    if(dep){dependencies.set(canonicalRef,dep);frontier.push(dep)}
  }

  // V3.8.5.53: stage the COMPLETE window first, then run the accounting engine directly
  // in chronological order. This removes dependence on old BullMQ job/status state and makes
  // "100%" mean every selected event actually entered processGreenEvent in this recovery run.
  async function upsertEvent(p,status,{resetStatus=false}={}){
    const r=await db.query(`
      INSERT INTO whatsapp_events(
        id_message,webhook_type,chat_id,sender_id,sender_name,message_type,message_text,
        event_timestamp,raw_payload,status,webhook_received_at,last_error,processed_at
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,
        COALESCE(to_timestamp(CASE WHEN $8::bigint>100000000000 THEN $8::bigint/1000.0 ELSE $8::bigint::double precision END),NOW()),$11,NULL
      )
      ON CONFLICT(id_message) DO UPDATE SET
        webhook_type=EXCLUDED.webhook_type,
        chat_id=COALESCE(NULLIF(EXCLUDED.chat_id,''),whatsapp_events.chat_id),
        sender_id=COALESCE(NULLIF(EXCLUDED.sender_id,''),whatsapp_events.sender_id),
        sender_name=COALESCE(NULLIF(EXCLUDED.sender_name,''),whatsapp_events.sender_name),
        message_type=COALESCE(NULLIF(EXCLUDED.message_type,''),whatsapp_events.message_type),
        message_text=CASE WHEN COALESCE(EXCLUDED.message_text,'')<>'' THEN EXCLUDED.message_text ELSE whatsapp_events.message_text END,
        event_timestamp=COALESCE(EXCLUDED.event_timestamp,whatsapp_events.event_timestamp),
        raw_payload=EXCLUDED.raw_payload,
        status=CASE WHEN $12::boolean THEN EXCLUDED.status ELSE whatsapp_events.status END,
        last_error=CASE WHEN $12::boolean THEN NULL ELSE whatsapp_events.last_error END,
        processed_at=CASE WHEN $12::boolean THEN NULL ELSE whatsapp_events.processed_at END
      RETURNING (xmax=0) AS inserted
    `,[
      p.idMessage,p.typeWebhook,p.senderData.chatId,p.senderData.sender,p.senderData.senderName,p.messageData.typeMessage,msgText(p.messageData),normalizeWhatsappEventTimestamp(p.timestamp),JSON.stringify(p),status,status==="ignored"?"مرجع محفوظ لدعم استرجاع فترة الانقطاع":null,Boolean(resetStatus)
    ]);
    return {inserted:Boolean(r.rows[0]?.inserted)};
  }

  let dependencyInserted=0,inserted=0,existing=0;
  const errors=[];
  const dependencyList=[...dependencies.values()].sort((a,b)=>eventMsFromPayload(a)-eventMsFromPayload(b));
  let depIndex=0;
  for(const dep of dependencyList){
    depIndex++;
    try{const r=await upsertEvent({...dep,_abshirOutageDependency:true},"ignored");if(r.inserted)dependencyInserted++}catch(e){errors.push(`dependency:${dep.idMessage}:${e.message}`)}
    if(depIndex===dependencyList.length||depIndex%50===0)await report({stage:"DEPENDENCIES",selected:selected.length,dependencyTotal:dependencyList.length,dependencyProcessed:depIndex,dependencyInserted,errorCount:errors.length,directReconciliation:true,recoveryEngine:recoveryEngine,message:`تجهيز المراجع ${depIndex}/${dependencyList.length}`});
  }

  let staged=0;
  for(const raw of selected){
    const p={...raw,_abshirOutageRecovery:true,_abshirOutageRecoveryJobId:outageRecoveryJobId||undefined,_abshirRecoveryWindow:{fromAt:from.toISOString(),toAt:to.toISOString()}};
    try{
      const r=await upsertEvent(p,"received",{resetStatus:true});
      if(r.inserted)inserted++; else existing++;
    }catch(e){errors.push(`stage:${p.idMessage}:${e.message}`)}
    staged++;
    if(staged===selected.length||staged%50===0)await report({stage:"STAGING_EVENTS",historyFetched:history.length,selected:selected.length,processed:staged,inserted,existing,dependencyInserted,errorCount:errors.length,directReconciliation:true,recoveryEngine:recoveryEngine,message:`تجهيز كامل الفترة للفحص ${staged}/${selected.length}`});
  }

  if(runtime&&Array.isArray(runtime.queuedIds))runtime.queuedIds=selected.map(p=>String(p.idMessage)).filter(Boolean);

  let handled=0,repairedInventories=0,financialEntriesFixed=0,reversedMessages=0,waitingReview=0;
  let reactionEvents=0,likesFound=0,likeRemovalsFound=0,partialReactionsFound=0,fullCancelsFound=0;
  let ignoredEvents=0,duplicateEvents=0,blockedEvents=0,crossProviderProtected=0,legacyProtected=0;
  const recoveryDiagnostics=[];

  for(const raw of selected){
    if(handled%10===0&&typeof runtime?.waitForLivePriority==='function'){
      try{await runtime.waitForLivePriority({stage:'DIRECT_RECONCILIATION',processed:handled,total:selected.length});}catch{}
    }
    const p={...raw,_abshirOutageRecovery:true,_abshirOutageRecoveryJobId:outageRecoveryJobId||undefined,_abshirRecoveryWindow:{fromAt:from.toISOString(),toAt:to.toISOString()}};
    const md=p.messageData||{};
    if(String(md.typeMessage||'')==='reactionMessage'){
      reactionEvents++;
      const emoji=reactionEmoji(md);
      if(isCommissionLike(emoji))likesFound++;
      else if(!emoji)likeRemovalsFound++;
      else if(partialEmojiQuantity(emoji))partialReactionsFound++;
      else if(emoji==='🚫')fullCancelsFound++;
    }
    try{
      const out=await processGreenEvent(p,{force:true,userId,repairMode:false,safeRecovery:true});
      const fixed=Number(out?.repairedMissing||0);
      if(fixed>0){repairedInventories++;financialEntriesFixed+=fixed;}
      crossProviderProtected+=Number(out?.crossProviderCovered||0);
      legacyProtected+=Number(out?.legacyCovered||0);
      if(Number(out?.reversed||0)>0)reversedMessages++;
      if(out?.waitingReview)waitingReview++;
      if(out?.ignored)ignoredEvents++;
      if(out?.duplicate)duplicateEvents++;
      if(out?.blocked)blockedEvents++;
      if((fixed>0||out?.waitingReview||Number(out?.reversed||0)>0)&&recoveryDiagnostics.length<100){
        recoveryDiagnostics.push({idMessage:String(p.idMessage),type:String(md.typeMessage||''),emoji:String(md.typeMessage||'')==='reactionMessage'?reactionEmoji(md):'',fixedEntries:fixed,reversed:Number(out?.reversed||0),waitingReview:Boolean(out?.waitingReview),reason:String(out?.review?.reason||out?.reason||'')});
      }
    }catch(e){
      const msg=String(e?.message||e);
      errors.push(`process:${p.idMessage}:${msg}`);
      await setEventStatus(p.idMessage,"error",msg).catch(()=>{});
      if(recoveryDiagnostics.length<100)recoveryDiagnostics.push({idMessage:String(p.idMessage),type:String(md.typeMessage||''),error:msg});
    }
    handled++;
    if(handled===selected.length||handled%25===0){
      await report({
        stage:"DIRECT_RECONCILIATION",historyFetched:history.length,selected:selected.length,processed:handled,
        queueTotal:selected.length,queueHandled:handled,queueRemaining:Math.max(0,selected.length-handled),
        inserted,existing,requeued:existing,dependencyInserted,errorCount:errors.length,
        repairedInventories,financialEntriesFixed,reversedMessages,waitingReview,
        reactionEvents,likesFound,likeRemovalsFound,partialReactionsFound,fullCancelsFound,
        rawHistoryTypeCounts,normalizedReactionCandidates,localReactionSupplemented,localEventsSupplemented,localGreenEvents,localWahaEvents,
        wahaSyntheticReactions:Number(historyStats.syntheticReactions||0),wahaHistoryBaseMessages:Number(historyStats.historyBaseMessages||0),wahaReactionsWithoutSender:Number(historyStats.reactionsWithoutSender||0),
        ignoredEvents,duplicateEvents,blockedEvents,crossProviderProtected,legacyProtected,directReconciliation:true,fullReconciliation:true,recoveryEngine:recoveryEngine,
        auditCoverage:selected.length?Math.round((handled/selected.length)*10000)/100:100,
        message:handled>=100&&reactionEvents===0?`⚠ تم فحص ${handled}/${selected.length} بدون أي Reaction — لن يمكن إعادة بناء جرد 👍 إذا بقي العدد صفر`:`تدقيق محاسبي مباشر ${handled}/${selected.length} — 👍 ${likesFound} — أصلح ${repairedInventories} جرد`
      });
    }
  }

  const historyTimes=all.map(eventMsFromPayload).filter(Boolean);
  const oldestHistoryMs=historyTimes.length?Math.min(...historyTimes):0;
  const providerBaseCount=provider==='waha'?Number(historyStats.rawMessages||historyStats.historyBaseMessages||0):history.length;
  const truncated=Boolean(providerBaseCount>=count&&oldestHistoryMs>from.getTime());
  const result={
    fromAt:from.toISOString(),toAt:to.toISOString(),historyFetched:history.length,selected:selected.length,
    dependencyInserted,inserted,existing,requeued:existing,queued:selected.length,
    queueTotal:selected.length,queueHandled:handled,queueRemaining:Math.max(0,selected.length-handled),
    repairedInventories,financialEntriesFixed,reversedMessages,waitingReview,
    reactionEvents,likesFound,likeRemovalsFound,partialReactionsFound,fullCancelsFound,
    rawHistoryTypeCounts,normalizedReactionCandidates,localReactionSupplemented,localEventsSupplemented,localGreenEvents,localWahaEvents,
    wahaSyntheticReactions:Number(historyStats.syntheticReactions||0),wahaHistoryBaseMessages:Number(historyStats.historyBaseMessages||0),wahaReactionsWithoutSender:Number(historyStats.reactionsWithoutSender||0),
    ignoredEvents,duplicateEvents,blockedEvents,crossProviderProtected,legacyProtected,
    directReconciliation:true,fullReconciliation:true,recoveryEngine:recoveryEngine,
    auditCoverage:selected.length?Math.round((handled/selected.length)*10000)/100:100,
    errors,errorCount:errors.length,recoveryDiagnostics,truncated,oldestHistoryAt:oldestHistoryMs?new Date(oldestHistoryMs).toISOString():null
  };
  await report({stage:"FINALIZING",...result,message:`تم تدقيق ${handled}/${selected.length} رسالة مباشرة — جاري تثبيت النتيجة`});
  await audit(userId,provider==='waha'?"waha.outage_recovery.cross_provider_v63":"green.outage_recovery.cross_provider_v63","system","whatsapp",result);
  return result;
}
export async function reprocessRecent(limit,enqueue){const q=await db.query(`SELECT id_message,raw_payload FROM whatsapp_events WHERE status IN ('ignored','error','failed','legacy_pending','received','waiting_review','waiting_reaction','waiting_completion','reversed') ORDER BY webhook_received_at DESC LIMIT $1`,[Math.min(Number(limit)||250,1000)]);let queued=0,errors=[];for(const x of q.rows){try{await enqueue({...x.raw_payload,_abshirReplayNonce:Date.now()});queued++}catch(e){if(!/Job.*already exists|duplicate/i.test(e.message))errors.push(e.message)}}return {queued,errors}}
export async function last3DaysAudit(enqueue){const r=await recoverHistory(5000,enqueue,{hours:72,requeueExisting:true});return {...r,days:3,groupItems:r.selected,replayed:r.inserted+r.requeued,errorCount:r.errors.length,inventories:0,editsCorrected:0,deletionsApplied:0,deferred:0,warning:r.truncated?'Green API أعاد 5000 حدث وما زال أقدم حدث داخل نافذة 72 ساعة؛ قد توجد أحداث إضافية لم تصل من السجل.':''}}
export async function cleanupStatus(){const r=await db.query(`SELECT * FROM whatsapp_cleanup_sessions ORDER BY id DESC LIMIT 1`);if(!r.rowCount)return {status:"IDLE",groupOpen:true};const x=r.rows[0];return {status:x.status,groupOpen:x.group_open,removed:x.removed,kept:x.kept,lastError:x.last_error||"",finalNote:x.final_note||""}}
export async function startCleanup(userId){
  const g=await greenPublicSettings();
  const id=(await db.query(`INSERT INTO whatsapp_cleanup_sessions(status,group_open,started_by_user_id) VALUES('LOCKING',NULL,$1) RETURNING id`,[userId])).rows[0].id;
  try{
    if(g.enabled&&g.groupId)await greenGroupPosting(g.groupId,false);
    await db.query(`UPDATE whatsapp_cleanup_sessions SET status='CLEANING',group_open=FALSE WHERE id=$1`,[id]);

    // The former cleanup deleted every old processed whatsapp_events row after
    // the newest 300. That could remove reactions and their dependencies, making
    // a later outage recovery impossible. Route cleanup through the retention
    // engine instead: it releases large, expired payload/text data while keeping
    // event identities, reaction payloads, ledger rows, and idempotency evidence.
    const storageResult=await runStorageCleanup({userId,automatic:false});
    const removedBuckets=storageResult?.report?.removed||{};
    const removed=Object.values(removedBuckets).reduce((sum,value)=>sum+Number(value||0),0);
    const count=(await db.query(`SELECT COUNT(*)::int n FROM whatsapp_events`)).rows[0].n;

    if(g.enabled&&g.groupId)await greenGroupPosting(g.groupId,true);
    await db.query(`UPDATE whatsapp_cleanup_sessions SET status='COMPLETED',group_open=TRUE,removed=$2,kept=$3,completed_at=NOW(),updated_at=NOW(),final_note='تم تنظيف البيانات المنتهية بأمان دون حذف سجل الأحداث أو الـReaction' WHERE id=$1`,[id,removed,count]);
    return await cleanupStatus();
  }catch(e){
    try{if(g.enabled&&g.groupId)await greenGroupPosting(g.groupId,true)}catch{}
    await db.query(`UPDATE whatsapp_cleanup_sessions SET status='ERROR',group_open=TRUE,last_error=$2,completed_at=NOW(),updated_at=NOW() WHERE id=$1`,[id,e.message]);
    throw e;
  }
}
export async function forceOpenCleanup(userId){const g=await greenPublicSettings();if(g.enabled&&g.groupId)await greenGroupPosting(g.groupId,true);await db.query(`UPDATE whatsapp_cleanup_sessions SET status='CANCELLED',group_open=TRUE,updated_at=NOW(),final_note='تم فتح القروب يدويًا' WHERE id=(SELECT id FROM whatsapp_cleanup_sessions ORDER BY id DESC LIMIT 1)`);await audit(userId,"whatsapp_cleanup.force_open","system","cleanup",{});return await cleanupStatus()}

export async function featureBootstrap(){const [transfers,pending,issues,cnums,cancels,wa,pairs,green,guide,friday,cleanup]=await Promise.all([transfersForBootstrap(),db.query(`SELECT p.*,c.name captain_name FROM whatsapp_pending_movements p LEFT JOIN captains c ON c.id=p.captain_id ORDER BY p.created_at DESC LIMIT 250`),db.query(`SELECT i.*,u.username resolved_by FROM system_issues i LEFT JOIN users u ON u.id=i.resolved_by_user_id ORDER BY CASE i.status WHEN 'OPEN' THEN 0 WHEN 'IN_REVIEW' THEN 1 ELSE 2 END,i.created_at DESC LIMIT 80`),db.query(`SELECT n.*,u1.username created_by,u2.username updated_by FROM inventory_cancellation_numbers n LEFT JOIN users u1 ON u1.id=n.created_by_user_id LEFT JOIN users u2 ON u2.id=n.updated_by_user_id ORDER BY n.updated_at DESC`),db.query(`SELECT x.*,p.name producer_name,c.name consumer_name FROM inventory_reaction_cancellations x LEFT JOIN captains p ON p.id=x.producer_id LEFT JOIN captains c ON c.id=x.consumer_id ORDER BY x.created_at DESC LIMIT 250`),db.query(`SELECT id_message,chat_id,sender_id,sender_name,message_type,message_text,status,last_error,webhook_received_at,event_timestamp,processing_started_at,processed_at FROM whatsapp_events ORDER BY webhook_received_at DESC LIMIT 150`),reactionPairs(),greenPublicSettings(),groupGuidePublic(),latestFridaySession(),cleanupStatus()]);const pend=pending.rows.map(x=>({ID:String(x.id),WhatsAppMessageID:x.whatsapp_message_id||"",GroupID:x.group_id||"",SenderPhone:x.sender_phone||"",SenderName:x.sender_name||"",CaptainID:x.captain_id?String(x.captain_id):"",CaptainName:x.captain_name||"",SourceType:x.source_type||"TEXT",Transcript:x.transcript||"",Direction:x.direction||"",Type:x.movement_type||"",Quantity:x.quantity,Confidence:n(x.confidence),Status:x.status,Error:x.error||"",ReviewedAt:x.reviewed_at,CreatedAt:x.created_at}));const iss=issues.rows.map(x=>({ID:String(x.id),DedupKey:x.dedup_key||"",Origin:x.origin,IssueType:x.issue_type,Severity:x.severity,Status:x.status,SourceID:x.source_id||"",RelatedID:x.related_id||"",Summary:x.summary,Details:JSON.stringify(x.details||{}),SuggestedAction:x.suggested_action||"",CreatedAt:x.created_at,UpdatedAt:x.updated_at,ResolvedBy:x.resolved_by||"",ResolvedAt:x.resolved_at,ResolutionNote:x.resolution_note||""}));const cn=cnums.rows.map(x=>({ID:String(x.id),Name:x.name,Phone:x.phone,Status:x.status,CreatedBy:x.created_by||"",CreatedAt:x.created_at,UpdatedBy:x.updated_by||"",UpdatedAt:x.updated_at}));const rc=cancels.rows.map(x=>({ID:String(x.id),DoneMessageID:x.done_message_id,OriginalMessageID:x.original_message_id||"",ReactionMessageID:x.reaction_message_id||"",AuthorizedPhone:x.authorized_phone||"",AuthorizedName:x.authorized_name||"",Status:x.status,Mode:x.mode,ProducerID:x.producer_id?String(x.producer_id):"",ProducerName:x.producer_name||"",ConsumerID:x.consumer_id?String(x.consumer_id):"",ConsumerName:x.consumer_name||"",MovementType:x.movement_type||"",OriginalQuantity:x.original_quantity,CancelQuantity:x.cancel_quantity,RemainingQuantity:x.remaining_quantity,DeltaQuantity:x.delta_quantity,ReversedTransactionIDs:JSON.stringify(x.reversed_ledger_ids||[]),CreatedAt:x.created_at,ReopenedAt:x.reopened_at,ReopenReason:x.reopen_reason||""}));const wm=wa.rows.map(x=>({MessageID:x.id_message,GroupID:x.chat_id||"",SenderPhone:displayPhone(x.sender_id),SenderName:x.sender_name||"",SourceType:x.message_type||"",MessageText:x.message_text||"",ProcessingStatus:String(x.status||"").toUpperCase(),ProcessingNote:x.last_error||"",CreatedAt:x.webhook_received_at,WhatsAppAt:x.event_timestamp?new Date(Number(x.event_timestamp)*(Number(x.event_timestamp)<1e11?1000:1)):null,SystemReceivedAt:x.webhook_received_at,ProcessingStartedAt:x.processing_started_at,ProcessingFinishedAt:x.processed_at}));const cancelled=rc.filter(x=>x.Status==="LOCKED"||x.Status==="PARTIAL").map(x=>({DoneMessageID:x.DoneMessageID,ProducerName:x.ProducerName,ConsumerName:x.ConsumerName,Type:x.MovementType,Quantity:x.OriginalQuantity,Components:[],CancelReason:x.Mode,CancelledBy:x.AuthorizedName,CancelledAt:x.CreatedAt}));return {transfers,pendingMovements:pend,systemIssues:iss,cancellationNumbers:cn,reactionCancellations:rc,whatsappMessages:wm,reactionPairs:pairs,greenApi:green,groupGuide:guide,fridayGroupSession:friday,whatsappCleanup:cleanup,cancelledOrders:cancelled}}
export async function captainFeatureBootstrap(captainId){const [transfers,partial]=await Promise.all([transfersForBootstrap(captainId),db.query(`SELECT x.* FROM inventory_reaction_cancellations x WHERE x.status='PARTIAL' AND (x.producer_id=$1 OR x.consumer_id=$1) ORDER BY x.created_at DESC LIMIT 200`,[captainId])]);return {transfers,partialCancellations:partial.rows.map(x=>({ID:String(x.id),DoneMessageID:x.done_message_id,OriginalMessageID:x.original_message_id||"",ReactionMessageID:x.reaction_message_id||"",AuthorizedPhone:x.authorized_phone||"",AuthorizedName:x.authorized_name||"",Status:x.status,Mode:x.mode,ProducerID:x.producer_id?String(x.producer_id):"",ConsumerID:x.consumer_id?String(x.consumer_id):"",MovementType:x.movement_type||"",OriginalQuantity:n(x.original_quantity),CancelQuantity:n(x.cancel_quantity),RemainingQuantity:n(x.remaining_quantity),DeltaQuantity:n(x.delta_quantity),CreatedAt:x.created_at}))}}


