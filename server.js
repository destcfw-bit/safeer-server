import {registerPushRoutes} from "./push-notifications.js";
import {registerBalanceImportRoutes} from "./balance-transfer.js";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import { makeLegacyRpc } from "./legacy.js";
import {
  db, initDb, findUserByUsername, getUserPublic,
  listCaptains, createCaptain, updateCaptain, getBalance,
  createMovement, reverseLedgerEntry, listLedger, audit,
  createCaptainUser, getCaptainProfile, getCaptainSummary, getCaptainAccount,
  createRechargeCode, listRechargeCodes, cancelRechargeCode, redeemRechargeCode,
  createRechargeRequest, listRechargeRequests, reviewRechargeRequest,
  buildWeeklySettlement, listWeeklySettlements, getWeeklySettlementItems,
  markSettlementTransferred, archiveWeeklySettlement,
  insertWebhookEvent, getStats, saveMigrationSnapshot, touchUserLogin,
  startFullMigrationRun, stageFullMigrationBatch, completeFullMigrationUpload,
  setFullMigrationCutoverMeta, getFullMigrationStatus, applyFullMigrationStep,
  getFinalCutoverAudit, getFinalWeekMigrationAudit, getFinalTakeoverState, saveFinalTakeoverState,
  beginLegacyWeekBridgeRun, importLegacyWeekBridgeBatch, completeLegacyWeekBridgeUpload,
  attachLegacyWeekBridgeRepair, failLegacyWeekBridgeRun, getLegacyWeekBridgeStatus, applyLegacyWeekCurrentBalanceSync,
  findRechargePortalUserByUsername, getRechargePortalUserPublic, touchRechargePortalUserLogin,
  searchRechargePortalCaptains, createRechargePortalCode, listRechargePortalCodes, getRechargePortalStats,
  getSystemSetting,getCleanStartState,getCaptainSiteMaintenanceState,
  isCleanSlateResetRequired,executeOneTimeCleanSlateReset
} from "./db.js";
import { enqueueWebhook, startWorker, whatsappQueue, repairQueue, redis, getAccountingMode, setAccountingMode, commitFinalTakeoverLive, quiesceActiveRepairForFinalTakeover, startRepairForExistingCutover, enforceCleanStartBootGate, prepareQueuesForCleanSlateReset } from "./queue.js";
import { transferImage, greenPublicSettings, activeWhatsappProvider, activateGreenWebhook, restoreCaptainToGroupIfEligible, payFridaySettlement, forceOpenFriday, repairOrphanedWeeklyFloor, syncCaptainBalanceState, startThursdayFixedDeductionScheduler, rollbackFloorChargesForDate, recordGreenServiceWebhook, recordWahaSessionWebhook, convertWahaWebhookToGreen, wahaBridgeGroups, wahaBridgeScanGroup, wahaBridgeStatus } from "./features.js";
import { startStorageCleanupScheduler } from "./storage.js";
import { northWhatsappName, isTrustedNorthWhatsappName } from "./north-captain.js";

const app = Fastify({logger:true, bodyLimit:12*1024*1024});
const NORTH_DROPCONNECT_SECRET = process.env.NORTH_DROPCONNECT_SECRET || "";

// V3.8.5.64 — Cross-provider WAHA+GREEN safe rebuild with canonical WhatsApp message-id idempotency.
// PostgreSQL is the core requirement for login/accounting. Redis/WhatsApp is a secondary service:
// if it is temporarily down, the site remains usable and the queue reconnects in the background.
let systemReady=false;       // core PostgreSQL/schema is ready
let redisReady=false;        // Redis + clean-start queue gate is ready
let workerStarted=false;
let schedulersStarted=false;
let startupError=null;
let startupStage="HTTP_BINDING";
let startupStartedAt=new Date().toISOString();
let backgroundStarted=false;

function sleep(ms){ return new Promise(resolve=>setTimeout(resolve,ms)); }
async function withTimeout(promise,ms,label){
  let timer;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{ timer=setTimeout(()=>reject(new Error(`${label}_timeout_${ms}ms`)),ms); })
    ]);
  }finally{ if(timer)clearTimeout(timer); }
}


const RETIRED_HISTORY_PREFIXES=["/cutover/final","/repair/legacy-week","/migration/full","/migration/google-snapshot"];
app.addHook("preHandler",async(request,reply)=>{
  const path=String(request.raw.url||"").split("?")[0];
  if(RETIRED_HISTORY_PREFIXES.some(prefix=>path.startsWith(prefix))){
    return reply.code(410).send({ok:false,error:"retired_in_clean_start",message:"تم إلغاء نقل وإصلاح الجرد القديم في إصدار البداية الجديدة"});
  }
});

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is missing");
await app.register(jwt, {secret:process.env.JWT_SECRET});
const legacyRpc = makeLegacyRpc(app);

app.decorate("authenticate", async function(request, reply) {
  try {
    await request.jwtVerify();
    const current=await getUserPublic(request.user?.sub);
    const sameCaptain=String(current?.captain_id||"")===String(request.user?.captainId||"");
    if(!current?.is_active||current.role!==request.user?.role||!sameCaptain)throw new Error("session_revoked");
    request.user={...request.user,role:current.role,captainId:current.captain_id||null,username:current.username};
  } catch {
    return reply.code(401).send({ok:false,error:"session_revoked"});
  }
});

function requireRoles(...roles) {
  return async (request, reply) => {
    await app.authenticate(request, reply);
    if (reply.sent) return;
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ok:false,error:"forbidden"});
    }
    if(request.user.role==="captain"){
      const maintenance=await getCaptainSiteMaintenanceState();
      if(maintenance.enabled){
        return reply.code(503).send({ok:false,error:"captain_site_maintenance",maintenance});
      }
    }
  };
}

registerBalanceImportRoutes(app,requireRoles);
registerPushRoutes(app,{db,requireRoles});

function requireAbshirManualBridgeSecret(request,reply){
  const configured=String(process.env.ABSHIR_MANUAL_BRIDGE_SECRET||'');
  const supplied=String(request.headers['x-abshir-manual-bridge-secret']||'');
  if(!configured){
    reply.code(503).send({ok:false,error:'abshir_manual_bridge_not_configured'});
    return false;
  }
  if(!supplied||supplied!==configured){
    reply.code(401).send({ok:false,error:'invalid_abshir_manual_bridge_secret'});
    return false;
  }
  return true;
}

function requireMigrationSecret(request, reply){
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.body?.secret || "");
  if(!configured){reply.code(503).send({ok:false,error:"migration_sync_not_configured"});return false;}
  if(!supplied || supplied!==configured){reply.code(401).send({ok:false,error:"invalid_migration_secret"});return false;}
  return true;
}


