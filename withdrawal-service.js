import { db } from './db.js';
import { maximumWithdrawal } from './withdrawal-policy.js';
const money = x => Math.round(Number(x)*1000)/1000;
export async function ensureWithdrawalTables() {
  await db.query(`CREATE TABLE IF NOT EXISTS captain_withdrawal_settings (captain_id BIGINT PRIMARY KEY REFERENCES captains(id), classification TEXT NOT NULL DEFAULT 'consumer' CHECK(classification IN ('producer','both','consumer')), announcement_seen_at TIMESTAMPTZ);
    CREATE TABLE IF NOT EXISTS captain_withdrawal_requests (id BIGSERIAL PRIMARY KEY, captain_id BIGINT NOT NULL REFERENCES captains(id), amount NUMERIC(12,3) NOT NULL CHECK(amount>0), status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','transferred','rejected','kept')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), reviewed_at TIMESTAMPTZ, reviewed_by BIGINT REFERENCES users(id), ledger_entry_id BIGINT REFERENCES ledger_entries(id), note TEXT);
    ALTER TABLE captain_withdrawal_requests DROP CONSTRAINT IF EXISTS captain_withdrawal_requests_status_check;
    ALTER TABLE captain_withdrawal_requests ADD CONSTRAINT captain_withdrawal_requests_status_check CHECK(status IN ('pending','approved','transferred','rejected','kept'));
    ALTER TABLE captain_withdrawal_settings ADD COLUMN IF NOT EXISTS bank_name TEXT;
    ALTER TABLE captain_withdrawal_settings ADD COLUMN IF NOT EXISTS cliq_alias TEXT;
    ALTER TABLE captain_withdrawal_requests ADD COLUMN IF NOT EXISTS bank_name TEXT;
    ALTER TABLE captain_withdrawal_requests ADD COLUMN IF NOT EXISTS cliq_alias TEXT;
    CREATE TABLE IF NOT EXISTS withdrawal_global_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    INSERT INTO withdrawal_global_settings(id,enabled) VALUES(1,FALSE) ON CONFLICT(id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS withdrawal_requests_captain_idx ON captain_withdrawal_requests(captain_id,created_at DESC);`);
}
export async function withdrawalEnabled(client=db){const r=await client.query('SELECT enabled FROM withdrawal_global_settings WHERE id=1');return r.rows[0]?.enabled===true;}
export async function getWithdrawalControl(){await ensureWithdrawalTables();return {enabled:await withdrawalEnabled()};}
export async function setWithdrawalControl(enabled){await ensureWithdrawalTables();await db.query('UPDATE withdrawal_global_settings SET enabled=$1,updated_at=NOW() WHERE id=1',[enabled===true]);return getWithdrawalControl();}
function currentAmmanWeek(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(new Date()).map(x=>[x.type,x.value]));const date=new Date(p.year+'-'+p.month+'-'+p.day+'T12:00:00+03:00');const back={Fri:0,Sat:1,Sun:2,Mon:3,Tue:4,Wed:5,Thu:6}[p.weekday]??0;date.setUTCDate(date.getUTCDate()-back);return [date.toISOString().slice(0,10)+'T00:00:00+03:00',new Date(date.getTime()+7*86400000).toISOString()];}
async function weeklyClassifications(client){const [start,end]=currentAmmanWeek();const {rows}=await client.query(`SELECT captain_id,BOOL_OR(entry_type='PRODUCTION') AS produced,BOOL_OR(entry_type='CONSUMPTION') AS consumed FROM ledger_entries WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz AND reversed_at IS NULL AND entry_type IN ('PRODUCTION','CONSUMPTION') AND COALESCE(reference_type,'')<>'green_partial' AND COALESCE(metadata->>'type','') IN ('PASSENGER','ORDER') GROUP BY captain_id`,[start,end]);return new Map(rows.map(x=>[String(x.captain_id),x.produced&&x.consumed?'both':x.produced?'producer':'consumer']));}
async function withdrawalBalances(client,id){
 const q=await client.query("SELECT COALESCE(SUM(amount),0)::numeric total,COALESCE(SUM(CASE WHEN amount>0 AND (entry_type='RECHARGE' OR reference_type='recharge_code') THEN amount ELSE 0 END),0)::numeric recharge FROM ledger_entries WHERE captain_id=$1",[id]);
 const total=money(q.rows[0].total),recharge=money(q.rows[0].recharge);
 return {total,recharge,eligible:Math.max(0,money(total-recharge))};
}
async function info(client,id){
  const {rows:[settings]}=await client.query('SELECT classification,announcement_seen_at,bank_name,cliq_alias FROM captain_withdrawal_settings WHERE captain_id=$1',[id]);
  const funds=await withdrawalBalances(client,id);
  const {rows:[pending]}=await client.query("SELECT COALESCE(SUM(amount),0)::numeric AS reserved FROM captain_withdrawal_requests WHERE captain_id=$1 AND status IN ('pending','approved')",[id]);
  const weekly=(await weeklyClassifications(client)).get(String(id));const classification=weekly||'unclassified';
  const total=funds.total,reserved=Number(pending.reserved); const maximum=Math.max(0,money(maximumWithdrawal(funds.eligible,classification)-reserved)); const windowOpen=await withdrawalEnabled(client); const reason=!windowOpen?'طلبات السحب مغلقة من الإدارة':classification==='consumer'?'حركات هذا الأسبوع استهلاك فقط':classification==='unclassified'?'لا توجد حركات إنتاج أو استهلاك هذا الأسبوع':funds.eligible<=1?'لا يوجد رصيد إنتاج مؤهل للسحب؛ رصيد الشحن محمي':reserved>0&&maximum<=0?'الرصيد محجوز لطلبات سحب سابقة':maximum<=0?'لا يوجد مبلغ متاح للسحب':!settings?.cliq_alias?'يجب حفظ بيانات كليك أولًا':null;return {classification,bankName:settings?.bank_name||null,cliqAlias:settings?.cliq_alias||null,balance:total,rechargeBalance:funds.recharge,eligibleBalance:funds.eligible,reserved,maximum,windowOpen,reason,announcementSeen:!!settings?.announcement_seen_at};
}
export async function captainWithdrawalData(id){await ensureWithdrawalTables();return { ...(await info(db,id)),requests:(await db.query('SELECT id,amount,status,created_at,reviewed_at,note,bank_name,cliq_alias FROM captain_withdrawal_requests WHERE captain_id=$1 ORDER BY id DESC LIMIT 50',[id])).rows};}
export async function requestCaptainWithdrawal(id,amount){await ensureWithdrawalTables();if(!await withdrawalEnabled())throw Error('طلبات السحب مغلقة من الإدارة');const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM captains WHERE id=$1 FOR UPDATE',[id]);const state=await info(c,id);if(!state.windowOpen)throw Error('طلبات السحب مغلقة من الإدارة');if(!state.bankName||!state.cliqAlias)throw Error('يجب حفظ البنك ومعرّف كليك قبل طلب السحب');const raw=Number(amount);const value=money(raw);if(!Number.isFinite(raw)||raw!==value||value<=0||value>state.maximum)throw Error('المبلغ غير مسموح أو الرصيد غير كافٍ');const r=await c.query('INSERT INTO captain_withdrawal_requests(captain_id,amount,bank_name,cliq_alias) VALUES($1,$2,$3,$4) RETURNING id,status,amount',[id,value,state.bankName,state.cliqAlias]);await c.query('COMMIT');return r.rows[0];}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function accountantWithdrawalData(){await ensureWithdrawalTables();return (await db.query('SELECT w.id,w.captain_id,c.name,c.phone,w.amount,w.bank_name,w.cliq_alias,w.status,w.created_at,w.reviewed_at,w.note FROM captain_withdrawal_requests w JOIN captains c ON c.id=w.captain_id ORDER BY w.id DESC LIMIT 500')).rows;}
export async function listWithdrawalClassifications(){await ensureWithdrawalTables();const weekly=await weeklyClassifications(db);const {rows}=await db.query("SELECT c.id,c.name,c.phone,COALESCE(w.classification,'unclassified') AS saved_classification FROM captains c LEFT JOIN captain_withdrawal_settings w ON w.captain_id=c.id ORDER BY c.name,c.id");return rows.map(c=>({...c,classification:weekly.get(String(c.id))||'unclassified'}));}
export async function bulkSetWithdrawalClassification(ids,classification){if(!['producer','both','consumer'].includes(classification))throw Error('تصنيف غير صالح');if(!Array.isArray(ids)||ids.length<1||ids.length>500||ids.some(x=>!/^[0-9]+$/.test(String(x)))||new Set(ids.map(String)).size!==ids.length)throw Error('اختيار الكباتن غير صالح');await ensureWithdrawalTables();const c=await db.connect();try{await c.query('BEGIN');const found=await c.query('SELECT id FROM captains WHERE id=ANY($1::bigint[]) FOR UPDATE',[ids.map(String)]);if(found.rowCount!==ids.length)throw Error('بعض الكباتن غير موجودين');await c.query("INSERT INTO captain_withdrawal_settings(captain_id,classification) SELECT unnest($1::bigint[]),$2 ON CONFLICT(captain_id) DO UPDATE SET classification=EXCLUDED.classification",[ids.map(String),classification]);await c.query('COMMIT');return {ok:true,updated:ids.length};}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
export async function setWithdrawalClassification(id,classification){if(!['producer','both','consumer'].includes(classification))throw Error('تصنيف غير صالح');await ensureWithdrawalTables();await db.query('INSERT INTO captain_withdrawal_settings(captain_id,classification) VALUES($1,$2) ON CONFLICT(captain_id) DO UPDATE SET classification=EXCLUDED.classification',[id,classification]);return {ok:true};}
export async function markWithdrawalAnnouncementSeen(id){await ensureWithdrawalTables();await db.query('INSERT INTO captain_withdrawal_settings(captain_id,announcement_seen_at) VALUES($1,NOW()) ON CONFLICT(captain_id) DO UPDATE SET announcement_seen_at=NOW()',[id]);return {ok:true};}
export async function reviewWithdrawal(id,status,reviewer,note=''){
 if(!['transferred','kept'].includes(status))throw Error('حالة غير صالحة');
 await ensureWithdrawalTables();const c=await db.connect();
 try{
  await c.query('BEGIN');
  const found=await c.query('SELECT captain_id FROM captain_withdrawal_requests WHERE id=$1',[id]);
  if(!found.rowCount)throw Error('الطلب غير موجود');
  await c.query('SELECT id FROM captains WHERE id=$1 FOR UPDATE',[found.rows[0].captain_id]);
  const item=(await c.query('SELECT * FROM captain_withdrawal_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!['pending','approved'].includes(item.status))throw Error('تمت معالجة الطلب مسبقاً');
  if(status==='kept'){
   if(item.status!=='pending')throw Error('هذا الطلب خُصم مسبقاً ولا يمكن إبقاؤه دون تسوية');
   await c.query("UPDATE captain_withdrawal_requests SET status='kept',reviewed_at=NOW(),reviewed_by=$2,note=$3 WHERE id=$1",[id,reviewer,String(note).slice(0,500)]);
  }else if(item.status==='pending'){
   const funds=await withdrawalBalances(c,item.captain_id);
   const classification=(await weeklyClassifications(c)).get(String(item.captain_id))||'unclassified';
   const reserved=await c.query("SELECT COALESCE(SUM(amount),0)::numeric AS total FROM captain_withdrawal_requests WHERE captain_id=$1 AND id<>$2 AND status IN ('pending','approved')",[item.captain_id,id]);
   const limit=money(maximumWithdrawal(funds.eligible,classification)-Number(reserved.rows[0].total));
   if(Number(item.amount)>limit||Number(item.amount)>funds.total)throw Error('المبلغ يتضمن رصيد شحن محمي أو يتجاوز رصيد الإنتاج المتاح');
   const entry=await c.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id) VALUES($1,$2,'WITHDRAWAL','debit','captain_withdrawal',$3,'سحب رصيد الكابتن','{}'::jsonb,$4) RETURNING id`,[item.captain_id,-Number(item.amount),String(id),reviewer]);
   await c.query("UPDATE captain_withdrawal_requests SET status='transferred',ledger_entry_id=$2,reviewed_at=NOW(),reviewed_by=$3,note=$4 WHERE id=$1",[id,entry.rows[0].id,reviewer,String(note).slice(0,500)]);
  }else{
   if(!item.ledger_entry_id)throw Error('طلب قديم بلا سجل خصم؛ يحتاج مراجعة');
   await c.query("UPDATE captain_withdrawal_requests SET status='transferred',reviewed_at=NOW(),reviewed_by=$2,note=$3 WHERE id=$1",[id,reviewer,String(note).slice(0,500)]);
  }
  await c.query('COMMIT');return {ok:true,status};
 }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

const validBank=v=>{const s=String(v??'').trim();if(s.length<2||s.length>100)throw Error('اسم البنك غير صالح');return s;};
const validAlias=v=>{const s=String(v??'').trim();if(!/^[A-Za-z0-9._-]{3,50}$/.test(s))throw Error('معرّف كليك غير صالح، استخدم أحرفًا إنجليزية وأرقامًا فقط');return s;};
export async function saveCaptainCliq(id,bank,alias){await ensureWithdrawalTables();const b=validBank(bank),a=validAlias(alias);const c=await db.connect();try{await c.query('BEGIN');await c.query('SELECT id FROM captains WHERE id=$1 FOR UPDATE',[id]);const r=await c.query('SELECT bank_name,cliq_alias FROM captain_withdrawal_settings WHERE captain_id=$1 FOR UPDATE',[id]);if(r.rows[0]?.cliq_alias)throw Error('تم تثبيت بيانات كليك؛ التعديل متاح للإدارة فقط');await c.query('INSERT INTO captain_withdrawal_settings(captain_id,bank_name,cliq_alias) VALUES($1,$2,$3) ON CONFLICT(captain_id) DO UPDATE SET bank_name=EXCLUDED.bank_name,cliq_alias=EXCLUDED.cliq_alias',[id,b,a]);await c.query('COMMIT');return {bankName:b,cliqAlias:a};}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
export async function adminUpdateCaptainCliq(id,bank,alias){await ensureWithdrawalTables();const b=validBank(bank),a=validAlias(alias);const r=await db.query('INSERT INTO captain_withdrawal_settings(captain_id,bank_name,cliq_alias) VALUES($1,$2,$3) ON CONFLICT(captain_id) DO UPDATE SET bank_name=EXCLUDED.bank_name,cliq_alias=EXCLUDED.cliq_alias RETURNING bank_name,cliq_alias',[id,b,a]);return {bankName:r.rows[0].bank_name,cliqAlias:r.rows[0].cliq_alias};}
