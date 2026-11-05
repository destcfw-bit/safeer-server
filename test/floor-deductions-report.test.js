import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {FLOOR_DEDUCTIONS_SQL,registerFloorDeductionReport} from '../floor-deductions-report.js';

test('floor report counts posted deduction entries, not guessed participant counts',()=>{
  assert.match(FLOOR_DEDUCTIONS_SQL,/FROM ledger_entries le/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/entry_type='WEEKLY_DEDUCTION'/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/WEEKLY_FLOOR/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/WEEKLY_THURSDAY_DEDUCTION/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/reversed_at IS NULL/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/safeer_half_floor_refund/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/AT TIME ZONE 'Asia\/Amman'/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/EXTRACT\(DOW FROM today\)::int \+ 2/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/metadata->>'weekStart'/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/JOIN floor_charges charge/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/week_start \+ 6/);
  assert.match(FLOOR_DEDUCTIONS_SQL,/WEEKLY_FLOOR_PARTIAL_REFUND/);
  assert.doesNotMatch(FLOOR_DEDUCTIONS_SQL,/UPDATE|DELETE|INSERT|COUNT\(\*\)\s*\*/i);
});

test('floor summary API is read-only and role-restricted',async()=>{
 let guard;
 let handler;
 const app={get:(path,settings,callback)=>{
  assert.equal(path,'/api/dashboard/floor-deductions');
  assert.equal(settings.preHandler.length,1);
  handler=callback;
 }};
 const queries=[];
 const db={query:async sql=>{queries.push(sql);return {rows:[{net_floor_deductions:'14.500',charge_count:11,gross:'15.000',refunds:'0.500',week_start:'2026-10-30',week_end:'2026-11-05'}]}}};
 registerFloorDeductionReport(app,{db,requireRoles:(...roles)=>{guard=roles;return()=>{}}});
 assert.deepEqual(guard,['admin','accountant']);
 const result=await handler();
 assert.deepEqual(result,{ok:true,amount:14.5,charges:11,gross:15,refunded:0.5,weekStart:'2026-10-30',weekEnd:'2026-11-05',basis:'current_friday_thursday_actual_active_floors_net_of_linked_refunds',currency:'JOD'});
 assert.deepEqual(queries,[FLOOR_DEDUCTIONS_SQL]);
});

test('dashboard has one actual-floor tile, compiles and fetches protected totals',()=>{
 const html=readFileSync(new URL('../Accountant.html',import.meta.url),'utf8');
 assert.equal(html.split("floorStat.id='floorDeductionsCard'").length-1,1); // Created dynamically by renderStats
 assert.match(html,/أرضيات الأسبوع الحالي/);
 assert.match(html,/من الجمعة إلى نهاية الخميس/);
 assert.match(html,/fetch\('\/api\/dashboard\/floor-deductions',\{headers:\{Authorization:'Bearer '\+floorToken\}\}\)/);
 assert.match(html,/target\.textContent=money\(data\.amount\)/);
 assert.match(html,/data\.weekStart&&data\.weekEnd/);
 const core=/<script\b[^>]*id="accountantAppCode"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
 assert.ok(core);
 assert.doesNotThrow(()=>new Script(core[1],{filename:'Accountant.html'}));
});
