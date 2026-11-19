// API surface: RPC allowlist (mirrors the functions granted to "authenticated")
// and named read queries. All of it runs through asUser() → RLS applies.
import { j } from './db.js';

// kind: one = returns a value/row, set = returns rows, void = returns nothing
export const RPC = {
  save_pricing_plan: ['one', ['p', 'p_reason']],
  save_daily_bonus: ['one', ['p_date', 'p_manager', 'p', 'p_reason']],
  inventory_report: ['one', ['p_from', 'p_to', 'p_manager', 'p_promoter']],
  delete_pricing_plan: ['void', ['p_effective_from', 'p_reason']],
  preview_payroll: ['one', ['p_promoter', 'p_week']],
  upsert_promoter: ['one', ['p']],
  archive_promoter: ['void', ['p_id', 'p_reason']],
  reassign_promoters: ['one', ['p_to', 'p_ids', 'p_reason']],
  save_registrations: ['one', ['p_date', 'p_entries', 'p_reason']],
  save_incentive_rule: ['one', ['p_dates', 'p_rule', 'p_reason']],
  clear_incentive_rule: ['one', ['p_dates', 'p_reason']],
  generate_payrolls: ['one', ['p_week', 'p_manager']],
  approve_payrolls: ['one', ['p_ids']],
  reopen_payroll: ['void', ['p_id', 'p_reason']],
  pay_payroll: ['one', ['p_id', 'p_amount', 'p_method', 'p_reference', 'p_paid_at', 'p_notes', 'p_idempotency_key']],
  adjust_payroll: ['one', ['p_id', 'p_reason']],
  add_ledger_entry: ['one', ['p']],
  review_ledger_entry: ['void', ['p_id', 'p_decision', 'p_note']],
  void_ledger_entry: ['void', ['p_id', 'p_reason']],
  add_expense: ['one', ['p']],
  void_expense: ['void', ['p_id', 'p_reason']],
  get_dashboard: ['one', ['p_from', 'p_to', 'p_manager']],
  report_performance: ['set', ['p_from', 'p_to', 'p_manager']],
  expense_summary: ['set', ['p_from', 'p_to', 'p_group', 'p_manager']],
  update_manager: ['one', ['p_id', 'p']],
  set_manager_status: ['void', ['p_id', 'p_status', 'p_reason']],
  update_settings: ['one', ['p']],
  add_expense_category: ['void', ['p_key', 'p_name_ar', 'p_name_en']],
  store_attachment: ['one', ['p_mime', 'p_data_b64', 'p_manager']],
  get_attachment: ['one', ['p_id']],
};

// Parameters declared as PostgreSQL arrays (uuid[], date[], int[]); every other array/object is JSON.
const PG_ARRAYS = new Set(['p_ids', 'p_dates', 'p_counts']);

