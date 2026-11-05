import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';

const src=readFileSync(new URL('../withdrawal-service.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../Accountant.html',import.meta.url),'utf8');

test('a pending withdrawal can be cancelled once without a ledger debit',()=>{
 assert.match(src,/\['transferred','kept','cancelled'\]/);
 assert.match(src,/status==='kept'\|\|status==='cancelled'/);
 assert.match(src,/if\(!\['pending','approved'\]\.includes\(item\.status\)\)/);
 assert.match(src,/if\(item\.status!=='pending'\)/);
 assert.match(src,/UPDATE captain_withdrawal_requests SET status=\$4/);
 const before=src.indexOf("if(status==='kept'||status==='cancelled')");
 const after=src.indexOf("}else if(item.status==='pending')",before);
 const cancellation=src.slice(before,after);
 assert.doesNotMatch(cancellation,/INSERT INTO ledger_entries/);
});

test('request holds its original classification; older requests use request week',()=>{
 assert.match(src,/classification_at_request TEXT/);
 assert.match(src,/classification_at_request\) VALUES/);
 assert.match(src,/weeklyClassifications\(c,new Date\(item\.created_at\)\)/);
 assert.match(src,/classification=item\.classification_at_request\|\|historical/);
 assert.match(src,/maximumWithdrawal\(funds\.eligible,classification\)/);
});

test('request avoids immediate duplicate entries and shows protected-funds detail',()=>{
 assert.match(src,/created_at > NOW\(\)-INTERVAL '90 seconds'/);
 assert.match(src,/if\(duplicate\.rowCount\)throw Error/);
 assert.match(src,/المطلوب/);
 assert.match(src,/المتاح حاليًا/);
 assert.match(src,/الرصيد المحمي/);
 assert.match(src,/throw Error\('لا يمكن تحويل المبلغ كاملًا/);
});

test('accountant screen includes cancellation tab, confirmation and double-click protection',()=>{
 assert.match(html,/\['cancelled','🚫 الملغاة'\]/);
 assert.match(html,/\['cancelled','🚫 إلغاء الطلب'\]/);
 assert.match(html,/actions\.querySelectorAll\('button'\)\.forEach\(b=>b\.disabled=true\)/);
 const scripts=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1]);
 assert.ok(scripts.some(s=>s.includes('reviewCaptainWithdrawal')));
 const core=/<script\b[^>]*id="accountantAppCode"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
 assert.ok(core);
 assert.doesNotThrow(()=>new Script(core[1]));
});
