import { db } from './db.js';

// Read-only Friday–Thursday report (Asia/Amman): floor amounts come from
// actual active ledger deductions, net of refunds linked to those deductions.
export async function weeklyParticipantsReport(selectedWeek = '') {
  const requested = String(selectedWeek || '').trim();
  if (requested && !/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw new Error('تاريخ الأسبوع غير صالح');
  const localToday = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const chosen = requested || localToday;
  const date = new Date(chosen + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== chosen) throw new Error('تاريخ الأسبوع غير صالح');
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() - 5 + 7) % 7));
  const start = date.toISOString().slice(0,10);
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 7);
  const end = next.toISOString().slice(0,10);
  if (start > localToday) throw new Error('لا يمكن اختيار أسبوع مستقبلي');

  const activity = await db.query(`
    SELECT c.id,c.name,c.phone,
           COUNT(DISTINCT COALESCE(NULLIF(le.metadata->>'canonicalDoneMessageId',''),NULLIF(le.metadata->>'doneMessageId',''),le.reference_id,le.id::text))::int AS interactions
    FROM ledger_entries le
    JOIN captains c ON c.id=le.captain_id
    WHERE le.entry_type IN ('PRODUCTION','CONSUMPTION')
      AND le.reference_type IN ('green_reaction','green_partial')
      AND le.reversed_at IS NULL
      AND le.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Amman')
      AND le.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Amman')
      AND NOT EXISTS (SELECT 1 FROM ledger_entries rev WHERE rev.reversed_entry_id=le.id AND rev.reversed_at IS NULL)
    GROUP BY c.id,c.name,c.phone
    ORDER BY interactions DESC,c.name
  `,[start,end]);

  // Assign a deduction to the accounting week on the entry, not simply
  // the day the scheduled job happened to execute.
  const floors = await db.query(`
    WITH charges AS (
      SELECT le.id,le.captain_id,-le.amount AS charged
      FROM ledger_entries le
      WHERE le.reversed_at IS NULL AND le.entry_type='WEEKLY_DEDUCTION'
        AND le.amount<0
        AND COALESCE(le.metadata->>'type','') IN ('WEEKLY_FLOOR','WEEKLY_THURSDAY_DEDUCTION')
        AND (
          CASE
            WHEN COALESCE(le.metadata->>'weekStart','') ~ '^\\d{4}-\\d{2}-\\d{2}$'
              THEN le.metadata->>'weekStart'=$1
            WHEN COALESCE(le.metadata->>'weekEnd','') ~ '^\\d{4}-\\d{2}-\\d{2}$'
              THEN le.metadata->>'weekEnd'=$3
            ELSE le.created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Amman')
              AND le.created_at < ($2::date::timestamp AT TIME ZONE 'Asia/Amman')
          END
        )
    ), linked_refunds AS (
      SELECT charge.id,COALESCE(SUM(refund.amount),0) AS refunded
      FROM charges charge
      LEFT JOIN ledger_entries refund
        ON refund.reversed_at IS NULL AND refund.amount>0
        AND (
          (refund.reference_type='safeer_half_floor_refund' AND refund.reference_id=charge.id::text)
          OR (refund.metadata->>'type'='WEEKLY_FLOOR_PARTIAL_REFUND'
              AND refund.metadata->>'originalFloorEntryId'=charge.id::text)
        )
      GROUP BY charge.id
    )
    SELECT charge.captain_id,
           SUM(charge.charged-COALESCE(refund.refunded,0))::numeric(16,3) AS amount,
           COUNT(*)::int AS charge_count
    FROM charges charge LEFT JOIN linked_refunds refund ON refund.id=charge.id
    GROUP BY charge.captain_id
  `,[start,end,new Date(new Date(end+'T00:00:00Z').getTime()-86400000).toISOString().slice(0,10)]);

  const byCaptain = new Map(floors.rows.map(row=>[String(row.captain_id),Number(row.amount)]));
  const captains = activity.rows.map(r=>({
    id:r.id,name:r.name,phone:r.phone,interactions:Number(r.interactions),
    actualFloor:Number((byCaptain.get(String(r.id))||0).toFixed(3))
  }));
  const actualTotal = Number(floors.rows.reduce((sum,r)=>sum+Number(r.amount||0),0).toFixed(3));
  return {start,end,captains,count:captains.length,actualTotal,
    chargedCaptains:floors.rows.filter(r=>Number(r.amount)>0).length,
    chargeCount:floors.rows.reduce((sum,r)=>sum+Number(r.charge_count||0),0),
    note:'الأرضية الفعلية المسجلة في دفتر الحركات بعد الاسترجاعات؛ التقرير للعرض فقط ولا يغير الأرصدة'};
}