/** JS value → text parameter. */
function param(v, name) {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v) && PG_ARRAYS.has(name)) return '{' + v.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export async function callRpc(client, fn, args = {}) {
  const def = RPC[fn];
  if (!def) { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  const [kind, allowed] = def;
  const names = allowed.filter((k) => Object.prototype.hasOwnProperty.call(args, k));
  const params = names.map((k) => param(args[k], k));
  const call = `public.${fn}(${names.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  if (kind === 'set') return j(client, `select coalesce(json_agg(t), '[]'::json) as j from ${call} t`, params);
  if (kind === 'void') { await client.query(`select ${call}`, params); return null; }
  return j(client, `select to_json(${call}) as j`, params);
}

// ------------------------------------------------------------------ reads
const list = (sql) => `select coalesce(json_agg(t), '[]'::json) as j from (${sql}) t`;
const row = (sql) => `select row_to_json(t) as j from (${sql}) t`;
const P = (v) => (v === undefined || v === '' ? null : v);

export const QUERIES = {
  me: () => [row('select * from public.profiles where id = auth.uid()'), []],
  settings: () => [row('select * from public.settings where id = 1'), []],
  categories: () => [list('select * from public.expense_categories order by sort_order, key'), []],
  prefs: () => [`select prefs as j from public.user_preferences where user_id = auth.uid()`, []],
  managers: () => [list(`select m.*, (select count(*) from public.promoters p where p.manager_id = m.id and p.deleted_at is null)::int as promoters_count
    from public.profiles m where m.role = 'manager' and m.status <> 'deleted' order by m.full_name`), []],
  promoters: ({ search, managerId, status, balance } = {}) => [list(`select * from public.promoter_balances
     where ($1::uuid is null or manager_id = $1) and ($2::text is null or status::text = $2)
       and ($3::text is null or full_name ilike '%' || $3 || '%' or (regexp_replace($3, '\\D', '', 'g') <> '' and phone like '%' || regexp_replace($3, '\\D', '', 'g') || '%'))
       and ($4::text is null or ($4 = 'debt' and debt_balance > 0) or ($4 = 'no_debt' and debt_balance <= 0) or ($4 = 'unpaid' and unpaid_salary > 0))
     order by full_name`), [P(managerId), P(status), P(search?.trim()), P(balance)]],
  promoter: ({ id }) => [`select json_build_object(
      'promoter', (select row_to_json(b) from public.promoter_balances b where b.id = $1),
      'registrations', coalesce((select json_agg(r order by r.work_date desc) from (select * from public.registrations where promoter_id = $1 order by work_date desc limit 400) r), '[]'),
      'ledger', coalesce((select json_agg(l order by l.entry_date desc, l.created_at desc) from public.ledger_entries l where l.promoter_id = $1), '[]'),
      'payrolls', coalesce((select json_agg(o order by o.week_start desc) from public.payroll_overview o where o.promoter_id = $1), '[]'),
      'history', coalesce((select json_agg(h order by h.changed_at desc) from (select * from public.registration_history where promoter_id = $1 order by changed_at desc limit 200) h), '[]'),
      'payments', coalesce((select json_agg(x order by x.paid_at desc) from public.payroll_payments x where x.promoter_id = $1), '[]')
    ) as j`, [id]],
  day: ({ date, managerId }) => [`select json_build_object(
      'promoters', coalesce((select json_agg(p order by p.full_name) from (select id, full_name, phone, status, start_date, manager_id from public.promoters
                     where deleted_at is null and ($2::uuid is null or manager_id = $2)) p), '[]'),
      'regs', coalesce((select json_agg(r) from public.registrations r where r.work_date = $1::date and ($2::uuid is null or r.manager_id = $2)), '[]'),
      'locked', coalesce((select json_object_agg(promoter_id, status) from public.payrolls where week_start = public.week_start_of($1::date)
                     and status <> 'pending' and ($2::uuid is null or manager_id = $2)), '{}'),
      'rule', (select row_to_json(ir) from public.incentive_rules ir where ir.work_date = $1::date),
      'plan', public.plan_for_week($1::date),
      'bonuses', coalesce((select json_agg(b) from public.daily_bonuses b where b.work_date = $1::date and ($2::uuid is null or b.manager_id = $2)), '[]'),
      'week_regs', coalesce((select json_agg(w) from (select promoter_id, work_date, reg_count, active_count from public.registrations
                     where week_start = public.week_start_of($1::date) and ($2::uuid is null or manager_id = $2)) w), '[]')) as j`, [date, P(managerId)]],
  plans: () => [list('select * from public.pricing_plans order by effective_from desc'), []],
  debt_entries: ({ promoterId, managerId, from, to, status } = {}) => [list(`select l.*, p.full_name as promoter_name, p.phone as promoter_phone
      from public.ledger_entries l join public.promoters p on p.id = l.promoter_id
      where l.category in ('opening_debt','debt','debt_repayment')
        and ($1::uuid is null or l.promoter_id = $1) and ($2::uuid is null or l.manager_id = $2)
        and ($3::date is null or l.entry_date >= $3) and ($4::date is null or l.entry_date <= $4) and ($5::text is null or l.status::text = $5)
      order by l.entry_date desc, l.created_at desc limit 2000`), [P(promoterId), P(managerId), P(from), P(to), P(status)]],
  reg_history: ({ promoterId }) => [list('select * from public.registration_history where promoter_id = $1 order by changed_at desc'), [promoterId]],
  rules: ({ from, to }) => [list('select * from public.incentive_rules where work_date between $1::date and $2::date'), [from, to]],
  locked_weeks: ({ from, to }) => [`select coalesce(json_agg(distinct week_start), '[]'::json) as j from public.payrolls where status <> 'pending' and week_start between $1::date and $2::date`, [from, to]],
  payrolls: ({ weekStart, managerId, status }) => [list(`select * from public.payroll_overview where week_start = $1::date
      and ($2::uuid is null or manager_id = $2) and ($3::text is null or status::text = $3) order by promoter_name`), [weekStart, P(managerId), P(status)]],
  payroll: ({ id }) => [`select json_build_object(
      'payroll', (select row_to_json(o) from public.payroll_overview o where o.id = $1),
      'payments', coalesce((select json_agg(x order by x.paid_at) from public.payroll_payments x where x.payroll_id = $1), '[]'),
      'adjustments', coalesce((select json_agg(a order by a.created_at) from public.payroll_adjustments a where a.payroll_id = $1), '[]')) as j`, [id]],
  ledger: ({ promoterId, managerId, from, to, category, status, limit = 500 } = {}) => [list(`select l.*, p.full_name as promoter_name
      from public.ledger_entries l join public.promoters p on p.id = l.promoter_id
      where ($1::uuid is null or l.promoter_id = $1) and ($2::uuid is null or l.manager_id = $2)
        and ($3::date is null or l.entry_date >= $3) and ($4::date is null or l.entry_date <= $4)
        and ($5::text is null or l.category::text = $5) and ($6::text is null or l.status::text = $6)
      order by l.entry_date desc, l.created_at desc limit least($7::int, 2000)`), [P(promoterId), P(managerId), P(from), P(to), P(category), P(status), limit]],
  expenses: ({ from, to, managerId, category } = {}) => [list(`select e.*, p.full_name as promoter_name from public.expenses e
      left join public.promoters p on p.id = e.charged_promoter_id
      where e.expense_date between $1::date and $2::date and ($3::uuid is null or e.manager_id = $3) and ($4::text is null or e.category = $4)
      order by e.expense_date desc, e.created_at desc`), [from, to, P(managerId), P(category)]],
  audit: ({ table, from, to, limit = 100, offset = 0 } = {}) => [list(`select * from public.audit_log
      where ($1::text is null or table_name = $1)
        and ($2::date is null or at >= ($2::date)::timestamp at time zone 'Asia/Baghdad')
        and ($3::date is null or at < ($3::date + 1)::timestamp at time zone 'Asia/Baghdad')
      order by at desc limit least($4::int, 500) offset $5::int`), [P(table), P(from), P(to), limit, offset]],
};

export async function runQuery(client, name, args = {}) {
  const q = QUERIES[name];
  if (!q) { const e = new Error('NOT_FOUND'); e.status = 404; throw e; }
  const [sql, params] = q(args || {});
  return j(client, sql, params);
}