const loginAttempts=new Map();
const portalLoginAttempts=new Map();
function requestIp(request){return String(request.ip||request.headers["x-forwarded-for"]||"unknown").split(",")[0].trim()}
function loginAttemptKey(request,scope){return `${scope}:${requestIp(request)}`}
function loginAllowed(request,scope){
  const key=loginAttemptKey(request,scope),now=Date.now(),row=loginAttempts.get(key);
  if(!row)return true;
  if(row.lockedUntil>now)return false;
  if(now-row.windowStarted>5*60*1000){loginAttempts.delete(key);return true}
  return true;
}
function loginFailed(request,scope){
  const key=loginAttemptKey(request,scope),now=Date.now();
  let row=loginAttempts.get(key);
  if(!row||now-row.windowStarted>5*60*1000)row={count:0,windowStarted:now,lockedUntil:0};
  row.count+=1;
  if(row.count>=8)row.lockedUntil=now+60*1000;
  loginAttempts.set(key,row);
}
function loginSucceeded(request,scope){loginAttempts.delete(loginAttemptKey(request,scope))}
function portalCookies(request){
  const raw=String(request.headers.cookie||"");
  const out={};
  raw.split(";").forEach(part=>{const i=part.indexOf("=");if(i<0)return;const k=part.slice(0,i).trim();const v=part.slice(i+1).trim();if(k)out[k]=decodeURIComponent(v)});
  return out;
}
function portalCookieValue(token,maxAgeSeconds=8*60*60){
  const secure=Boolean(process.env.RAILWAY_ENVIRONMENT||process.env.RAILWAY_PUBLIC_DOMAIN||process.env.NODE_ENV==="production");
  return `abshir_portal_session=${encodeURIComponent(token||"")}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0,Number(maxAgeSeconds)||0)}${secure?"; Secure":""}`;
}
async function requirePortalAuth(request,reply){
  const token=portalCookies(request).abshir_portal_session||"";
  if(!token)return reply.code(401).send({ok:false,error:"not_authenticated"});
  let payload;
  try{payload=app.jwt.verify(token)}catch{return reply.code(401).send({ok:false,error:"not_authenticated"})}
  if(payload?.scope!=="recharge_portal"||!payload?.portalUserId)return reply.code(401).send({ok:false,error:"not_authenticated"});
  const user=await getRechargePortalUserPublic(payload.portalUserId);
  if(!user||!user.is_active)return reply.code(401).send({ok:false,error:"not_authenticated"});
  request.portalUser=user;
}
function portalLoginKey(request){return requestIp(request)}
function portalLoginAllowed(request){
  const key=portalLoginKey(request),now=Date.now(),row=portalLoginAttempts.get(key);
  if(!row)return true;
  if(row.lockedUntil&&row.lockedUntil>now)return false;
  if(now-row.windowStarted>5*60*1000){portalLoginAttempts.delete(key);return true}
  return true;
}
function portalLoginFailed(request){
  const key=portalLoginKey(request),now=Date.now();
  let row=portalLoginAttempts.get(key);
  if(!row||now-row.windowStarted>5*60*1000)row={count:0,windowStarted:now,lockedUntil:0};
  row.count+=1;if(row.count>=8)row.lockedUntil=now+60*1000;portalLoginAttempts.set(key,row);
}
function portalLoginSucceeded(request){portalLoginAttempts.delete(portalLoginKey(request))}
function portalAllowedPackages(username){
  const u=String(username||"").trim().toUpperCase();
  return (u==="A1"||u==="Q1") ? [0.5,1,5,10,15,20,30] : [10,15,20,30];
}
function portalCanCustomAmount(username){
  return String(username||"").trim().toUpperCase()==="T1";
}
function portalAmountAllowed(username,value){
  const amount=Number(value);
  if(!Number.isFinite(amount)||amount<=0||amount>999999999.999)return false;
  if(portalCanCustomAmount(username)){
    const rounded=Math.round(amount*1000)/1000;
    return Math.abs(amount-rounded)<1e-9;
  }
  return portalAllowedPackages(username).includes(amount);
}


app.get("/captain.webmanifest", async (request, reply) => reply.type("application/manifest+json").header("Cache-Control","no-cache").send({name:"السفير | بوابة الكباتن",short_name:"السفير",lang:"ar",dir:"rtl",start_url:"/captain",scope:"/",display:"standalone",background_color:"#0B2341",theme_color:"#0B2341",icons:[{src:"/assets/safeer-official-logo.png",sizes:"any",type:"image/png",purpose:"any"}]}));
app.get("/captain-sw.js", async (request, reply) => reply.type("application/javascript").header("Service-Worker-Allowed","/").header("Cache-Control","no-store").send("self.addEventListener('install',e=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('push',e=>{let data={};try{data=e.data?.json()||{}}catch{};e.waitUntil(self.registration.showNotification(String(data.title||'إشعار السفير').slice(0,100),{body:String(data.body||'لديك تحديث جديد').slice(0,220),icon:'/assets/safeer-official-logo.png',data:{url:'/captain'},tag:String(data.tag||'safeer-update')}))});self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(self.clients.openWindow('/captain'))});"));

app.get("/favicon.ico", async (request, reply) => {
  return reply.code(204).send();
});

app.get("/assets/safeer-official-logo.png", async (request, reply) => {
  const image=await fs.readFile(new URL("./assets/safeer-official-logo.png", import.meta.url));
  return reply.type("image/png").header("Cache-Control","public, max-age=3600").send(image);
});

app.get("/assets/safeer-logo.svg", async (request, reply) => {
  const image=await fs.readFile(new URL("./assets/safeer-logo.svg", import.meta.url));
  return reply.type("image/svg+xml").send(image);
});

app.get("/assets/ezwa-logo-gold.svg", async (request, reply) => {
  const image=await fs.readFile(new URL("./assets/ezwa-logo-gold.svg", import.meta.url));
  return reply.type("image/svg+xml").header("Cache-Control","public, max-age=3600").send(image);
});

app.get("/assets/ezwa-logo.png", async (request, reply) => {
  const image=await fs.readFile(new URL("./assets/ezwa-logo.png", import.meta.url));
  return reply.type("image/png").header("Cache-Control","public, max-age=86400").send(image);
});

app.get("/", async (request, reply) => reply.redirect("/captain"));

app.get("/health", async (request, reply) => {
  // Always test dependencies with strict timeouts, even before full readiness.
  let postgres=false,redisOk=false,errors=[];
  try{await withTimeout(db.query("SELECT 1"),2500,"postgres_health");postgres=true}catch(e){errors.push(`postgres:${e.message}`)}
  try{await withTimeout(redis.ping(),2500,"redis_health");redisOk=true}catch(e){errors.push(`redis:${e.message}`)}
  if(startupError)errors.push(`startup:${String(startupError).slice(0,1000)}`);
  return reply.code(200).send({
    ok:true,ready:systemReady,coreReady:systemReady,redisReady,workerStarted,
    postgres,redis:redisOk,stage:startupStage,time:new Date().toISOString(),startupStartedAt,
    startupError:startupError?String(startupError).slice(0,1000):null,errors
  });
});

// Static pages are always reachable. API/login becomes available as soon as PostgreSQL is ready.
// Redis/WhatsApp may still be reconnecting; queue-specific calls fail fast instead of freezing the site.
app.addHook("preHandler",async(request,reply)=>{
  if(systemReady)return;
  const path=String(request.raw.url||"").split("?")[0];
  const safe=path==="/"||path==="/health"||path==="/favicon.ico"||path==="/accountant"||path==="/captain"||path==="/recharge-portal"||path==="/recharge-portal/";
  if(safe)return;
  return reply.code(503).send({
    ok:false,error:"system_starting",
    message:"قاعدة البيانات قيد التجهيز، أعد المحاولة بعد ثوانٍ",
    startupStage,startupError:startupError?String(startupError).slice(0,800):null
  });
});

app.get("/integration/abshir-manual/waha/status", async (request, reply) => {
  if(!requireAbshirManualBridgeSecret(request,reply))return;
  try{return reply.send(await wahaBridgeStatus())}
  catch(error){return reply.code(503).send({ok:false,error:String(error?.message||error),provider:'WAHA'})}
});

app.get("/integration/abshir-manual/waha/groups", async (request, reply) => {
  if(!requireAbshirManualBridgeSecret(request,reply))return;
  try{return reply.send(await wahaBridgeGroups())}
  catch(error){return reply.code(503).send({ok:false,error:String(error?.message||error),provider:'WAHA'})}
});

app.post("/integration/abshir-manual/waha/scan", async (request, reply) => {
  if(!requireAbshirManualBridgeSecret(request,reply))return;
  const groupId=String(request.body?.group_jid||request.body?.groupId||'').trim();
  if(!groupId)return reply.code(400).send({ok:false,error:'group_jid_required'});
  try{return reply.send(await wahaBridgeScanGroup(groupId))}
  catch(error){return reply.code(503).send({ok:false,error:String(error?.message||error),provider:'WAHA'})}
});


app.get("/stats", {preHandler:[requireRoles("admin","accountant")]}, async () => ({
  ok:true,
  db:await getStats(),
  queue:await whatsappQueue.getJobCounts("waiting","active","completed","failed","delayed"),
  repairQueue:await repairQueue.getJobCounts("waiting","active","completed","failed","delayed"),
  accountingMode:await getAccountingMode(),
  cleanStart:await getCleanStartState(),
  time:new Date().toISOString()
}));

app.post("/auth/login", async (request, reply) => {
  if(!loginAllowed(request,"auth"))return reply.code(429).send({ok:false,error:"too_many_login_attempts"});
  const {username,password} = request.body || {};
  if (!username || !password) return reply.code(400).send({ok:false,error:"missing_credentials"});
  const user = await findUserByUsername(String(username));
  if (!user || !user.is_active || !(await bcrypt.compare(String(password), user.password_hash))) {
    loginFailed(request,"auth");
    return reply.code(401).send({ok:false,error:"invalid_credentials"});
  }
  loginSucceeded(request,"auth");
  await touchUserLogin(user.id);
  const token = app.jwt.sign({
    sub:String(user.id), role:user.role, captainId:user.captain_id || null, username:user.username
  }, {expiresIn:"12h"});
  return {ok:true,token,user:{
    id:user.id,username:user.username,role:user.role,captainId:user.captain_id || null
  }};
});

