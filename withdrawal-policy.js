// Shared withdrawal eligibility rules. No balance mutations are performed here.
export function withdrawalWindowOpen(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Amman', weekday: 'short' }).format(date);
  return day === 'Thu' || day === 'Fri';
}
export function maximumWithdrawal(balance, classification) {
  const amount = Number(balance);
  if (!Number.isFinite(amount) || amount <= 1) return 0;
  const type = String(classification || '').trim().toLowerCase().replace(/\s*\+\s*/g, '+').replace(/\s+/g, ' ');
  let max = 0;
  if (['producer', 'producer_only', 'منتج', 'منتج فقط'].includes(type)) max = amount - 1;
  else if (['both', 'producer_consumer', 'producer_and_consumer', 'منتج ومستهلك', 'منتج+مستهلك', 'producer+consumer', 'producer & consumer', 'producer-consumer'].includes(type)) max = amount * 0.7 - 1;
  return Math.max(0, Math.floor((max + Number.EPSILON) * 1000) / 1000);
}
export function validateWithdrawalRequest({ balance, classification, requestedAmount, now = new Date() }) {
  if (!withdrawalWindowOpen(now)) return { allowed: false, reason: 'طلبات السحب متاحة الخميس والجمعة فقط', maximum: 0 };
  const maximum = maximumWithdrawal(balance, classification);
  const requested = Number(requestedAmount);
  if (!Number.isFinite(requested) || requested <= 0 || requested > maximum) return { allowed: false, reason: 'المبلغ يتجاوز الحد المسموح أو غير صالح', maximum };
  return { allowed: true, maximum };
}
