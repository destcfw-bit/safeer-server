import { weeklyParticipantsReport } from './weekly-participants.js';
import { captainWithdrawalData, requestCaptainWithdrawal, accountantWithdrawalData, listWithdrawalClassifications, markWithdrawalAnnouncementSeen, reviewWithdrawal, getWithdrawalControl, setWithdrawalControl, saveCaptainCliq, adminUpdateCaptainCliq } from './withdrawal-service.js';

import bcrypt from "bcryptjs";
import * as XLSX from "xlsx";
import { randomUUID, createHash } from "node:crypto";
import {
  db, findUserByUsername, getUserPublic, listCaptains, createCaptain, updateCaptain,
  createCaptainUser, getCaptainProfile, getCaptainSummary, getBalance, listLedger, setCaptainBalanceExact,
  createMovement, createMovementBatch, reconcileManualExcelMovements, previewLatestManualExcelRollback, rollbackLatestManualExcelImport, reverseLedgerEntry, redeemRechargeCode,
  listRechargeCodes, createRechargeCode, listWeeklySettlements, getWeeklySettlementItems, audit,
  getDailyInventoryComparison, reconcileDailyInventory,
  getMigrationComparison, getLatestMigrationSnapshot, getCaptainFullProfileData,
  listStaffUsers, createStaffUser, updateStaffUser, touchUserLogin,
  listDeadLetters, getWebhookDiagnostic, resolveDeadLetter, getReliabilityStats,
  getFullMigrationStatus, applyFullMigrationStep, resetFullMigrationApply, getWhatsappLiveFeed, getFinalCutoverAudit, getFinalTakeoverState,
  getLegacyWeekBridgeStatus,getCleanStartState,getCleanStartOperationalCutover,
  previewRechargeOnlyCleanStart,executeRechargeOnlyCleanStart,executeSilentAllBalancesZero,
  getCaptainSiteMaintenanceState,setCaptainSiteMaintenanceState
} from "./db.js";
import {
  redis, whatsappQueue, repairQueue, enqueueReplay, enqueueWahaIdentityRepair, enqueueWebhook, getAccountingMode, setAccountingMode,
  startLiveCutoverAndRepair, preflightLiveCutoverAndRepair, getLiveCutoverRepairStatus, stabilizeCurrentFridayFullRebuild, resumeCurrentFridayFullRebuild, startCurrentFridayFullRebuild, startCorrectedFridayFullRebuild, getCurrentFridayFullRebuildStatus,
  prepareRechargeOnlyCleanStart,startCleanStartLive,stopCleanStartLive,getCleanStartControlState
} from "./queue.js";
import {
  featureBootstrap, captainFeatureBootstrap, saveTransfer, reviewTransferNative,
  saveGreenSettings, testGreen, greenHealth, listGreenGroups, activateGreenWebhook, greenPublicSettings,
  saveGroupGuide, sendGroupGuide, groupGuidePublic,
  fridayPreview, getFridaySession, startFridaySession, forceOpenFriday, commitFriday, ensureFridaySettlement,
  payFridaySettlement, returnFridaySettlement, verifyFridaySettlement, undoLastFriday, reconcileFridaySettlementStates,
  reviewPendingMovement, resolveIssueNative, clearSystemIssuesNative, reprocessIssueNative, approveSuspicious, correctReaction, undoReactionPairNative,
  addCancellationNumber, setCancellationNumberStatus, removeCancellationNumberNative, reopenCancellationNative,
  recoverHistory, recoverOutageWindow, reprocessRecent, last3DaysAudit, cleanupStatus, startCleanup, forceOpenCleanup,
  safetyReconcile, repairWeeklyFloors, reconcileMixed40, repairCancelled, processGreenEvent, restoreCaptainToGroupIfEligible, syncCaptainBalanceState, repairOrphanedWeeklyFloor, getInventoryDeleteRemovalPolicy, setInventoryDeleteRemovalPolicy,
  getParallelComparisonMode, setParallelComparisonMode, getParallelComparisonBaseline, repairWahaLidMappings
} from "./features.js";
import { getStorageOverview, getStoragePolicy, saveStoragePolicy, runStorageCleanup } from "./storage.js";

const CFG = {
  systemVersion:"V11.80.0 SILENT BALANCE ZERO / Railway Compat 3.8.5.80",
  brandName:"أبشر فزعة الشمال الكبرى",
  passengerCommission:0.75,
  orderCommission:1,
  weeklyFloorCharge:1.5,
  weeklyOrderBatchSize:0,
  weeklyOrderBatchDeduction:0,
  weeklyThursdayDeduction:0,
  weeklyThursdayDeductionTime:"21:00 Asia/Amman (floor 1.50)",
  fridayReserveBalance:1.5,
  minActiveBalance:0.75,
  groupBlockBalance:-0.75,
  largeMovementThreshold:10,
  packages:{
    5:{balance:5,paid:5},
    10:{balance:10,paid:10},
    15:{balance:15,paid:15},
    20:{balance:20,paid:20},
    30:{balance:30,paid:30}
  }
};

function iso(v){ return v ? new Date(v).toISOString().replace("Z","") : ""; }
function jordanDateParts(v=new Date()) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"Asia/Amman", year:"numeric", month:"2-digit", day:"2-digit"
  }).formatToParts(new Date(v));
  const out={};
  for(const p of parts) if(p.type!=="literal") out[p.type]=p.value;
  return out;
}
function dateKey(v=new Date()) {
  const p=jordanDateParts(v);
  return `${p.year}-${p.month}-${p.day}`;
}
function rightPhone(v){const d=String(v||'').replace(/\D/g,'');const nine=d.slice(-9);return nine?`0${nine}`:'';}
function ammanFridayWeekBounds(now=new Date()){
  const local=new Date(now.getTime()+3*60*60*1000);
  const day=local.getUTCDay();
  const diff=(day-5+7)%7;
  local.setUTCDate(local.getUTCDate()-diff);
  local.setUTCHours(0,0,0,0);
  const start=new Date(local.getTime()-3*60*60*1000);
  const end=new Date(start.getTime()+7*24*60*60*1000);
  return {start,end};
}
function legacyReversalNote(text=""){
  return /(?:إلغاء\s*Reaction|إزالة\s*👍|إلغاء\s+أرضية|عكس\s+الحركة|عكس الحركة|Reversal of ledger entry|تراجع عن .*عكس)/i.test(String(text||""));
}
async function currentWeekCaptainLedger(captainId,cleanStartAt=null){
  const {start,end}=ammanFridayWeekBounds();
  const r=await db.query(`
    WITH all_ledger AS (
      SELECT le.*,
        SUM(le.amount) OVER (PARTITION BY le.captain_id ORDER BY le.created_at ASC,le.id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS computed_balance_after
      FROM ledger_entries le
      WHERE le.captain_id=$1
    ), base AS (
      SELECT le.*,
        (le.computed_balance_after-le.amount) AS computed_balance_before,
        COALESCE(
          NULLIF(le.metadata->>'reactionId',''),
          substring(COALESCE(le.description,'') from 'REACTION:([A-Za-z0-9_-]+)')
        ) AS reaction_id
      FROM all_ledger le
      WHERE COALESCE(le.reference_type,'')<>'migration_balance'
        AND le.entry_type<>'MIGRATION_BALANCE_ADJUSTMENT'
        AND le.entry_type<>'REVERSAL'
        AND le.entry_type<>'FRIDAY_SETTLEMENT'
        AND le.entry_type<>'CLEAN_START_RESET'
        AND NOT (COALESCE(le.reference_type,'')='ledger_entry' OR COALESCE(le.reference_id,'') ~ '^REV-')
        AND COALESCE(le.description,'') !~* '(إلغاء[[:space:]]*Reaction|إزالة[[:space:]]*👍|إلغاء[[:space:]]+أرضية|عكس[[:space:]]+الحركة|Reversal of ledger entry)'
        AND NOT EXISTS (SELECT 1 FROM ledger_entries rr WHERE rr.reversed_entry_id=le.id)
        AND NOT EXISTS (
          SELECT 1 FROM ledger_entries rr
          WHERE le.reference_type='legacy_sheet'
            AND le.reference_id IS NOT NULL
            AND rr.captain_id=le.captain_id
            AND COALESCE(rr.description,'') ILIKE ('%عكس الحركة ' || le.reference_id || '%')
        )
    ), timed AS (
      SELECT base.*,
        COALESCE(
          CASE
            WHEN we.event_timestamp IS NULL THEN NULL
            WHEN we.event_timestamp>100000000000 THEN to_timestamp(we.event_timestamp/1000.0)
            ELSE to_timestamp(we.event_timestamp::double precision)
          END,
          base.created_at
        ) AS effective_at
      FROM base
      LEFT JOIN whatsapp_events we ON we.id_message=base.reaction_id
    )
    SELECT * FROM timed
    WHERE effective_at >= $2::timestamptz AND effective_at < $3::timestamptz
      AND ($4::timestamptz IS NULL OR effective_at >= $4::timestamptz)
    ORDER BY effective_at DESC,id DESC
    LIMIT 2000
  `,[captainId,start.toISOString(),end.toISOString(),cleanStartAt]);
  return {entries:r.rows,start,end};
}
function legacyStatus(s){
  const x=String(s||"").toLowerCase();
  return x==="active"?"ACTIVE":x==="disabled"?"DISABLED":"FROZEN";
}
function legacySettlementStatus(row={}){
  const raw=String(row.status||"").toLowerCase();
  const note=String(row.payment_note||"");
  if(raw==="due")return "PENDING";
  if(raw==="transferred")return "PAID";
  if(/^RETURNED:/i.test(note))return "RETURNED";
  if(/(?:^|\|)\s*REVERTED\b/i.test(note))return "REVERTED";
  return "ARCHIVED";
}
function legacyCaptain(c){
  return {
    id:String(c.id), fullName:c.name, phone:c.phone,
    payoutName:c.payout_name||"", payoutMethod:c.payout_method||"",
    payoutIdentifier:c.payout_identifier||"",
    balanceMode:c.balance_mode||"PREPAID", protectFromGroupRemoval:Boolean(c.protect_from_group_removal),
    balance:Number(c.balance||0), status:legacyStatus(c.status),
    statusReason:String(c.notes||"").replaceAll("تسجيل تلقائي من قروب شمال عبر DropConnect","تسجيل تلقائي من قروب شمال عبر الجرد الآلي").trim(), groupState:"",
    createdAt:iso(c.created_at), updatedAt:iso(c.updated_at), lastLoginAt:""
  };
}


// V3.8.4.2 HOTFIX: the Railway accountant bootstrap previously returned inventory: []
// and weeklyComparison: {rows:[],summary:{}} even when the ledger contained valid work.
// Build both views directly from PostgreSQL so the UI always reflects the financial ledger.
function ledgerQtySql(alias="le"){
  return `CASE WHEN COALESCE(${alias}.metadata->>'workloadQuantity',${alias}.metadata->>'quantity','') ~ '^[0-9]+(?:[.][0-9]+)?$' THEN COALESCE(${alias}.metadata->>'workloadQuantity',${alias}.metadata->>'quantity')::numeric ELSE 1 END`;
}

async function inventorySnapshotFromLedger(caps=[],cleanStartAt=null){
  const q=await db.query(`
    WITH moves AS (
      SELECT le.*
      FROM ledger_entries le
      WHERE le.reversed_at IS NULL
        AND le.entry_type<>'REVERSAL'
        AND le.entry_type IN ('PRODUCTION','CONSUMPTION')
        AND ($1::timestamptz IS NULL OR le.created_at >= $1::timestamptz)
        AND COALESCE(le.reference_type,'')<>'green_partial'
        AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')
    ), agg AS (
      SELECT captain_id,
        COALESCE(SUM(CASE WHEN entry_type='PRODUCTION' AND metadata->>'type'='PASSENGER' THEN ${ledgerQtySql('moves')} ELSE 0 END),0) production_passengers,
        COALESCE(SUM(CASE WHEN entry_type='CONSUMPTION' AND metadata->>'type'='PASSENGER' THEN ${ledgerQtySql('moves')} ELSE 0 END),0) consumption_passengers,
        COALESCE(SUM(CASE WHEN entry_type='PRODUCTION' AND metadata->>'type'='ORDER' THEN ${ledgerQtySql('moves')} ELSE 0 END),0) production_orders,
        COALESCE(SUM(CASE WHEN entry_type='CONSUMPTION' AND metadata->>'type'='ORDER' THEN ${ledgerQtySql('moves')} ELSE 0 END),0) consumption_orders,
        COALESCE(SUM(ABS(amount)) FILTER(WHERE entry_type='PRODUCTION'),0) production_total,
        COALESCE(SUM(ABS(amount)) FILTER(WHERE entry_type='CONSUMPTION'),0) consumption_total,
        COUNT(*)::int movement_count,
        MIN(created_at) first_at,
        MAX(created_at) last_at
      FROM moves GROUP BY captain_id
    ), first_move AS (
      SELECT DISTINCT ON (captain_id) captain_id,id,created_at
      FROM moves ORDER BY captain_id,created_at ASC,id ASC
    ), last_move AS (
      SELECT DISTINCT ON (captain_id) captain_id,id,created_at,entry_type,metadata
      FROM moves ORDER BY captain_id,created_at DESC,id DESC
    )
    SELECT a.*,fm.id first_id,lm.id last_id,lm.entry_type last_entry_type,lm.metadata last_metadata,
      COALESCE((SELECT SUM(x.amount) FROM ledger_entries x WHERE x.captain_id=a.captain_id AND (x.created_at<fm.created_at OR (x.created_at=fm.created_at AND x.id<fm.id))),0) opening_balance,
      COALESCE((SELECT SUM(x.amount) FROM ledger_entries x WHERE x.captain_id=a.captain_id AND (x.created_at<lm.created_at OR (x.created_at=lm.created_at AND x.id<lm.id))),0) last_balance_before
    FROM agg a JOIN first_move fm USING(captain_id) JOIN last_move lm USING(captain_id)
  `,[cleanStartAt]);
  const byId=new Map(q.rows.map(x=>[String(x.captain_id),x]));
  return caps.map(c=>{
    const x=byId.get(String(c.id));
    const current=Number(c.balance||0);
    if(!x)return {
      CaptainID:String(c.id),CaptainName:c.name,Phone:c.phone,
      ProductionPassengers:0,ConsumptionPassengers:0,ProductionOrders:0,ConsumptionOrders:0,
      ProductionTotal:0,ConsumptionTotal:0,NetCommission:0,
      OpeningBalance:current,LastBalanceBefore:current,CurrentBalance:current,
      MovementCount:0,LastMovement:'لا توجد حركات',LastMovementAt:'',UpdatedAt:iso(c.updated_at)
    };
    const pt=Number(x.production_total||0),ct=Number(x.consumption_total||0);
    const type=String(x.last_metadata?.type||'PASSENGER');
    const dir=String(x.last_entry_type||'CONSUMPTION');
    return {
      CaptainID:String(c.id),CaptainName:c.name,Phone:c.phone,
      ProductionPassengers:Number(x.production_passengers||0),ConsumptionPassengers:Number(x.consumption_passengers||0),
      ProductionOrders:Number(x.production_orders||0),ConsumptionOrders:Number(x.consumption_orders||0),
      ProductionTotal:pt,ConsumptionTotal:ct,NetCommission:Number((pt-ct).toFixed(3)),
      OpeningBalance:Number(x.opening_balance||0),LastBalanceBefore:Number(x.last_balance_before||0),CurrentBalance:current,
      MovementCount:Number(x.movement_count||0),
      LastMovement:`${dir==='PRODUCTION'?'إنتاج':'استهلاك'} — ${type==='ORDER'?'أوردر':'راكب'}`,
      LastMovementAt:iso(x.last_at),UpdatedAt:iso(x.last_at)
    };
  }).sort((a,b)=>String(a.CaptainName||'').localeCompare(String(b.CaptainName||''),'ar'));
}

async function currentWeekComparisonFromLedger(caps=[],cleanStartAt=null){
  const {start,end}=ammanFridayWeekBounds();
  const q=await db.query(`
    SELECT le.captain_id,
      COALESCE(SUM(ABS(le.amount)) FILTER(WHERE le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')),0) production,
      COALESCE(SUM(ABS(le.amount)) FILTER(WHERE le.entry_type='CONSUMPTION' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER')),0) consumption,
      COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER') THEN ${ledgerQtySql('le')} ELSE 0 END),0) production_count,
      COALESCE(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER') THEN ${ledgerQtySql('le')} ELSE 0 END),0) consumption_count,
      COALESCE(SUM(CASE WHEN COALESCE(le.metadata->>'type','')='WEEKLY_FLOOR' THEN -le.amount ELSE 0 END),0) floor_actual,
      COUNT(*) FILTER(WHERE COALESCE(le.metadata->>'type','')='WEEKLY_FLOOR')::int floor_count,
      COALESCE(SUM(CASE
        WHEN COALESCE(le.metadata->>'type','')='WEEKLY_THURSDAY_DEDUCTION' THEN -le.amount
        ELSE 0 END),0) order_deductions
    FROM ledger_entries le
    WHERE le.created_at >= $1::timestamptz AND le.created_at < $2::timestamptz
      AND ($3::timestamptz IS NULL OR le.created_at >= $3::timestamptz)
      AND le.reversed_at IS NULL AND le.entry_type<>'REVERSAL'
    GROUP BY le.captain_id
  `,[start.toISOString(),end.toISOString(),cleanStartAt]);
  const capById=new Map(caps.map(c=>[String(c.id),c]));
  const rows=[];
  for(const x of q.rows){
    const c=capById.get(String(x.captain_id)); if(!c)continue;
    const production=Number(x.production||0),consumption=Number(x.consumption||0);
    const productionCount=Number(x.production_count||0),consumptionCount=Number(x.consumption_count||0);
    const participated=(productionCount>0||consumptionCount>0);
    const floorExpected=participated?1.5:0,floorActual=Number(x.floor_actual||0),floorCount=Number(x.floor_count||0);
    const floorDifference=Number((floorActual-floorExpected).toFixed(3));
    let floorStatus='NO_ACTIVITY';
    if(participated&&floorCount===0)floorStatus='MISSING';
    else if(participated&&floorCount>1)floorStatus='DUPLICATE';
    else if(!participated&&floorCount>0)floorStatus='UNEXPECTED';
    else if(participated)floorStatus='OK';
    rows.push({
      captainId:String(c.id),captainName:c.name,phone:c.phone,participated,
      production,productionCount,consumption,consumptionCount,
      difference:Number((production-consumption).toFixed(3)),orderDeductions:Number(x.order_deductions||0),
      floorExpected,floorActual,floorCount,floorDifference,floorStatus
    });
  }
  rows.sort((a,b)=>String(a.captainName).localeCompare(String(b.captainName),'ar'));
  const summary=rows.reduce((z,r)=>{
    z.production+=r.production;z.productionCount+=r.productionCount;z.consumption+=r.consumption;z.consumptionCount+=r.consumptionCount;
    z.orderDeductions+=r.orderDeductions;z.floorExpected+=r.floorExpected;z.floorActual+=r.floorActual;z.floorCount+=r.floorCount;
    if(r.participated)z.expectedFloorCount++;
    if(r.floorStatus==='MISSING')z.missingFloors++;
    if(r.floorStatus==='DUPLICATE')z.duplicateFloors++;
    if(r.floorStatus==='UNEXPECTED')z.unexpectedFloors++;
    return z;
  },{production:0,productionCount:0,consumption:0,consumptionCount:0,orderDeductions:0,floorExpected:0,floorActual:0,floorCount:0,expectedFloorCount:0,missingFloors:0,duplicateFloors:0,unexpectedFloors:0});
  for(const k of ['production','consumption','orderDeductions','floorExpected','floorActual'])summary[k]=Number(summary[k].toFixed(3));
  summary.difference=Number((summary.production-summary.consumption).toFixed(3));
  summary.floorDifference=Number((summary.floorActual-summary.floorExpected).toFixed(3));
  summary.floorIssues=summary.missingFloors+summary.duplicateFloors+summary.unexpectedFloors;
  return {weekStart:start.toLocaleDateString('en-CA',{timeZone:'Asia/Amman'}),weekEnd:new Date(end.getTime()-86400000).toLocaleDateString('en-CA',{timeZone:'Asia/Amman'}),rows,summary};
}
function ledgerDoneId(e={}){
  const fromMeta=String(e.metadata?.doneMessageId||"").trim();
  if(fromMeta)return fromMeta;
  const m=String(e.description||"").match(/(?:^|\s|—)DONE:([A-Za-z0-9_-]+)/i);
  return m?.[1]||"";
}

async function ledgerParticipantMap(entries=[]){
  const doneIds=[...new Set(entries.map(ledgerDoneId).filter(Boolean))];
  if(!doneIds.length)return new Map();
  const q=await db.query(`
    SELECT le.*,c.name captain_name,c.phone captain_phone,
           COALESCE(NULLIF(le.metadata->>'doneMessageId',''),
                    substring(COALESCE(le.description,'') from 'DONE:([A-Za-z0-9_-]+)')) AS done_id
    FROM ledger_entries le
    JOIN captains c ON c.id=le.captain_id
    WHERE (
      (le.metadata ? 'doneMessageId' AND le.metadata->>'doneMessageId'=ANY($1::text[]))
      OR substring(COALESCE(le.description,'') from 'DONE:([A-Za-z0-9_-]+)')=ANY($1::text[])
    )
    ORDER BY le.id
  `,[doneIds]);
  const map=new Map();
  for(const row of q.rows){
    const done=String(row.done_id||"");
    if(!done)continue;
    const item=map.get(done)||{ProducerID:"",ProducerName:"",ProducerPhone:"",ConsumerID:"",ConsumerName:"",ConsumerPhone:""};
    const explicit=String(row.metadata?.pairRole||"").toLowerCase();
    const role=explicit==="producer"?"producer":explicit==="consumer"?"consumer":Number(row.amount||0)>=0?"producer":"consumer";
    if(role==="producer" && !item.ProducerID){
      item.ProducerID=String(row.captain_id||"");item.ProducerName=row.captain_name||"";item.ProducerPhone=row.captain_phone||"";
    }
    if(role==="consumer" && !item.ConsumerID){
      item.ConsumerID=String(row.captain_id||"");item.ConsumerName=row.captain_name||"";item.ConsumerPhone=row.captain_phone||"";
    }
    map.set(done,item);
  }
  return map;
}