app.get("/me", {preHandler:[app.authenticate]}, async request => {
  return {ok:true,user:await getUserPublic(request.user.sub)};
});

app.get("/captains", {preHandler:[requireRoles("admin","accountant")]}, async request => {
  return {ok:true,captains:await listCaptains(String(request.query?.q || ""))};
});

app.post("/captains", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const {name,phone,notes} = request.body || {};
  if (!name || !phone) return reply.code(400).send({ok:false,error:"name_phone_required"});
  const captain = await createCaptain({name:String(name),phone:String(phone),notes});
  await audit(request.user.sub,"captain.create","captain",captain.id,{name,phone});
  return reply.code(201).send({ok:true,captain});
});

app.patch("/captains/:id", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const captain = await updateCaptain(request.params.id, request.body || {});
  if (!captain) return reply.code(404).send({ok:false,error:"captain_not_found"});
  await audit(request.user.sub,"captain.update","captain",captain.id,request.body || {});
  return {ok:true,captain};
});

app.get("/captains/:id/balance", {preHandler:[app.authenticate]}, async (request, reply) => {
  const id = String(request.params.id);
  if (request.user.role === "captain" && String(request.user.captainId) !== id) {
    return reply.code(403).send({ok:false,error:"forbidden"});
  }
  return {ok:true,captainId:id,balance:await getBalance(id)};
});

app.get("/captains/:id/ledger", {preHandler:[app.authenticate]}, async (request, reply) => {
  const id = String(request.params.id);
  if (request.user.role === "captain" && String(request.user.captainId) !== id) {
    return reply.code(403).send({ok:false,error:"forbidden"});
  }
  return {ok:true,entries:await listLedger(id, request.query?.limit)};
});

app.get("/captains/:id/statement",{preHandler:[requireRoles("admin","accountant")]},async(request,reply)=>{
 const id=String(request.params.id||""),from=String(request.query?.from||""),to=String(request.query?.to||"");
 if(!/^\d+$/.test(id)||[from,to].some(v=>v&&!/^\d{4}-\d{2}-\d{2}$/.test(v))||(from&&to&&from>to))return reply.code(400).send({ok:false,error:"invalid_statement_parameters"});
 const captain=(await db.query("SELECT id,name,phone,status FROM captains WHERE id=$1",[id])).rows[0];
 if(!captain)return reply.code(404).send({ok:false,error:"captain_not_found"});
 const start=from?new Date(from+"T00:00:00+03:00").toISOString():null,end=to?new Date(Date.parse(to+"T00:00:00+03:00")+86400000).toISOString():null;
 const params=[id,...(start?[start]:[]),...(end?[end]:[])];
 const where="captain_id=$1 AND entry_type<>'CLEAN_START_RESET'"+(start?" AND created_at >= $2::timestamptz":"")+(end?" AND created_at < $"+(start?3:2)+"::timestamptz":"");
 const rows=(await db.query("SELECT id,entry_type,amount,description,created_at,reference_type,reference_id,metadata,reversed_at FROM ledger_entries WHERE "+where+" ORDER BY created_at,id LIMIT 20001",params)).rows;
 if(rows.length>20000)return reply.code(413).send({ok:false,error:"statement_too_large",message:"اختر فترة أقصر من 20 ألف حركة"});
 const opening=Number((await db.query("SELECT COALESCE(SUM(amount),0) balance FROM ledger_entries WHERE captain_id=$1 AND entry_type<>'CLEAN_START_RESET'"+(start?" AND created_at<$2::timestamptz":""),start?[id,start]:[id])).rows[0].balance);
 let balance=opening,credit=0,debit=0;
 const entries=rows.map(e=>{const a=Number(e.amount)||0;balance+=a;if(a>=0)credit+=a;else debit-=a;return {...e,running_balance:Number(balance.toFixed(3))}});
 return {ok:true,captain,from,to,opening_balance:opening,closing_balance:Number(balance.toFixed(3)),totals:{credit:Number(credit.toFixed(3)),debit:Number(debit.toFixed(3))},rows:entries};
});

// Unified real movement endpoint.
// kind: recharge | production | consumption | order_commission | rider_commission |
//       weekly_deduction | manual_credit | manual_debit
app.post("/movements", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const {captainId,kind,amount,referenceType,referenceId,description,metadata} = request.body || {};
  if (!captainId || !kind || amount === undefined) {
    return reply.code(400).send({ok:false,error:"captainId_kind_amount_required"});
  }
  if(String(kind||"").toLowerCase()!=="recharge"){
    const cleanState=await getCleanStartState();
    if(cleanState.status!=="COMPLETED")return reply.code(409).send({ok:false,error:"clean_start_required",message:"نفّذ البداية الجديدة قبل إدخال حركات الجرد"});
  }
  const result = await createMovement({
    captainId, kind, amount, referenceType, referenceId, description, metadata,
    createdBy:request.user.sub
  });
  return reply.code(201).send({ok:true,...result});
});

// Refund/reversal: never edits old history; it adds an exact opposite entry.
app.post("/ledger/:id/reverse", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const result = await reverseLedgerEntry({
    entryId:request.params.id,
    createdBy:request.user.sub,
    reason:request.body?.reason || null
  });
  if(["PRODUCTION","CONSUMPTION"].includes(String(result.original?.entry_type||"").toUpperCase())){
    await repairOrphanedWeeklyFloor({captainId:result.original.captain_id,occurredAt:result.original.created_at,userId:request.user.sub,reason:request.body?.reason||"عكس حركة يدوي"});
    result.balance=await getBalance(result.original.captain_id);
    await syncCaptainBalanceState(result.original.captain_id).catch(()=>null);
  }
  return reply.code(201).send({ok:true,...result});
});




// V3.7 FINAL TAKEOVER: freeze old accounting, take a final week snapshot, then go LIVE safely.
app.post("/cutover/final/prepare", async (request, reply) => {
  if(!requireMigrationSecret(request,reply))return;
  const clientKey=String(request.body?.clientKey||"").trim();
  const repairFromAt=request.body?.repairFromAt;
  if(!clientKey)return reply.code(400).send({ok:false,error:"client_key_required"});
  const existing=await getFinalTakeoverState();
  if(existing?.status==="LIVE_REPAIR")return reply.code(409).send({ok:false,error:"final_takeover_already_completed",state:existing});
  if(existing?.clientKey===clientKey && ["PREPARED","OLD_FROZEN","SYNCING","GREEN_SWITCHED","APPLYING","READY_TO_COMMIT"].includes(existing?.status)){
    return {ok:true,idempotent:true,state:existing};
  }
  if(existing && ["PREPARED","OLD_FROZEN","SYNCING","GREEN_SWITCHED","APPLYING","READY_TO_COMMIT"].includes(existing.status) && existing.clientKey!==clientKey){
    return reply.code(409).send({ok:false,error:"final_takeover_already_active",state:existing});
  }
  let auditResult=await getFinalCutoverAudit();

  // V3.7.4 SELF-HEAL:
  // An old historical Repair is not a reason to trap the cutover forever.
  // Pause/drain only the unprocessed repair queue, let any active job finish,
  // cancel the old repair run, then re-audit. A fresh Friday repair starts after commit.
  let repairCleanup=null;
  if(!auditResult.ready && auditResult.activeRepair){
    try{
      repairCleanup=await quiesceActiveRepairForFinalTakeover({timeoutMs:45000});
      auditResult=await getFinalCutoverAudit();
    }catch(e){
      return reply.code(Number(e?.statusCode)||409).send({
        ok:false,
        error:"pre_cutover_repair_busy",
        message:e?.message||String(e),
        blocking:auditResult.blocking||[],
        audit:auditResult
      });
    }
  }

  if(!auditResult.ready){
    const details=(auditResult.blocking||[]).join(" | ") || "سبب غير محدد";
    return reply.code(409).send({
      ok:false,
      error:"pre_cutover_audit_failed: "+details,
      code:"pre_cutover_audit_failed",
      blocking:auditResult.blocking||[],
      warnings:auditResult.warnings||[],
      audit:auditResult
    });
  }
  const from=new Date(repairFromAt);
  if(!Number.isFinite(from.getTime()))return reply.code(400).send({ok:false,error:"repair_start_invalid"});
  await setAccountingMode("paused");
  const state=await saveFinalTakeoverState({clientKey,status:"PREPARED",repairFromAt:from.toISOString(),preparedAt:new Date().toISOString(),sourceMigrationId:auditResult.migration?.id||null},null);
  return {ok:true,state,audit:auditResult,repairCleanup,message:"النظام الجديد جاهز وموقوف محاسبيًا مؤقتًا لحين أخذ آخر نسخة من Google"};
});

