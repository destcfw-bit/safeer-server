import {createHash} from "node:crypto";
import {db} from "./db.js";

function phoneOf(value){
  let p=String(value??"").replace(/\D/g,"");
  if(p.startsWith("00962"))p=p.slice(2);
  if(p.startsWith("962"))p=p.slice(3);
  if(p.length===9&&p.startsWith("7"))p="0"+p;
  return /^07\d{8}$/.test(p)?p:null;
}
function parseRows(body){
  const source=body?.captains;
  if(!Array.isArray(source)||source.length<1||source.length>5000)throw new Error("captains_count_invalid");
  const seen=new Set();
  return source.map((r,i)=>{
    const phone=phoneOf(r.phone);
    const name=String(r.name||"").trim().slice(0,180);
    const raw=r.balance;
    const balance=typeof raw==="number"?raw:Number(String(raw??"").trim());
    if(!phone||!name||raw==null||String(raw).trim()===""||!Number.isFinite(balance)||Math.abs(balance)>999999999.999||Math.abs(balance*1000-Math.round(balance*1000))>0.00001)throw new Error("invalid_row_"+(i+1));
    if(seen.has(phone))throw new Error("duplicate_phone_"+phone);
    seen.add(phone);
    return {phone,name,balance:Number(balance.toFixed(3))};
  }).sort((a,b)=>a.phone.localeCompare(b.phone));
}
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
async function statusRows(client,rows,lock=false){
  const phones=rows.map(r=>r.phone);
  const existing=await client.query(`SELECT c.id,c.name,c.phone,
       COALESCE((SELECT SUM(amount) FROM ledger_entries WHERE captain_id=c.id),0)::numeric AS balance
       FROM captains c WHERE RIGHT(regexp_replace(c.phone,'[^0-9]','','g'),9)=ANY($1::text[])
       ${lock?"FOR UPDATE OF c":""}`,[phones.map(p=>p.slice(-9))]);
  const index=new Map(existing.rows.map(r=>[phoneOf(r.phone),r]));
  return rows.map(r=>{
    const found=index.get(r.phone);
    const current=found?Number(found.balance):null;
    return {...r,existingId:found?.id||null,currentBalance:current,action:!found?"create":Math.abs(current-r.balance)<0.0005?"unchanged":"update"};
  });
}
export function registerBalanceImportRoutes(app,requireRoles){
  app.post("/api/balance-transfer/preview",{preHandler:[requireRoles("admin","accountant")]},async(request,reply)=>{
    try{
      const rows=parseRows(request.body);
      const prepared=await statusRows(db,rows);
      const counts={create:0,update:0,unchanged:0};
      prepared.forEach(r=>counts[r.action]++);
      return {ok:true,rows:prepared,counts,fingerprint:hash(prepared)};
    }catch(e){return reply.code(400).send({ok:false,error:e.message});}
  });
  app.post("/api/balance-transfer/apply",{preHandler:[requireRoles("admin","accountant")]},async(request,reply)=>{
    let rows;
    try{rows=parseRows(request.body);}catch(e){return reply.code(400).send({ok:false,error:e.message});}
    if(!/^[a-f0-9]{64}$/.test(String(request.body?.fingerprint||"")))return reply.code(400).send({ok:false,error:"preview_required"});
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(70390425)");
      const prepared=await statusRows(client,rows,true);
      if(hash(prepared)!==request.body.fingerprint)throw new Error("balances_changed_preview_again");
      await client.query(`CREATE TABLE IF NOT EXISTS captain_balance_import_runs (
        fingerprint TEXT PRIMARY KEY,source_hash TEXT UNIQUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),created_by BIGINT,record_count INTEGER NOT NULL)`);
      const imported=await client.query("SELECT 1 FROM captain_balance_import_runs WHERE source_hash=$1",[hash(rows)]);
      if(imported.rowCount)throw new Error("file_already_imported");
      const summary={create:0,update:0,unchanged:0};
      for(const r of prepared){
        let id=r.existingId;
        if(!id){
          const insert=await client.query("INSERT INTO captains(name,phone,notes) VALUES($1,$2,$3) RETURNING id",[r.name,r.phone,"استيراد الأرقام والأرصدة من Google Script"]);
          id=insert.rows[0].id;
        }
        const difference=Number((r.balance-(r.currentBalance??0)).toFixed(3));
        if(Math.abs(difference)>=0.0005){
          const entryType=difference>0?"MANUAL_CREDIT":"MANUAL_DEBIT";
          const ref=hash([request.body.fingerprint,r.phone]).slice(0,40);
          await client.query(`INSERT INTO ledger_entries(captain_id,amount,entry_type,direction,reference_type,reference_id,description,metadata,created_by_user_id)
            VALUES($1,$2,$3,$4,'google_balance_transfer',$5,$6,$7::jsonb,$8)`,[
            id,difference,entryType,difference>0?"credit":"debit",ref,"مطابقة الرصيد النهائي المنقول من Google Script",
            JSON.stringify({source:"google_script",targetBalance:r.balance,previousBalance:r.currentBalance??0,importFingerprint:request.body.fingerprint}),request.user.sub
          ]);
        }
        summary[r.action]++;
      }
      await client.query("INSERT INTO captain_balance_import_runs(fingerprint,source_hash,created_by,record_count) VALUES($1,$2,$3,$4)",[request.body.fingerprint,hash(rows),request.user.sub,rows.length]);
      await client.query("INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details) VALUES($1,'captain.balance.import','batch',$2,$3::jsonb)",[request.user.sub,request.body.fingerprint,JSON.stringify(summary)]);
      await client.query("COMMIT");
      return {ok:true,summary};
    }catch(e){await client.query("ROLLBACK");return reply.code(409).send({ok:false,error:e.message});}
    finally{client.release();}
  });
}
