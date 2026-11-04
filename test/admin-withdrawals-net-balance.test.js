import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createContext,runInContext,Script} from "node:vm";

const html=readFileSync(new URL("../Accountant.html",import.meta.url),"utf8");
const main=/<script\b[^>]*id="accountantAppCode"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
const admin=/<script\b[^>]*id="admin-withdrawals-ui"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];

test("third dashboard metric sits next to admin withdrawals figures",()=>{
 assert.ok(html.indexOf('id="awDashNetBalance"')>html.indexOf('id="awDashMonth"'));
 assert.match(html,/الرصيد بعد سحوبات الإدارة/);
 assert.match(html,/إجمالي الأرصدة − السحوبات/);
 assert.match(html,/\.aw-dashboard \.aw-totals\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test("dashboard reuses its exact existing captain-balance total without changing wallet balances",()=>{
 assert.ok(main);
 assert.match(main,/window\.getAdminWithdrawalsCaptainBalance=\(\)=>Number\(state\?\.stats\?\.totalBalances\)/);
 assert.match(main,/window\.updateAdminWithdrawalNet\?\.\(\)/);
 assert.ok(admin);
 assert.match(admin,/activeAdminWithdrawalTotal=Number\(summary\.total\)/);
 assert.match(admin,/window\.updateAdminWithdrawalNet=updateAdminWithdrawalNet/);
 assert.doesNotMatch(admin,/UPDATE\s+(?:captains|ledger_entries)|INSERT\s+INTO\s+ledger_entries/i);
 assert.doesNotThrow(()=>new Script(main));
 assert.doesNotThrow(()=>new Script(admin));
});

test("net UI value subtracts expenses with three decimal precision, including cancellation",()=>{
 const m=/function updateAdminWithdrawalNet\(\)\{[\s\S]*?\n\}\nfunction renderDashboard\(data\)/.exec(admin||"");
 assert.ok(m,"net calculation should be a separable render function");
 const fn=m[0].slice(0,-"function renderDashboard(data)".length);
 let base=936.5;
 const node={textContent:""};
 const context=createContext({
   byId:id=>id==="awDashNetBalance"?node:null,
   window:{getAdminWithdrawalsCaptainBalance:()=>base},
   currency:value=>Number(value).toFixed(3)+" د.أ",
 });
 runInContext("let activeAdminWithdrawalTotal=null;\n"+fn,context);
 runInContext("updateAdminWithdrawalNet()",context);
 assert.equal(node.textContent,"—");
 runInContext("activeAdminWithdrawalTotal=1;updateAdminWithdrawalNet()",context);
 assert.equal(node.textContent,"935.500 د.أ");
 runInContext("activeAdminWithdrawalTotal=0;updateAdminWithdrawalNet()",context);
 assert.equal(node.textContent,"936.500 د.أ");
 base=0.3;
 runInContext("activeAdminWithdrawalTotal=0.1;updateAdminWithdrawalNet()",context);
 assert.equal(node.textContent,"0.200 د.أ");
 base=1;
 runInContext("activeAdminWithdrawalTotal=2;updateAdminWithdrawalNet()",context);
 assert.equal(node.textContent,"-1.000 د.أ");
});