app.post("/cutover/final/mark-old-frozen", async (request, reply) => {
  if(!requireMigrationSecret(request,reply))return;
  const clientKey=String(request.body?.clientKey||"").trim();
  const state=await getFinalTakeoverState();
  if(!state || state.clientKey!==clientKey)return reply.code(409).send({ok:false,error:"final_takeover_state_mismatch"});
  const next=await saveFinalTakeoverState({status:"OLD_FROZEN",oldSystemFrozenAt:request.body?.frozenAt||new Date().toISOString()},null);
  return {ok:true,state:next};
});

app.post("/cutover/final/switch-green", async (request, reply) => {
  if(!requireMigrationSecret(request,reply))return;
  const clientKey=String(request.body?.clientKey||"").trim();
  const runKey=String(request.body?.runKey||"").trim();
  const state=await getFinalTakeoverState();
  if(!state || state.clientKey!==clientKey)return reply.code(409).send({ok:false,error:"final_takeover_state_mismatch"});
  if(state.status==="GREEN_SWITCHED" && state.runKey===runKey && state.cutoverAt)return {ok:true,idempotent:true,state};
  const run=await getFullMigrationStatus(runKey);
  if(!run)return reply.code(404).send({ok:false,error:"migration_run_not_found"});
  await setAccountingMode("paused");
  const green=await activateGreenWebhook(null);
  const cutoverAt=new Date().toISOString();
  await setFullMigrationCutoverMeta(runKey,{cutoverAt,repairFromAt:state.repairFromAt});
  const next=await saveFinalTakeoverState({status:"GREEN_SWITCHED",runKey,runId:run.id,cutoverAt,greenSwitchedAt:cutoverAt,greenWebhook:green?.settings?.webhookUrl||null},null);
  return {ok:true,state:next,cutoverAt,greenApi:green?.settings||null,message:"تم تحويل GREEN إلى Railway والطابور الجديد موقوف مؤقتًا حتى تثبيت آخر الأرصدة"};
});

app.post("/cutover/final/apply-step", async (request, reply) => {
  if(!requireMigrationSecret(request,reply))return;
  const clientKey=String(request.body?.clientKey||"").trim();
  const runKey=String(request.body?.runKey||"").trim();
  const state=await getFinalTakeoverState();
  if(!state || state.clientKey!==clientKey)return reply.code(409).send({ok:false,error:"final_takeover_state_mismatch"});
  const run=await getFullMigrationStatus(runKey);
  if(!run)return reply.code(404).send({ok:false,error:"migration_run_not_found"});
  if(run.status==="failed")return reply.code(409).send({ok:false,error:"final_sync_failed",run});
  if(run.status==="completed"){
    const audit=await getFinalWeekMigrationAudit(runKey);
    await saveFinalTakeoverState({status:"READY_TO_COMMIT",runKey,runId:run.id,finalSyncCompletedAt:run.completed_at||new Date().toISOString(),finalAuditReady:Boolean(audit.ready)},null);
    return {ok:true,done:true,run,audit};
  }
  if(!["uploaded","applying"].includes(run.status))return reply.code(409).send({ok:false,error:`migration_not_ready:${run.status}`,run});
  await saveFinalTakeoverState({status:"APPLYING",runKey,runId:run.id},null);
  const result=await applyFullMigrationStep(run.id,null);
  const updated=await getFullMigrationStatus(runKey);
  return {ok:true,done:updated?.status==="completed",result,run:updated};
});

app.post("/cutover/final/commit", async (request, reply) => {
  if(!requireMigrationSecret(request,reply))return;
  const clientKey=String(request.body?.clientKey||"").trim();
  const runKey=String(request.body?.runKey||"").trim();
  const state=await getFinalTakeoverState();
  if(!state || state.clientKey!==clientKey)return reply.code(409).send({ok:false,error:"final_takeover_state_mismatch"});
  if(state.status==="LIVE_REPAIR" && state.runKey===runKey)return {ok:true,idempotent:true,state};
  const audit=await getFinalWeekMigrationAudit(runKey);
  if(!audit.ready)return reply.code(409).send({ok:false,error:"final_sync_audit_failed",blocking:audit.blocking,audit});
  const cutoverAt=state.cutoverAt||audit.run?.cutover_at;
  const fromAt=state.repairFromAt||audit.run?.repair_from_at;
  if(!cutoverAt||!fromAt)return reply.code(409).send({ok:false,error:"final_cutover_times_missing"});
  const live=await commitFinalTakeoverLive({fromAt,cutoffAt:cutoverAt,userId:null});
  const next=await saveFinalTakeoverState({status:"LIVE_REPAIR",committedAt:new Date().toISOString(),repairRunId:live.runId,repairTotal:live.total,repairQueued:live.queued,mode:"live"},null);
  return {ok:true,state:next,audit,repair:live,message:`تم الاستلام النهائي. Railway LIVE الآن وبدأ إصلاح ${live.total} حدث من بداية الأسبوع بالخلفية`};
});

app.get("/cutover/final/status", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.query?.secret || "");
  if(!configured||supplied!==configured)return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  return {ok:true,state:await getFinalTakeoverState()};
});

// V3.8 independent old-Google -> Railway weekly Repair bridge.
async function legacyWeekBridgeDisabled(){ return (await redis.get('abshir:legacy_week_bridge:disabled'))==='1'; }
// GREEN stays on Railway LIVE; these routes only import old raw webhook history and repair it idempotently.
app.post("/repair/legacy-week/prepare", async (request, reply) => {
  if(await legacyWeekBridgeDisabled())return reply.code(409).send({ok:false,error:'legacy_week_bridge_disabled_by_rebuild'});
  if(!requireMigrationSecret(request,reply))return;
  const {runKey,fromAt,cutoffAt,spreadsheetId}=request.body||{};
  const from=new Date(fromAt),cutoff=new Date(cutoffAt||Date.now());
  if(!runKey)return reply.code(400).send({ok:false,error:"bridge_run_key_required"});
  if(!Number.isFinite(from.getTime())||!Number.isFinite(cutoff.getTime())||from>=cutoff){
    return reply.code(400).send({ok:false,error:"bridge_range_invalid"});
  }
  const existing=await getLegacyWeekBridgeStatus(String(runKey));
  if(existing && ['REPAIR_RUNNING','COMPLETED'].includes(String(existing.status||''))){
    return {ok:true,idempotent:true,run:existing};
  }
  const run=await beginLegacyWeekBridgeRun({runKey,fromAt:from.toISOString(),cutoffAt:cutoff.toISOString(),spreadsheetId});
  return reply.code(201).send({ok:true,run,message:"تم تجهيز جسر الأسبوع. GREEN يبقى LIVE على Railway."});
});

app.post("/repair/legacy-week/import", async (request, reply) => {
  if(await legacyWeekBridgeDisabled())return reply.code(409).send({ok:false,error:'legacy_week_bridge_disabled_by_rebuild'});
  if(!requireMigrationSecret(request,reply))return;
  const {runKey,rows}=request.body||{};
  if(!runKey)return reply.code(400).send({ok:false,error:"bridge_run_key_required"});
  if(!Array.isArray(rows)||!rows.length)return {ok:true,received:0,inserted:0,duplicates:0,invalid:0};
  if(rows.length>500)return reply.code(413).send({ok:false,error:"bridge_batch_too_large"});
  const result=await importLegacyWeekBridgeBatch({runKey,rows});
  return {ok:true,...result};
});

app.post("/repair/legacy-week/complete", async (request, reply) => {
  if(await legacyWeekBridgeDisabled())return reply.code(409).send({ok:false,error:'legacy_week_bridge_disabled_by_rebuild'});
  if(!requireMigrationSecret(request,reply))return;
  const runKey=String(request.body?.runKey||'').trim();
  if(!runKey)return reply.code(400).send({ok:false,error:"bridge_run_key_required"});
  try{
    const run=await completeLegacyWeekBridgeUpload(runKey);
    if(run.repair_run_id){
      const current=await getLegacyWeekBridgeStatus(runKey);
      return {ok:true,idempotent:true,run:current,message:"Repair الأسبوع بدأ مسبقًا."};
    }
    const repair=await startRepairForExistingCutover({
      fromAt:run.from_at,cutoffAt:run.cutoff_at,userId:null,timeBasis:'event'
    });
    const linked=await attachLegacyWeekBridgeRepair(runKey,repair.runId);
    return {
      ok:true,run:linked,repair,
      message:`تم رفع تاريخ Google وبدأ Repair مستقل من بداية الأسبوع (${repair.total} حدث). GREEN والجديد مستمران LIVE.`
    };
  }catch(e){
    if(Number(e?.statusCode||0)!==409) await failLegacyWeekBridgeRun(runKey,e?.message||String(e)).catch(()=>{});
    throw e;
  }
});


