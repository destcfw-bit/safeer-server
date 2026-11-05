// Financial reporting ONLY. This module never changes captain balances or ledger rows.
// Floor charges are attributed to their original Friday-Thursday accounting week.
export const FLOOR_DEDUCTIONS_SQL = `
WITH amman_today AS (
  SELECT (NOW() AT TIME ZONE 'Asia/Amman')::date AS today
), week_bounds AS (
  SELECT today - ((EXTRACT(DOW FROM today)::int + 2) % 7) AS week_start
  FROM amman_today
), floor_charges AS (
  SELECT le.id, le.amount
  FROM ledger_entries le CROSS JOIN week_bounds w
  WHERE le.reversed_at IS NULL
    AND le.entry_type='WEEKLY_DEDUCTION'
    AND le.amount<0
    AND COALESCE(le.metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_THURSDAY_DEDUCTION')
    AND (
      CASE
        WHEN COALESCE(le.metadata->>'weekStart','') ~ '^\\d{4}-\\d{2}-\\d{2}$'
          THEN (le.metadata->>'weekStart')::date = w.week_start
        ELSE (le.created_at AT TIME ZONE 'Asia/Amman')::date >= w.week_start
             AND (le.created_at AT TIME ZONE 'Asia/Amman')::date < w.week_start + 7
      END
    )
), floor_refunds AS (
  SELECT COALESCE(SUM(refund.amount),0) AS refunded
  FROM ledger_entries refund
  JOIN floor_charges charge ON (
    (refund.reference_type='safeer_half_floor_refund' AND refund.reference_id=charge.id::text)
    OR (COALESCE(refund.metadata->>'type','')='WEEKLY_FLOOR_PARTIAL_REFUND'
        AND refund.metadata->>'originalFloorEntryId'=charge.id::text)
  )
  WHERE refund.reversed_at IS NULL AND refund.amount>0
), floor_totals AS (
  SELECT COALESCE(SUM(-amount),0) AS gross, COUNT(*)::int AS charge_count
  FROM floor_charges
)
SELECT to_char(w.week_start,'YYYY-MM-DD') AS week_start,
       to_char(w.week_start + 6,'YYYY-MM-DD') AS week_end,
       t.charge_count,
       t.gross::numeric(16,3) AS gross,
       r.refunded::numeric(16,3) AS refunds,
       (t.gross-r.refunded)::numeric(16,3) AS net_floor_deductions
FROM week_bounds w CROSS JOIN floor_totals t CROSS JOIN floor_refunds r
`;

export function registerFloorDeductionReport(app,{db,requireRoles}) {
  app.get('/api/dashboard/floor-deductions',
    {preHandler:[requireRoles('admin','accountant')]},
    async () => {
      const result=await db.query(FLOOR_DEDUCTIONS_SQL);
      const row=result.rows[0]||{};
      return {
        ok:true,
        amount:Number(row.net_floor_deductions||0),
        charges:Number(row.charge_count||0),
        gross:Number(row.gross||0),
        refunded:Number(row.refunds||0),
        weekStart:row.week_start||null,
        weekEnd:row.week_end||null,
        basis:'current_friday_thursday_actual_active_floors_net_of_linked_refunds',
        currency:'JOD'
      };
    });
}