function legacyTx(e,captainName="",participants={}){
  const type=String(e.entry_type||"");
  const amt=Number(e.amount||0);
  const direction=amt>=0?"PRODUCTION":"CONSUMPTION";
  const metaType=String(e.metadata?.type||"");
  const movementType =
    metaType==="WEEKLY_FLOOR"?"WEEKLY_FLOOR":
    metaType==="WEEKLY_ORDER_BATCH"?"WEEKLY_ORDER_BATCH":
    type.includes("FRIDAY")?"FRIDAY_SETTLEMENT":
    metaType==="ORDER"||type.includes("ORDER")?"ORDER":
    metaType==="PASSENGER"||type.includes("RIDER")||type.includes("PASSENGER")?"PASSENGER":
    type.includes("RECHARGE")?"RECHARGE":"MANUAL";
  const rawQuantity=Number(e.metadata?.quantity||1);
  const workloadQuantity=(String(e.reference_type||'')==='green_partial'||e.metadata?.excludeFromWorkload)?0:Number(e.metadata?.workloadQuantity??rawQuantity);
  const effectiveAt=e.effective_at||e.created_at;
  return {
    ID:String(e.id), CaptainID:String(e.captain_id), CaptainName:captainName,
    Direction:direction, MovementDirection:direction, Type:movementType,
    Quantity:rawQuantity,WorkloadQuantity:workloadQuantity,
    UnitCommission:Math.abs(Number(e.metadata?.unitCommission||amt||0)),
    TotalCommission:Math.abs(amt),
    BalanceBefore:Number(e.metadata?.balanceBefore??e.computed_balance_before??0),
    BalanceAfter:Number(e.metadata?.balanceAfter??e.computed_balance_after??0),
    ProducerID:String(participants?.ProducerID||""),ProducerName:participants?.ProducerName||"",ProducerPhone:participants?.ProducerPhone||"",
    ConsumerID:String(participants?.ConsumerID||""),ConsumerName:participants?.ConsumerName||"",ConsumerPhone:participants?.ConsumerPhone||"",
    DoneMessageID:ledgerDoneId(e),
    Note:e.description||"", Details:e.description||"",
    CreatedAt:iso(effectiveAt),AccountingDate:dateKey(new Date(effectiveAt)), Status:"ACTIVE",
    ReferenceType:e.reference_type||"", ReferenceID:e.reference_id||"",
    ReversedEntryID:e.reversed_entry_id||""
  };
}
function safeArray(v){return Array.isArray(v)?v:[]}
async function detailStep(label,promise){
  try{return await promise;}catch(e){throw new Error(`${label}: ${e?.message||e}`);}
}

function waDisplayPhone(value){
  if(/@lid$/i.test(String(value||'').trim()))return 'بانتظار تحويل رقم WAHA';
  let d=String(value||'').replace(/\D/g,'');
  if(d.startsWith('00962'))d=d.slice(2);
  if(d.startsWith('962'))d=d.slice(3);
  return d?('0'+d.replace(/^0+/,'')):'';
}
function liveWhatsappSummary(row){
  const p=row.raw_payload||{};
  const md=p.messageData||{};
  const type=String(row.message_type||md.typeMessage||'');
  const quoted=md.quotedMessage||{};
  const target=String(
    md?.reactionMessageData?.stanzaId||md?.reactionMessageData?.quotedStanzaId||md?.reactionMessageData?.idMessageQuoted||
    md?.extendedTextMessageData?.stanzaId||quoted?.stanzaId||
    md?.deletedMessageData?.stanzaId||md?.deletedMessageData?.idMessage||md?.deletedMessageData?.messageId||''
  );
  const reaction=String(md?.reactionMessageData?.text||md?.reactionMessageData?.emoji||'').replace(/\uFE0F/g,'').trim();
  const text=String(row.message_text||md?.textMessageData?.textMessage||md?.extendedTextMessageData?.text||md?.editedMessageData?.textMessage||md?.fileMessageData?.caption||'').trim();
  const quotedText=String(quoted?.textMessageData?.textMessage||quoted?.textMessage||quoted?.extendedTextMessageData?.text||'').trim();
  let kind='MESSAGE';
  if(type==='reactionMessage')kind='REACTION';
  else if(type==='deletedMessage')kind='DELETE';
  else if(type==='audioMessage')kind='AUDIO';
  else if(type==='editedMessage')kind='EDIT';
  else if(target||type==='quotedMessage'||type==='extendedTextMessage')kind='REPLY';
  const eventAt=row.event_at?new Date(row.event_at):null;
  const received=row.webhook_received_at?new Date(row.webhook_received_at):null;
  const processed=row.processed_at?new Date(row.processed_at):null;
  return {
    id:Number(row.id||0),idMessage:row.id_message||'',kind,
    webhookType:row.webhook_type||'',messageType:type,
    senderName:row.sender_name||p?.senderData?.senderName||'',
    senderPhone:waDisplayPhone(row.sender_id||p?.senderData?.sender||''),
    outgoing:/^outgoing/i.test(String(row.webhook_type||'')),
    text,quotedText,targetId:target,reaction,
    status:String(row.status||''),processingMode:String(row.processing_mode||''),
    eventAt:row.event_at||null,receivedAt:row.webhook_received_at||null,processedAt:row.processed_at||null,
    deliveryDelayMs:eventAt&&received?Math.max(0,received-eventAt):null,
    processingDelayMs:received&&processed?Math.max(0,processed-received):null,
    totalDelayMs:eventAt&&processed?Math.max(0,processed-eventAt):null,
    delayMs:received&&processed?Math.max(0,processed-received):null,
    duplicates:Number(row.duplicate_count||0),error:row.last_error||''
  };
}


function excelNormText(value){
  return String(value??"")
    .trim().toLowerCase()
    .replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي")
    .replace(/ؤ/g,"و").replace(/ئ/g,"ي")
    .replace(/[^\p{L}\p{N}]+/gu," ");
}
function excelNormPhone(value){
  let d=String(value??"").replace(/\D/g,"");
  if(d.startsWith("00962"))d=d.slice(2);
  if(d.startsWith("962"))d=d.slice(3);
  if(d.startsWith("0"))d=d.slice(1);
  return d;
}
function excelNum(value){
  const normalized=String(value??"")
    .replace(/٫/g,".").replace(/٬/g,"").replace(/,/g,"")
    .replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d))
    .replace(/[^\d.\-]/g,"");
  const n=Number(normalized);
  return Number.isFinite(n)?n:0;
}
function pickHeader(headers,aliases){
  const normalized=headers.map(h=>({raw:h,n:excelNormText(h)}));
  for(const alias of aliases){
    const a=excelNormText(alias);
    const exact=normalized.find(x=>x.n===a);
    if(exact)return exact.raw;
  }
  for(const alias of aliases){
    const a=excelNormText(alias);
    const contains=normalized.find(x=>x.n.includes(a)||a.includes(x.n));
    if(contains)return contains.raw;
  }
  return null;
}
async function parseInventoryExcelFile({fileName,base64}={}){
  if(!base64)throw new Error("ملف Excel فارغ");
  const raw=String(base64).includes(",")?String(base64).split(",").pop():String(base64);
  const buf=Buffer.from(raw,"base64");
  if(buf.length>7*1024*1024)throw new Error("حجم الملف كبير؛ الحد 7MB");

  let wb;
  try{wb=XLSX.read(buf,{type:"buffer",cellDates:false,raw:false});}
  catch{throw new Error("تعذر قراءة الملف. استخدم XLSX أو XLS أو CSV");}

  const captains=await listCaptains("");
  const byPhone=new Map(),byName=new Map();
  for(const c of captains){
    const p=excelNormPhone(c.phone),n=excelNormText(c.name);
    if(p)byPhone.set(p,c);
    if(n){if(!byName.has(n))byName.set(n,[]);byName.get(n).push(c);}
  }

  const nameAliases=["اسم الكابتن","الكابتن","اسم","الاسم","الاسم الكامل","captain","captain name"];
  const phoneAliases=["رقم الهاتف","الهاتف","رقم","الرقم","تلفون","موبايل","phone","mobile"];
  const totalAliases=["الجرد اليدوي","اليدوي","اجمالي الانتاج","إجمالي الإنتاج","الانتاج","الإنتاج","عدد الانتاج","عدد الإنتاج","المجموع","total","production total"];
  const riderAliases=["انتاج ركاب","إنتاج ركاب","ركاب","عدد الركاب","ركاب انتاج","production passengers","passengers","riders"];
  const orderAliases=["انتاج اوردرات","إنتاج أوردرات","اوردرات","أوردرات","عدد الاوردرات","عدد الأوردرات","طلبات","production orders","orders"];

  let chosen=null;
  for(const sheetName of wb.SheetNames){
    const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{defval:"",raw:false});
    if(!rows.length)continue;
    const headers=Object.keys(rows[0]||{});
    const nameKey=pickHeader(headers,nameAliases),phoneKey=pickHeader(headers,phoneAliases);
    const totalKey=pickHeader(headers,totalAliases),ridersKey=pickHeader(headers,riderAliases),ordersKey=pickHeader(headers,orderAliases);
    if((nameKey||phoneKey)&&(totalKey||ridersKey||ordersKey)){
      chosen={sheetName,rows,nameKey,phoneKey,totalKey,ridersKey,ordersKey};break;
    }
  }
  if(!chosen)throw new Error("لم أجد أعمدة الجرد. لازم اسم/رقم الكابتن ومعه الإنتاج أو الركاب/الأوردرات");

  const imported=[],unmatched=[],duplicates=[],seen=new Set();
  for(let i=0;i<chosen.rows.length;i++){
    const row=chosen.rows[i],rowNo=i+2;
    const rawName=chosen.nameKey?String(row[chosen.nameKey]??"").trim():"";
    const rawPhone=chosen.phoneKey?String(row[chosen.phoneKey]??"").trim():"";
    if(!rawName&&!rawPhone)continue;

    let captain=null;
    const phone=excelNormPhone(rawPhone);
    if(phone)captain=byPhone.get(phone)||null;
    if(!captain&&rawName){
      const arr=byName.get(excelNormText(rawName))||[];
      if(arr.length===1)captain=arr[0];
      else if(arr.length>1){unmatched.push({row:rowNo,name:rawName,phone:rawPhone,reason:"الاسم مكرر؛ أضف رقم الهاتف"});continue;}
    }
    if(!captain){unmatched.push({row:rowNo,name:rawName,phone:rawPhone,reason:"لم يتم العثور على الكابتن"});continue;}
    if(seen.has(String(captain.id))){duplicates.push({row:rowNo,captainId:String(captain.id),name:captain.name,reason:"الكابتن مكرر داخل الملف"});continue;}
    seen.add(String(captain.id));

    const riders=chosen.ridersKey?Math.max(0,Math.trunc(excelNum(row[chosen.ridersKey]))):null;
    const orders=chosen.ordersKey?Math.max(0,Math.trunc(excelNum(row[chosen.ordersKey]))):null;
    let total=chosen.totalKey?Math.max(0,Math.trunc(excelNum(row[chosen.totalKey]))):null;
    if(total===null&&(riders!==null||orders!==null))total=Number(riders||0)+Number(orders||0);
    if(total===null)continue;

    imported.push({
      captainId:String(captain.id),captainName:captain.name,phone:captain.phone,excelRow:rowNo,
      manualTotal:total,manualPassengers:riders,manualOrders:orders,
      hasSplit:riders!==null||orders!==null
    });
  }

  return {
    fileName:String(fileName||""),sheetName:chosen.sheetName,
    detected:{name:chosen.nameKey||null,phone:chosen.phoneKey||null,total:chosen.totalKey||null,passengers:chosen.ridersKey||null,orders:chosen.ordersKey||null},
    imported,unmatched,duplicates,
    summary:{imported:imported.length,unmatched:unmatched.length,duplicates:duplicates.length}
  };
}

async function parseManualMovementExcelFile({fileName,base64}={}){
  if(!base64)throw new Error("ملف Excel فارغ");
  const raw=String(base64).includes(",")?String(base64).split(",").pop():String(base64);
  const buf=Buffer.from(raw,"base64");
  if(buf.length>7*1024*1024)throw new Error("حجم الملف كبير؛ الحد 7MB");

  let wb;
  try{wb=XLSX.read(buf,{type:"buffer",cellDates:false,raw:false});}
  catch{throw new Error("تعذر قراءة الملف. استخدم XLSX أو XLS أو CSV");}

  const captains=await listCaptains("");
  const byPhone=new Map(),byName=new Map();
  for(const c of captains){
    const p=excelNormPhone(c.phone),n=excelNormText(c.name);
    if(p)byPhone.set(p,c);
    if(n){if(!byName.has(n))byName.set(n,[]);byName.get(n).push(c);}
  }

  const nameAliases=["اسم الكابتن","الكابتن","اسم","الاسم","الاسم الكامل","captain","captain name"];
  const phoneAliases=["رقم الهاتف","الهاتف","رقم","الرقم","تلفون","موبايل","phone","mobile"];
  const consumptionOrdersAliases=["عدد اوردرات استهلاك","عدد أوردرات استهلاك","اوردرات استهلاك","أوردرات استهلاك","استهلاك اوردرات","استهلاك أوردرات","consumption orders"];
  const consumptionPassengersAliases=["عدد ركاب استهلاك","ركاب استهلاك","استهلاك ركاب","consumption passengers","consumption riders"];
  const productionOrdersAliases=["عدد اوردرات انتاج","عدد أوردرات انتاج","عدد اوردرات إنتاج","عدد أوردرات إنتاج","اوردرات انتاج","أوردرات إنتاج","انتاج اوردرات","إنتاج أوردرات","production orders"];
  const productionPassengersAliases=["عدد ركاب انتاج","عدد ركاب إنتاج","ركاب انتاج","ركاب إنتاج","انتاج ركاب","إنتاج ركاب","production passengers","production riders"];

  const headerIndex=(headers,aliases)=>{
    const normalized=headers.map((h,index)=>({index,raw:String(h??"").trim(),n:excelNormText(h)}));
    for(const alias of aliases){const a=excelNormText(alias),m=normalized.find(x=>x.n===a);if(m)return m.index;}
    for(const alias of aliases){const a=excelNormText(alias),m=normalized.find(x=>x.n&&a&&(x.n.includes(a)||a.includes(x.n)));if(m)return m.index;}
    return -1;
  };

  let chosen=null;
  for(const sheetName of wb.SheetNames){
    const matrix=XLSX.utils.sheet_to_json(wb.Sheets[sheetName],{header:1,defval:"",raw:false,blankrows:false});
    if(!matrix.length)continue;
    for(let headerRow=0;headerRow<Math.min(30,matrix.length);headerRow++){
      const headers=Array.isArray(matrix[headerRow])?matrix[headerRow]:[];
      const nameIndex=headerIndex(headers,nameAliases),phoneIndex=headerIndex(headers,phoneAliases);
      const consumptionOrdersIndex=headerIndex(headers,consumptionOrdersAliases);
      const consumptionPassengersIndex=headerIndex(headers,consumptionPassengersAliases);
      const productionOrdersIndex=headerIndex(headers,productionOrdersAliases);
      const productionPassengersIndex=headerIndex(headers,productionPassengersAliases);
      if((nameIndex>=0||phoneIndex>=0)&&(consumptionOrdersIndex>=0||consumptionPassengersIndex>=0||productionOrdersIndex>=0||productionPassengersIndex>=0)){
        chosen={sheetName,matrix,headerRow,nameIndex,phoneIndex,consumptionOrdersIndex,consumptionPassengersIndex,productionOrdersIndex,productionPassengersIndex,headers};
        break;
      }
    }
    if(chosen)break;
  }
  if(!chosen)throw new Error("لم أجد صف العناوين المطلوب. لازم يحتوي اسم/رقم الكابتن ومعه أعمدة عدد أوردرات/ركاب الاستهلاك أو الإنتاج");

  const merged=new Map(),unmatched=[],zeroRows=[];
  for(let i=chosen.headerRow+1;i<chosen.matrix.length;i++){
    const row=Array.isArray(chosen.matrix[i])?chosen.matrix[i]:[],rowNo=i+1;
    const cell=index=>index>=0?row[index]:"";
    const rawName=String(cell(chosen.nameIndex)??"").trim();
    const rawPhone=String(cell(chosen.phoneIndex)??"").trim();
    const quantities={
      consumptionOrders:chosen.consumptionOrdersIndex>=0?Math.max(0,Math.trunc(excelNum(cell(chosen.consumptionOrdersIndex)))):0,
      consumptionPassengers:chosen.consumptionPassengersIndex>=0?Math.max(0,Math.trunc(excelNum(cell(chosen.consumptionPassengersIndex)))):0,
      productionOrders:chosen.productionOrdersIndex>=0?Math.max(0,Math.trunc(excelNum(cell(chosen.productionOrdersIndex)))):0,
      productionPassengers:chosen.productionPassengersIndex>=0?Math.max(0,Math.trunc(excelNum(cell(chosen.productionPassengersIndex)))):0
    };
    const totalQty=Object.values(quantities).reduce((a,b)=>a+b,0);
    if(!rawName&&!rawPhone&&!totalQty)continue;

    let captain=null;
    const phone=excelNormPhone(rawPhone);
    if(phone)captain=byPhone.get(phone)||null;
    if(!captain&&rawName){
      const arr=byName.get(excelNormText(rawName))||[];
      if(arr.length===1)captain=arr[0];
      else if(arr.length>1){unmatched.push({row:rowNo,name:rawName,phone:rawPhone,reason:"الاسم مكرر؛ استخدم رقم الهاتف"});continue;}
    }
    if(!captain){unmatched.push({row:rowNo,name:rawName,phone:rawPhone,reason:"لم يتم العثور على الكابتن"});continue;}
    if(!totalQty){zeroRows.push({row:rowNo,captainId:String(captain.id),name:captain.name,phone:captain.phone});continue;}

    for(const [k,v] of Object.entries(quantities))if(!Number.isInteger(v)||v<0||v>1000000)throw new Error(`سطر ${rowNo}: ${k} يجب أن يكون من 0 إلى 1,000,000`);
    const key=String(captain.id);
    if(!merged.has(key))merged.set(key,{captainId:key,captainName:captain.name,phone:captain.phone,sourceRows:[],consumptionOrders:0,consumptionPassengers:0,productionOrders:0,productionPassengers:0});
    const item=merged.get(key);item.sourceRows.push(rowNo);
    for(const k of Object.keys(quantities))item[k]+=quantities[k];
  }

  const imported=[...merged.values()].map(item=>{
    const productionAmount=Number((item.productionPassengers*CFG.passengerCommission+item.productionOrders*CFG.orderCommission).toFixed(3));
    const consumptionAmount=Number((item.consumptionPassengers*CFG.passengerCommission+item.consumptionOrders*CFG.orderCommission).toFixed(3));
    return {...item,productionAmount,consumptionAmount,netAmount:Number((productionAmount-consumptionAmount).toFixed(3)),totalQty:item.productionPassengers+item.productionOrders+item.consumptionPassengers+item.consumptionOrders};
  });
  const totals=imported.reduce((a,x)=>({
    captains:a.captains+1,
    consumptionOrders:a.consumptionOrders+x.consumptionOrders,
    consumptionPassengers:a.consumptionPassengers+x.consumptionPassengers,
    productionOrders:a.productionOrders+x.productionOrders,
    productionPassengers:a.productionPassengers+x.productionPassengers,
    consumptionAmount:Number((a.consumptionAmount+x.consumptionAmount).toFixed(3)),
    productionAmount:Number((a.productionAmount+x.productionAmount).toFixed(3))
  }),{captains:0,consumptionOrders:0,consumptionPassengers:0,productionOrders:0,productionPassengers:0,consumptionAmount:0,productionAmount:0});
  totals.netAmount=Number((totals.productionAmount-totals.consumptionAmount).toFixed(3));
  const headerName=index=>index>=0?String(chosen.headers[index]??"").trim():null;

  return {
    fileName:String(fileName||""),sheetName:chosen.sheetName,headerRow:chosen.headerRow+1,
    detected:{name:headerName(chosen.nameIndex),phone:headerName(chosen.phoneIndex),consumptionOrders:headerName(chosen.consumptionOrdersIndex),consumptionPassengers:headerName(chosen.consumptionPassengersIndex),productionOrders:headerName(chosen.productionOrdersIndex),productionPassengers:headerName(chosen.productionPassengersIndex)},
    imported,unmatched,zeroRows,totals,
    summary:{imported:imported.length,unmatched:unmatched.length,zeroRows:zeroRows.length}
  };
}