app.post("/repair/legacy-week/balance-sync", async (request, reply) => {
  if(await legacyWeekBridgeDisabled())return reply.code(409).send({ok:false,error:'legacy_week_bridge_disabled_by_rebuild'});
  if(!requireMigrationSecret(request,reply))return;
  const {runKey,cutoffAt,rows}=request.body||{};
  if(!runKey)return reply.code(400).send({ok:false,error:"bridge_run_key_required"});
  const status=await getLegacyWeekBridgeStatus(String(runKey));
  if(!status)return reply.code(404).send({ok:false,error:"bridge_run_not_found"});
  if(String(status.repair_status||status.status||'')!=='COMPLETED' && String(status.status||'')!=='COMPLETED')return reply.code(409).send({ok:false,error:"repair_not_completed"});
  const result=await applyLegacyWeekCurrentBalanceSync({runKey:String(runKey),cutoffAt:cutoffAt||status.cutoff_at,rows:Array.isArray(rows)?rows:[]});
  let restored=0;
  for(const captainId of result.eligibleCaptainIds||[]){const r=await restoreCaptainToGroupIfEligible(captainId).catch(()=>null);if(r?.restored)restored++;}
  return {ok:true,...result,restored};
});
app.get("/repair/legacy-week/status", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.query?.secret || "");
  if(!configured||supplied!==configured)return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  return {ok:true,run:await getLegacyWeekBridgeStatus(String(request.query?.runKey||'')||null)};
});

app.post("/migration/full/start", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.body?.secret || "");
  if(!configured)return reply.code(503).send({ok:false,error:"migration_sync_not_configured"});
  if(!supplied || supplied!==configured)return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  const run=await startFullMigrationRun(request.body||{});
  return reply.code(201).send({ok:true,runId:run.id,runKey:run.run_key,status:run.status});
});

app.post("/migration/full/batch", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.body?.secret || "");
  if(!configured)return reply.code(503).send({ok:false,error:"migration_sync_not_configured"});
  if(!supplied || supplied!==configured)return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  const {runKey,sheetName,rows}=request.body||{};
  const r=await stageFullMigrationBatch({runKey,sheetName,rows});
  return {ok:true,...r};
});

app.post("/migration/full/complete-upload", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  const supplied=String(request.headers["x-migration-secret"] || request.body?.secret || "");
  if(!configured)return reply.code(503).send({ok:false,error:"migration_sync_not_configured"});
  if(!supplied || supplied!==configured)return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  const run=await completeFullMigrationUpload(request.body?.runKey);
  return {ok:true,runId:run.id,status:run.status};
});

app.post("/migration/google-snapshot", async (request, reply) => {
  const configured=String(process.env.MIGRATION_SYNC_SECRET || "");
  if(!configured){
    return reply.code(503).send({ok:false,error:"migration_sync_not_configured"});
  }
  const supplied=String(request.headers["x-migration-secret"] || request.body?.secret || "");
  if(!supplied || supplied!==configured){
    return reply.code(401).send({ok:false,error:"invalid_migration_secret"});
  }
  const payload=request.body?.payload || request.body || {};
  const saved=await saveMigrationSnapshot(payload);
  return reply.code(201).send({
    ok:true,snapshotId:saved.id,receivedAt:saved.received_at,
    captainCount:saved.captain_count,movementCount:saved.movement_count
  });
});

// Register verified phone-number senders from the North group without manual approval.
// LID-only identifiers are deliberately excluded: they are not phone numbers.
async function autoRegisterNorthCaptain(body, log) {
  if(String(body?.action||"")!=="message")return;
  const raw=String(body?.sender?.phoneJid||body?.sender?.jid||"").trim();
  if(!/^\d{8,15}@s\.whatsapp\.net$/i.test(raw))return;
  const digits=raw.split("@")[0];
  const local=digits.startsWith("962")?digits.slice(3):digits.startsWith("0")?digits.slice(1):digits;
  if(!/^7\d{8}$/.test(local))return; // Jordanian mobile number only
  const phone="0"+local;
  const lockKey="abshir:north:auto-captain:"+local;
  const locked=await redis.set(lockKey,"1","EX",30,"NX");
  if(locked!=="OK")return;
  try {
    const existing=await db.query(
      `SELECT id FROM captains WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=$1 LIMIT 1`,
      [local]
    );
    const waName=northWhatsappName(body?.sender);
    const trustedName=isTrustedNorthWhatsappName(waName);
    if(existing.rowCount){
      if(trustedName){
        await db.query("UPDATE captains SET name=$2,updated_at=NOW() WHERE id=$1 AND name ~ $3 AND notes=$4",
          [existing.rows[0].id,waName,"^كابتن [0-9]+$","تسجيل تلقائي من قروب شمال عبر DropConnect"]);
      }
      return;
    }
    const name=trustedName?waName:"كابتن "+local.slice(-4);
    const captain=await createCaptain({name,phone,notes:"تسجيل تلقائي من قروب شمال عبر DropConnect"});
    try{
      await createCaptainUser({captainId:captain.id,username:captain.phone,password:"123456",createdBy:null});
      // Captain may optionally change the initial password later.
      log.info({captainId:captain.id},"North captain auto-registered from verified WhatsApp PN");
    }catch(err){
      log.error({err,captainId:captain.id},"North captain created but login setup failed");
    }
  }catch(err){
    if(err?.code!=="23505"&&err?.message!=="captain_phone_exists")log.warn({err},"North captain automatic registration failed");
  }finally{
    await redis.del(lockKey).catch(()=>{});
  }
}

