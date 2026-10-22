import { db } from './db.js';

export async function weeklyParticipantsReport() {
  const now = new Date();
  const local = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Amman',year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now);
  const get = type => local.find(x=>x.type===type)?.value;
  const day = new Date(Date.UTC(Number(get('year')),Number(get('month'))-1,Number(get('day'))));
  const daysSinceFriday = (day.getUTCDay()-5+7)%7;
  day.setUTCDate(day.getUTCDate()-daysSinceFriday);
  const start = day.toISOString().slice(0,10);
  day.setUTCDate(day.getUTCDate()+7);
  const end = day.toISOString().slice(0,10);
  const rows = await db.query(`
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
  const captains=rows.rows.map(r=>({id:r.id,name:r.name,phone:r.phone,interactions:Number(r.interactions)}));
  const floor=1.5;
  return {start,end,captains,count:captains.length,floor,estimatedTotal:Number((captains.length*floor).toFixed(3)),note:'تقرير تقديري للحركات المحاسبية الفعلية، دون خصم أرصدة'};
}
