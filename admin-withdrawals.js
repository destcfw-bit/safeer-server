import { randomUUID } from "node:crypto";

// Administrative expense log only: NEVER post these expenses to captain ledgers.
export const ADMIN_WITHDRAWAL_CATEGORIES = Object.freeze({
  salary: "رواتب",
  operations: "مصاريف تشغيل",
  transport: "مواصلات",
  owner: "سحب إداري",
  other: "أخرى"
});

function invalid(message, code=400) {
  return Object.assign(new Error(message), {statusCode:code});
}

export function validExpenseDate(value) {
  const text=String(value||"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return false;
  const date=new Date(text+"T00:00:00Z");
  return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===text&&text>="2000-01-01"&&text<="2100-12-31";
}

export function validateAdminWithdrawal(body={}) {
  const expenseDate=String(body.expenseDate||"").trim();
  const category=String(body.category||"").trim();
  const title=String(body.title||"").trim();
  const beneficiary=String(body.beneficiary||"").trim();
  const reason=String(body.reason||"").trim();
  const rawAmount=String(body.amount??"").trim();
  if(!validExpenseDate(expenseDate))throw invalid("تاريخ السحب غير صالح");
  if(!Object.hasOwn(ADMIN_WITHDRAWAL_CATEGORIES,category))throw invalid("نوع المصروف غير صالح");
  if(!title||title.length>120)throw invalid("اكتب عنوانًا لا يزيد عن 120 حرفًا");
  if(beneficiary.length>120)throw invalid("اسم المستفيد طويل جدًا");
  if(!reason||reason.length>500)throw invalid("اكتب سبب المصروف (500 حرف كحد أقصى)");
  if(!/^\d{1,9}(?:\.\d{1,3})?$/.test(rawAmount))throw invalid("المبلغ يجب أن يكون رقمًا موجبًا بحد أقصى 3 خانات عشرية");
  const amount=Number(rawAmount);
  if(!Number.isFinite(amount)||amount<=0||amount>9999999.999)throw invalid("المبلغ خارج النطاق المسموح");
  const requestId=body.requestId==null||body.requestId===""?randomUUID():String(body.requestId);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId))throw invalid("معرّف العملية غير صالح");
  return {expenseDate,category,title,beneficiary,reason,amount,requestId};
}

export async function initAdminWithdrawalsSchema(db) {
  // Independent from all captain accounting and the clean-slate reset tables.
  await db.query([
    "CREATE TABLE IF NOT EXISTS admin_withdrawals (",
    "id BIGSERIAL PRIMARY KEY,",
    "expense_date DATE NOT NULL,",
    "category TEXT NOT NULL CHECK (category IN ('salary','operations','transport','owner','other')),",
    "title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),",
    "beneficiary TEXT NOT NULL DEFAULT '',",
    "reason TEXT NOT NULL,",
    "amount NUMERIC(14,3) NOT NULL CHECK (amount > 0),",
    "request_id UUID NOT NULL UNIQUE,",
    "created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,",
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
    "voided_at TIMESTAMPTZ,",
    "voided_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,",
    "void_reason TEXT",
    ");",
    "CREATE INDEX IF NOT EXISTS admin_withdrawals_date_idx ON admin_withdrawals(expense_date DESC, id DESC);"
  ].join("\n"));
}