app.post("/webhook/dropconnect", async (request, reply) => {
  const supplied=String(request.headers["x-dropcode-token"]||"");
  if(!NORTH_DROPCONNECT_SECRET || supplied!==NORTH_DROPCONNECT_SECRET){
    request.log.warn({schema:request.body?.schema||null,session:request.body?.session||null},"DropConnect north webhook rejected");
    return reply.code(401).send({ok:false,error:"invalid_dropconnect_token"});
  }

  const body=request.body||{};
  const isUnified=String(body?.schema||"")==="dropcode.event.v1" && String(body?.groupMode||"")==="north";
  if(isUnified && String(body.action||"")==="members_snapshot"){
    const members=Array.isArray(body.members)?body.members.slice(0,500):[];
    let created=0,skipped=0;
    for(const member of members){
      if(!/^\d{8,15}@s\.whatsapp\.net$/i.test(String(member?.phoneJid||""))){skipped++;continue}
      try{
        const before=await db.query("SELECT id FROM captains WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=RIGHT($1,9) LIMIT 1",[String(member.phoneJid).split("@")[0]]);
        await autoRegisterNorthCaptain({action:"message",sender:{...member,jid:member.jid,phoneJid:member.phoneJid}},request.log);
        if(!before.rowCount)created++;
      }catch(err){skipped++;request.log.warn({err},"North group member registration failed")}
    }
    request.log.info({received:members.length,attemptedNew:created,skipped},"North group roster auto-registration received");
    return reply.send({ok:true,received:members.length,attemptedNew:created,skipped});
  }
  let payload=null;

  if(isUnified){
    const chatId=String(body?.group?.id||"");
    const sender=String(body?.sender?.jid||body?.reaction?.participant||"");
    // Preserve an explicit phone JID only when supplied by the WhatsApp transport.
    // Do not infer a phone number from an opaque @lid identifier.
    const senderPhone=String(body?.sender?.phoneJid||"");
    const verifiedPhone=/^\d+@s\.whatsapp\.net$/i.test(senderPhone)?senderPhone:"";
    const senderName=northWhatsappName(body?.sender);
    const timestamp=Number(body?.timestamp||Date.now());
    const action=String(body?.action||"");
    const baseId=String(body?.message?.id||body?.reaction?.targetMessageId||"");

    if(action==="reaction_added" || action==="reaction_removed"){
      const eventId=String(body?.dropcodeEventId||Date.now());
      payload={
        typeWebhook:"incomingMessageReceived",
        idMessage:`dropconnect-reaction-${eventId}`,
        senderData:{chatId,sender:verifiedPhone||sender,senderPhone:verifiedPhone,senderName,chatName:String(body?.group?.name||"")},
        messageData:{
          typeMessage:"reactionMessage",
          reactionMessageData:{
            text:action==="reaction_removed"?"":String(body?.reaction?.emoji||""),
            stanzaId:String(body?.reaction?.targetMessageId||baseId),
            quotedStanzaId:String(body?.reaction?.targetMessageId||baseId),
            idMessageQuoted:String(body?.reaction?.targetMessageId||baseId)
          }
        },
        timestamp,
        _abshirProvider:"DROPCODE_CONNECT",
        _dropcode:body
      };
    } else if(action==="message" && baseId){
      payload={
        typeWebhook:body?.sender?.fromMe?"outgoingMessageReceived":"incomingMessageReceived",
        idMessage:baseId,
        senderData:{chatId,sender:verifiedPhone||sender,senderPhone:verifiedPhone,senderName,chatName:String(body?.group?.name||"")},
        messageData:body?.message?.quotedMessageId
          ? {
              typeMessage:"extendedTextMessage",
              extendedTextMessageData:{
                text:String(body?.message?.text||""),
                stanzaId:String(body.message.quotedMessageId),
                participant:String(body?.message?.quotedParticipant||"")
              }
            }
          : {
              typeMessage:"textMessage",
              textMessageData:{textMessage:String(body?.message?.text||"")}
            },
        timestamp,
        _abshirProvider:"DROPCODE_CONNECT",
        _dropcode:body
      };
      if(body?.message?.media){
        payload.messageData.fileMessageData={
          downloadUrl:String(body.message.media?.url||""),
          url:String(body.message.media?.url||""),
          mimeType:String(body.message.media?.mimetype||body.message.media?.mimeType||""),
          fileName:String(body.message.media?.filename||""),
          caption:String(body?.message?.text||"")
        };
      }
    }
  } else if(String(body?.dropcode?.mode||"")==="north"){
    payload=await convertWahaWebhookToGreen(body);
  } else {
    return reply.code(200).send({ok:true,ignored:true,reason:"not_north_group"});
  }

  if(!payload){
    return reply.code(200).send({ok:true,ignored:true,reason:"unsupported_event"});
  }

  if(String(payload?.messageData?.typeMessage||"")==="reactionMessage"){
    const emoji=String(payload?.messageData?.reactionMessageData?.text||"").replace(/\uFE0F/g,"").trim();
    if(emoji && emoji!=="👍" && emoji!=="🚫" && !/^[1-9]️⃣$/.test(emoji) && emoji!=="🔟"){
      return reply.code(200).send({ok:true,ignored:true,reason:"north_reaction_not_allowed"});
    }
  }

  if(isUnified && String(body?.action||"")==="message"){
    await autoRegisterNorthCaptain(body,request.log).catch(err=>request.log.warn({err},"North captain auto-registration skipped"));
  }
  payload._abshirInventoryMode="north";
  const stored=await insertWebhookEvent(payload,{processingMode:"dropconnect_north",traceStage:"dropconnect.webhook.received"});
  if(stored.inserted) await enqueueWebhook(payload);
  request.log.info({
    idMessage:payload?.idMessage||null,
    chatId:payload?.senderData?.chatId||null,
    schema:body?.schema||null,
    action:body?.action||body?.event||null
  },"DropConnect north webhook accepted");
  return reply.code(200).send({ok:true,duplicate:!stored.inserted,idMessage:payload?.idMessage||null});
});

app.post("/webhook/green-api", async (request, reply) => {
  if(await activeWhatsappProvider()!=='green')return reply.code(200).send({ok:true,ignored:true,reason:"provider_disabled",provider:"WAHA"});
  // V3.8.5.8: support GREEN-API webhookUrlToken Authorization header while
  // preserving the legacy greenHook query/x-green-hook path during cutover.
  const expected=String(await getSystemSetting("green_webhook_secret","")||"");
  const authHeader=String(request.headers.authorization||"").trim();
  const authToken=authHeader.replace(/^(?:Bearer|Basic)\s+/i,"").trim();
  const supplied=String(request.query?.greenHook||request.headers['x-green-hook']||authToken||"");
  if(!expected || expected!==supplied){
    request.log.warn({hasAuthorization:Boolean(authHeader),hasLegacyQuery:Boolean(request.query?.greenHook),typeWebhook:request.body?.typeWebhook||null},"green webhook rejected: invalid auth");
    return reply.code(401).send({ok:false,error:"invalid_green_secret"});
  }
  const payload = request.body || {};
  request.log.info({typeWebhook:payload?.typeWebhook||null,idMessage:payload?.idMessage||null,chatId:payload?.senderData?.chatId||null},"green webhook received");
  // Delivery/read/sent statuses are not accounting events. Even if GREEN still emits
  // a mandatory failed/noAccount status, acknowledge it immediately and never enqueue
  // it into the accounting worker. This keeps the webhook lane light.
  if(String(payload?.typeWebhook||"").toLowerCase()==="outgoingmessagestatus"){
    request.log.info({idMessage:payload?.idMessage||null,status:payload?.status||null},"green outgoing status acknowledged without queue");
    return reply.code(200).send({ok:true,ignored:true,typeWebhook:payload?.typeWebhook||null,status:payload?.status||null});
  }
  // GREEN-API sends valid service webhooks (for example stateInstanceChanged)
  // without idMessage/chatId. These notifications MUST be acknowledged with 200;
  // otherwise GREEN retries the same notification every 60 seconds and can block
  // later notifications in the webhook queue. We only persist/enqueue message-like
  // events that carry idMessage; service events are logged and safely acknowledged.
  if (!payload?.idMessage) {
    request.log.info({
      typeWebhook:payload?.typeWebhook||null,
      stateInstance:payload?.stateInstance||null,
      statusInstance:payload?.statusInstance||null
    },"green webhook service acknowledged");
    // V3.8.5.58: keep the ACK immediate, but persist session-state transitions in the
    // background so repeated Abshir disconnects can be diagnosed without blocking GREEN.
    void recordGreenServiceWebhook(payload).catch(error=>request.log.warn({err:String(error?.message||error)},"green session event persist failed"));
    return reply.code(200).send({ok:true,ignored:true,typeWebhook:payload?.typeWebhook||null});
  }

  const stored = await insertWebhookEvent(payload);
  if (stored.inserted) await enqueueWebhook(payload);
  return reply.code(200).send({ok:true,duplicate:!stored.inserted,idMessage:payload.idMessage});
});


app.post("/webhook/waha", async (request, reply) => {
  if(await activeWhatsappProvider()!=='waha')return reply.code(200).send({ok:true,ignored:true,reason:"provider_disabled",provider:"GREEN"});
  const expected=String(await getSystemSetting("waha_webhook_secret","")||"");
  const supplied=String(request.headers['x-abshir-waha-secret']||request.query?.wahaHook||"");
  if(!expected||supplied!==expected){
    request.log.warn({event:request.body?.event||null,session:request.body?.session||null},"WAHA webhook rejected: invalid secret");
    return reply.code(401).send({ok:false,error:"invalid_waha_secret"});
  }
  const event=request.body||{};
  const linkedWaha=await greenPublicSettings();
  const eventSession=String(event?.session||event?.payload?.session||'').trim();
  if(eventSession&&linkedWaha.session&&eventSession!==String(linkedWaha.session))return reply.code(200).send({ok:true,ignored:true,reason:'other_session'});
  request.log.info({event:event?.event||null,session:event?.session||null,id:event?.payload?.id||event?.id||null},"WAHA webhook received");
  if(String(event?.event||'')==='session.status'){
    void recordWahaSessionWebhook(event).catch(error=>request.log.warn({err:String(error?.message||error)},"WAHA session event persist failed"));
    return reply.code(200).send({ok:true,service:true,status:event?.payload?.status||null});
  }
  if(['message.ack','message.ack.group','message.waiting','engine.event'].includes(String(event?.event||''))){
    return reply.code(200).send({ok:true,ignored:true,event:event?.event||null});
  }
  const payload=await convertWahaWebhookToGreen(event);
  if(!payload?.idMessage)return reply.code(200).send({ok:true,ignored:true,event:event?.event||null});
  const eventGroup=String(payload?.senderData?.chatId||'');
  if(linkedWaha.groupId&&eventGroup&&eventGroup!==String(linkedWaha.groupId))return reply.code(200).send({ok:true,ignored:true,reason:'other_group',groupId:eventGroup});
  const stored=await insertWebhookEvent(payload,{processingMode:'waha_live',traceStage:'waha.webhook.received'});
  if(stored.inserted)await enqueueWebhook(payload);
  return reply.code(200).send({ok:true,duplicate:!stored.inserted,idMessage:payload.idMessage,provider:'WAHA'});
});




