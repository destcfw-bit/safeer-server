import test from 'node:test';
import assert from 'node:assert/strict';
import { maximumWithdrawal, withdrawalWindowOpen } from './withdrawal-policy.js';
test('producer reserve',()=>assert.equal(maximumWithdrawal(10,'producer'),9));
test('mixed reserve',()=>assert.equal(maximumWithdrawal(10,'both'),4));
test('consumer cannot withdraw',()=>assert.equal(maximumWithdrawal(10,'consumer'),0));
test('Jordan Thursday',()=>assert.equal(withdrawalWindowOpen(new Date('2026-10-22T12:00:00Z')),true));
test('Jordan Saturday',()=>assert.equal(withdrawalWindowOpen(new Date('2026-10-24T12:00:00Z')),false));