export function makeLegacyRpc(app){
  const DELEGATED_METHODS=Object.freeze({
    accountantBootstrapFast:"overview",
    accountantBootstrap:"overview",
    getCaptainFullProfile:"captains",
    createCaptain:"captains",
    resetCaptainPassword:"captains",
    setCaptainExactBalance:"captains",
    setCaptainAdministrativeState:"captains",
    updateCaptainPayoutDetails:"captains",
    setCaptainGroupProtection:"captains",
    setCaptainBalanceMode:"captains",
    exportCaptainBalances:"captains",
    submitTransfer:"transfers",
    reviewTransfer:"transfers",
    getAccountantRechargeReport:"codes",
    issueAccountantRechargeCode:"codes",
    getInventoryReconciliation:"inventory",
    reconcileInventoryDifference:"inventory",
    runInventoryReconciliationNow:"inventory",
    addManualCombinedMovement:"movements",
    addManualMovement:"movements",
    previewLatestExcelRollback:"movements",
    parseInventoryExcel:"movements",
    parseManualMovementExcel:"movements",
    commitManualMovementExcel:"movements",
    undoAccountantTransaction:"movements",
    getFridayGroupClosureSession:"settlements",
    previewFridaySettlements:"settlements",
    startFridayGroupClosureSession:"settlements",
    forceOpenFridayGroup:"settlements",
    commitFridayGroupSession:"settlements",
    ensureDirectFridaySettlement:"settlements",
    markFridaySettlementPaid:"settlements",
    processDirectFridayPayment:"settlements",
    verifyPaidFridaySettlementBalance:"settlements",
    returnFridaySettlementToBalance:"settlements",
    undoLastFridaySettlementBatch:"settlements",
    getNorthCommissionAudit:"diagnostics",
    getNorthInventoryDiagnostics:"diagnostics",
    getWhatsAppLiveFeed:"diagnostics",
    getWebhookDiagnostic:"diagnostics",
    getReliabilityCenter:"diagnostics"
  });
  async function delegatedPermissions(captainId){
    if(!captainId)return [];
    try{
      const r=await db.query("SELECT permissions FROM captain_admin_grants WHERE captain_id=$1 AND active=true",[captainId]);
      const p=r.rows[0]?.permissions;
      return Array.isArray(p)?p.filter(x=>typeof x==="string"&&x!=="settings"):[];
    }catch(e){if(e.code==="42P01")return [];throw e;}
  }
  function scopedDelegateData(data,permissions){
    const can=k=>permissions.includes(k);
    const copy={...data};
    const fields={captains:"captains",transfers:"transfers",transactions:"transactions",codes:"codes",inventory:"inventory",
      pendingMovements:"movements",whatsappMessages:"diagnostics",weeklySettlements:"settlements",
      fridayPreview:"settlements",fridayGroupSession:"settlements",weeklyComparison:"inventory",
      inventoryReconciliation:"inventory",auditLog:"settings",greenApi:"settings",groupGuide:"settings",
      systemIssues:"settings",unregisteredAttempts:"captains",reactionPairs:"diagnostics",
      cancellationNumbers:"diagnostics",reactionCancellations:"diagnostics",cancelledOrders:"diagnostics"};
    for(const [key,permission] of Object.entries(fields))if(!can(permission))delete copy[key];
    if(!can("captains")&&can("codes")){
      copy.captains=(Array.isArray(data.captains)?data.captains:[]).map(c=>({
        ID:c.ID,FullName:c.FullName,Phone:c.Phone,id:c.id,name:c.name,phone:c.phone
      }));
    }
    if(!can("overview"))copy.stats={};
    copy.me={...(copy.me||{}),role:"accountant",delegated:true,permissions};
    return copy;
  }
  async function verify(token, roles=[]){
    let u;
    try{u=app.jwt.verify(String(token||""));}catch{throw new Error("انتهت الجلسة، سجّل الدخول من جديد");}
    const current=await getUserPublic(u?.sub);
    const sameCaptain=String(current?.captain_id||"")===String(u?.captainId||"");
    if(!current?.is_active||!sameCaptain||(!u?.delegated&&current.role!==u?.role)|| (u?.delegated&&(current.role!=="captain"||u.role!=="accountant")))
      throw new Error("تم إلغاء الجلسة؛ سجّل الدخول من جديد");
    if(u?.delegated && !(await delegatedPermissions(u.captainId)).length)throw new Error("تم إلغاء تفويض الإدارة");
    if(current.role==="captain"){
      const maintenance=await getCaptainSiteMaintenanceState();
      if(maintenance.enabled)throw Object.assign(new Error("CAPTAIN_SITE_MAINTENANCE"),{statusCode:503});
    }
    if(roles.length && !roles.includes(u.role)) throw new Error("ليس لديك صلاحية");
    return {...u,role:u.delegated?"accountant":current.role,captainId:current.captain_id||null,username:current.username};
  }


  // Reviewed old Google Apps Script balances; never silently create captains or sum balances.
  function normalizeOldScriptRows(input){
    if(!Array.isArray(input)||input.length>5000)throw new Error("ملف الأرصدة كبير أو غير صالح");
    const rows=input.map((x,i)=>{
      const phone=String(x?.phone??"").replace(/[^0-9]/g,"").slice(-9);
      const balanceText=String(x?.balance??"").trim();
      const validPhone=/^7[789][0-9]{7}$/.test(phone);
      const validBalance=/^-?[0-9]+(?:\.[0-9]{1,3})?$/.test(balanceText)&&Math.abs(Number(balanceText))<=999999999;
      return {index:i+1,phone,balance:validBalance?Number(Number(balanceText).toFixed(3)):null,validPhone,validBalance};
    });
    return rows;
  }
  async function inspectOldScriptBalances(input){
    const source=normalizeOldScriptRows(input);
    const count=new Map();
    for(const r of source)if(r.validPhone)count.set(r.phone,(count.get(r.phone)||0)+1);
    // Match existing captain profiles OR their linked login numbers.
    // Some migrated captains have a LID/legacy phone on the captain row,
    // while the actual WhatsApp number lives in the captain login username.
    const [captainResult,loginResult]=await Promise.all([
      db.query("SELECT c.id,c.name,c.phone,COALESCE(SUM(l.amount),0)::numeric(12,3) AS balance FROM captains c LEFT JOIN ledger_entries l ON l.captain_id=c.id GROUP BY c.id"),
      db.query("SELECT captain_id,username FROM users WHERE role='captain' AND captain_id IS NOT NULL")
    ]);
    const caps=captainResult.rows;
    const byPhone=new Map();
    const add=(raw,c)=>{
      const digits=String(raw||"").replace(/\D/g,"");
      const phone=digits.slice(-9);
      if(!/^7[789][0-9]{7}$/.test(phone))return;
      if(!byPhone.has(phone))byPhone.set(phone,new Map());
      byPhone.get(phone).set(String(c.id),c);
    };
    const byId=new Map(caps.map(c=>[String(c.id),c]));
    for(const c of caps)add(c.phone,c);
    for(const u of loginResult.rows){
      const c=byId.get(String(u.captain_id));
      if(c)add(u.username,c);
    }
    const rows=source.map(r=>{
      const targets=[...(byPhone.get(r.phone)?.values()||[])];
      const status=!r.validPhone||!r.validBalance?"INVALID":count.get(r.phone)>1?"DUPLICATE":targets.length!==1?(targets.length?"AMBIGUOUS":"UNMATCHED"):"MATCHED";
      const c=status==="MATCHED"?targets[0]:null;
      const currentBalance=c?Number(Number(c.balance).toFixed(3)):null;
      return {index:r.index,phone:r.phone,balance:r.balance,status,captainId:c?String(c.id):null,captainName:c?String(c.name):"",currentBalance,difference:c?Number((r.balance-currentBalance).toFixed(3)):null};
    });
    const importId=createHash("sha256").update(JSON.stringify(source.map(r=>[r.phone,r.balance]))).digest("hex");
    const previewId=createHash("sha256").update(JSON.stringify([importId,rows.map(r=>[r.status,r.captainId])])).digest("hex");
    const stats={total:rows.length,matched:rows.filter(r=>r.status==="MATCHED").length,changed:rows.filter(r=>r.status==="MATCHED"&&r.difference!==0).length,duplicate:rows.filter(r=>r.status==="DUPLICATE").length,unmatched:rows.filter(r=>r.status==="UNMATCHED").length,invalid:rows.filter(r=>r.status==="INVALID").length,ambiguous:rows.filter(r=>r.status==="AMBIGUOUS").length};
    return {ok:true,importId,previewId,stats,rows};
  }

  const OUTAGE_RECOVERY_STATUS_KEY="abshir:whatsapp:outage_recovery:status:v65";

  async function readOutageRecoveryStatus(){
    try{const raw=await redis.get(OUTAGE_RECOVERY_STATUS_KEY);return raw?JSON.parse(raw):{status:"IDLE"};}
    catch{return {status:"IDLE"};}
  }

  async function writeOutageRecoveryStatus(value){
    const next={...(value||{}),updatedAt:new Date().toISOString()};
    await redis.set(OUTAGE_RECOVERY_STATUS_KEY,JSON.stringify(next),"EX",24*60*60);
    return next;
  }


  async function outageRecoveryCaptainBalanceChanges(jobId){
    const jid=String(jobId||'').trim();
    if(!jid)return [];
    const q=await db.query(`
      WITH impact AS (
        SELECT le.captain_id,
          COALESCE(SUM(le.amount),0)::numeric(14,3) recovery_delta,
          COALESCE(SUM(CASE WHEN le.entry_type='PRODUCTION' AND le.amount>0 THEN le.amount ELSE 0 END),0)::numeric(14,3) production_added,
          COALESCE(ABS(SUM(CASE WHEN le.entry_type='CONSUMPTION' AND le.amount<0 THEN le.amount ELSE 0 END)),0)::numeric(14,3) consumption_added,
          COALESCE(SUM(CASE WHEN le.entry_type='REVERSAL' THEN le.amount ELSE 0 END),0)::numeric(14,3) reversal_delta,
          COUNT(*)::int financial_entries
        FROM ledger_entries le
        WHERE COALESCE(le.metadata->>'outageRecoveryJobId','')=$1
        GROUP BY le.captain_id
      ), balances AS (
        SELECT c.id,c.name,c.phone,COALESCE(SUM(le.amount),0)::numeric(14,3) current_balance
        FROM captains c
        LEFT JOIN ledger_entries le ON le.captain_id=c.id
        GROUP BY c.id,c.name,c.phone
      )
      SELECT b.id,b.name,b.phone,b.current_balance,
             i.recovery_delta,i.production_added,i.consumption_added,i.reversal_delta,i.financial_entries
      FROM impact i
      JOIN balances b ON b.id=i.captain_id
      ORDER BY ABS(i.recovery_delta) DESC,i.financial_entries DESC,b.name
      LIMIT 250
    `,[jid]);
    return q.rows.map(x=>{
      const after=Number(x.current_balance||0),delta=Number(x.recovery_delta||0);
      return {
        captainId:String(x.id),captainName:String(x.name||''),phone:String(x.phone||''),
        productionAdded:Number(x.production_added||0),consumptionAdded:Number(x.consumption_added||0),
        reversalDelta:Number(x.reversal_delta||0),recoveryDelta:delta,
        balanceBefore:Number((after-delta).toFixed(3)),balanceAfter:Number(after.toFixed(3)),
        financialEntries:Number(x.financial_entries||0)
      };
    });
  }

  async function outageRecoveryProcessingSnapshot(ids,jobId){
    const unique=[...new Set((Array.isArray(ids)?ids:[]).map(String).filter(Boolean))];
    const empty={queueTotal:0,queueHandled:0,queueRemaining:0,queueFailed:0,queueErrors:0,queueProcessing:0,queueWaiting:0,repairedInventories:0,financialEntriesFixed:0,reversedMessages:0,waitingReview:0,captainBalanceChanges:[]};
    if(!unique.length)return empty;
    const rows=(await db.query(`
      SELECT status,COUNT(*)::int n
      FROM whatsapp_events
      WHERE id_message=ANY($1::text[])
      GROUP BY status
    `,[unique])).rows;
    const counts={};
    for(const row of rows)counts[String(row.status||'unknown')]=Number(row.n||0);
    const pending=Number(counts.received||0)+Number(counts.queued||0)+Number(counts.processing||0);
    const failed=Number(counts.failed||0);
    const logicalErrors=Number(counts.error||0);
    const ledger=(await db.query(`
      SELECT COUNT(*)::int financial_entries,
             COUNT(DISTINCT NULLIF(metadata->>'doneMessageId',''))::int repaired_inventories
      FROM ledger_entries
      WHERE COALESCE(metadata->>'outageRecoveryJobId','')=$1
    `,[String(jobId||'')])).rows[0]||{};
    const captainBalanceChanges=await outageRecoveryCaptainBalanceChanges(jobId).catch(()=>[]);
    return {
      queueTotal:unique.length,
      queueHandled:Math.max(0,unique.length-pending),
      queueRemaining:pending,
      queueFailed:failed,
      queueErrors:logicalErrors,
      queueProcessing:Number(counts.processing||0),
      queueWaiting:Number(counts.queued||0)+Number(counts.received||0),
      repairedInventories:Number(ledger.repaired_inventories||0),
      financialEntriesFixed:Number(ledger.financial_entries||0),
      reversedMessages:Number(counts.reversed||0),
      waitingReview:Number(counts.waiting_review||0),
      captainBalanceChanges,
      captainsChanged:captainBalanceChanges.length,
      totalRecoveryDelta:Number(captainBalanceChanges.reduce((sum,x)=>sum+Number(x.recoveryDelta||0),0).toFixed(3))
    };
  }

  async function startOutageRecoveryBackground(token,payload){
    const me=await verify(token,["admin","accountant"]);
    payload=payload||{};
    const current=await readOutageRecoveryStatus();
    const startedMs=current?.startedAt?new Date(current.startedAt).getTime():0;
    const stillFresh=String(current?.status||"")==="RUNNING"&&Number.isFinite(startedMs)&&Date.now()-startedMs<45*60*1000;
    if(stillFresh){
      return {ok:true,started:false,message:"يوجد استرجاع يعمل حاليًا — تم فتح حالة العملية الحالية",recovery:current};
    }
    const jobId=`OUTAGE-${Date.now()}-${randomUUID().slice(0,8)}`;
    const base=await writeOutageRecoveryStatus({
      status:"RUNNING",stage:"STARTING",jobId,startedAt:new Date().toISOString(),
      fromAt:payload.fromAt||null,toAt:payload.toAt||null,count:Math.min(20000,Math.max(100,Number(payload.count)||20000)),
      historyFetched:0,selected:0,processed:0,inserted:0,requeued:0,existing:0,dependencyInserted:0,errorCount:0,
      queueTotal:0,queueHandled:0,queueRemaining:0,queueFailed:0,queueErrors:0,repairedInventories:0,financialEntriesFixed:0,reversedMessages:0,waitingReview:0,captainBalanceChanges:[],captainsChanged:0,totalRecoveryDelta:0,reactionEvents:0,likesFound:0,likeRemovalsFound:0,partialReactionsFound:0,fullCancelsFound:0,crossProviderProtected:0,legacyProtected:0,localEventsSupplemented:0,localReactionSupplemented:0,wahaSyntheticReactions:0,directReconciliation:true
    });
    setImmediate(async()=>{
      const runtime={selectedIds:[],queuedIds:[],groupId:""};
      runtime.waitForLivePriority=async(meta={})=>{
        let waitedMs=0;
        while(true){
          const counts=await whatsappQueue.getJobCounts("waiting","active","delayed","prioritized").catch(()=>({}));
          const pressure=Number(counts.waiting||0)+Number(counts.active||0)+Number(counts.delayed||0)+Number(counts.prioritized||0);
          if(pressure<=0)return {waitedMs,counts};
          const prev=await readOutageRecoveryStatus().catch(()=>null);
          if(prev&&String(prev.jobId||'')===jobId){
            await writeOutageRecoveryStatus({...prev,status:"RUNNING",jobId,livePriorityWait:true,liveQueuePressure:pressure,message:`أولوية للجرد LIVE — انتظار ${pressure} حركة جديدة ثم متابعة الاسترجاع`}).catch(()=>{});
          }
          await new Promise(resolve=>setTimeout(resolve,500));
          waitedMs+=500;
          if(waitedMs>=30000)return {waitedMs,counts,softTimeout:true};
        }
      };
      try{
        const recoveryPayload={...payload,_abshirOutageRecoveryJobId:jobId};
        const result=await recoverOutageWindow(recoveryPayload,enqueueWebhook,me.sub,async progress=>{
          const prev=await readOutageRecoveryStatus();
          if(String(prev?.jobId||"")!==jobId)return;
          const processing=await outageRecoveryProcessingSnapshot(runtime.queuedIds,jobId).catch(()=>({}));
          await writeOutageRecoveryStatus({...prev,...progress,...processing,status:"RUNNING",jobId});
        },runtime);

        const queueIds=[...new Set((runtime.queuedIds||[]).map(String).filter(Boolean))];
        let processing=await outageRecoveryProcessingSnapshot(queueIds,jobId);
        let timedOut=false;
        const monitorStarted=Date.now();
        while(processing.queueRemaining>0 && Date.now()-monitorStarted<30*60*1000){
          const prev=await readOutageRecoveryStatus();
          if(String(prev?.jobId||"")!==jobId)return;
          await writeOutageRecoveryStatus({...prev,...result,...processing,status:"RUNNING",stage:"PROCESSING_QUEUE",jobId,message:`معالجة الطابور ${processing.queueHandled}/${processing.queueTotal} — باقي ${processing.queueRemaining}`});
          await new Promise(resolve=>setTimeout(resolve,1200));
          processing=await outageRecoveryProcessingSnapshot(queueIds,jobId);
        }
        if(processing.queueRemaining>0)timedOut=true;
        const prev=await readOutageRecoveryStatus();
        const warningCount=Number(result.errorCount||0)+Number(processing.queueFailed||0)+Number(processing.queueErrors||0)+(timedOut?1:0);
        const finalStatus=(warningCount||result.truncated)?"COMPLETED_WITH_WARNINGS":"COMPLETED";
        await writeOutageRecoveryStatus({...prev,...result,...processing,status:finalStatus,stage:"DONE",jobId,processingTimedOut:timedOut,warningCount,completedAt:new Date().toISOString(),message:timedOut?`انتهى الفحص وبقي ${processing.queueRemaining} حدث في الطابور بعد مهلة المتابعة`:`اكتمل الفحص ومعالجة الطابور`});
      }catch(error){
        const prev=await readOutageRecoveryStatus();
        await writeOutageRecoveryStatus({...prev,status:"FAILED",stage:"FAILED",jobId,completedAt:new Date().toISOString(),error:String(error?.message||error)}).catch(()=>{});
      }
    });
    return {ok:true,started:true,message:"بدأ استرجاع فترة الانقطاع بالخلفية. يمكنك إبقاء الصفحة مفتوحة وستظهر النتيجة تلقائيًا.",recovery:base};
  }

  async function login(identifier,password,wantCaptain){
    if(wantCaptain){
      const maintenance=await getCaptainSiteMaintenanceState();
      if(maintenance.enabled)return {ok:false,maintenance:true,maintenanceState:maintenance,message:"موقع الكباتن في وضع الصيانة"};
    }
    const rawIdentifier=String(identifier||"").trim();
    const secret=String(password||"");
    let user=null;
    if(wantCaptain){
      const digits=rawIdentifier.replace(/[^0-9]/g,"");
      const last9=digits.slice(-9);
      const phoneLike=/^7[789][0-9]{7}$/.test(last9) && digits.length>=9 && digits.length<=13;
      const candidates=phoneLike
        ?(await db.query(`
          SELECT DISTINCT u.id,u.username,u.password_hash,u.role,u.captain_id,u.is_active
          FROM users u LEFT JOIN captains c ON c.id=u.captain_id
          WHERE u.role='captain' AND (
            u.username=$1
            OR RIGHT(regexp_replace(u.username,'[^0-9]','','g'),9)=$2
            OR RIGHT(regexp_replace(COALESCE(c.phone,''),'[^0-9]','','g'),9)=$2
          )
          ORDER BY u.id DESC LIMIT 30
        `,[rawIdentifier,last9])).rows
        :(await db.query(`
          SELECT id,username,password_hash,role,captain_id,is_active
          FROM users WHERE username=$1 AND role='captain' LIMIT 1
        `,[rawIdentifier])).rows;
      // Do not select an arbitrary historical account with a matching phone.
      // Match the password against active accounts; ambiguous matching accounts
      // are refused rather than silently logging into the wrong captain wallet.
      const matching=[];
      for(const candidate of candidates){
        if(!candidate.is_active)continue;
        if(await bcrypt.compare(secret,candidate.password_hash))matching.push(candidate);
      }
      const owners=new Set(matching.map(x=>String(x.captain_id||"")));
      if(owners.size===1)user=matching.find(x=>x.username===rawIdentifier)||matching[0];
    }else{
      user=await findUserByUsername(rawIdentifier);
      if(!user||!["admin","accountant"].includes(user.role)||!user.is_active||!(await bcrypt.compare(secret,user.password_hash)))user=null;
    }
    if(!user)throw new Error("بيانات الدخول غير صحيحة");
    await touchUserLogin(user.id);
    const token=app.jwt.sign({
      sub:String(user.id),role:user.role,captainId:user.captain_id||null,username:user.username
    },{expiresIn:"12h"});
    if(wantCaptain){
      const cap=await getCaptainProfile(user.captain_id);
      return {ok:true,token,role:"CAPTAIN",mustChangePassword:false,user:legacyCaptain(cap||{})};
    }
    return {ok:true,token,role:"ACCOUNTANT",user:{id:String(user.id),name:user.username,username:user.username}};
  }

  async function accountantBootstrap(token){
    const me=await verify(token,["admin","accountant"]);
    const caps=await listCaptains("");
    const captains=caps.map(legacyCaptain);
    const cleanStart=await getCleanStartState();
    const captainMaintenance=await getCaptainSiteMaintenanceState();
    const cleanStartAt=cleanStart.status==="COMPLETED"?cleanStart.resetAt:null;
    const nameById=Object.fromEntries(caps.map(c=>[String(c.id),c.name]));
    const txr=await db.query(`
      WITH x AS (
        SELECT le.*,
          SUM(le.amount) OVER (PARTITION BY le.captain_id ORDER BY le.created_at ASC,le.id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS computed_balance_after
        FROM ledger_entries le
      )
      SELECT x.*,(x.computed_balance_after-x.amount) AS computed_balance_before
      FROM x
      WHERE ($1::timestamptz IS NULL OR x.created_at >= $1::timestamptz OR (x.entry_type='RECHARGE' AND x.reversed_at IS NULL))
        AND x.entry_type<>'CLEAN_START_RESET'
      ORDER BY x.created_at DESC,x.id DESC LIMIT 500
    `,[cleanStartAt]);
    const participantMap=await ledgerParticipantMap(txr.rows);
    const transactions=txr.rows.map(e=>legacyTx(e,nameById[String(e.captain_id)]||"",participantMap.get(ledgerDoneId(e))||{}));
    const cr=await listRechargeCodes({limit:150});
    const codes=cr.map(c=>({
      ID:String(c.id),Code:c.code,BalanceValue:Number(c.amount),Status:
      c.status==="active"?"UNUSED":c.status==="used"?"USED":"CANCELLED",
      IssuedAt:iso(c.created_at),UsedAt:iso(c.used_at),
      CaptainName:c.assigned_captain_name||c.used_by_captain_name||""
    }));
    // Repair any stale `due` settlement whose committed Friday debit already
    // exists before the bootstrap is exposed to the browser. This makes the
    // database authoritative across refreshes, tabs and devices.
    await reconcileFridaySettlementStates();
    const wss=await listWeeklySettlements();
    const weeklySettlements=[];
    for(const s of wss.slice(0,20)){
      const items=await getWeeklySettlementItems(s.id,"");
      for(const x of items){
        weeklySettlements.push({
          ID:String(x.id),SettlementID:String(s.id),SettlementBatchID:String(s.id),CaptainID:String(x.captain_id),
          CaptainName:x.captain_name,Phone:x.captain_phone||"",
          PayoutName:x.payout_name||"",PayoutMethod:x.payout_method||"",PayoutIdentifier:x.payout_identifier||"",
          WeekStart:String(s.week_start).slice(0,10),WeekEnd:String(s.week_end).slice(0,10),
          ProductionAmount:Number(x.production||0),ConsumptionAmount:Number(x.consumption||0),NetAmount:Number(x.net||0),
          AmountDue:Number(x.amount_due ?? x.net ?? 0),ReserveAmount:Number(x.reserve_amount||0),
          BalanceBefore:Number(x.balance_before||0),BalanceAfter:Number(x.balance_after||0),
          PaidAmount:String(x.status||"").toLowerCase()==="transferred"?Number(x.amount_due ?? x.net ?? 0):0,
          Status:legacySettlementStatus(x),PaymentNote:x.payment_note||"",FridayDebitEntryID:x.friday_debit_entry_id?String(x.friday_debit_entry_id):"",
          PreparedAt:iso(x.created_at),PaidAt:iso(x.transferred_at)
        });
      }
    }
    const audits=await db.query(`
      SELECT a.*,u.username FROM audit_logs a
      LEFT JOIN users u ON u.id=a.user_id
      ORDER BY a.created_at DESC LIMIT 150
    `);
    const auditLog=audits.rows.map(a=>({
      ID:String(a.id),Role:"ACCOUNTANT",UserID:String(a.user_id||""),
      Username:a.username||"",Action:a.action,Details:JSON.stringify(a.details||{}),
      CreatedAt:iso(a.created_at)
    }));
    const stats={
      totalCaptains:captains.length,
      activeCaptains:captains.filter(x=>x.status==="ACTIVE").length,
      frozenCaptains:captains.filter(x=>x.status==="FROZEN").length,
      disabledCaptains:captains.filter(x=>x.status==="DISABLED").length,
      pendingTransfers:0,pendingWhatsApp:0,openSystemIssues:0,criticalSystemIssues:0,
      pendingFridaySettlements:weeklySettlements.filter(x=>x.Status==="PENDING").length,
      pendingFridayAmount:weeklySettlements.filter(x=>x.Status==="PENDING").reduce((s,x)=>s+Number(x.AmountDue||0),0),
      totalBalances:captains.reduce((s,x)=>s+Number(x.balance||0),0)
    };
    const f=await detailStep("FEATURE_BOOTSTRAP",featureBootstrap());
    stats.pendingTransfers=f.transfers.filter(x=>x.Status==="PENDING").length;
    stats.pendingWhatsApp=f.pendingMovements.filter(x=>["PENDING","PROCESSING"].includes(x.Status)).length;
    stats.openSystemIssues=f.systemIssues.filter(x=>["OPEN","IN_REVIEW"].includes(x.Status)).length;
    stats.criticalSystemIssues=f.systemIssues.filter(x=>["OPEN","IN_REVIEW"].includes(x.Status)&&x.Severity==="CRITICAL").length;
    const [preview,inventory,weeklyComparison,accountingMode,unregisteredQ]=await Promise.all([
      detailStep("FRIDAY_PREVIEW",fridayPreview()),
      detailStep("INVENTORY_SNAPSHOT",inventorySnapshotFromLedger(caps,cleanStartAt)),
      detailStep("WEEKLY_COMPARISON",currentWeekComparisonFromLedger(caps,cleanStartAt)),
      detailStep("ACCOUNTING_MODE",getAccountingMode()),
      detailStep("UNREGISTERED_NUMBERS",db.query(`WITH u AS (
        SELECT regexp_replace(COALESCE(sender_id,''),'[^0-9]','','g') digits,
          MAX(COALESCE(sender_name,'')) sender_name,COUNT(*)::int attempt_count,
          (ARRAY_AGG(COALESCE(message_text,'') ORDER BY webhook_received_at DESC))[1] last_message,
          MAX(webhook_received_at) last_attempt_at
        FROM whatsapp_events WHERE status='blocked' AND last_error='رقم غير مسجل' AND COALESCE(sender_id,'') NOT LIKE '%@lid'
        GROUP BY regexp_replace(COALESCE(sender_id,''),'[^0-9]','','g')
      ) SELECT u.*,
        EXISTS(SELECT 1 FROM captains c WHERE RIGHT(regexp_replace(c.phone,'[^0-9]','','g'),9)=RIGHT(u.digits,9)) registered
      FROM u WHERE u.digits<>'' ORDER BY last_attempt_at DESC LIMIT 500`))
    ]);
    const unregisteredAttempts=unregisteredQ.rows.map(x=>({
      Phone:rightPhone(x.digits),SenderName:x.sender_name||'',AttemptCount:Number(x.attempt_count||0),LastMessage:x.last_message||'',LastAttemptAt:iso(x.last_attempt_at),Status:x.registered?'REGISTERED':'OPEN'
    }));
    return {
      ok:true,me:{id:String(me.sub),username:me.username,role:me.role},stats,captains,
      transfers:f.transfers,transactions,codes,inventory,pendingMovements:f.pendingMovements,whatsappMessages:f.whatsappMessages,
      systemIssues:f.systemIssues,auditLog,reactionPairs:f.reactionPairs,cancellationNumbers:f.cancellationNumbers,reactionCancellations:f.reactionCancellations,
      unregisteredAttempts,fridaySnapshots:[],
      fridayPreview:preview,fridayGroupSession:f.fridayGroupSession,cancelledOrders:f.cancelledOrders,weeklySettlements,
      weeklyComparison,greenApi:f.greenApi,groupGuide:f.groupGuide,safety:{ok:true},
      inventoryReconciliation:await detailStep("DAILY_INVENTORY",getDailyInventoryComparison(dateKey(new Date()))),
      cleanStart,captainMaintenance,
      config:{ok:true,...CFG,accountingMode,cleanStart}
    };
  }

  // V3.8.5 LOGIN PRIORITY HOTFIX
  // Login must never wait for the very heavy accountant/captain bootstrap.
  // These fast bootstraps validate the fresh JWT and return only the minimum
  // data required to open the UI; the full payload is loaded in background.
  async function accountantBootstrapFast(token){
    const me=await verify(token,["admin","accountant"]);
    const [cleanStart,accountingMode,captainMaintenance]=await Promise.all([getCleanStartState(),getAccountingMode(),getCaptainSiteMaintenanceState()]);
    return {
      ok:true,
      me:{id:String(me.sub),username:me.username,role:me.role},
      stats:{},
      cleanStart,
      captainMaintenance,
      config:{ok:true,...CFG,accountingMode,cleanStart},
      loginFast:true
    };
  }

  async function captainBootstrapFast(token){
    const me=await verify(token,["captain"]);
    const c=await getCaptainProfile(me.captainId);
    if(!c) throw new Error("الحساب غير موجود");
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    return {
      ok:true,
      captain:legacyCaptain(c),
      transactions:[],currentWeekTransactions:[],transfers:[],weeklySettlements:[],
      fridaySnapshots:[],lastFridaySnapshot:null,partialCancellations:[],
      dashboardSummary:{todayKey:today,today:{production:0,consumption:0,orders:0,passengers:0,movements:0},week:{production:0,consumption:0,orders:0,passengers:0,movements:0}},
      whatsappStatuses:[],disputes:[],notifications:[],unreadNotifications:0,alerts:[],
      config:{ok:true,...CFG},
      loginFast:true
    };
  }

  async function captainBootstrap(token){
    const me=await verify(token,["captain"]);
    const c=await getCaptainProfile(me.captainId);
    if(!c) throw new Error("الحساب غير موجود");
    const cleanStartAt=await getCleanStartOperationalCutover();
    const entries=(await db.query(`
      WITH x AS (
        SELECT le.*,
          SUM(le.amount) OVER (ORDER BY le.created_at ASC,le.id ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS computed_balance_after
        FROM ledger_entries le WHERE le.captain_id=$1
      )
      SELECT x.*,(x.computed_balance_after-x.amount) AS computed_balance_before
      FROM x ORDER BY x.created_at DESC,x.id DESC LIMIT 1000
    `,[me.captainId])).rows;
    // Captain privacy/clarity: migration opening/final-balance adjustment entries are
    // accounting internals. Keep them in PostgreSQL and accountant views, but never
    // expose them as captain movements. The captain's current balance remains unchanged.
    const captainEntries=entries.filter(e=>{
      const referenceType=String(e.reference_type||'').toLowerCase();
      const entryType=String(e.entry_type||'').toUpperCase();
      const description=String(e.description||'');
      if(entryType==='CLEAN_START_RESET')return false;
      if(cleanStartAt&&new Date(e.created_at)<new Date(cleanStartAt)&&entryType!=='RECHARGE')return false;
      if(referenceType==='migration_balance')return false;
      if(entryType==='MIGRATION_BALANCE_ADJUSTMENT')return false;
      if(entryType==='REVERSAL'||entryType==='FRIDAY_SETTLEMENT'||e.reversed_at)return false;
      if(/(?:رصيد\s*افتتاحي\s*\/\s*تسوية\s*نهائية\s*من\s*Google\s*Apps\s*Script|تسوية\s*نهائية\s*من\s*Google\s*Apps\s*Script|migration\s*balance\s*adjustment)/i.test(description))return false;
      return true;
    });
    const participantMap=await ledgerParticipantMap(captainEntries);
    const transactions=captainEntries.map(e=>legacyTx(e,c.name,participantMap.get(ledgerDoneId(e))||{}));
    const currentWeek=await currentWeekCaptainLedger(me.captainId,cleanStartAt);
    const weekParticipantMap=await ledgerParticipantMap(currentWeek.entries);
    const currentWeekTransactions=currentWeek.entries.map(e=>{
      const tx=legacyTx(e,c.name,weekParticipantMap.get(ledgerDoneId(e))||{});
      tx.CreatedAt=iso(e.effective_at||e.created_at);
      return tx;
    });
    const summary=await getCaptainSummary(me.captainId);
    const settlements=await db.query(`
      SELECT wsi.*,ws.week_start,ws.week_end FROM weekly_settlement_items wsi
      JOIN weekly_settlements ws ON ws.id=wsi.settlement_id
      WHERE wsi.captain_id=$1
        AND ($2::timestamptz IS NULL OR ws.created_at >= $2::timestamptz)
      ORDER BY ws.week_end DESC LIMIT 200
    `,[me.captainId,cleanStartAt]);
    const weeklySettlements=settlements.rows.map(x=>({
      ID:String(x.id),CaptainID:String(x.captain_id),CaptainName:c.name,
      WeekStart:String(x.week_start).slice(0,10),WeekEnd:String(x.week_end).slice(0,10),
      ProductionAmount:Number(x.production||0),ConsumptionAmount:Number(x.consumption||0),NetAmount:Number(x.net||0),
      AmountDue:Number(x.amount_due ?? x.net ?? 0),ReserveAmount:Number(x.reserve_amount||0),
      BalanceBefore:Number(x.balance_before||0),BalanceAfter:Number(x.balance_after||0),
      PaidAmount:String(x.status||"").toLowerCase()==="transferred"?Number(x.amount_due ?? x.net ?? 0):0,
      Status:legacySettlementStatus(x),PaymentNote:x.payment_note||"",FridayDebitEntryID:x.friday_debit_entry_id?String(x.friday_debit_entry_id):"",
      PreparedAt:iso(x.created_at),PaidAt:iso(x.transferred_at)
    }));
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const todayTx=transactions.filter(x=>String(x.AccountingDate||'')===today);
    const periodSummary=arr=>({
      production:arr.filter(x=>x.Direction==="PRODUCTION").reduce((s,x)=>s+Number(x.TotalCommission||0),0),
      consumption:arr.filter(x=>x.Direction==="CONSUMPTION").reduce((s,x)=>s+Number(x.TotalCommission||0),0),
      orders:arr.filter(x=>x.Type==="ORDER").reduce((s,x)=>s+Number(x.WorkloadQuantity??x.Quantity??0),0),
      passengers:arr.filter(x=>x.Type==="PASSENGER").reduce((s,x)=>s+Number(x.WorkloadQuantity??x.Quantity??0),0),
      movements:arr.filter(x=>x.Type==="ORDER"||x.Type==="PASSENGER").reduce((s,x)=>s+Number(x.WorkloadQuantity??x.Quantity??0),0)
    });
    const f=await captainFeatureBootstrap(me.captainId);
    const latestSettlement=settlements.rows[0]||null;
    const lastFridaySnapshot=latestSettlement?{
      ID:String(latestSettlement.id),CaptainID:String(latestSettlement.captain_id),CaptainName:c.name,
      WeekStart:String(latestSettlement.week_start).slice(0,10),WeekEnd:String(latestSettlement.week_end).slice(0,10),
      Classification:Number(latestSettlement.net||0)>0?'PRODUCER':((Number(latestSettlement.production||0)>0||Number(latestSettlement.consumption||0)>0)?'CONSUMER':'NO_ACTIVITY'),
      Production:Number(latestSettlement.production||0),Consumption:Number(latestSettlement.consumption||0),NetAmount:Number(latestSettlement.net||0),
      AmountDue:Number(latestSettlement.amount_due||0),ReserveAmount:Number(latestSettlement.reserve_amount||1.5),BalanceBefore:Number(latestSettlement.balance_before||0),BalanceAfter:Number(latestSettlement.balance_after||0),MovementCount:Number(latestSettlement.movement_count||0),
      Status:legacySettlementStatus(latestSettlement),PaymentNote:latestSettlement.payment_note||"",FridayDebitEntryID:latestSettlement.friday_debit_entry_id?String(latestSettlement.friday_debit_entry_id):"",CreatedAt:iso(latestSettlement.created_at),PaidAt:iso(latestSettlement.transferred_at)
    }:null;
    return {
      ok:true,captain:legacyCaptain(c),transactions,currentWeekTransactions,
      transfers:f.transfers,weeklySettlements,fridaySnapshots:lastFridaySnapshot?[lastFridaySnapshot]:[],lastFridaySnapshot,
      partialCancellations:f.partialCancellations||[],
      dashboardSummary:{todayKey:today,weekStart:currentWeek.start.toISOString(),weekEnd:currentWeek.end.toISOString(),today:periodSummary(todayTx),week:periodSummary(currentWeekTransactions)},
      whatsappStatuses:[],disputes:[],notifications:[],unreadNotifications:0,alerts:[],
      config:{ok:true,...CFG}
    };
  }

  async function automaticFridayCloseAndCommit(me){
    const session=await startFridaySession(me.sub,me.username);
    if(session.lastError){
      await forceOpenFriday(me.sub).catch(()=>{});
      throw new Error(`تعذر إغلاق القروب بأمان؛ لم يتم ترحيل الجمعة: ${session.lastError}`);
    }
    const deadline=Date.now()+Math.min(120000,Number(process.env.FRIDAY_DRAIN_TIMEOUT_MS||45000));
    let counts=await whatsappQueue.getJobCounts('waiting','active','delayed');
    while((Number(counts.waiting||0)+Number(counts.active||0)+Number(counts.delayed||0))>0 && Date.now()<deadline){await new Promise(r=>setTimeout(r,500));counts=await whatsappQueue.getJobCounts('waiting','active','delayed')}
    if((Number(counts.waiting||0)+Number(counts.active||0)+Number(counts.delayed||0))>0){
      await forceOpenFriday(me.sub).catch(()=>{});
      throw new Error(`تم فتح القروب بدون ترحيل لأن ${Number(counts.waiting||0)+Number(counts.active||0)+Number(counts.delayed||0)} حدثًا سابقًا للفاصل ما زال بالطابور`);
    }
    return await commitFriday(me.sub);
  }

  return async function legacyRpc(method,args=[]){
    const retiredCleanStartMethods=new Set([
      "applyFullMigrationStep","resetFullMigrationApply",
      "startCurrentFridayFullRebuild","startCorrectedFridayFullRebuild",
      "stabilizeCurrentFridayFullRebuild","resumeCurrentFridayFullRebuild",
      "startLiveCutoverAndFridayRepair","recoverRecentGreenGroupHistory",
      "reprocessPreviousWhatsAppMessages","runLast3DaysGreenAuditNow",
      "repairAllWeeklyFloors","reconcilePreviousWeekMixed40","repairAllCancelledInventory",
      "setWhatsappReliabilityMode","drainGreenWebhookQueueNow"
    ]);
    if(retiredCleanStartMethods.has(String(method||""))){
      await verify(args[0],["admin","accountant"]);
      throw Object.assign(new Error("تم إلغاء هذه الأداة في إصدار البداية الجديدة؛ استخدم صفحة «البداية الجديدة» فقط"),{statusCode:410});
    }
    // Password change is optional for captains in Al Safeer.
    if(!["loginCaptain","loginAccountant","logout"].includes(method)){
      let identity=null;
      try{identity=app.jwt.verify(String(args?.[0]||""))}catch{}
      if(identity?.delegated){
        const permission=DELEGATED_METHODS[method];
        if(!permission)throw new Error("هذه العملية غير مخوّلة لحساب الكابتن");
        const granted=await delegatedPermissions(identity.captainId);
        if((permission==="overview" ? granted.length===0 : !granted.includes(permission)))throw new Error("ليس لديك صلاحية هذا القسم");
        await verify(args[0],["accountant"]);
      }
    }
    switch(method){
      case "getWeeklyParticipantsReport": { await verify(args[0],["admin","accountant"]); return weeklyParticipantsReport(); }
      case "getCaptainWithdrawalData": { const me=await verify(args[0],["captain"]); return captainWithdrawalData(me.captainId); }
      case "requestCaptainWithdrawal": { const me=await verify(args[0],["captain"]); return requestCaptainWithdrawal(me.captainId,args[1]); }
      case "markWithdrawalAnnouncementSeen": { const me=await verify(args[0],["captain"]); return markWithdrawalAnnouncementSeen(me.captainId); }
      case "getWithdrawalControl": { await verify(args[0],["admin","accountant"]); return getWithdrawalControl(); }
      case "setWithdrawalControl": { const me=await verify(args[0],["admin"]); if(me.delegated)throw Error("غير مصرح"); return setWithdrawalControl(args[1]===true); }
      case "saveCaptainCliq": { const me=await verify(args[0],["captain"]); return saveCaptainCliq(me.captainId,args[1],args[2]); }
      case "adminUpdateCaptainCliq": { const me=await verify(args[0],["admin"]); if(me.delegated)throw Error("غير مصرح"); return adminUpdateCaptainCliq(args[1],args[2],args[3]); }
      case "listWithdrawalClassifications": { await verify(args[0],["admin","accountant"]); return listWithdrawalClassifications(); }
      case "getAccountantWithdrawalData": { await verify(args[0],["admin","accountant"]); return accountantWithdrawalData(); }
      case "reviewCaptainWithdrawal": { const me=await verify(args[0],["admin","accountant"]); return reviewWithdrawal(args[1],args[2],me.sub,args[3]); }

      case "getCaptainSiteMaintenanceStatus":
        return {ok:true,maintenance:await getCaptainSiteMaintenanceState()};
      case "loginAccountant": return login(args[0],args[1],false);
      case "loginCaptain": return login(args[0],args[1],true);
      case "logout": return {ok:true};
      case "accountantBootstrap": {const u=app.jwt.verify(String(args[0]));const data=await accountantBootstrap(args[0]);return u.delegated?scopedDelegateData(data,await delegatedPermissions(u.captainId)):data;}
      case "accountantBootstrapFast": {const data=await accountantBootstrapFast(args[0]);const u=app.jwt.verify(String(args[0]));return u.delegated?scopedDelegateData(data,await delegatedPermissions(u.captainId)):data;}
      case "captainBootstrap": return captainBootstrap(args[0]);
      case "captainBootstrapFast": return captainBootstrapFast(args[0]);



      case "listManualBroadcastGroups": {
        await verify(args[0],["admin"]);
        const base=String(process.env.DROPCODE_API_URL||"").replace(/\/$/,""),key=String(process.env.DROPCODE_API_KEY||""),session=String(process.env.DROPCODE_SESSION||"").trim().toLowerCase();
        if(!base||!key||!session)throw Error("إعدادات DropConnect غير مكتملة");
        const response=await fetch(base+"/api/"+encodeURIComponent(session)+"/groups",{headers:{"X-Api-Key":key},signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw Error("تعذر تحميل القروبات: DropConnect HTTP "+response.status+" — تأكد من معرّف جلسة السفير وصلاحية المفتاح");
        const data=await response.json(),groups=Array.isArray(data)?data:Array.isArray(data.groups)?data.groups:[];
        return groups.filter(g=>/^[0-9-]+@g\.us$/.test(String(g.id||""))).map(g=>({id:String(g.id),name:String(g.subject||g.name||g.id)}));
      }
      case "sendManualBroadcast": {
        const me=await verify(args[0],["admin"]);if(me.delegated)throw Error("الإرسال متاح للإدارة الرئيسية فقط");
        const groupId=String(args[1]||""),message=String(args[2]||"").trim();
        if(!/^[0-9-]+@g\.us$/.test(groupId)||!message||message.length>4000)throw Error("اختر قروبًا واكتب رسالة لا تتجاوز 4000 حرف");
        const base=String(process.env.DROPCODE_API_URL||"").replace(/\/$/,""),key=String(process.env.DROPCODE_API_KEY||""),session=String(process.env.DROPCODE_SESSION||"");
        if(!base||!key||!session)throw Error("إعدادات DropConnect غير مكتملة");
        const headers={"X-Api-Key":key,"Content-Type":"application/json"};
        const groupsResponse=await fetch(base+"/api/"+encodeURIComponent(session)+"/groups",{headers,signal:AbortSignal.timeout(15000)});
        if(!groupsResponse.ok)throw Error("تعذر التحقق من القروب");
        const source=await groupsResponse.json(),groups=Array.isArray(source)?source:Array.isArray(source.groups)?source.groups:[];
        if(!groups.some(g=>String(g.id)===groupId))throw Error("القروب غير موجود في جلسة واتساب الحالية");
        const response=await fetch(base+"/api/sendText",{method:"POST",headers,body:JSON.stringify({session,chatId:groupId,text:message}),signal:AbortSignal.timeout(25000)});
        if(!response.ok)throw Error("فشل إرسال الرسالة إلى القروب");
        const result=await response.json().catch(()=>({}));if(result.ok===false)throw Error("رفض DropConnect إرسال الرسالة");
        await audit(me.sub,"whatsapp.manual_group_broadcast","whatsapp_group",groupId,{length:message.length}).catch(()=>{});
        return {ok:true};
      }
      case "getNorthGroupForImport":{
        await verify(args[0],["admin"]);
        const base=String(process.env.DROPCODE_API_URL||"").replace(/\/$/,"");
        const key=String(process.env.DROPCODE_API_KEY||"");
        const session=String(process.env.DROPCODE_SESSION||"ebsher1test").toLowerCase();
        if(!base||!key||session!=="ebsher1test")throw new Error("جلسة شمال في DropConnect غير مضبوطة بأمان");
        const response=await fetch(base+"/api/"+encodeURIComponent(session)+"/groups",{headers:{"X-Api-Key":key},signal:AbortSignal.timeout(15000)});
        if(!response.ok)throw new Error("تعذر قراءة قروبات شمال من DropConnect");
        const source=await response.json();
        const groups=Array.isArray(source)?source:Array.isArray(source?.groups)?source.groups:[];
        const allowed=groups.filter(g=>/شمال/.test(String(g.subject||g.name||""))&&/^[\d-]+@g\.us$/.test(String(g.id||"")));
        return {ok:true,groups:allowed.map(g=>({id:g.id,name:String(g.subject||g.name)}))};
      }
      case "addNorthGroupSelectedFromImport":{
        const me=await verify(args[0],["admin"]);
        const p=args[1]||{}, groupId=String(p.groupId||"");
        const selected=Array.isArray(p.phones)?p.phones:[];
        if(!selected.length||selected.length>10)throw new Error("اختر من 1 إلى 10 أرقام في كل دفعة");
        const phones=selected.map(x=>String(x||"").replace(/\D/g,"").slice(-9));
        if(phones.some(x=>!/^7[789][0-9]{7}$/.test(x))||new Set(phones).size!==phones.length)throw new Error("أرقام غير صالحة أو مكررة");
        const preview=await inspectOldScriptBalances(p.rows);
        const eligible=new Set(preview.rows.filter(x=>x.status==="UNMATCHED").map(x=>x.phone));
        if(phones.some(x=>!eligible.has(x)))throw new Error("بعض الأرقام ليست من قائمة غير المسجلين أو مكررة");
        const base=String(process.env.DROPCODE_API_URL||"").replace(/\/$/,"");
        const key=String(process.env.DROPCODE_API_KEY||"");
        const session=String(process.env.DROPCODE_SESSION||"ebsher1test").toLowerCase();
        if(!base||!key||session!=="ebsher1test")throw new Error("إعدادات جلسة شمال غير مكتملة");
        const headers={"X-Api-Key":key,"Content-Type":"application/json"};
        const groupsReply=await fetch(base+"/api/"+encodeURIComponent(session)+"/groups",{headers,signal:AbortSignal.timeout(15000)});
        if(!groupsReply.ok)throw new Error("فشل التحقق من قروب شمال");
        const gData=await groupsReply.json(), groups=Array.isArray(gData)?gData:gData.groups||[];
        const group=groups.find(g=>String(g.id)===groupId&&/شمال/.test(String(g.subject||g.name||"")));
        if(!group)throw new Error("القروب غير معتمد ضمن جلسة شمال");
        const results=[];
        for(const phone of phones){
          try{
            const response=await fetch(base+"/api/"+encodeURIComponent(session)+"/groups/"+encodeURIComponent(groupId)+"/participants/add",{
              method:"POST",headers,body:JSON.stringify({participants:["962"+phone+"@s.whatsapp.net"]}),signal:AbortSignal.timeout(25000)
            });
            const data=await response.json().catch(()=>({}));
            const detail=Array.isArray(data)?data[0]:null;
            const code=Number(detail?.status||0);
            const ok=response.ok&&(code===200||code===201||code===409);
            results.push({phone,ok,status:code||response.status,message:ok?"تم إرسال الإضافة؛ تحقق من العضوية":"تعذر الإضافة أو الخصوصية تمنع"});
          }catch(e){results.push({phone,ok:false,status:0,message:String(e.message||e).slice(0,150)})}
        }
        await audit(me.sub,"north.group.import_invites","captains",null,{groupId,results}).catch(()=>{});
        return {ok:true,results,groupId};
      }
      case "previewOldScriptBalances":{
        await verify(args[0],["admin","accountant"]);
        return inspectOldScriptBalances(args[1]);
      }
      case "applyOldScriptBalances":{
        const me=await verify(args[0],["admin"]);
        const payload=args[1]||{};
        if(payload.confirm!=="REPLACE_OLD_SCRIPT_BALANCES")throw new Error("تأكيد الاستبدال مطلوب");
        const preview=await inspectOldScriptBalances(payload.rows);
        if(preview.previewId!==payload.previewId)throw new Error("تغيّرت مطابقة الكباتن؛ أعد المعاينة قبل الاستيراد");
        if(!preview.stats.matched&&!preview.stats.unmatched)throw new Error("لا توجد أرقام صالحة للاستيراد");
        const candidates=preview.rows.filter(r=>r.status==="MATCHED"||r.status==="UNMATCHED");
        const client=await db.connect();
        try{
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('ABSHIR_OLD_SCRIPT_BALANCE_IMPORT'))");
          const done=await client.query("SELECT id FROM audit_logs WHERE action='captain.old_script_balance_import' AND details->>'importId'=$1 LIMIT 1",[preview.importId]);
          if(done.rowCount)throw new Error("تم استيراد هذا الملف سابقًا؛ لن نكرره");
          const ids=candidates.filter(r=>r.captainId).map(r=>r.captainId).sort((a,b)=>Number(a)-Number(b));
          await client.query("SELECT id FROM captains WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE",[ids]);
          let changed=0,unchanged=0,created=0;
          for(const r of candidates){
            let captainId=r.captainId;
            if(r.status==="UNMATCHED"){
              // Imported file contains phone/balance only: use a clearly marked placeholder name.
              const phone="0"+r.phone;
              const existing=await client.query("SELECT id FROM captains WHERE RIGHT(regexp_replace(phone,'[^0-9]','','g'),9)=$1 ORDER BY id FOR UPDATE",[r.phone]);
              if(existing.rowCount)throw new Error("تغيّرت مطابقة الرقم "+phone+"، أعد المعاينة");
              const inserted=await client.query(
                "INSERT INTO captains(name,phone,notes) VALUES($1,$2,$3) ON CONFLICT(phone) DO NOTHING RETURNING id",
                ["كابتن مستورد "+phone,phone,"مستورد من أرصدة أبشر Script القديم — يحتاج استكمال الاسم وتسجيل الدخول"]
              );
              if(!inserted.rowCount)throw new Error("الرقم موجود بالفعل، أعد المعاينة: "+phone);
              captainId=String(inserted.rows[0].id);
              created++;
            }
            const current=Number(await getBalance(captainId,client));
            // Use the latest balance under transaction lock so live ledger movement does not invalidate the entire reviewed batch.
            const delta=Number((r.balance-current).toFixed(3));
            if(Math.abs(delta)<0.0005){unchanged++;continue;}
            await client.query(`INSERT INTO ledger_entries(
              captain_id,amount,entry_type,direction,reference_type,reference_id,
              description,metadata,created_by_user_id
            ) VALUES($1,$2,$3,$4,'old_script_balance_import',$5,$6,$7::jsonb,$8)`,[
              captainId,delta,delta>0?'MANUAL_CREDIT':'MANUAL_DEBIT',delta>0?'credit':'debit',
              'SCRIPT-'+preview.importId.slice(0,18)+'-'+captainId,
              'استبدال الرصيد النهائي من أبشر Script القديم: '+current.toFixed(3)+' ← '+r.balance.toFixed(3),
              JSON.stringify({type:'BALANCE_SET',source:'OLD_GOOGLE_APPS_SCRIPT',importId:preview.importId,balanceBefore:current,targetBalance:r.balance,difference:delta}),
              me.sub
            ]);
            const after=Number(await getBalance(captainId,client));
            if(Math.abs(after-r.balance)>0.0005)throw new Error("فشل التحقق من رصيد "+r.phone);
            changed++;
          }
          await client.query(`INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
            VALUES($1,'captain.old_script_balance_import','captains',NULL,$2::jsonb)`,[
            me.sub,JSON.stringify({importId:preview.importId,total:preview.stats.total,matched:preview.stats.matched,created,changed,unchanged,skipped:preview.stats.total-candidates.length})
          ]);
          await client.query("COMMIT");
          return {ok:true,importId:preview.importId,matched:preview.stats.matched,created,changed,unchanged,skipped:preview.stats.total-candidates.length};
        }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
      }

      case "exportCaptainBalances":{
        const me=await verify(args[0],["admin","accountant"]);
        const caps=await listCaptains("");
        const exportedAt=new Date().toISOString();
        const captains=caps.map(c=>({
          CaptainID:String(c.id),
          Phone:String(c.phone||""),
          CaptainName:String(c.name||""),
          Balance:Number(c.balance||0),
          Status:legacyStatus(c.status)
        }));
        await audit(me.sub,"captain_balances.export","captains",null,{count:captains.length,exportedAt}).catch(()=>{});
        return {ok:true,exportedAt,count:captains.length,captains};
      }

      case "getCleanStartControl":{
        await verify(args[0],["admin","accountant"]);
        const [preview,control]=await Promise.all([previewRechargeOnlyCleanStart(),getCleanStartControlState()]);
        return {ok:true,preview,control};
      }
      case "executeRechargeOnlyCleanStart":{
        const me=await verify(args[0],["admin","accountant"]);
        const queueState=await prepareRechargeOnlyCleanStart();
        try{
          const result=await executeRechargeOnlyCleanStart({userId:me.sub,confirmation:args[1]});
          const resumed=await startCleanStartLive({userId:me.sub});
          return {ok:true,message:`تمت إعادة بناء الأرصدة بنجاح (الدورة ${Number(result.resetCount||result.state?.resetCount||1)}): بقي الشحن المنفذ فقط، والجرد التلقائي عاد LIVE تلقائيًا`,result,queueState,resumed,control:await getCleanStartControlState()};
        }catch(error){
          // Never leave LIVE paused if a reset attempt fails.
          await startCleanStartLive({userId:me.sub}).catch(()=>{});
          throw error;
        }
      }
      case "zeroAllCaptainBalancesSilently":{
        const me=await verify(args[0],["admin","accountant"]);
        const result=await executeSilentAllBalancesZero({userId:me.sub,confirmation:args[1]});
        return {
          ok:true,
          message:`تم تصفير جميع الأرصدة تشغيليًا إلى 0 د.أ بدون إظهار حركة تصفير للكباتن. الجرد التلقائي بقي LIVE.`,
          result
        };
      }
      case "startCleanStartAutomaticAccounting":{
        const me=await verify(args[0],["admin","accountant"]);
        const result=await startCleanStartLive({userId:me.sub});
        return {ok:true,message:"الجرد التلقائي Always-On يعمل؛ لا يوجد حد زمني يستبعد طلبًا قديمًا مرتبطًا بتفاعل جديد",result,control:await getCleanStartControlState()};
      }
      case "stopCleanStartAutomaticAccounting":{
        const me=await verify(args[0],["admin","accountant"]);
        const result=await stopCleanStartLive({userId:me.sub});
        return {ok:true,message:"الجرد Always-On محمي من الإيقاف اليدوي وبقي LIVE",result,control:await getCleanStartControlState()};
      }
      case "getCaptainSiteMaintenanceControl":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,maintenance:await getCaptainSiteMaintenanceState()};
      }
      case "setCaptainSiteMaintenanceControl":{
        const me=await verify(args[0],["admin","accountant"]);
        const payload=args[1]&&typeof args[1]==="object"?args[1]:{};
        const maintenance=await setCaptainSiteMaintenanceState({
          enabled:payload.enabled===true,
          progress:payload.progress,
          message:payload.message
        },me.sub);
        return {
          ok:true,
          maintenance,
          message:maintenance.enabled
            ? `تم تشغيل صيانة موقع الكباتن عند ${maintenance.progress}%`
            : "تم إنهاء الصيانة وفتح موقع الكباتن"
        };
      }

      case "createCaptain":{
        const me=await verify(args[0],["admin","accountant"]); const p=args[1]||{};
        const c=await createCaptain({name:p.fullName,phone:p.phone,notes:null});
        const balanceMode=String(p.balanceMode||"PREPAID")==="OPEN_NEGATIVE"?"OPEN_NEGATIVE":"PREPAID";
        if(balanceMode!==String(c.balance_mode||"PREPAID"))await db.query(`UPDATE captains SET balance_mode=$2,updated_at=NOW() WHERE id=$1`,[c.id,balanceMode]);
        await createCaptainUser({captainId:c.id,username:c.phone,password:String(p.password||"123456"),createdBy:me.sub});

        // Manual registration only: unresolved WhatsApp inventory stays pending while a
        // participant is unregistered. Once an admin/accountant registers the number,
        // retry pending captain-mapping reactions. Successful retries post both ledger
        // sides atomically; still-unmapped items remain pending and are never duplicated.
        const pending=await db.query(`
          SELECT raw_payload
          FROM whatsapp_events
          WHERE message_type='reactionMessage'
            AND (
              (status='waiting_review' AND COALESCE(last_error,'') ILIKE '%تعذر ربط المنتج أو المستهلك%')
              OR (status='blocked' AND last_error='رقم غير مسجل')
            )
          ORDER BY webhook_received_at DESC
          LIMIT 500
        `);
        let requeued=0,requeueFailed=0;
        for(const row of pending.rows){
          if(!row.raw_payload)continue;
          try{
            await enqueueWebhook({...row.raw_payload,_abshirReplayNonce:randomUUID()});
            requeued++;
          }catch{requeueFailed++}
        }

        return {
          ok:true,
          message:(requeued
            ? `تم إنشاء حساب الكابتن وجدولة إعادة فحص ${requeued} جرد معلّق`
            : "تم إنشاء حساب الكابتن")+(requeueFailed?` — تعذرت جدولة ${requeueFailed} حركة؛ أعد المحاولة من إعادة المعالجة`:""),
          captain:legacyCaptain({...c,balance_mode:balanceMode,balance:0}),
          pendingInventoryRequeued:requeued,
          pendingInventoryRequeueFailed:requeueFailed
        };
      }
      case "addManualCombinedMovement":{
        const me=await verify(args[0],["admin","accountant"]); const p=args[1]||{};
        const cleanState=await getCleanStartState();
        if(cleanState.status!=="COMPLETED")throw new Error("نفّذ «تثبيت الشحن وتصفير الباقي» من صفحة البداية الجديدة قبل إدخال الجرد اليدوي");
        const direction=String(p.direction||"").toUpperCase();
        if(!["PRODUCTION","CONSUMPTION"].includes(direction))throw new Error("اتجاه الحركة غير صالح");
        const kind=direction==="PRODUCTION"?"production":"consumption";
        const passengerQty=Number(p.passengerQty||0),orderQty=Number(p.orderQty||0);
        for(const [label,qty] of [["الركاب",passengerQty],["الأوردرات",orderQty]]){
          if(!Number.isInteger(qty)||qty<0||qty>1000000)throw new Error(`عدد ${label} يجب أن يكون عددًا صحيحًا من 0 إلى 1,000,000`);
        }
        const totalQty=passengerQty+orderQty;
        if(totalQty<1)throw new Error("أدخل عدد الركاب أو عدد الأوردرات على الأقل");
        if(totalQty>CFG.largeMovementThreshold&&p.confirmLarge!==true)throw new Error("الحركة الكبيرة تحتاج تأكيدًا صريحًا");
        const requestBase=String(p.requestId||`LEG-BATCH-${Date.now()}`).trim();
        const note=String(p.note||"").trim();
        const components=[];
        if(passengerQty>0)components.push({
          kind,amount:CFG.passengerCommission*passengerQty,
          referenceType:"legacy_manual_combined",referenceId:`${requestBase}-PASSENGER`,
          description:note||`${direction} يدوي — ${passengerQty} راكب`,
          metadata:{quantity:passengerQty,workloadQuantity:passengerQty,unitCommission:CFG.passengerCommission,type:"PASSENGER",manualCombined:true,batchId:requestBase}
        });
        if(orderQty>0)components.push({
          kind,amount:CFG.orderCommission*orderQty,
          referenceType:"legacy_manual_combined",referenceId:`${requestBase}-ORDER`,
          description:note||`${direction} يدوي — ${orderQty} أوردر`,
          metadata:{quantity:orderQty,workloadQuantity:orderQty,unitCommission:CFG.orderCommission,type:"ORDER",manualCombined:true,batchId:requestBase}
        });
        const r=await createMovementBatch({captainId:p.captainId,movements:components,createdBy:me.sub});
        const balanceState=await syncCaptainBalanceState(p.captainId).catch(()=>null);
        const captain=await getCaptainProfile(p.captainId).catch(()=>null);
        return {
          ok:true,
          message:`تم تسجيل ${direction==="PRODUCTION"?"الإنتاج":"الاستهلاك"}: ${passengerQty} ركاب + ${orderQty} أوردرات`,
          balance:Number(r.balance),
          captain:captain?legacyCaptain(captain):null,
          transactions:r.entries.slice().reverse().map(e=>legacyTx(e,captain?.name||"")),
          groupRestore:balanceState,
          components:{passengerQty,orderQty,totalAmount:Number((passengerQty*CFG.passengerCommission+orderQty*CFG.orderCommission).toFixed(3))}
        };
      }
      case "addManualMovement":{
        const me=await verify(args[0],["admin","accountant"]); const p=args[1]||{};
        const cleanState=await getCleanStartState();
        if(cleanState.status!=="COMPLETED")throw new Error("نفّذ «تثبيت الشحن وتصفير الباقي» من صفحة البداية الجديدة قبل إدخال الجرد اليدوي");
        const direction=String(p.direction||"").toUpperCase();
        if(!["PRODUCTION","CONSUMPTION"].includes(direction))throw new Error("اتجاه الحركة غير صالح");
        const kind=direction==="PRODUCTION"?"production":"consumption";
        const type=String(p.type||"").toUpperCase();
        if(!["PASSENGER","ORDER"].includes(type))throw new Error("نوع الحركة غير صالح");
        const unit=type==="ORDER"?CFG.orderCommission:CFG.passengerCommission;
        const qty=Number(p.quantity);
        if(!Number.isInteger(qty)||qty<1||qty>1000000)throw new Error("الكمية يجب أن تكون عددًا صحيحًا من 1 إلى 1,000,000");
        if(qty>CFG.largeMovementThreshold&&p.confirmLarge!==true)throw new Error("الحركة الكبيرة تحتاج تأكيدًا صريحًا");
        const r=await createMovement({
          captainId:p.captainId,kind,amount:unit*qty,
          referenceType:"legacy_manual",referenceId:p.requestId||`LEG-${Date.now()}`,
          description:p.note||`${p.direction||""} ${p.type||""}`,
          metadata:{quantity:qty,unitCommission:unit,type},createdBy:me.sub
        });
        const balanceState=await syncCaptainBalanceState(p.captainId).catch(()=>null);
        return {ok:true,message:"تم تسجيل الحركة",balance:Number(r.balance),transaction:legacyTx(r.entry),groupRestore:balanceState};
      }
      case "resetCaptainPassword":{
        const me=await verify(args[0],["admin","accountant"]);
        const captainId=args[1],pass=String(args[2]||"");
        if(pass.length<6) throw new Error("كلمة المرور يجب أن تكون 6 خانات على الأقل");
        const row=await db.query(`SELECT phone FROM captains WHERE id=$1`,[captainId]);
        if(!row.rowCount) throw new Error("الكابتن غير موجود");
        await createCaptainUser({captainId,username:row.rows[0].phone,password:pass,createdBy:me.sub});
        return {ok:true,message:"تم تغيير كلمة مرور الكابتن"};
      }
      case "setCaptainExactBalance":{
        const me=await verify(args[0],["admin","accountant"]);
        const captainId=args[1],p=args[2]||{};
        const target=Number(p.targetBalance);
        if(!Number.isFinite(target))throw new Error("أدخل الرصيد النهائي المطلوب بشكل صحيح");
        if(Math.abs(target)>999999999.999)throw new Error("الرصيد المطلوب خارج الحد المسموح");
        if(p.confirm!==true)throw new Error("يجب تأكيد تعديل الرصيد");
        const before=Number(await getBalance(captainId));
        const roundedTarget=Number(target.toFixed(3));
        const difference=Number((roundedTarget-before).toFixed(3));
        const r=await setCaptainBalanceExact({
          captainId,targetBalance:roundedTarget,createdBy:me.sub,
          reason:String(p.reason||"").trim(),
          referenceId:String(p.requestId||`BALSET-${Date.now()}-${captainId}`).trim()
        });
        const balanceState=await syncCaptainBalanceState(captainId).catch(()=>null);
        const captain=await getCaptainProfile(captainId).catch(()=>null);
        return {
          ok:true,
          message:r.changed
            ?`تم تثبيت رصيد ${captain?.name||"الكابتن"} على ${Number(r.balance).toFixed(3)} د.أ`
            :`الرصيد أصلًا ${Number(r.balance).toFixed(3)} د.أ ولا يحتاج تعديل`,
          changed:r.changed,balance:Number(r.balance),balanceBefore:Number(r.balanceBefore),
          targetBalance:Number(r.targetBalance),difference:Number(r.difference),
          transaction:r.entry?legacyTx(r.entry,captain?.name||""):null,
          captain:captain?legacyCaptain(captain):null,groupRestore:balanceState
        };
      }
      case "setCaptainAdministrativeState":{
        await verify(args[0],["admin","accountant"]);
        const id=args[1],action=String(args[2]||"").toUpperCase();
        if(!["ENABLE","DISABLE"].includes(action))throw new Error("حالة الكابتن غير صالحة");
        await updateCaptain(id,{status:action==="DISABLE"?"disabled":"active"});
        return {ok:true,message:action==="DISABLE"?"تم إيقاف الكابتن":"تم تحديث حالة الكابتن"};
      }
      case "updateCaptainPayoutDetails":{
        await verify(args[0],["admin","accountant"]);
        const p=args[2]||{};
        await db.query(`UPDATE captains SET payout_name=$2,payout_method=$3,payout_identifier=$4,updated_at=NOW() WHERE id=$1`,
          [args[1],p.payoutName||"",p.payoutMethod||"",p.payoutIdentifier||""]);
        return {ok:true,message:"تم حفظ بيانات التحويل"};
      }
      case "setCaptainGroupProtection":{
        const me=await verify(args[0],["admin","accountant"]);
        const captainId=String(args[1]||"");
        const protect=args[2]===true;
        const updated=await db.query("UPDATE captains SET protect_from_group_removal=$2,updated_at=NOW() WHERE id=$1 RETURNING id",[captainId,protect]);
        if(!updated.rowCount)throw new Error("الكابتن غير موجود");
        await audit(me.sub,"captain.group_protection","captain",captainId,{protect});
        return {ok:true,message:protect?"تمت حماية الكابتن من الإزالة التلقائية":"تم إلغاء الحماية اليدوية"};
      }
      case "setCaptainBalanceMode":{
        await verify(args[0],["admin","accountant"]);
        const requested=String(args[2]||"PREPAID").toUpperCase();
        const mode=requested==="STANDARD"?"PREPAID":requested;
        if(!["PREPAID","OPEN_NEGATIVE"].includes(mode))throw new Error("نمط الرصيد غير صالح");
        const updated=await db.query(`UPDATE captains SET balance_mode=$2,updated_at=NOW() WHERE id=$1 RETURNING id`,[args[1],mode]);
        if(!updated.rowCount)throw new Error("الكابتن غير موجود");
        return {ok:true,message:"تم تحديث نمط الرصيد"};
      }
      case "changeMyPassword":{
        const me=await verify(args[0],["admin","accountant","captain"]);
        const oldp=String(args[1]||""),newp=String(args[2]||"");
        const r=await db.query(`SELECT password_hash FROM users WHERE id=$1`,[me.sub]);
        if(!r.rowCount || !(await bcrypt.compare(oldp,r.rows[0].password_hash))) throw new Error("كلمة المرور الحالية غير صحيحة");
        if(newp.length<8 || newp==="123456" || newp===oldp) throw new Error("اختر كلمة مرور جديدة لا تقل عن 8 خانات ومختلفة عن 123456");
        await db.query(`UPDATE users SET password_hash=$2,must_change_password=FALSE,updated_at=NOW() WHERE id=$1`,[me.sub,await bcrypt.hash(newp,12)]);
        return {ok:true,message:"تم تغيير كلمة المرور"};
      }
      case "redeemRechargeCode":{
        const me=await verify(args[0],["captain"]);
        const r=await redeemRechargeCode({captainId:me.captainId,code:String(args[1]||"")});
        const groupRestore=Number(r.balance)>-.75?await restoreCaptainToGroupIfEligible(me.captainId).catch(()=>null):null;
        return {ok:true,message:`تم شحن ${Number(r.amount).toFixed(3)} بنجاح`,balance:Number(r.balance),status:"ACTIVE",groupRestore};
      }
      case "undoAccountantTransaction":{
        const me=await verify(args[0],["admin","accountant"]);
        const r=await reverseLedgerEntry({entryId:args[1],createdBy:me.sub,reason:"Legacy UI reversal"});
        if(["PRODUCTION","CONSUMPTION"].includes(String(r.original?.entry_type||"").toUpperCase())){
          await repairOrphanedWeeklyFloor({captainId:r.original.captain_id,occurredAt:r.original.created_at,userId:me.sub,reason:"استرجاع حركة من المحاسب"});
          r.balance=await getBalance(r.original.captain_id);
          await syncCaptainBalanceState(r.original.captain_id).catch(()=>null);
        }
        return {ok:true,message:"تم استرجاع الحركة",balance:Number(r.balance)};
      }



      case "previewLatestExcelRollback":{
        await verify(args[0],["admin","accountant"]);
        const r=await previewLatestManualExcelRollback();
        return {ok:true,...r};
      }

      case "rollbackLatestExcelImport":{
        const me=await verify(args[0],["admin","accountant"]);const p=args[1]||{};
        if(p.confirm!==true||String(p.confirmText||'').trim()!=="إصلاح آخر رفع Excel")throw new Error("اكتب عبارة التأكيد: إصلاح آخر رفع Excel");
        const before=await previewLatestManualExcelRollback();
        if(!before.available)throw new Error(before.message||"لا يوجد رفع Excel يحتاج إلغاء");
        const r=await rollbackLatestManualExcelImport({createdBy:me.sub});
        let restoredStates=0,lowStates=0;
        for(const cid of r.captainIds||[]){
          try{
            const st=await syncCaptainBalanceState(cid,{notify:false});
            if(st?.low)lowStates++;else restoredStates++;
          }catch{}
        }
        await audit(me.sub,'movement.excel.bulk.rollback.completed','system',r.batchId,{affectedCaptains:r.affectedCaptains,reversedEntries:r.reversedEntries,restoredEntries:r.restoredEntries,restoredStates,lowStates});
        return {ok:true,...r,restoredStates,lowStates,message:`تم إلغاء آخر رفع Excel فقط وإرجاع الحالة السابقة لـ ${r.affectedCaptains} كابتن · عكس ${r.reversedEntries} حركة من الرفع الخاطئ${r.restoredEntries?` · استرجاع ${r.restoredEntries} حركة Excel كانت موجودة قبله`:''}`};
      }

      case "parseInventoryExcel":{
        await verify(args[0],["admin","accountant"]);
        const parsed=await parseInventoryExcelFile(args[1]||{});
        return {ok:true,...parsed};
      }

      case "parseManualMovementExcel":{
        await verify(args[0],["admin","accountant"]);
        const parsed=await parseManualMovementExcelFile(args[1]||{});
        return {ok:true,...parsed,batchId:`XLSX-${Date.now()}-${Math.random().toString(36).slice(2,10)}`};
      }

      case "commitManualMovementExcel":{
        const me=await verify(args[0],["admin","accountant"]); const p=args[1]||{};
        const cleanState=await getCleanStartState();
        if(cleanState.status!=="COMPLETED")throw new Error("نفّذ «تثبيت الشحن وتصفير الباقي» من صفحة البداية الجديدة قبل رفع الجرد");
        if(!cleanState.resetAt||!cleanState.epochId)throw new Error("دورة الجرد الحالية غير مكتملة؛ أعد تنفيذ إعادة بناء الأرصدة");
        if(p.confirm!==true)throw new Error("يجب تأكيد الاستيراد قبل التسجيل");
        const batchId=String(p.batchId||"").trim();
        if(!/^XLSX-[A-Za-z0-9-]{8,100}$/.test(batchId))throw new Error("معرّف الاستيراد غير صالح؛ أعد رفع الملف");
        const rows=Array.isArray(p.rows)?p.rows:[];
        if(!rows.length)throw new Error("لا توجد حركات صالحة للاستيراد");
        if(rows.length>3000)throw new Error("عدد الكباتن في الملف كبير جدًا؛ الحد 3000");
        const results=[],errors=[];
        let createdEntries=0,reversedEntries=0,createdCaptains=0,unchangedCaptains=0,repairedCaptains=0;
        for(const row of rows){
          const captainId=String(row?.captainId||"").trim();
          if(!/^\d+$/.test(captainId)){errors.push({captainId,name:row?.captainName||"",error:"معرّف كابتن غير صالح"});continue;}
          const q={
            consumptionOrders:Number(row?.consumptionOrders||0),
            consumptionPassengers:Number(row?.consumptionPassengers||0),
            productionOrders:Number(row?.productionOrders||0),
            productionPassengers:Number(row?.productionPassengers||0)
          };
          let valid=true;
          for(const [key,value] of Object.entries(q))if(!Number.isInteger(value)||value<0||value>1000000){errors.push({captainId,name:row?.captainName||"",error:`${key} خارج المدى 0..1,000,000`});valid=false;break;}
          if(!valid)continue;
          const components=[];
          const push=(kind,type,qty,unit,suffix,label)=>{if(qty>0)components.push({kind,amount:qty*unit,description:`استيراد Excel مطابق — ${label}: ${qty}`,metadata:{quantity:qty,workloadQuantity:qty,unitCommission:unit,type,manualExcel:true,excelBatchId:batchId,excelEpochId:cleanState.epochId,skipWeeklyFloor:true}})};
          push("consumption","PASSENGER",q.consumptionPassengers,CFG.passengerCommission,"CON-P","ركاب استهلاك");
          push("consumption","ORDER",q.consumptionOrders,CFG.orderCommission,"CON-O","أوردرات استهلاك");
          push("production","PASSENGER",q.productionPassengers,CFG.passengerCommission,"PRO-P","ركاب إنتاج");
          push("production","ORDER",q.productionOrders,CFG.orderCommission,"PRO-O","أوردرات إنتاج");
          if(!components.length)continue;
          try{
            const r=await reconcileManualExcelMovements({
              captainId,movements:components,createdBy:me.sub,
              epochId:cleanState.epochId,resetAt:cleanState.resetAt,batchId
            });
            createdEntries+=Number(r.createdEntries||0);reversedEntries+=Number(r.reversedEntries||0);
            if(r.status==='unchanged')unchangedCaptains++;
            else if(r.status==='repaired')repairedCaptains++;
            else createdCaptains++;
            await syncCaptainBalanceState(captainId).catch(()=>null);
            results.push({captainId,name:row?.captainName||"",balance:Number(r.balance),entries:Number(r.createdEntries||0),reversedEntries:Number(r.reversedEntries||0),status:r.status});
          }catch(error){
            errors.push({captainId,name:row?.captainName||"",error:String(error?.message||error)});
          }
        }
        await audit(me.sub,'movement.excel.bulk.reconcile','system',batchId,{batchId,epochId:cleanState.epochId,rows:rows.length,createdCaptains,unchangedCaptains,repairedCaptains,errors:errors.length,createdEntries,reversedEntries});
        return {ok:true,batchId,success:results.length,failed:errors.length,createdEntries,reversedEntries,createdCaptains,unchangedCaptains,repairedCaptains,results,errors,message:`مطابقة Excel اكتملت: 🆕 ${createdCaptains} جديد · 🛡️ ${unchangedCaptains} موجود بدون تكرار · 🛠️ ${repairedCaptains} تم إصلاحه${errors.length?` · ❌ ${errors.length} خطأ`:''}`};
      }

      case "getInventoryReconciliation":{
        await verify(args[0],["admin","accountant"]);
        const date=args[1]||dateKey(new Date());
        return {ok:true,businessDate:String(date).slice(0,10),rows:await getDailyInventoryComparison(date)};
      }
      case "reconcileInventoryDifference":{
        const me=await verify(args[0],["admin","accountant"]); const p=args[1]||{};
        const r=await reconcileDailyInventory({
          businessDate:p.businessDate,captainId:p.captainId,
          manualPassengers:p.manualPassengers,manualOrders:p.manualOrders,
          addPassengers:p.addPassengers,addOrders:p.addOrders,
          note:p.note,userId:me.sub
        });
        const groupRestore=Number(r.balance)>-.75?await restoreCaptainToGroupIfEligible(p.captainId).catch(()=>null):null;
        return {ok:true,message:"تمت تسوية فرق الجرد وحفظها كسجل مستقل",balance:Number(r.balance),groupRestore};
      }


      case "getNorthCommissionAudit":{
        await verify(args[0],["admin","accountant"]);
        const limit=Math.min(200,Math.max(1,Number(args[1])||100));
        const q=await db.query(`
          WITH balances AS (
            SELECT l.id,l.captain_id,l.amount,l.entry_type,l.reference_type,l.reference_id,l.description,l.metadata,l.created_at,
              SUM(l.amount) OVER(PARTITION BY l.captain_id ORDER BY l.created_at,l.id ROWS UNBOUNDED PRECEDING) AS balance_after
            FROM ledger_entries l
          )
          SELECT b.*,c.name AS captain_name,c.phone AS captain_phone,
                 (b.balance_after-b.amount) AS balance_before
          FROM balances b JOIN captains c ON c.id=b.captain_id
          WHERE b.created_at>=NOW()-INTERVAL '14 days'
            AND (b.entry_type IN ('PRODUCTION','CONSUMPTION','RIDER_COMMISSION','ORDER_COMMISSION')
              OR b.reference_type ILIKE '%north%'
              OR b.metadata->>'source' ILIKE '%north%'
              OR b.metadata->>'inventoryMode'='north')
          ORDER BY b.created_at DESC,b.id DESC LIMIT $1
        `,[limit]);
        return {ok:true,entries:q.rows};
      }
      case "getNorthInventoryDiagnostics":{
        await verify(args[0],["admin","accountant"]);
        const limit=Math.min(100,Math.max(1,Number(args[1]||40)));
        const events=await db.query(`
          SELECT id_message,webhook_type,message_type,message_text,status,last_error,
                 attempts,duplicate_count,webhook_received_at,processed_at,
                 CASE WHEN sender_id LIKE '%@lid' THEN 'lid'
                      WHEN sender_id IS NULL OR sender_id='' THEN 'missing'
                      ELSE 'phone_or_jid' END AS sender_format,
                 CASE WHEN raw_payload->>'_abshirInventoryMode'='north' THEN true ELSE false END AS north,
                 CASE WHEN raw_payload->'messageData'->'reactionMessageData' IS NOT NULL THEN true ELSE false END AS reaction,
                 CASE WHEN raw_payload->'messageData'->'extendedTextMessageData'->>'stanzaId' IS NOT NULL THEN true ELSE false END AS quoted_reply
          FROM whatsapp_events
          WHERE raw_payload->>'_abshirInventoryMode'='north'
          ORDER BY webhook_received_at DESC LIMIT $1`,[limit]);
        const queue=await whatsappQueue.getJobCounts("waiting","active","delayed","failed").catch(e=>({error:String(e.message||e)}));
        const mode=await getAccountingMode();
        return {ok:true,mode,queue,events:events.rows};
      }
      case "getSystemHealth":{
        await verify(args[0],["admin","accountant"]);
        const started=Date.now();
        let postgres={ok:false,latencyMs:null};
        let redisHealth={ok:false,latencyMs:null};
        try{
          const t=Date.now();await db.query("SELECT 1");postgres={ok:true,latencyMs:Date.now()-t};
        }catch(e){postgres={ok:false,error:e.message}}
        try{
          const t=Date.now();await redis.ping();redisHealth={ok:true,latencyMs:Date.now()-t};
        }catch(e){redisHealth={ok:false,error:e.message}}

        const [queue,dbStats,ledgerStats,snapshot]=await Promise.all([
          whatsappQueue.getJobCounts("waiting","active","completed","failed","delayed").catch(()=>({})),
          db.query(`
            SELECT
              (SELECT COUNT(*) FROM captains)::int AS captains,
              (SELECT COUNT(*) FROM ledger_entries)::int AS ledger_entries,
              (SELECT COUNT(*) FROM weekly_settlements)::int AS weekly_settlements,
              (SELECT COUNT(*) FROM inventory_reconciliations)::int AS reconciliations,
              (SELECT COUNT(*) FROM whatsapp_dead_letters WHERE status='pending')::int AS dead_letters,
              (SELECT COALESCE(SUM(duplicate_count),0) FROM whatsapp_events)::int AS duplicates_prevented
          `).then(r=>r.rows[0]),
          db.query(`
            SELECT MAX(created_at) AS last_ledger_at,
              COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '24 hours')::int AS ledger_24h
            FROM ledger_entries
          `).then(r=>r.rows[0]),
          getLatestMigrationSnapshot()
        ]);

        const wa=await db.query(`
          SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER(WHERE status IN ('received','queued','processing'))::int AS pending,
            COUNT(*) FILTER(WHERE status='failed')::int AS failed,
            MAX(webhook_received_at) AS last_webhook_at,
            MAX(processed_at) AS last_processed_at
          FROM whatsapp_events
        `).then(r=>r.rows[0]);

        const accountingMode=await getAccountingMode();
        return {ok:true,
          generatedAt:new Date().toISOString(),
          requestLatencyMs:Date.now()-started,
          uptimeSeconds:Math.round(process.uptime()),
          memory:{
            rssMB:Math.round(process.memoryUsage().rss/1024/1024),
            heapUsedMB:Math.round(process.memoryUsage().heapUsed/1024/1024)
          },
          postgres,redis:redisHealth,queue,database:dbStats,ledger:ledgerStats,whatsapp:wa,
          googleSync:snapshot?{
            connected:true,receivedAt:snapshot.received_at,
            sourceUpdatedAt:snapshot.source_updated_at,
            captainCount:snapshot.captain_count,
            movementCount:snapshot.movement_count,
            totalBalance:Number(snapshot.total_balance||0)
          }:{connected:false},
          greenAccountingMode:accountingMode
        };
      }


      case "getFullMigrationStatus":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,run:await getFullMigrationStatus(args[1]||null)};
      }

      case "applyFullMigrationStep":{
        const me=await verify(args[0],["admin"]);
        const result=await applyFullMigrationStep(args[1],me.sub);
        return {ok:true,result,run:await getFullMigrationStatus()};
      }

      case "resetFullMigrationApply":{
        const me=await verify(args[0],["admin"]);
        await resetFullMigrationApply(args[1],me.sub);
        return {ok:true,message:"تم تجهيز النقل لإعادة المحاولة",run:await getFullMigrationStatus()};
      }

      case "getMigrationComparison":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,comparison:await getMigrationComparison()};
      }

      case "getCaptainFullProfile":{
        await verify(args[0],["admin","accountant"]);
        const data=await getCaptainFullProfileData(args[1]);
        if(!data)throw new Error("الكابتن غير موجود");
        return {ok:true,data};
      }


      case "getWhatsAppLiveFeed":{
        await verify(args[0],["admin","accountant"]);
        const p=args[1]||{};
        const feed=await getWhatsappLiveFeed({
          afterId:p.afterId||0,
          limit:p.limit||80,
          chatId:p.chatId||"",
          includeStats:p.includeStats!==false,
          processingMode:"dropconnect_north"
        });
        return {
          ok:true,
          events:feed.rows.map(liveWhatsappSummary),
          stats:feed.stats,
          group:{id:p.chatId||"",name:"DropConnect — قروبات الشمال"},
          source:"DROPCODE Connect",
          serverTime:new Date().toISOString()
        };
      }

      case "getStorageCenter":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,overview:await getStorageOverview(),policy:await getStoragePolicy()};
      }

      case "saveStorageRetention":{
        const me=await verify(args[0],["admin"]);
        const policy=await saveStoragePolicy(args[1]||{},me.sub);
        await audit(me.sub,"storage.policy.save","system","storage",policy);
        return {ok:true,message:"تم حفظ سياسة التخزين والتنظيف التلقائي",policy,overview:await getStorageOverview()};
      }

      case "runStorageCleanup":{
        const me=await verify(args[0],["admin"]);
        const dryRun=Boolean(args[1]?.dryRun);
        const result=await runStorageCleanup({userId:me.sub,automatic:false,dryRun});
        await audit(me.sub,dryRun?"storage.cleanup.preview":"storage.cleanup.run","system","storage",{result});
        return {ok:true,message:dryRun?"تم حساب ما يمكن تنظيفه بدون حذف":"اكتمل تنظيف التخزين بأمان",result,overview:await getStorageOverview()};
      }

      case "getParallelComparisonMonitor":{
        await verify(args[0],["admin","accountant"]);
        const [mode,baseline,provider,deleteRemovalPolicy,queue]=await Promise.all([
          getParallelComparisonMode(),getParallelComparisonBaseline(),greenPublicSettings(),getInventoryDeleteRemovalPolicy(),
          whatsappQueue.getJobCounts("waiting","active","failed","delayed").catch(()=>({}))
        ]);
        const since=mode.startedAt||baseline.capturedAt||new Date(0).toISOString();
        const [automaticQ,manualQ,eventQ,recentQ,deleteQ]=await Promise.all([
          db.query(`SELECT c.id,c.name,c.phone,
            COALESCE(SUM(j.effective_passenger_quantity) FILTER(WHERE j.status='ACTIVE' AND j.producer_id=c.id),0)::numeric auto_production_passengers,
            COALESCE(SUM(j.effective_order_quantity) FILTER(WHERE j.status='ACTIVE' AND j.producer_id=c.id),0)::numeric auto_production_orders,
            COALESCE(SUM(j.effective_passenger_quantity) FILTER(WHERE j.status='ACTIVE' AND j.consumer_id=c.id),0)::numeric auto_consumption_passengers,
            COALESCE(SUM(j.effective_order_quantity) FILTER(WHERE j.status='ACTIVE' AND j.consumer_id=c.id),0)::numeric auto_consumption_orders,
            COUNT(j.done_message_id) FILTER(WHERE j.status='ACTIVE')::int active_jobs
            FROM captains c LEFT JOIN whatsapp_comparison_jobs j ON (j.producer_id=c.id OR j.consumer_id=c.id) AND j.event_at >= $1::timestamptz
            GROUP BY c.id,c.name,c.phone HAVING COUNT(j.done_message_id)>0`,[since]),
          db.query(`SELECT c.id,c.name,c.phone,
            COALESCE(SUM(${ledgerQtySql('le')}) FILTER(WHERE le.entry_type='PRODUCTION' AND le.metadata->>'type'='PASSENGER'),0)::numeric production_passengers,
            COALESCE(SUM(${ledgerQtySql('le')}) FILTER(WHERE le.entry_type='PRODUCTION' AND le.metadata->>'type'='ORDER'),0)::numeric production_orders,
            COALESCE(SUM(${ledgerQtySql('le')}) FILTER(WHERE le.entry_type='CONSUMPTION' AND le.metadata->>'type'='PASSENGER'),0)::numeric consumption_passengers,
            COALESCE(SUM(${ledgerQtySql('le')}) FILTER(WHERE le.entry_type='CONSUMPTION' AND le.metadata->>'type'='ORDER'),0)::numeric consumption_orders
            FROM captains c LEFT JOIN ledger_entries le ON le.captain_id=c.id AND le.reversed_at IS NULL AND le.entry_type IN ('PRODUCTION','CONSUMPTION') AND COALESCE(le.metadata->>'type','') IN ('PASSENGER','ORDER') AND COALESCE(le.reference_type,'') NOT IN ('green_reaction','green_partial')
            GROUP BY c.id,c.name,c.phone`),
          db.query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE status='error')::int errors,COUNT(*) FILTER(WHERE status='duplicate')::int duplicates,COUNT(*) FILTER(WHERE COALESCE(sender_id,'') LIKE '%@lid')::int unresolved_lids,MAX(webhook_received_at) last_event_at FROM whatsapp_events WHERE webhook_received_at >= $1::timestamptz AND ($2='' OR chat_id=$2)`,[since,String(provider.groupId||'')]),
          db.query(`SELECT id_message,webhook_type,message_type,message_text,status,last_error,sender_id,webhook_received_at FROM whatsapp_events WHERE webhook_received_at >= $1::timestamptz AND ($2='' OR chat_id=$2) ORDER BY webhook_received_at DESC LIMIT 30`,[since,String(provider.groupId||'')]),
          db.query(`SELECT COUNT(*)::int total,COALESCE(SUM(reversed_count),0)::int reversed,MAX(updated_at) last_delete_at FROM whatsapp_delete_everyone_markers WHERE deleted_at >= $1::timestamptz`,[since])
        ]);
        const byId=new Map();
        for(const row of manualQ.rows){const id=String(row.id),base=baseline.captains?.[id]||{};byId.set(id,{captainId:id,name:row.name,phone:row.phone,manual:{productionPassengers:Number(row.production_passengers||0)-Number(base.production_passengers||0),productionOrders:Number(row.production_orders||0)-Number(base.production_orders||0),consumptionPassengers:Number(row.consumption_passengers||0)-Number(base.consumption_passengers||0),consumptionOrders:Number(row.consumption_orders||0)-Number(base.consumption_orders||0)},automatic:{productionPassengers:0,productionOrders:0,consumptionPassengers:0,consumptionOrders:0},activeJobs:0})}
        for(const row of automaticQ.rows){const id=String(row.id),item=byId.get(id)||{captainId:id,name:row.name,phone:row.phone,manual:{productionPassengers:0,productionOrders:0,consumptionPassengers:0,consumptionOrders:0},automatic:{},activeJobs:0};item.automatic={productionPassengers:Number(row.auto_production_passengers||0),productionOrders:Number(row.auto_production_orders||0),consumptionPassengers:Number(row.auto_consumption_passengers||0),consumptionOrders:Number(row.auto_consumption_orders||0)};item.activeJobs=Number(row.active_jobs||0);byId.set(id,item)}
        const keys=['productionPassengers','productionOrders','consumptionPassengers','consumptionOrders'];
        const totals={manual:{},automatic:{},difference:{}};for(const key of keys){totals.manual[key]=0;totals.automatic[key]=0}
        const rows=[...byId.values()].map(item=>{item.difference={};for(const key of keys){item.difference[key]=Number(item.automatic[key]||0)-Number(item.manual[key]||0);totals.manual[key]+=Number(item.manual[key]||0);totals.automatic[key]+=Number(item.automatic[key]||0)}item.matches=keys.every(key=>Math.abs(item.difference[key])<0.001);return item}).filter(item=>item.activeJobs||keys.some(key=>item.manual[key]||item.automatic[key]));
        for(const key of keys)totals.difference[key]=totals.automatic[key]-totals.manual[key];
        const matched=keys.every(key=>Math.abs(totals.difference[key])<0.001);
        return {ok:true,mode,provider,deleteRemovalPolicy,queue,since,baselineCapturedAt:baseline.capturedAt||'',events:eventQ.rows[0]||{},deletes:deleteQ.rows[0]||{},totals,matched,rows,recentEvents:recentQ.rows,safety:{financiallyIsolated:mode.enabled,outboundSuppressed:mode.outboundWhatsappSuppressed,balanceEnforcementSuppressed:mode.balanceEnforcementSuppressed,sameGroup:Boolean(provider.groupId),waha:String(provider.provider||'')==='waha',webhookConfigured:Boolean(provider.webhookConfigured)}};
      }

      case "repairWahaLidMappings":{
        const me=await verify(args[0],["admin","accountant"]);
        const mode=await getParallelComparisonMode();
        if(!mode.enabled)throw new Error('شغّل وضع المقارنة الآمن أولًا حتى تبقى إعادة الرسائل معزولة عن الأرصدة');
        const repair=await repairWahaLidMappings(me.sub);let queued=0;const errors=[];
        for(const idMessage of repair.eventIds){
          try{await enqueueWahaIdentityRepair(idMessage,me.sub);queued++}
          catch(error){errors.push({idMessage,error:String(error?.message||error)})}
        }
        const {eventIds,...summary}=repair;
        return {ok:errors.length===0,message:queued?`تم تحويل أرقام ${summary.resolvedEvents} رسالة وإرسال ${queued} رسالة للإصلاح المرتب بدون تغيير الأرصدة`:summary.unresolvedLids.length?'لم يظهر رقم الهاتف الحقيقي من WAHA بعد؛ تأكد أن الرقم مشرف في القروب ثم أعد المحاولة':'لا توجد رسائل LID قديمة تحتاج إصلاحًا',repair:summary,queued,errors};
      }

      case "setParallelComparisonMode":{
        const me=await verify(args[0],["admin"]);const options=args[1]||{};
        if(options.enabled===false&&String(options.confirmation||'')!=="تشغيل فعلي")throw new Error("اكتب تشغيل فعلي للتأكد قبل إيقاف العزل المالي");
        const mode=await setParallelComparisonMode(options,me.sub);
        if(mode.enabled)await setAccountingMode('live',me.sub);
        return {ok:true,mode,message:mode.enabled?(options.restart?'بدأت نافذة مقارنة جديدة مع تصفير أرقام المقارنة':'وضع المقارنة الآمن يعمل — اليدوي يبقى المالي والآلي للمراقبة فقط'):'تم إيقاف وضع المقارنة؛ راجع النتائج قبل التشغيل الفعلي'};
      }

      case "getReliabilityCenter":{
        await verify(args[0],["admin","accountant"]);
        const [stats,deadLetters,queueCounts,repairQueueCounts,mode,failedJobs,cutoverRepair,finalAudit,finalTakeover,legacyWeekBridge,deleteRemovalPolicy,fullWeekRebuild]=await Promise.all([
          getReliabilityStats(),
          listDeadLetters(100,""),
          whatsappQueue.getJobCounts("waiting","active","completed","failed","delayed"),
          repairQueue.getJobCounts("waiting","active","completed","failed","delayed"),
          getAccountingMode(),
          whatsappQueue.getJobs(["failed"],0,49,false).catch(()=>[]),
          getLiveCutoverRepairStatus(),
          getFinalCutoverAudit(),
          getFinalTakeoverState(),
          getLegacyWeekBridgeStatus(),
          getInventoryDeleteRemovalPolicy(),
          getCurrentFridayFullRebuildStatus()
        ]);
        return {ok:true,mode,stats,queue:queueCounts,repairQueue:repairQueueCounts,cutoverRepair,finalAudit,finalTakeover,legacyWeekBridge,deleteRemovalPolicy,fullWeekRebuild,deadLetters,
          failedJobs:(failedJobs||[]).map(j=>({
            id:String(j.id),idMessage:j.data?.idMessage||"",
            attemptsMade:Number(j.attemptsMade||0),
            failedReason:j.failedReason||"",
            timestamp:j.timestamp||null,
            finishedOn:j.finishedOn||null
          }))
        };
      }

      case "getWebhookDiagnostic":{
        await verify(args[0],["admin","accountant"]);
        const d=await getWebhookDiagnostic(args[1]);
        if(!d)throw new Error("لم يتم العثور على الرسالة");
        return {ok:true,diagnostic:d};
      }

      case "replayWebhookEvent":{
        const me=await verify(args[0],["admin"]);
        const idMessage=String(args[1]||"");
        if(!idMessage)throw new Error("أدخل idMessage");
        const r=await enqueueReplay(idMessage,me.sub);
        return {ok:true,message:"تمت إعادة الرسالة إلى الطابور بأمان",jobId:r.jobId};
      }

      case "resolveDeadLetter":{
        const me=await verify(args[0],["admin"]);
        await resolveDeadLetter(args[1],me.sub);
        return {ok:true,message:"تم إغلاق الخطأ من قائمة DLQ"};
      }

      case "setInventoryDeleteRemovalPolicy":{
        const me=await verify(args[0],["admin"]);
        const policy=await setInventoryDeleteRemovalPolicy(Boolean(args[1]),me.sub);
        return {ok:true,policy,message:policy.forced?'حذف لدى الجميع موقوف إجباريًا من التأثير المالي':policy.enabled?'تم تشغيل تأثير حذف لدى الجميع على الجرد':'تم إيقاف تأثير حذف لدى الجميع على الجرد'};
      }

      case "startCurrentFridayFullRebuild":{
        const me=await verify(args[0],["admin"]);
        const r=await startCurrentFridayFullRebuild({userId:me.sub});
        await audit(me.sub,'whatsapp.inventory.full_week_rebuild.start','system','whatsapp',r);
        return {ok:true,message:`بدأت إعادة بناء الجرد من بداية الجمعة: تم عكس ${r.reversedCount} حركة قديمة وسيُعاد تشغيل ${r.total} حدث بالترتيب. LIVE سيعود تلقائيًا بعد الوصول للحظة الفاصل.`,...r};
      }

      case "startCorrectedFridayFullRebuild":{
        const me=await verify(args[0],["admin"]);
        const r=await startCorrectedFridayFullRebuild({userId:me.sub});
        await audit(me.sub,'whatsapp.inventory.corrected_full_week_rebuild.start','system','whatsapp',r);
        return {ok:true,message:`بدأت إعادة البناء المصححة: أُلغي أثر ${r.reversedCount} حركة واتساب قديمة وسيُعاد تشغيل ${r.total} حدث بالعدد الصحيح (السعر لا يُستخدم كعدد).`,...r};
      }

      case "stabilizeCurrentFridayFullRebuild":{
        const me=await verify(args[0],["admin"]);
        const r=await stabilizeCurrentFridayFullRebuild({userId:me.sub});
        await audit(me.sub,'whatsapp.inventory.full_week_rebuild.stabilize','system','whatsapp',{runId:r.runId,before:r.before,after:r.after,requeued:r.requeued,stoppedBridges:r.stoppedBridges?.length||0,cancelledRuns:r.cancelledRuns?.length||0});
        return {ok:true,message:`تم إيقاف الجسر القديم وتنظيف Jobs الزائدة. أعيد ترتيب ${r.requeued} حدث للـRun الحالي فقط.`,...r};
      }

      case "resumeCurrentFridayFullRebuild":{
        const me=await verify(args[0],["admin"]);
        const r=await resumeCurrentFridayFullRebuild({userId:me.sub});
        await audit(me.sub,'whatsapp.inventory.full_week_rebuild.resume_missing','system','whatsapp',{runId:r.runId,missing:r.missing,queued:r.queued,generation:r.generation||null,total:r.total||null,truthCompleted:r.truthCompleted||null});
        return {ok:true,message:r.alreadyComplete?'كل أحداث الـRun كانت مكتملة؛ تم تثبيت الرصيد وإرجاع LIVE.':`تم استكمال الـRun الحالي فقط: أُعيد صف ${r.queued} حدث ناقص من أصل ${r.missing}. لن يعاد تشغيل الأحداث المكتملة.`,...r};
      }

      case "setWhatsappReliabilityMode":{
        const me=await verify(args[0],["admin"]);
        const requested=String(args[1]||'').toLowerCase();
        const takeover=await getFinalTakeoverState();
        if(takeover && ["PREPARED","OLD_FROZEN","SYNCING","GREEN_SWITCHED","APPLYING","READY_TO_COMMIT"].includes(String(takeover.status||'')) && requested!=="paused"){
          throw new Error("الاستلام النهائي V3.7 يعمل الآن. لا يمكن تشغيل LIVE أو Shadow يدويًا قبل تثبيت آخر أرصدة Google.");
        }
        const mode=await setAccountingMode(requested);
        await audit(me.sub,"whatsapp.mode.change","system","whatsapp",{mode});
        return {ok:true,message:mode==="shadow"?"تم تشغيل Shadow Mode":mode==="paused"?"تم إيقاف الطابور مؤقتًا":"تم تشغيل الوضع الحي",mode};
      }

      case "getFinalCutoverAudit":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,audit:await getFinalCutoverAudit()};
      }

      case "startLiveCutoverAndFridayRepair":{
        const me=await verify(args[0],["admin"]);
        const takeover=await getFinalTakeoverState();
        if(takeover && ["PREPARED","OLD_FROZEN","SYNCING","GREEN_SWITCHED","APPLYING","READY_TO_COMMIT"].includes(String(takeover.status||''))){
          throw new Error("يوجد استلام نهائي V3.7 يعمل الآن. اتركه يكمل ولا تبدأ تحويلًا يدويًا ثانيًا.");
        }
        const finalAudit=await getFinalCutoverAudit();
        if(!finalAudit.ready){
          throw new Error(`الفحص النهائي منع التحويل: ${(finalAudit.blocking||[]).join(" — ")||"يوجد فرق يحتاج مراجعة"}`);
        }
        const migration=await getFullMigrationStatus();
        if(!migration||migration.status!=="completed")throw new Error("أكمل تطبيق نقل App Script أولًا قبل التحويل الفوري إلى LIVE");
        const fromAt=args[1]||null;
        // Validate first, then arm the LIVE worker BEFORE switching GREEN. This removes the
        // dangerous few-second window where a newly redirected webhook could land in Shadow Mode.
        await preflightLiveCutoverAndRepair({fromAt});
        await setAccountingMode("live");
        const green=await activateGreenWebhook(me.sub);
        // The final cutover timestamp is recorded after GREEN accepts the Railway webhook.
        // Any callback that arrived during the switch was already processed LIVE and the repair
        // pass is idempotent, so replaying it cannot charge a captain twice.
        const r=await startLiveCutoverAndRepair({fromAt,userId:me.sub});
        await audit(me.sub,"whatsapp.cutover_repair.start","system","whatsapp",{...r,greenWebhook:green?.settings?.webhookUrl||null});
        return {ok:true,message:`نجح الفحص النهائي. تم تحويل GREEN إلى النظام الجديد وتشغيل LIVE فورًا، وبدأ إصلاح ${r.total} حدث قديم بالخلفية`,finalAudit,greenApi:green?.settings||null,...r};
      }

      case "getLiveCutoverRepairStatus":{
        await verify(args[0],["admin","accountant"]);
        return {ok:true,status:await getLiveCutoverRepairStatus()};
      }

      case "issueAccountantRechargeCode":{
        const me=await verify(args[0],["admin","accountant"]);
        const p=args[1]||{};
        const amount=Number(p.amount),quantity=Number(p.quantity??1);
        if(!Number.isFinite(amount)||amount<=0||amount>10000||Math.abs(Math.round(amount*1000)-amount*1000)>0.000001)
          throw new Error("قيمة الكود غير صالحة (حتى 3 خانات عشرية)");
        if(!Number.isSafeInteger(quantity)||quantity<1||quantity>200)
          throw new Error("عدد الأكواد يجب أن يكون من 1 إلى 200");
        const client=await db.connect();
        try{
          await client.query("BEGIN");
          const codes=[];
          for(let i=0;i<quantity;i++){
            const code="SF-"+randomUUID().replace(/-/g,"").slice(0,8).toUpperCase();
            const r=await client.query(`INSERT INTO recharge_codes(code,amount,created_by_user_id,assigned_captain_id)
              VALUES($1,$2,$3,NULL) RETURNING id,code,amount,created_at`,[code,amount,me.sub]);
            codes.push({id:String(r.rows[0].id),code:r.rows[0].code,amount:Number(r.rows[0].amount)});
          }
          await client.query("COMMIT");
          await audit(me.sub,"recharge_code.batch.create","recharge_code",null,{quantity,amount,ids:codes.map(c=>c.id)}).catch(()=>{});
          return {ok:true,codes,quantity,total:Number((amount*quantity).toFixed(3))};
        }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}
        finally{client.release()}
      }
      case "previewUnusedRechargeCodesReset":{
        const me=await verify(args[0],["admin"]);
        if(me.delegated||me.role!=="admin"||String(me.username||"").toLowerCase()!==String(process.env.ADMIN_USERNAME||"").trim().toLowerCase())throw new Error("هذه العملية للحساب الرئيسي فقط");
        const r=await db.query("SELECT COUNT(*)::int AS count, COALESCE(SUM(amount),0) AS total FROM recharge_codes WHERE status='active'");
        return {ok:true,count:r.rows[0].count,total:Number(r.rows[0].total)};
      }
      case "cancelAllUnusedRechargeCodes":{
        const me=await verify(args[0],["admin"]);
        if(me.delegated||me.role!=="admin"||String(me.username||"").toLowerCase()!==String(process.env.ADMIN_USERNAME||"").trim().toLowerCase())throw new Error("هذه العملية للحساب الرئيسي فقط");
        const p=args[1]||{};
        if(p.confirm!=="CANCEL_UNUSED_SAFEER_CODES"||!Number.isSafeInteger(p.expectedCount)||p.expectedCount<0)throw new Error("تأكيد الإلغاء غير صالح");
        const client=await db.connect();
        try{
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('SAFEER_CANCEL_UNUSED_RECHARGE_CODES'))");
          const before=await client.query("SELECT COUNT(*)::int AS count,COALESCE(SUM(amount),0) AS total FROM recharge_codes WHERE status='active'");
          if(before.rows[0].count!==p.expectedCount)throw new Error("تغير عدد الأكواد؛ أعد المعاينة قبل الإلغاء");
          const last=await client.query("SELECT COALESCE(MAX(closed_at),'1970-01-01'::timestamptz) AS opened_at FROM safeer_recharge_closings");
          const openedAt=last.rows[0].opened_at;
          const closedAt=new Date();
          const result=await client.query("UPDATE recharge_codes SET status='cancelled' WHERE status='active' RETURNING id");
          const report=await client.query(`SELECT COALESCE(u.username,p.username,'غير معروف') AS issuer,
            COUNT(*)::int AS count,COALESCE(SUM(rc.amount),0) AS issued_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='used'),0) AS used_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='active'),0) AS pending_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='cancelled'),0) AS cancelled_total
            FROM recharge_codes rc
            LEFT JOIN users u ON u.id=rc.created_by_user_id
            LEFT JOIN recharge_portal_users p ON p.id=rc.issued_by_portal_user_id
            WHERE rc.created_at >= $1 AND rc.created_at <= $2
            GROUP BY COALESCE(u.username,p.username,'غير معروف') ORDER BY issued_total DESC`,[openedAt,closedAt]);
          const archived=await client.query(`SELECT rc.code,rc.amount,rc.status,rc.created_at,rc.used_at,
            COALESCE(u.username,p.username,'غير معروف') AS issuer,
            COALESCE(c.name,used.name,'غير معروف') AS captain_name,
            COALESCE(c.phone,used.phone,'') AS captain_phone
            FROM recharge_codes rc
            LEFT JOIN users u ON u.id=rc.created_by_user_id
            LEFT JOIN recharge_portal_users p ON p.id=rc.issued_by_portal_user_id
            LEFT JOIN captains c ON c.id=rc.assigned_captain_id
            LEFT JOIN captains used ON used.id=rc.used_by_captain_id
            WHERE rc.created_at >= $1 AND rc.created_at <= $2 ORDER BY rc.created_at DESC`,[openedAt,closedAt]);
          const closing=await client.query("INSERT INTO safeer_recharge_closings(opened_at,closed_at,closed_by_user_id,cancelled_count,snapshot) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id", [openedAt,closedAt,me.sub,result.rowCount,JSON.stringify({summary:report.rows,records:archived.rows})]);
          await client.query("COMMIT");
          await audit(me.sub,"recharge_code.bulk_cancel_unused","recharge_code",null,{count:result.rowCount,total:Number(before.rows[0].total)}).catch(()=>{});
          return {ok:true,count:result.rowCount,closingId:String(closing.rows[0].id),message:"تم تسكير أسبوع الأكواد وأرشفة التقرير وفتح أسبوع جديد"};
        }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}
        finally{client.release()}
      }
      case "resetRechargeAccountingPeriod":{
        const me=await verify(args[0],["admin"]);
        if(me.delegated||me.role!=="admin"||String(me.username||"").toLowerCase()!==String(process.env.ADMIN_USERNAME||"").trim().toLowerCase())throw new Error("التصفير للحساب الرئيسي فقط");
        const p=args[1]||{};
        if(p.confirm!=="RESET_SAFEER_RECHARGE_ACCOUNTING")throw new Error("تأكيد التصفير غير صالح");
        const client=await db.connect();
        try{
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('SAFEER_CANCEL_UNUSED_RECHARGE_CODES'))");
          const last=await client.query("SELECT COALESCE(MAX(closed_at),'1970-01-01'::timestamptz) AS opened_at FROM safeer_recharge_closings");
          const openedAt=last.rows[0].opened_at;
          const closedAt=new Date();
          const report=await client.query(`SELECT COALESCE(u.username,p.username,'غير معروف') AS issuer,
            COUNT(*)::int AS count,COALESCE(SUM(rc.amount),0) AS issued_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='used'),0) AS used_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='active'),0) AS pending_total,
            COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='cancelled'),0) AS cancelled_total
            FROM recharge_codes rc
            LEFT JOIN users u ON u.id=rc.created_by_user_id
            LEFT JOIN recharge_portal_users p ON p.id=rc.issued_by_portal_user_id
            WHERE rc.created_at >= $1 AND rc.created_at < $2
            GROUP BY COALESCE(u.username,p.username,'غير معروف') ORDER BY issued_total DESC`,[openedAt,closedAt]);
          const archived=await client.query(`SELECT rc.code,rc.amount,rc.status,rc.created_at,rc.used_at,
            COALESCE(u.username,p.username,'غير معروف') AS issuer,
            COALESCE(c.name,used.name,'غير معروف') AS captain_name,
            COALESCE(c.phone,used.phone,'') AS captain_phone
            FROM recharge_codes rc
            LEFT JOIN users u ON u.id=rc.created_by_user_id
            LEFT JOIN recharge_portal_users p ON p.id=rc.issued_by_portal_user_id
            LEFT JOIN captains c ON c.id=rc.assigned_captain_id
            LEFT JOIN captains used ON used.id=rc.used_by_captain_id
            WHERE rc.created_at >= $1 AND rc.created_at < $2 ORDER BY rc.created_at DESC`,[openedAt,closedAt]);
          const closing=await client.query("INSERT INTO safeer_recharge_closings(opened_at,closed_at,closed_by_user_id,cancelled_count,snapshot) VALUES($1,$2,$3,0,$4::jsonb) RETURNING id",[openedAt,closedAt,me.sub,JSON.stringify({summary:report.rows,records:archived.rows,kind:"accounting_reset_only"})]);
          await client.query("COMMIT");
          await audit(me.sub,"recharge_code.accounting_period_reset","safeer_recharge_closing",closing.rows[0].id,{issuerCount:report.rows.length,codeCount:archived.rows.length}).catch(()=>{});
          return {ok:true,closingId:String(closing.rows[0].id),issuerCount:report.rows.length,codeCount:archived.rows.length};
        }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}
        finally{client.release()}
      }
      case "getAccountantRechargeReport":{
        await verify(args[0],["admin","accountant"]);
        const closingId=String(args[1]?.closingId||"");
        const archives=await db.query("SELECT id,opened_at,closed_at,cancelled_count FROM safeer_recharge_closings ORDER BY closed_at DESC LIMIT 100");
        if(closingId){
          const closed=await db.query("SELECT snapshot FROM safeer_recharge_closings WHERE id=$1",[closingId]);
          if(!closed.rowCount)throw new Error("الأسبوع المؤرشف غير موجود");
          return {ok:true,records:closed.rows[0].snapshot.records||[],summary:closed.rows[0].snapshot.summary||[],archives:archives.rows,archived:true};
        }
        const last=await db.query("SELECT COALESCE(MAX(closed_at),'1970-01-01'::timestamptz) AS opened_at FROM safeer_recharge_closings");
        const openedAt=last.rows[0].opened_at;
        const records=await db.query(`SELECT rc.id,rc.code,rc.amount,rc.status,rc.created_at,rc.used_at,
          COALESCE(issuer.username,portal.username,'غير معروف') AS issuer,
          COALESCE(c.name,used.name,'غير معروف') AS captain_name,
          COALESCE(c.phone,used.phone,'') AS captain_phone
          FROM recharge_codes rc
          LEFT JOIN users issuer ON issuer.id=rc.created_by_user_id
          LEFT JOIN recharge_portal_users portal ON portal.id=rc.issued_by_portal_user_id
          LEFT JOIN captains c ON c.id=rc.assigned_captain_id
          LEFT JOIN captains used ON used.id=rc.used_by_captain_id
          WHERE rc.created_at >= $1
          ORDER BY rc.created_at DESC LIMIT 1000`,[openedAt]);
        const summary=await db.query(`SELECT COALESCE(u.username,p.username,'غير معروف') AS issuer,
          COUNT(*)::int AS count,COALESCE(SUM(rc.amount),0) AS issued_total,
          COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='used'),0) AS used_total,
          COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='active'),0) AS pending_total,
          COALESCE(SUM(rc.amount) FILTER(WHERE rc.status='cancelled'),0) AS cancelled_total
          FROM recharge_codes rc
          LEFT JOIN users u ON u.id=rc.created_by_user_id
          LEFT JOIN recharge_portal_users p ON p.id=rc.issued_by_portal_user_id
          WHERE rc.created_at >= $1
          GROUP BY COALESCE(u.username,p.username,'غير معروف') ORDER BY issued_total DESC`,[openedAt]);
        return {ok:true,records:records.rows,summary:summary.rows,archives:archives.rows,archived:false};
      }
      case "previewImportedCaptainLoginRepair":{
        await verify(args[0],["admin"]);
        const result=await db.query(`
          SELECT c.id,c.name,c.phone
          FROM captains c WHERE
            (COALESCE(c.notes,'') ILIKE '%مستورد من أرصدة أبشر Script%'
              OR COALESCE(c.notes,'') ILIKE '%مستورد%Script%')
            AND NOT EXISTS(SELECT 1 FROM users u WHERE u.captain_id=c.id AND u.role='captain')
          ORDER BY c.id LIMIT 500`);
        return {ok:true,count:result.rowCount,captains:result.rows.map(x=>({id:String(x.id),name:x.name,phone:x.phone}))};
      }
      case "repairImportedCaptainLogins":{
        const me=await verify(args[0],["admin"]);
        const payload=args[1]||{},password=String(payload.password||"");
        if(payload.confirm!=="CREATE_MISSING_IMPORTED_LOGINS"||password.length<6||password.length>128)
          throw new Error("تأكيد الإصلاح وكلمة مرور مؤقتة من 6 إلى 128 خانة مطلوبان");
        const passwordHash=await bcrypt.hash(password,12);
        const client=await db.connect();
        try{
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtext('ABSHIR_IMPORTED_CAPTAIN_LOGIN_REPAIR'))");
          const rows=await client.query(`
            SELECT c.id,c.name,c.phone FROM captains c
            WHERE (COALESCE(c.notes,'') ILIKE '%مستورد من أرصدة أبشر Script%'
                 OR COALESCE(c.notes,'') ILIKE '%مستورد%Script%')
            AND NOT EXISTS(SELECT 1 FROM users u WHERE u.captain_id=c.id AND u.role='captain')
            ORDER BY c.id LIMIT 500 FOR UPDATE OF c`);
          let created=0;const skipped=[];
          for(const c of rows.rows){
            const owner=await client.query("SELECT id FROM users WHERE username=$1 LIMIT 1",[c.phone]);
            if(owner.rowCount){skipped.push({id:String(c.id),phone:c.phone,reason:"رقم الدخول مستخدم بحساب آخر"});continue;}
            const ins=await client.query(`
              INSERT INTO users(username,password_hash,role,captain_id,is_active,must_change_password)
              VALUES($1,$2,'captain',$3,TRUE,FALSE) ON CONFLICT(username) DO NOTHING RETURNING id`,
              [c.phone,passwordHash,c.id]);
            if(!ins.rowCount){skipped.push({id:String(c.id),phone:c.phone,reason:"تعارض رقم الدخول"});continue;}
            created++;
          }
          await client.query(`
            INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)
            VALUES($1,'captain.imported_logins.repair','captains',NULL,$2::jsonb)`,
            [me.sub,JSON.stringify({created,skipped,examined:rows.rowCount})]);
          await client.query("COMMIT");
          return {ok:true,created,skipped,examined:rows.rowCount};
        }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}
      }
      case "getCaptainAdminGrantCandidates":{
        await verify(args[0],["admin"]);
        const list=await listCaptains("");
        return {ok:true,captains:list.map(c=>({id:String(c.id),name:c.name,phone:c.phone}))};
      }
      case "getCaptainAdminGrants":{
        await verify(args[0],["admin"]);
        await db.query(`CREATE TABLE IF NOT EXISTS captain_admin_grants (
          captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
          permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT false,
          granted_by BIGINT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        const rows=await db.query(`SELECT g.captain_id,c.name,c.phone,g.permissions,g.active,g.updated_at
          FROM captain_admin_grants g JOIN captains c ON c.id=g.captain_id ORDER BY c.name`);
        return {ok:true,grants:rows.rows};
      }
      case "saveCaptainAdminGrant":{
        const me=await verify(args[0],["admin"]);
        const p=args[1]||{};
        const available=["overview","captains","transfers","codes","inventory","movements","transactions","settlements","diagnostics"];
        const permissions=[...new Set(Array.isArray(p.permissions)?p.permissions:[])].filter(x=>available.includes(x));
        const captainId=String(p.captainId||"");
        if(!/^\d+$/.test(captainId))throw new Error("اختر كابتن مسجل");
        await db.query(`CREATE TABLE IF NOT EXISTS captain_admin_grants (
          captain_id BIGINT PRIMARY KEY REFERENCES captains(id) ON DELETE CASCADE,
          permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
          active BOOLEAN NOT NULL DEFAULT false,
          granted_by BIGINT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        const result=await db.query(`INSERT INTO captain_admin_grants(captain_id,permissions,active,updated_at)
          VALUES($1,$2::jsonb,$3,NOW()) ON CONFLICT(captain_id) DO UPDATE
          SET permissions=EXCLUDED.permissions,active=EXCLUDED.active,updated_at=NOW()
          RETURNING captain_id,permissions,active`,[captainId,JSON.stringify(permissions),Boolean(p.active)&&permissions.length>0]);
        await audit(me.sub,"captain.admin_grant.update","captain",captainId,{permissions,active:Boolean(p.active)});
        return {ok:true,grant:result.rows[0]};
      }
      case "enterDelegatedAdmin":{
        const me=await verify(args[0],["captain"]);
        const permissions=await delegatedPermissions(me.captainId);
        if(!permissions.length)throw new Error("ليس لديك تفويض إدارة فعّال");
        const delegatedToken=app.jwt.sign({sub:String(me.sub),role:"accountant",captainId:me.captainId,username:me.username,delegated:true},{expiresIn:"30m"});
        return {ok:true,token:delegatedToken,permissions};
      }
      case "getMyCaptainAdminGrant":{
        const me=await verify(args[0],["captain"]);
        const result=await db.query(`SELECT permissions,active FROM captain_admin_grants WHERE captain_id=$1`,[me.captainId]).catch(e=>{
          if(e.code==="42P01")return {rows:[]};
          throw e;
        });
        const row=result.rows[0];
        return {ok:true,active:Boolean(row?.active),permissions:row?.active?(row.permissions||[]):[]};
      }
      case "getStaffUsers":{
        await verify(args[0],["admin"]);
        return {ok:true,users:await listStaffUsers()};
      }

      case "createStaffUser":{
        const me=await verify(args[0],["admin"]);const p=args[1]||{};
        const u=await createStaffUser({
          username:p.username,password:p.password,role:p.role,
          displayName:p.displayName,createdBy:me.sub
        });
        return {ok:true,message:"تم إنشاء المستخدم الإداري",user:u};
      }

      case "updateStaffUser":{
        const me=await verify(args[0],["admin"]);const p=args[1]||{};
        if(String(p.id)===String(me.sub) && p.isActive===false){
          throw new Error("لا يمكنك إيقاف حسابك الحالي");
        }
        const u=await updateStaffUser({
          id:p.id,role:p.role,displayName:p.displayName,isActive:p.isActive,
          password:p.password,updatedBy:me.sub
        });
        return {ok:true,message:"تم تحديث المستخدم",user:u};
      }

      // V3.4.0: all UI operations are wired to real Railway/PostgreSQL implementations.
      case "submitTransfer":{const me=await verify(args[0],["captain"]);await saveTransfer({captainId:me.captainId,payload:args[1]});return {ok:true,message:"تم إرسال الحوالة للمراجعة"};}
      case "reviewTransfer":{const me=await verify(args[0],["admin","accountant"]);const r=await reviewTransferNative({id:args[1],action:args[2],note:args[3],userId:me.sub});return {ok:true,...r};}

      case "saveGreenApiSettings":{const me=await verify(args[0],["admin","accountant"]);const g=await saveGreenSettings(args[1],me.sub);return {ok:true,message:`تم حفظ إعدادات واتساب — ${g.provider==="waha"?"WAHA":"GREEN API"}`,greenApi:g};}
      case "testGreenApiConnection":{await verify(args[0],["admin","accountant"]);const r=await testGreen();return {ok:true,message:r.provider==="waha"?"WAHA متصل والجلسة WORKING":"GREEN API متصل وواتساب بحالة Authorized",...r};}
      case "checkGreenApiHealth":{await verify(args[0],["admin","accountant"]);const r=await greenHealth();if(!r.ok)throw new Error("الـWebhook أو حالة جلسة واتساب غير سليمة؛ افحص الحالة ثم اضغط تفعيل Webhook عند الحاجة");return {ok:true,message:`ربط ${r.settings?.provider==="waha"?"WAHA":"GREEN API"} سليم`,greenApi:r.settings};}
      case "listGreenApiGroups":{await verify(args[0],["admin","accountant"]);return {ok:true,groups:await listGreenGroups()};}
      case "activateGreenApiWebhook":{const me=await verify(args[0],["admin","accountant"]);const r=await activateGreenWebhook(me.sub);const mode=await getAccountingMode();await audit(me.sub,"whatsapp.webhook.activate","system","whatsapp",{mode,provider:r?.settings?.provider||"green",activationSkipped:Boolean(r?.skipped),activationReason:r?.reason||null});return {ok:true,pending:Boolean(r?.setSettingsApplied),skipped:Boolean(r?.skipped),message:r?.message||"تم تفعيل Webhook.",greenApi:r.settings,mode};}
      case "startGreenOutageRecoveryBackground":{return await startOutageRecoveryBackground(args[0],args[1]||{});}
      case "getGreenOutageRecoveryStatus":{await verify(args[0],["admin","accountant"]);return {ok:true,recovery:await readOutageRecoveryStatus()};}

      case "recoverGreenOutageWindow":{
        const me=await verify(args[0],["admin","accountant"]);
        const r=await recoverOutageWindow(args[1]||{},enqueueWebhook,me.sub);
        const warning=r.truncated?" — ⚠ سجل GREEN المتاح لا يغطي بداية الفترة كاملة":r.errorCount?` — ⚠ ${r.errorCount} ملاحظة`:"";
        return {ok:r.errorCount===0,message:`تم فحص ${r.selected} رسالة داخل فترة الانقطاع: جديد ${r.inserted}، أعيد للطابور ${r.requeued}، موجود سابقًا ${r.existing}${warning}`,...r};
      }
      case "saveGroupGuideSettings":{const me=await verify(args[0],["admin","accountant"]);const g=await saveGroupGuide(args[1],me.sub);return {ok:true,message:"تم حفظ رسالة شرح الطلب",groupGuide:g};}
      case "sendGroupGuideNow":{const me=await verify(args[0],["admin","accountant"]);const g=await sendGroupGuide(me.sub);return {ok:true,message:"تم إرسال رسالة شرح الطلب إلى القروب",groupGuide:g};}
      case "drainGreenWebhookQueueNow":{await verify(args[0],["admin","accountant"]);await whatsappQueue.resume();const q=await whatsappQueue.getJobCounts("waiting","active","completed","failed","delayed");return {ok:true,message:`تم تشغيل التفريغ — بانتظار ${Number(q.waiting||0)}، معالجة ${Number(q.active||0)}`,performance:{queue:q}};}
      case "resetGreenPerformanceMetrics":{await verify(args[0],["admin","accountant"]);await redis.del("abshir:green:perf");return {ok:true,message:"تم تصفير قياسات الأداء",performance:{}};}
      case "recoverRecentGreenGroupHistory":{await verify(args[0],["admin","accountant"]);const r=await recoverHistory(args[1]||500,enqueueWebhook);return {ok:true,message:`تم فحص ${r.total} حدث: استرجاع ${r.inserted}، موجود مسبقًا ${r.existing}`,errors:r.errors,...r};}
      case "reprocessPreviousWhatsAppMessages":{await verify(args[0],["admin","accountant"]);const r=await reprocessRecent(args[1]||250,enqueueWebhook);return {ok:true,message:`تمت إعادة ${r.queued} رسالة إلى الطابور`,...r};}
      case "runLast3DaysGreenAuditNow":{await verify(args[0],["admin","accountant"]);const r=await last3DaysAudit(enqueueWebhook);return {ok:true,message:`تم فحص آخر 72 ساعة: ${r.groupItems} حدث — جديد ${r.inserted} — إعادة طابور ${r.requeued}${r.warning?` — ⚠ ${r.warning}`:""}`,...r};}

      case "previewFridaySettlements":{await verify(args[0],["admin","accountant"]);const preview=await fridayPreview();return {ok:true,message:"معاينة الجمعة جاهزة",periodKey:preview.weekEnd,preview};}
      case "getFridayGroupClosureSession":{await verify(args[0],["admin","accountant"]);return {ok:true,session:await getFridaySession(),preview:await fridayPreview()};}
      case "startFridayGroupClosureSession":{const me=await verify(args[0],["admin","accountant"]);const r=await automaticFridayCloseAndCommit(me);return {ok:true,message:r.warning?"تم تثبيت الجمعة لكن تحقق من فتح القروب":"تم إغلاق القروب وتثبيت جرد الجمعة وفتحه تلقائيًا. لا يُخصم مستحق المنتج إلا عند «تم تحويل».",session:r.session,preview:r.preview,warning:r.warning};}
      case "forceOpenFridayGroup":{const me=await verify(args[0],["admin","accountant"]);const session=await forceOpenFriday(me.sub);return {ok:true,message:"تم فتح القروب",session};}
      case "commitFridayGroupSession":{const me=await verify(args[0],["admin","accountant"]);const r=await commitFriday(me.sub);return {ok:true,message:r.warning?"تم الترحيل لكن تحقق من فتح القروب":"تم اعتماد الجرد والترحيل وفتح القروب",session:r.session,preview:r.preview,warning:r.warning};}
      case "ensureDirectFridaySettlement":{const me=await verify(args[0],["admin","accountant"]);const x=await ensureFridaySettlement(args[1],args[2],me.sub);return {ok:true,settlement:{ID:String(x.id),CaptainID:String(x.captain_id),CaptainName:x.captain_name,Status:legacySettlementStatus(x),AmountDue:Number(x.amount_due ?? x.net ?? 0),WeekEnd:String(x.week_end).slice(0,10)}};}
      case "markFridaySettlementPaid":{const me=await verify(args[0],["admin","accountant"]);const r=await payFridaySettlement(args[1],me.sub,args[2]||"");return {ok:true,status:"PAID",settlementId:String(args[1]),paidAmount:r.paidAmount,balanceAfter:Number(r.balance),paidAt:iso(r.item?.transferred_at),message:r.message};}
      case "processDirectFridayPayment":{const me=await verify(args[0],["admin","accountant"]);const x=await ensureFridaySettlement(args[1],args[2],me.sub);const r=await payFridaySettlement(x.id,me.sub,args[3]||"");return {ok:true,status:"PAID",settlementId:String(x.id),paidAmount:r.paidAmount,balanceAfter:Number(r.balance),paidAt:iso(r.item?.transferred_at),message:r.message};}
      case "verifyPaidFridaySettlementBalance":{const me=await verify(args[0],["admin","accountant"]);const r=await verifyFridaySettlement(args[1],me.sub);return {ok:true,...r};}
      case "returnFridaySettlementToBalance":{const me=await verify(args[0],["admin","accountant"]);const r=await returnFridaySettlement(args[1],me.sub,args[2]||"");return {ok:true,status:"RETURNED",settlementId:String(args[1]),captainId:String(r.captainId||""),weekEnd:String(r.weekEnd||"").slice(0,10),balance:Number(r.balance),returnedAt:r.returnedAt||"",message:r.message};}
      case "undoLastFridaySettlementBatch":{const me=await verify(args[0],["admin","accountant"]);const r=await undoLastFriday(me.sub,args[1]);return {ok:true,...r};}

      case "reviewWhatsAppMovement":{const me=await verify(args[0],["admin","accountant"]);const r=await reviewPendingMovement(args[1],args[2],args[3]||{},me.sub);return {ok:true,...r};}
      case "resolveSystemIssue":{const me=await verify(args[0],["admin","accountant"]);await resolveIssueNative(args[1],args[2],args[3],me.sub);return {ok:true,message:args[2]==="DISMISS"?"تم استبعاد المشكلة":"تم إغلاق المشكلة"};}
      case "clearSystemIssues":{const me=await verify(args[0],["admin","accountant"]);const r=await clearSystemIssuesNative(me.sub);return {ok:true,message:`تم مسح مركز الأخطاء بالكامل — ${r.deleted} سجل`,deleted:r.deleted};}
      case "reprocessSystemIssue":{const me=await verify(args[0],["admin","accountant"]);const r=await reprocessIssueNative(args[1],me.sub);if(r.replayPayload)await enqueueWebhook(r.replayPayload);return {ok:true,message:r.replayPayload?"تمت إعادة الرسالة إلى الطابور":"تمت مراجعة المشكلة"};}
      case "approveSuspiciousReaction":{const me=await verify(args[0],["admin","accountant"]);const r=await approveSuspicious(args[1],args[2]||{},me.sub);return {ok:true,...r};}
      case "correctInventoryReaction":{const me=await verify(args[0],["admin","accountant"]);const r=await correctReaction(args[1],args[2]||{},me.sub);return {ok:true,...r};}
      case "undoInventoryReactionPair":{const me=await verify(args[0],["admin","accountant"]);const r=await undoReactionPairNative(args[1],args[2],me.sub);return {ok:true,...r};}

      case "addInventoryCancellationNumber":{const me=await verify(args[0],["admin","accountant"]);await addCancellationNumber(args[1],me.sub);return {ok:true,message:"تمت إضافة رقم الإلغاء"};}
      case "setInventoryCancellationNumberStatus":{const me=await verify(args[0],["admin","accountant"]);await setCancellationNumberStatus(args[1],args[2],me.sub);return {ok:true,message:"تم تحديث حالة الرقم"};}
      case "removeInventoryCancellationNumber":{const me=await verify(args[0],["admin","accountant"]);await removeCancellationNumberNative(args[1],me.sub);return {ok:true,message:"تم حذف صلاحية رقم الإلغاء"};}
      case "reopenInventoryCancellation":{const me=await verify(args[0],["admin","accountant"]);await reopenCancellationNative(args[1],args[2],me.sub);return {ok:true,message:"تمت إعادة فتح الجرد؛ يمكن وضع 👍 من جديد"};}

      case "runInventoryReconciliationNow":{await verify(args[0],["admin","accountant"]);const r=await safetyReconcile();return {ok:true,message:r.message,safety:r};}
      case "repairAllWeeklyFloors":{const me=await verify(args[0],["admin","accountant"]);const r=await repairWeeklyFloors(me.sub);return {ok:true,...r};}
      case "reconcilePreviousWeekMixed40":{const me=await verify(args[0],["admin","accountant"]);const r=await reconcileMixed40(me.sub);return {ok:r.errors?.length===0,message:r.adjusted?`تم إلغاء ${r.adjusted} اقتطاع/استرجاع قديم من قاعدة 40 حركة لهذا الأسبوع. تعديل الرصيد الصافي: ${Number(r.netAdjustment||0).toFixed(3)} د.أ. القاعدة الوحيدة الآن أرضية 1.50 د.أ الخميس 9 مساءً.`:`لا يوجد اقتطاع 40 حركة فعّال على الأسبوع الحالي. القاعدة الوحيدة الآن أرضية 1.50 د.أ الخميس 9 مساءً.`,result:r};}
      case "repairAllCancelledInventory":{const me=await verify(args[0],["admin","accountant"]);const r=await repairCancelled(me.sub);return {ok:true,...r};}

      case "startWhatsappMessageCleanup":{const me=await verify(args[0],["admin","accountant"]);const session=await startCleanup(me.sub);return {ok:true,message:"اكتمل تنظيف سجل واتساب الآمن وفتح القروب",session};}
      case "getWhatsappMessageCleanupStatus":{await verify(args[0],["admin","accountant"]);return {ok:true,session:await cleanupStatus()};}
      case "forceOpenWhatsappCleanupGroup":{const me=await verify(args[0],["admin","accountant"]);const session=await forceOpenCleanup(me.sub);return {ok:true,message:"تم فتح القروب وإنهاء جلسة التنظيف",session};}

      default:
        throw new Error(`الوظيفة ${method} لم تُنقل إلى Railway بعد`);
    }
  }
}