app.get("/transfer-image/:token", async (request, reply) => {
  const token=String(request.params.token||"");
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token))return reply.code(404).send("not found");
  const x=await transferImage(token);
  if(!x?.image_data)return reply.code(404).send("not found");
  const mime=["image/png","image/jpeg","image/webp"].includes(String(x.image_mime))?String(x.image_mime):"application/octet-stream";
  if(mime==="application/octet-stream")reply.header("Content-Disposition",'attachment; filename="transfer-file"');
  return reply.type(mime).header("X-Content-Type-Options","nosniff").header("Content-Security-Policy","default-src 'none'").header("Cache-Control","private, max-age=300").send(x.image_data);
});

app.get("/accountant", async (request, reply) => {
  const html=await fs.readFile(new URL("./Accountant.html", import.meta.url),"utf8");
  return reply.header("Cache-Control","no-store, no-cache, must-revalidate").type("text/html; charset=utf-8").send(html);
});

app.get("/captain", async (request, reply) => {
  const html=await fs.readFile(new URL("./Captain.html", import.meta.url),"utf8");
  return reply.header("Cache-Control","no-store, no-cache, must-revalidate").type("text/html; charset=utf-8").send(html);
});

app.get("/recharge-portal", async (request, reply) => reply.redirect("/recharge-portal/"));
app.get("/recharge-portal/", async (request, reply) => {
  const html=await fs.readFile(new URL("./RechargePortal.html", import.meta.url),"utf8");
  return reply.header("Cache-Control","no-store").type("text/html; charset=utf-8").send(html);
});

app.post("/api/portal/login", async (request, reply) => {
  if(!portalLoginAllowed(request))return reply.code(429).send({ok:false,error:"too_many_attempts"});
  const username=String(request.body?.username||"").trim();
  const password=String(request.body?.password||"");
  if(!username||!password)return reply.code(400).send({ok:false,error:"missing_credentials"});
  const user=await findRechargePortalUserByUsername(username);
  if(!user||!user.is_active||!(await bcrypt.compare(password,user.password_hash))){
    portalLoginFailed(request);
    return reply.code(401).send({ok:false,error:"invalid_credentials"});
  }
  portalLoginSucceeded(request);
  await touchRechargePortalUserLogin(user.id);
  const token=app.jwt.sign({scope:"recharge_portal",portalUserId:String(user.id),username:user.username},{expiresIn:"8h"});
  reply.header("Set-Cookie",portalCookieValue(token));
  return {ok:true,user:{id:String(user.id),username:user.username,displayName:user.display_name,codePrefix:user.code_prefix,packages:portalAllowedPackages(user.username),canCustomAmount:portalCanCustomAmount(user.username)}};
});

app.post("/api/portal/logout", async (request, reply) => {
  reply.header("Set-Cookie",portalCookieValue("",0));
  return {ok:true};
});

app.get("/api/portal/me", {preHandler:[requirePortalAuth]}, async request => ({
  ok:true,user:{id:String(request.portalUser.id),username:request.portalUser.username,displayName:request.portalUser.display_name,codePrefix:request.portalUser.code_prefix,packages:portalAllowedPackages(request.portalUser.username),canCustomAmount:portalCanCustomAmount(request.portalUser.username)}
}));

app.get("/api/portal/captains", {preHandler:[requirePortalAuth]}, async (request, reply) => {
  const q=String(request.query?.q||"").trim();
  if(q.length<2)return {ok:true,captains:[]};
  try{
    const rows=await searchRechargePortalCaptains(q,30);
    return {ok:true,captains:rows.map(c=>({id:String(c.id),name:c.name,phone:c.phone,legacyId:c.legacy_id||"",balance:Number(c.balance||0),status:c.status,groupState:c.group_state||""}))};
  }catch(e){request.log.error(e);return reply.code(500).send({ok:false,error:"captain_search_failed"})}
});

app.post("/api/portal/codes", {preHandler:[requirePortalAuth]}, async (request, reply) => {
  const captainId=String(request.body?.captainId||"").trim();
  const packageValue=Number(request.body?.packageValue);
  if(!captainId||!portalAmountAllowed(request.portalUser.username,packageValue))return reply.code(400).send({ok:false,error:"invalid_request"});
  try{
    const code=await createRechargePortalCode({portalUserId:request.portalUser.id,captainId,packageValue});
    return reply.code(201).send({ok:true,code});
  }catch(e){
    if(e?.message==="captain_not_found")return reply.code(404).send({ok:false,error:"captain_not_found"});
    if(e?.message==="code_generation_failed")return reply.code(500).send({ok:false,error:"code_generation_failed"});
    throw e;
  }
});

app.get("/api/portal/codes", {preHandler:[requirePortalAuth]}, async request => ({
  ok:true,codes:await listRechargePortalCodes({portalUserId:request.portalUser.id,q:String(request.query?.q||""),status:String(request.query?.status||""),limit:250})
}));

app.get("/api/portal/stats", {preHandler:[requirePortalAuth]}, async request => ({
  ok:true,stats:await getRechargePortalStats(request.portalUser.id)
}));

app.post("/legacy-rpc", async (request, reply) => {
  let isLogin=false;
  try{
    const {method,args} = request.body || {};
    if(!method) return reply.code(400).send({__rpcError:true,message:"method_required"});
    isLogin=method==="loginAccountant"||method==="loginCaptain";
    if(isLogin&&!loginAllowed(request,"legacy"))return reply.code(429).send({__rpcError:true,message:"محاولات دخول كثيرة؛ انتظر دقيقة ثم حاول مجددًا"});
    const result=await legacyRpc(String(method),Array.isArray(args)?args:[]);
    if(isLogin)loginSucceeded(request,"legacy");
    return result;
  }catch(error){
    if(isLogin)loginFailed(request,"legacy");
    request.log.error(error);
    return reply.code(Number(error?.statusCode)||400).send({__rpcError:true,message:error?.message||"فشل الطلب"});
  }
});

app.post("/captains/:id/account", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const {username,password} = request.body || {};
  if (!username || !password) {
    return reply.code(400).send({ok:false,error:"username_password_required"});
  }
  const user = await createCaptainUser({
    captainId:request.params.id,
    username:String(username),
    password:String(password),
    createdBy:request.user.sub
  });
  return reply.code(201).send({ok:true,user});
});


app.get("/captains/:id/account", {preHandler:[requireRoles("admin","accountant")]}, async request => {
  return {ok:true,account:await getCaptainAccount(request.params.id)};
});

app.get("/captain/profile", {preHandler:[requireRoles("captain")]}, async request => {
  const captainId = request.user.captainId;
  return {
    ok:true,
    captain:await getCaptainProfile(captainId),
    summary:await getCaptainSummary(captainId)
  };
});

app.get("/captain/ledger", {preHandler:[requireRoles("captain")]}, async request => {
  return {
    ok:true,
    entries:await listLedger(request.user.captainId, request.query?.limit || 100)
  };
});

app.get("/recharge/codes", {preHandler:[requireRoles("admin","accountant")]}, async request => {
  return {ok:true,codes:await listRechargeCodes({
    status:String(request.query?.status || ""),
    limit:request.query?.limit
  })};
});

app.post("/recharge/codes", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const {amount} = request.body || {};
  const code = await createRechargeCode({amount,createdBy:request.user.sub});
  return reply.code(201).send({ok:true,code});
});

app.post("/recharge/codes/:id/cancel", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const code = await cancelRechargeCode({id:request.params.id,userId:request.user.sub});
  return reply.code(200).send({ok:true,code});
});

app.post("/captain/recharge/redeem", {preHandler:[requireRoles("captain")]}, async (request, reply) => {
  const {code} = request.body || {};
  if (!code) return reply.code(400).send({ok:false,error:"code_required"});
  const result = await redeemRechargeCode({
    captainId:request.user.captainId,
    code:String(code)
  });
  const groupRestore=Number(result.balance)>-0.75?await restoreCaptainToGroupIfEligible(request.user.captainId).catch(()=>null):null;
  return reply.code(200).send({ok:true,...result,groupRestore});
});

app.post("/captain/recharge/requests", {preHandler:[requireRoles("captain")]}, async (request, reply) => {
  const {amount,method,referenceText,note} = request.body || {};
  const rr = await createRechargeRequest({
    captainId:request.user.captainId,
    amount,method,referenceText,note
  });
  return reply.code(201).send({ok:true,request:rr});
});