export function registerAdminWithdrawalsRoutes(app,{db,requireRoles}) {
  const adminGuard={preHandler:[requireRoles("admin")]};

  app.get("/api/admin/withdrawals",adminGuard,async (request)=>{
    const query=request.query||{};
    const from=query.from?String(query.from):null;
    const to=query.to?String(query.to):null;
    if((from&&!validExpenseDate(from))||(to&&!validExpenseDate(to))||(from&&to&&from>to))
      throw invalid("فترة البحث غير صالحة");
    const limit=Math.max(1,Math.min(300,Number.parseInt(String(query.limit||"100"),10)||100));
    const params=[from,to,limit];
    const [listed,totals]=await Promise.all([
      db.query([
        "SELECT w.id,to_char(w.expense_date,'YYYY-MM-DD') expense_date,w.category,w.title,",
        "w.beneficiary,w.reason,w.amount,w.created_at,w.voided_at,w.void_reason,",
        "COALESCE(NULLIF(u.display_name,''),u.username,'حساب محذوف') created_by_name,",
        "COALESCE(NULLIF(v.display_name,''),v.username,'—') voided_by_name",
        "FROM admin_withdrawals w",
        "LEFT JOIN users u ON u.id=w.created_by_user_id",
        "LEFT JOIN users v ON v.id=w.voided_by_user_id",
        "WHERE ($1::date IS NULL OR w.expense_date >= $1::date)",
        "AND ($2::date IS NULL OR w.expense_date <= $2::date)",
        "ORDER BY w.expense_date DESC,w.id DESC LIMIT $3"
      ].join(" "),params),
      db.query([
        "SELECT COUNT(*) FILTER (WHERE voided_at IS NULL)::int active_count,",
        "COALESCE(SUM(amount) FILTER (WHERE voided_at IS NULL),0) total,",
        "COALESCE(SUM(amount) FILTER (WHERE voided_at IS NULL AND expense_date >= date_trunc('month',NOW() AT TIME ZONE 'Asia/Amman')::date",
        "AND expense_date < (date_trunc('month',NOW() AT TIME ZONE 'Asia/Amman') + interval '1 month')::date),0) month_total,",
        "COALESCE(SUM(amount) FILTER (WHERE voided_at IS NULL AND ($1::date IS NULL OR expense_date >= $1::date)",
        "AND ($2::date IS NULL OR expense_date <= $2::date)),0) filtered_total",
        "FROM admin_withdrawals"
      ].join(" "),[from,to])
    ]);
    const sum=totals.rows[0]||{};
    return {ok:true,rows:listed.rows,summary:{
      count:Number(sum.active_count||0),
      total:Number(sum.total||0),
      currentMonth:Number(sum.month_total||0),
      filteredTotal:Number(sum.filtered_total||0)
    }};
  });

  app.post("/api/admin/withdrawals",adminGuard,async (request,reply)=>{
    const data=validateAdminWithdrawal(request.body);
    const client=await db.connect();
    try {
      await client.query("BEGIN");
      const added=await client.query([
        "INSERT INTO admin_withdrawals(expense_date,category,title,beneficiary,reason,amount,request_id,created_by_user_id)",
        "VALUES($1::date,$2,$3,$4,$5,$6,$7::uuid,$8) ON CONFLICT(request_id) DO NOTHING RETURNING id"
      ].join(" "),[data.expenseDate,data.category,data.title,data.beneficiary,data.reason,data.amount,data.requestId,request.user.sub]);
      if(!added.rowCount){
        const existing=await client.query("SELECT id,created_by_user_id,expense_date,category,title,beneficiary,reason,amount FROM admin_withdrawals WHERE request_id=$1::uuid",[data.requestId]);
        const item=existing.rows[0];
        const same= item&&String(item.created_by_user_id)===String(request.user.sub)
          &&String(item.category)===data.category &&String(item.title)===data.title
          &&String(item.beneficiary)===data.beneficiary &&String(item.reason)===data.reason
          &&Number(item.amount)===data.amount;
        if(!same)throw invalid("هذه العملية مسجلة من قبل بمعلومات مختلفة",409);
        await client.query("COMMIT");
        return reply.send({ok:true,duplicate:true,id:item.id});
      }
      const id=added.rows[0].id;
      await client.query([
        "INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)",
        "VALUES($1,'admin_withdrawal.create','admin_withdrawal',$2,$3::jsonb)"
      ].join(" "),[request.user.sub,String(id),JSON.stringify({
        expenseDate:data.expenseDate,category:data.category,title:data.title,
        beneficiary:data.beneficiary,reason:data.reason,amount:data.amount
      })]);
      await client.query("COMMIT");
      return reply.code(201).send({ok:true,id});
    }catch(error){
      await client.query("ROLLBACK").catch(()=>{});
      throw error;
    }finally{client.release()}
  });

  app.post("/api/admin/withdrawals/:id/void",adminGuard,async (request)=>{
    const id=String(request.params?.id||"");
    if(!/^[1-9]\d{0,17}$/.test(id))throw invalid("معرّف السحب غير صالح");
    const reason=String(request.body?.reason||"").trim();
    if(!reason||reason.length>300)throw invalid("اكتب سبب إلغاء القيد (300 حرف كحد أقصى)");
    const client=await db.connect();
    try{
      await client.query("BEGIN");
      const updated=await client.query([
        "UPDATE admin_withdrawals SET voided_at=NOW(),voided_by_user_id=$2,void_reason=$3",
        "WHERE id=$1 AND voided_at IS NULL RETURNING id"
      ].join(" "),[id,request.user.sub,reason]);
      if(!updated.rowCount)throw invalid("القيد غير موجود أو ملغى مسبقًا",409);
      await client.query([
        "INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details)",
        "VALUES($1,'admin_withdrawal.void','admin_withdrawal',$2,$3::jsonb)"
      ].join(" "),[request.user.sub,id,JSON.stringify({reason})]);
      await client.query("COMMIT");
      return {ok:true,id};
    }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error}
    finally{client.release()}
  });
}
