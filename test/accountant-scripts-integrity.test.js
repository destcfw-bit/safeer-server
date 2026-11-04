import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

const html=readFileSync(new URL("../Accountant.html",import.meta.url),"utf8");
const app=html.match(/<script\b[^>]*id="accountantAppCode"[^>]*>([\s\S]*?)<\/script>/i);
const expenses=html.match(/<script\b[^>]*id="admin-withdrawals-ui"[^>]*>([\s\S]*?)<\/script>/i);

test("core accountant script remains complete and compilable",()=>{
  assert.ok(app,"accountant app script must exist");
  assert.match(app[1],/function renderDashboard\(/);
  assert.match(app[1],/function openCaptainStatement\(/);
  assert.match(app[1],/win\.document\.close\(\)/);
  assert.doesNotMatch(app[1],/<script\b[^>]*id="admin-withdrawals-ui"/i);
  assert.doesNotThrow(()=>new Script(app[1],{filename:"Accountant.html#core"}));
});

test("admin withdrawals is an independent valid script after core",()=>{
  assert.ok(expenses,"expenses controller must exist");
  assert.ok(html.indexOf(expenses[0])>html.indexOf(app[0])+app[0].length);
  assert.equal(html.match(/<script\b[^>]*id="admin-withdrawals-ui"/gi)?.length,1);
  assert.doesNotThrow(()=>new Script(expenses[1],{filename:"Accountant.html#admin-withdrawals"}));
  const finalClosing=html.lastIndexOf("</body>");
  assert.ok(html.indexOf(expenses[0])+expenses[0].length<finalClosing);
});

test("printed statement template keeps its original body ending",()=>{
  assert.match(app[1],/<\/body><\/html>'\);win\.document\.close\(\)/);
});