app.get("/recharge/requests", {preHandler:[requireRoles("admin","accountant")]}, async request => {
  return {ok:true,requests:await listRechargeRequests({
    status:String(request.query?.status || ""),
    limit:request.query?.limit
  })};
});

app.post("/recharge/requests/:id/review", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const approve = Boolean(request.body?.approve);
  const result = await reviewRechargeRequest({
    requestId:request.params.id,
    approve,
    userId:request.user.sub
  });
  return reply.code(200).send({ok:true,...result});
});


app.post("/settlements/build", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const {weekStart,weekEnd} = request.body || {};
  const settlement = await buildWeeklySettlement({weekStart,weekEnd,userId:request.user.sub});
  return reply.code(201).send({ok:true,settlement});
});

app.get("/settlements", {preHandler:[requireRoles("admin","accountant")]}, async () => {
  return {ok:true,settlements:await listWeeklySettlements()};
});

app.get("/settlements/:id/items", {preHandler:[requireRoles("admin","accountant")]}, async request => {
  return {ok:true,items:await getWeeklySettlementItems(request.params.id,String(request.query?.status||""))};
});

app.post("/settlements/items/:id/transferred", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const result=await payFridaySettlement(request.params.id,request.user.sub,String(request.body?.note||""));
  return reply.code(200).send({ok:true,item:result.item,balance:result.balance,paidAmount:result.paidAmount,already:Boolean(result.already)});
});

app.post("/settlements/:id/archive", {preHandler:[requireRoles("admin","accountant")]}, async (request, reply) => {
  const settlement=await archiveWeeklySettlement({settlementId:request.params.id,userId:request.user.sub});
  return reply.code(200).send({ok:true,settlement});
});


const safeerHalfFloorCandidates = `
  SELECT le.id,le.captain_id,c.name,le.amount,le.created_at
  FROM ledger_entries le JOIN captains c ON c.id=le.captain_id
  WHERE le.amount=-1.500
    AND le.reversed_at IS NULL
    AND COALESCE(le.metadata->>'type','')='WEEKLY_FLOOR'
    AND NOT EXISTS (SELECT 1 FROM ledger_entries refund
      WHERE refund.reference_type='safeer_half_floor_refund'
        AND refund.reference_id=le.id::text)
  ORDER BY le.id
`;
app.get("/admin/safeer-half-floor-refund/preview",{preHandler:[requireRoles("admin")]},async()=>{
  const {rows}=await db.query(safeerHalfFloorCandidates);
  return {ok:true,count:rows.length,total:(rows.length*0.5).toFixed(3),captains:rows.map(r=>({id:r.captain_id,name:r.name,entryId:r.id}))};
});
app.post("/admin/safeer-half-floor-refund/apply",{preHandler:[requireRoles("admin")]},async(request,reply)=>{
  if(request.body?.confirm!=="REFUND_HALF_FLOOR")return reply.code(400).send({ok:false,error:"confirmation_required"});
  const client=await db.connect();
  let captainIds=[];
  try{
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('safeer_half_floor_refund_v1'))");
    const {rows}=await client.query(safeerHalfFloorCandidates);
    if(Number(request.body.expectedCount)!==rows.length){
      await client.query("ROLLBACK");
      return reply.code(409).send({ok:false,error:"preview_changed",count:rows.length});
    }
    for(const row of rows){
      await client.query("SELECT id FROM captains WHERE id=$1 FOR UPDATE",[row.captain_id]);
      await client.query(`INSERT INTO ledger_entries
        (captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
        VALUES ($1,0.500,'MANUAL_ADJUSTMENT','credit','safeer_half_floor_refund',$2,
          'استرجاع نصف دينار من أرضية 1.50 إلى 1.00',
          $3::jsonb,$4)`,
        [row.captain_id,String(row.id),JSON.stringify({type:"WEEKLY_FLOOR_PARTIAL_REFUND",originalFloorEntryId:String(row.id),refundAmount:0.5}),request.user.sub]);
    }
    await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
      VALUES($1,'safeer.floor.half_refund','system','bulk',$2::jsonb)`,
      [request.user.sub,JSON.stringify({count:rows.length,total:rows.length*0.5,entryIds:rows.map(r=>r.id)})]);
    await client.query("COMMIT");
    captainIds=[...new Set(rows.map(r=>String(r.captain_id)))];
    const {syncCaptainBalanceState}=await import("./features.js");
    await Promise.all(captainIds.map(id=>syncCaptainBalanceState(id).catch(error=>request.log.error({error,captainId:id},"refund balance sync failed"))));
    return {ok:true,count:rows.length,total:(rows.length*0.5).toFixed(3)};
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}
  finally{client.release()}
});

app.setErrorHandler((error, request, reply) => {
  request.log.error(error);
  if (error?.statusCode) return reply.code(error.statusCode).send({ok:false,error:error.message});
  if (error?.code === "23505") return reply.code(409).send({ok:false,error:"duplicate"});
  return reply.code(500).send({ok:false,error:"internal_error"});
});

async function initializeRedisServices(){
  while(true){
    try{
      startupStage="REDIS_CONNECT";
      await withTimeout(redis.ping(),8000,"redis_ping");
      startupStage="QUEUE_GATE";
      await withTimeout(enforceCleanStartBootGate(),15000,"queue_gate");
      redisReady=true;
      startupError=null;
      if(!workerStarted){
        startupStage="WORKER_START";
        startWorker();
        workerStarted=true;
      }
      startupStage="READY";
      app.log.info("ABSHIR Redis/WhatsApp queue services are ready");
      return;
    }catch(err){
      redisReady=false;
      startupError=err?.stack||err?.message||String(err);
      startupStage="REDIS_RETRY";
      app.log.error({err},"Redis/queue initialization failed; core site stays online; retrying in 10 seconds");
      await sleep(10000);
    }
  }
}

async function initializeBackground(){
  if(backgroundStarted)return;
  backgroundStarted=true;

  // Core DB/schema boot: retry until PostgreSQL is healthy. Do not involve Redis here.
  while(!systemReady){
    try{
      startupError=null;
      startupStage="POSTGRES_INIT";
      await initDb();
      if(await isCleanSlateResetRequired()){
        startupStage="CLEAN_SLATE_QUEUE_LOCK";
        await withTimeout(redis.ping(),10000,"clean_slate_redis");
        const queueReset=await withTimeout(prepareQueuesForCleanSlateReset(),90000,"clean_slate_queue_prepare");
        startupStage="CLEAN_SLATE_DATABASE_RESET";
        const cleanSlate=await withTimeout(executeOneTimeCleanSlateReset(),120000,"clean_slate_database_reset");
        app.log.warn({queueReset,cleanSlate},"ABSHIR one-time clean slate completed; accounts preserved and all balances reset to zero");
      }
      startupStage="POSTGRES_VERIFY";
      await withTimeout(db.query("SELECT 1"),5000,"postgres_verify");

      const staleFriday=await db.query(`SELECT id FROM friday_group_sessions WHERE status='COMMITTING' AND updated_at < NOW()-INTERVAL '20 minutes' ORDER BY id DESC LIMIT 1`).catch(()=>({rowCount:0}));
      if(staleFriday.rowCount){
        await forceOpenFriday(null).catch(error=>app.log.error({error},"failed to recover stale Friday group lock"));
      }
      await rollbackFloorChargesForDate("2026-08-27",null).catch(error=>app.log.error({error},"failed to rollback 2026-08-27 floor charges"));

      if(!schedulersStarted){
        startStorageCleanupScheduler();
        startThursdayFixedDeductionScheduler();
        schedulersStarted=true;
      }

      // Important: login, Excel import, balances and normal PostgreSQL accounting are now usable.
      systemReady=true;
      startupStage="CORE_READY";
      app.log.info("ABSHIR PostgreSQL core is ready; login/accounting enabled");
    }catch(err){
      startupError=err?.stack||err?.message||String(err);
      startupStage="POSTGRES_RETRY";
      app.log.error({err},"PostgreSQL initialization failed; retrying in 10 seconds");
      await sleep(10000);
    }
  }

  // Redis/WhatsApp is isolated from core readiness. A Redis outage no longer blocks captain/accountant login.
  void initializeRedisServices();
}

async function main() {
  await app.listen({port:Number(process.env.PORT || 3000),host:"0.0.0.0"});
  startupStage="HTTP_READY";
  app.log.info({port:Number(process.env.PORT || 3000)},"ABSHIR HTTP listener is up; initializing PostgreSQL core in background");
  void initializeBackground();
}
main().catch(err => { console.error(err); process.exit(1); });
