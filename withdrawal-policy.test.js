import test from "node:test";
import assert from "node:assert/strict";
import { maximumWithdrawal, withdrawalWindowOpen, validateWithdrawalRequest } from "./withdrawal-policy.js";

test("producer withdrawal preserves one dinar", () => {
  assert.equal(maximumWithdrawal(10, "producer"), 9);
  assert.equal(maximumWithdrawal(1, "producer"), 0);
});

test("mixed classification applies current 70% policy minus one-dinar reserve", () => {
  assert.equal(maximumWithdrawal(10, "both"), 6);
  assert.equal(maximumWithdrawal(100, "both"), 69);
  assert.equal(maximumWithdrawal(10, "منتج+مستهلك"), 6);
});

test("consumer and unknown classifications cannot withdraw", () => {
  assert.equal(maximumWithdrawal(10, "consumer"), 0);
  assert.equal(maximumWithdrawal(10, "unclassified"), 0);
});

test("Jordan withdrawal window is Thursday and Friday only", () => {
  assert.equal(withdrawalWindowOpen(new Date("2026-10-22T12:00:00Z")), true);
  assert.equal(withdrawalWindowOpen(new Date("2026-10-23T12:00:00Z")), true);
  assert.equal(withdrawalWindowOpen(new Date("2026-10-24T12:00:00Z")), false);
});

test("withdrawal request cannot exceed the 70% limit", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(validateWithdrawalRequest({ balance:10, classification:"both", requestedAmount:7, now }).allowed, false);
  assert.equal(validateWithdrawalRequest({ balance:10, classification:"both", requestedAmount:6, now }).allowed, true);
});
