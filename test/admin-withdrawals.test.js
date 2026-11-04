import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerAdminWithdrawalsRoutes, validateAdminWithdrawal, validExpenseDate, initAdminWithdrawalsSchema } from "../admin-withdrawals.js";

const sample={
  expenseDate:"2026-11-04",category:"salary",title:"راتب محاسب",
  beneficiary:"المحاسب أحمد",reason:"راتب بداية الشهر",amount:"15.500",
  requestId:"e3cbfc4c-c097-4e78-a69f-d530233bc4de"
};

test("valid Jordan admin expense has an exact date, category and 3-decimal amount",()=>{
 const entry=validateAdminWithdrawal(sample);
 assert.equal(entry.expenseDate,"2026-11-04");
 assert.equal(entry.amount,15.5);
 assert.equal(entry.category,"salary");
 assert.equal(entry.beneficiary,"المحاسب أحمد");
 assert.equal(validExpenseDate("2024-02-29"),true);
 assert.equal(validExpenseDate("2026-02-29"),false);
 assert.equal(validExpenseDate("2026-13-10"),false);
});

test("rejects negative, zero, malformed, unsupported and unsafe entries",()=>{
 for(const amount of ["0","-1","1.0001","Infinity","1e2","99999999.99"])
  assert.throws(()=>validateAdminWithdrawal({...sample,amount}),/المبلغ/);
 assert.throws(()=>validateAdminWithdrawal({...sample,reason:" "}),/سبب/);
 assert.throws(()=>validateAdminWithdrawal({...sample,category:"ledger"}),/نوع/);
 assert.throws(()=>validateAdminWithdrawal({...sample,expenseDate:"2026-02-31"}),/تاريخ/);
 assert.throws(()=>validateAdminWithdrawal({...sample,requestId:"bad"}),/معرّف/);
});

function fakeApp(db){
 const routes=new Map(),roles=[];
 const app={
  get:(path,opts,handler)=>routes.set("GET "+path,{opts,handler}),
  post:(path,opts,handler)=>routes.set("POST "+path,{opts,handler})
 };
 const requireRoles=(...r)=>{roles.push(r);return async()=>{}};
 registerAdminWithdrawalsRoutes(app,{db,requireRoles});
 return {routes,roles};
}

test("all expense endpoints require a real admin role",()=>{
 const h=fakeApp({query:async()=>({rows:[]})});
 assert.deepEqual(h.roles,[["admin"],["admin"],["admin"]]);
 for(const route of h.routes.values())assert.equal(route.opts.preHandler.length,1);
});

test("expense table is isolated from captain balances and no reset table is modified",async()=>{
 const sql=[];
 await initAdminWithdrawalsSchema({query:async text=>{sql.push(text);return {rows:[]}}});
 assert.match(sql[0],/CREATE TABLE IF NOT EXISTS admin_withdrawals/);
 assert.match(sql[0],/request_id UUID NOT NULL UNIQUE/);
 assert.doesNotMatch(sql[0],/ledger_entries|captains\b|recharge_codes/i);
});

test("new expense commits an auditable record without touching captain ledger",async()=>{
 const statements=[];
 let released=false;
 const db={connect:async()=>({
  query:async(sql,values)=>{
   statements.push({sql,values});
   if(sql.includes("INSERT INTO admin_withdrawals"))return {rows:[{id:"17"}],rowCount:1};
   return {rows:[],rowCount:1};
  },
  release:()=>{released=true}
 })};
 const h=fakeApp(db);
 const response={status:200,code(n){this.status=n;return this},send(v){return v}};
 const result=await h.routes.get("POST /api/admin/withdrawals").handler({body:sample,user:{sub:"1"}},response);
 assert.deepEqual(result,{ok:true,id:"17"});
 assert.equal(response.status,201);
 assert.equal(released,true);
 assert.ok(statements.some(s=>s.sql==="COMMIT"));
 assert.ok(statements.some(s=>s.sql.includes("admin_withdrawal.create")));
 assert.equal(statements.some(s=>/INSERT INTO ledger_entries|UPDATE captains|UPDATE ledger_entries/i.test(s.sql)),false);
});

test("cancelling a record is a soft void with reason and audit, not a DELETE",async()=>{
 const statements=[];
 const db={connect:async()=>({
  query:async(sql,values)=>{
   statements.push(sql);
   if(sql.startsWith("UPDATE admin_withdrawals"))return {rows:[{id:"17"}],rowCount:1};
   return {rows:[],rowCount:1};
  },release:()=>{}
 })};
 const h=fakeApp(db);
 const result=await h.routes.get("POST /api/admin/withdrawals/:id/void").handler({
  params:{id:"17"},body:{reason:"أُدخل بالخطأ"},user:{sub:"1"}
 });
 assert.equal(result.id,"17");
 assert.ok(statements.some(s=>s.includes("voided_at=NOW()")));
 assert.ok(statements.some(s=>s.includes("admin_withdrawal.void")));
 assert.ok(statements.every(s=>!/DELETE\s+FROM|ledger_entries|captains/i.test(s)));
});

test("dashboard panel exists directly under stats and admin list has required fields",()=>{
 const html=readFileSync(new URL("../Accountant.html",import.meta.url),"utf8");
 const pos=html.indexOf('id="statsCards"');
 const admin=html.indexOf('id="adminWithdrawalsDashboard"');
 const next=html.indexOf('id="smartAlerts"');
 assert.ok(pos>=0&&admin>pos&&next>admin);
 for(const id of ["adminWithdrawalsNav","view-admin-withdrawals","awDate","awDayName","awCategory","awTitle","awBeneficiary","awReason","awAmount","awRows","awTotal","awPeriodTotal"]){
  assert.ok(html.includes('id="'+id+'"'),"missing "+id);
 }
 assert.match(html,/window\.refreshAdminWithdrawals/);
});
