// Read-only aggregation of actual posted weekly floor charges.
export const FLOOR_DEDUCTIONS_SQL = `
 SELECT
   COALESCE(SUM(CASE
     WHEN le.entry_type='WEEKLY_DEDUCTION' AND le.amount<0
       AND COALESCE(le.metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_THURSDAY_DEDUCTION')
       THEN -le.amount
     WHEN le.amount>0 AND (le.reference_type='safeer_half_floor_refund'
       OR COALESCE(le.metadata->>'type','')='WEEKLY_FLOOR_PARTIAL_REFUND')
       THEN -le.amount
     ELSE 0 END),0)::numeric(16,3) AS net_floor_deductions,
   COUNT(*) FILTER (WHERE le.entry_type='WEEKLY_DEDUCTION' AND le.amount<0
     AND COALESCE(le.metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_THURSDAY_DEDUCTION'))::int AS charge_count
 FROM ledger_entries le WHERE le.reversed_at IS NULL
`;
export function registerFloorDeductionReport(app,{db,requireRoles}) {
 app.get('/api/dashboard/floor-deductions',
   {preHandler:[requireRoles('admin','accountant')]},
   async ()=>{
     const result=await db.query(FLOOR_DEDUCTIONS_SQL);
     const row=result.rows[0]||{};
     return {ok:true,amount:Number(row.net_floor_deductions||0),
       charges:Number(row.charge_count||0),
       basis:'posted_active_floor_debits_minus_active_partial_refunds',currency:'JOD'};
   });
}
