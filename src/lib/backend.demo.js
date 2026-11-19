// DEMO backend — runs entirely in the browser (localStorage) so the app can be tried
// without a server. It applies the SAME rules as the database (duplicate protection,
// week locking, immutable ledger, adjustments) using the shared engine.
// Clearly labelled in the UI; never used when Supabase is configured.
import { computePayroll, debtBalance, payrollEffective, PAYROLL_CATEGORIES, planForWeek, DEFAULT_PLAN } from '../engine/payroll.js';
import { normalizeRule, calcDailyIncentive, calcDailyBonus } from '../engine/incentives.js';
import { baghdadToday, weekStartOf, addDays, diffDays, eachDay, payrollMonthOf } from '../engine/dates.js';

const KEY = 'salesapp-demo-v4';
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const nowISO = () => new Date().toISOString();
const clone = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function err(code, detail = '') { const e = new Error(code); e.code = code; e.detail = String(detail); throw e; }
function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return Math.abs(h | 0); }

export const DEMO_USERS = [
  { id: 'demo-admin', email: 'admin@demo.iq', role: 'super_admin', full_name: 'أبو مهدي — المدير العام', phone: '07800000001' },
  { id: 'demo-m1', email: 'karrar@demo.iq', role: 'manager', full_name: 'كرار الساعدي', phone: '07700000011' },
  { id: 'demo-m2', email: 'noor@demo.iq', role: 'manager', full_name: 'نور الربيعي', phone: '07700000022' },
  { id: 'demo-m3', email: 'haider@demo.iq', role: 'manager', full_name: 'حيدر البصري', phone: '07700000033' },
];

export function createDemoBackend() {
  let S = load();
  let listeners = [];
  let seeding = false;
  let me = () => S.profiles.find((p) => p.id === S.session && p.status === 'active') || null;

  function load() { try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 4) return s; } catch { /* */ } return null; }
  function persist() { if (seeding) return; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* quota */ } }
  const settings = () => S.settings;

  // ---------- auth helpers
  const role = () => { if (!S.session) err('NOT_AUTHENTICATED'); const m = me(); if (!m) err('ACCOUNT_INACTIVE'); return m.role; };
  const isAdmin = () => me()?.role === 'super_admin';
  const canAccess = (mid) => isAdmin() || (me()?.role === 'manager' && mid === S.session);
  const assertMgr = (mid) => { role(); if (!canAccess(mid)) err('FORBIDDEN'); };
  const scope = (mid) => (role() === 'super_admin' ? mid || null : S.session);
  const promoter = (id) => { const p = S.promoters.find((x) => x.id === id && !x.deleted_at); if (!p) err('NOT_FOUND', 'promoter'); return p; };
  const assertPromoter = (id) => { role(); const p = promoter(id); assertMgr(p.manager_id); return p; };
  const today = () => baghdadToday();
  const audit = (table, action, row, oldRow, reason) => S.audit.unshift({
    id: S.audit.length + 1, at: nowISO(), actor: S.session, action, table_name: table, row_id: String(row?.id ?? row?.work_date ?? oldRow?.id ?? ''),
    manager_id: row?.manager_id ?? oldRow?.manager_id ?? null, old_data: oldRow ? clone(oldRow) : null, new_data: row ? clone(row) : null, reason: reason || null });
  const isInt = (v) => /^-?\d{1,15}$/.test(String(v));
  const weekLocked = (pid, d) => S.payrolls.some((p) => p.promoter_id === pid && p.week_start === weekStartOf(d) && p.status !== 'pending');

  // ---------- engine glue
  function computeFor(pid, week) {
    const p = S.promoters.find((x) => x.id === pid);
    const ws = weekStartOf(week);
    const regs = S.registrations.filter((r) => r.promoter_id === pid && r.week_start === ws);
    const rules = {};
    const bonuses = {};
    for (let i = 0; i < 7; i++) { const d = addDays(ws, i); if (S.rules[d]) rules[d] = S.rules[d]; const b = S.bonuses[d + '|' + p.manager_id]; if (b) bonuses[d] = b; }
    return computePayroll({ promoter: p, week: ws, registrations: regs, rules, bonuses, ledger: S.ledger.filter((e) => e.promoter_id === pid), plan: planForWeek(S.plans, ws) });
  }
  function overview(p) {
    const pr = S.promoters.find((x) => x.id === p.promoter_id);
    const m = S.profiles.find((x) => x.id === p.manager_id);
    const eff = payrollEffective(p, S.adjustments.filter((a) => a.payroll_id === p.id), S.payments.filter((x) => x.payroll_id === p.id));
    return { ...p, ...eff, promoter_name: pr?.full_name, promoter_phone: pr?.phone, manager_name: m?.full_name, payroll_month: payrollMonthOf(p.week_start),
      week_end: addDays(p.week_start, 6), pay_date: addDays(p.week_start, 10) };
  }
  function refreshPayroll(pid, date) {
    const c = computeFor(pid, date);
    let p = S.payrolls.find((x) => x.promoter_id === pid && x.week_start === c.week_start);
    if (!p) {
      if (c.reg_count === 0 && c.entries.length === 0) return null;
      p = { id: uid(), promoter_id: pid, manager_id: c.manager_id, week_start: c.week_start, status: 'pending', carry_forward_debt: 0, payable_amount: 0,
            needs_recalc: false, created_at: nowISO(), approved_at: null, paid_at: null, payment_method: null, payment_reference: null, carry_entry_id: null };
      S.payrolls.push(p); audit('payrolls', 'INSERT', p);
    }
    if (p.status === 'pending') {
      Object.assign(p, pick(c), { payable_amount: Math.max(c.net_amount, 0), snapshot: c, needs_recalc: false, computed_at: nowISO() });
    } else {
      const eff = overview(p).effective_net;
      if (c.net_amount !== eff) p.needs_recalc = true;
    }
    return p.id;
  }
  const pick = (c) => ({ reg_count: c.reg_count, active_count: c.active_count, bonus_applied: c.bonus_applied, daily_bonus_amount: c.daily_bonus_amount, base_amount: c.base_amount, incentive_amount: c.incentive_amount, bonus_amount: c.bonus_amount,
    correction_amount: c.correction_amount, withdrawal_amount: c.withdrawal_amount, advance_amount: c.advance_amount, deduction_amount: c.deduction_amount,
    debt_repayment_amount: c.debt_repayment_amount, gross_amount: c.gross_amount, total_deductions: c.total_deductions, net_amount: c.net_amount });

  function balances(p) {
    const L = S.ledger.filter((e) => e.promoter_id === p.id && e.status === 'approved');
    const sum = (c) => L.filter((e) => e.category === c).reduce((s, e) => s + e.amount, 0);
    const regs = S.registrations.filter((r) => r.promoter_id === p.id);
    const unpaid = S.payrolls.filter((x) => x.promoter_id === p.id && ['approved', 'adjusted'].includes(x.status)).reduce((s, x) => s + overview(x).outstanding, 0);
    const last = regs.filter((r) => r.reg_count > 0).map((r) => r.work_date).sort().pop() || null;
    return { ...p, manager_name: S.profiles.find((m) => m.id === p.manager_id)?.full_name, lifetime_registrations: regs.reduce((s, r) => s + r.reg_count, 0),
      last_registration_date: last, opening_debt: sum('opening_debt'), new_debt: sum('debt'), debt_repaid: sum('debt_repayment'), debt_balance: debtBalance(L),
      withdrawals_total: sum('withdrawal'), advances_total: sum('advance'), bonuses_total: sum('bonus'), salary_paid_total: sum('salary_payment'), unpaid_salary: unpaid };
  }

  // ---------- API (same surface as the Supabase backend)
  const api = {
    kind: 'demo',
    demoUsers: DEMO_USERS,
    async getSessionUser() { return S?.session ? { id: S.session } : null; },
    onAuthChange(cb) { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; },
    async signIn(email) {
      if (!S) S = seed();
      const u = S.profiles.find((p) => p.email === String(email).trim().toLowerCase());
      if (!u) { const e = new Error('login_failed'); e.code = 'LOGIN'; throw e; }
      S.session = u.id; persist(); listeners.forEach((l) => l({ id: u.id }));
    },
    async signOut() { if (S) { S.session = null; persist(); } listeners.forEach((l) => l(null)); },
    async me() { await sleep(60); return S?.session ? clone(S.profiles.find((p) => p.id === S.session)) : null; },
    async resetDemo() { localStorage.removeItem(KEY); S = seed(); persist(); },

    async getSettings() { role(); return clone(settings()); },
    async updateSettings(p) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      for (const k of ['base_rate', 'default_extra_amount', 'max_daily_registrations']) if (p[k] != null && (!isInt(p[k]) || Number(p[k]) < 0)) err('VALIDATION', k);
      const old = clone(S.settings);
      Object.assign(S.settings, { company_name: p.company_name?.trim() || S.settings.company_name,
        base_rate: p.base_rate != null ? Number(p.base_rate) : S.settings.base_rate,
        default_extra_amount: p.default_extra_amount != null ? Number(p.default_extra_amount) : S.settings.default_extra_amount,
        ledger_requires_approval: p.ledger_requires_approval ?? S.settings.ledger_requires_approval,
        max_daily_registrations: p.max_daily_registrations != null ? Number(p.max_daily_registrations) : S.settings.max_daily_registrations });
      audit('settings', 'UPDATE', S.settings, old); persist(); return clone(S.settings);
    },
    async expenseCategories() { return clone(S.categories); },
    async addExpenseCategory(key, nameAr, nameEn) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      if (!/^[a-z0-9_]{2,40}$/.test(key)) err('VALIDATION', 'key');
      if (S.categories.some((c) => c.key === key)) err('DUPLICATE');
      S.categories.push({ key, name_ar: nameAr, name_en: nameEn, is_system: false, sort_order: 100 }); persist();
    },
    async getPrefs() { return S?.prefs?.[S.session] ?? null; },
    async savePrefs(prefs) { if (!S?.session) return; S.prefs[S.session] = prefs; persist(); },

    async listManagers() {
      await sleep(120); role(); if (!isAdmin()) err('FORBIDDEN');
      return S.profiles.filter((p) => p.role === 'manager' && p.status !== 'deleted')
        .map((m) => ({ ...m, promoters_count: S.promoters.filter((p) => p.manager_id === m.id && !p.deleted_at).length }));
    },
    async createManager({ email, password, full_name, phone }) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      email = String(email || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || String(password || '').length < 8 || String(full_name || '').trim().length < 2) err('VALIDATION', 'manager');
      if (S.profiles.some((p) => p.email === email)) err('DUPLICATE_EMAIL');
      const m = { id: uid(), email, role: 'manager', status: 'active', full_name: full_name.trim(), phone: (phone || '').replace(/[^0-9+]/g, ''), created_at: nowISO() };
      S.profiles.push(m); audit('profiles', 'INSERT', m); persist(); return { id: m.id };
    },
    async updateManager(id, p) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      const m = S.profiles.find((x) => x.id === id && x.role === 'manager'); if (!m) err('NOT_FOUND');
      const old = clone(m); Object.assign(m, { full_name: p.full_name?.trim() || m.full_name, phone: p.phone ?? m.phone, notes: p.notes ?? m.notes });
      audit('profiles', 'UPDATE', m, old); persist(); return clone(m);
    },
    async setManagerStatus(id, status, reason) {
      role(); if (!isAdmin()) err('FORBIDDEN'); if (id === S.session) err('FORBIDDEN', 'self');
      if (status === 'deleted' && S.promoters.some((p) => p.manager_id === id && !p.deleted_at)) err('HAS_PROMOTERS');
      const m = S.profiles.find((x) => x.id === id && x.role === 'manager'); if (!m) err('NOT_FOUND');
      const old = clone(m); m.status = status; audit('profiles', 'UPDATE', m, old, reason); persist();
    },
    async resetPassword(id, pw) { role(); if (!isAdmin()) err('FORBIDDEN'); if (String(pw).length < 8) err('VALIDATION', 'password'); return { ok: true }; },

    async listPromoters({ search = '', managerId, status, balance } = {}) {
      await sleep(120); const mid = scope(managerId);
      const s = search.trim().toLowerCase(); const digits = s.replace(/\D/g, '');
      return S.promoters.filter((p) => !p.deleted_at && (!mid || p.manager_id === mid) && (!status || p.status === status)
        && (!s || p.full_name.toLowerCase().includes(s) || (digits && p.phone.includes(digits))))
        .map(balances)
        .filter((p) => !balance || (balance === 'debt' ? p.debt_balance > 0 : balance === 'no_debt' ? p.debt_balance <= 0 : p.unpaid_salary > 0))
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar'));
    },
    async getPromoter(id) {
      await sleep(150); const p = assertPromoter(id);
      return clone({
        promoter: balances(p),
        registrations: S.registrations.filter((r) => r.promoter_id === id).sort((a, b) => b.work_date.localeCompare(a.work_date)),
        ledger: S.ledger.filter((e) => e.promoter_id === id).sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at)),
        payrolls: S.payrolls.filter((x) => x.promoter_id === id).map(overview).sort((a, b) => b.week_start.localeCompare(a.week_start)),
        history: S.regHistory.filter((h) => h.promoter_id === id).sort((a, b) => b.changed_at.localeCompare(a.changed_at)),
        payments: S.payments.filter((x) => x.promoter_id === id).sort((a, b) => b.paid_at.localeCompare(a.paid_at)),
      });
    },
    async upsertPromoter(p) {
      const r = role();
      const phone = String(p.phone || '').replace(/[^0-9+]/g, '');
      if (String(p.full_name || '').trim().length < 2) err('VALIDATION', 'full_name');
      if (!/^\+?[0-9]{7,15}$/.test(phone)) err('VALIDATION', 'phone');
      const wa = String(p.whatsapp || '').replace(/[^0-9+]/g, '') || null;
      if (wa && !/^\+?[0-9]{7,15}$/.test(wa)) err('VALIDATION', 'whatsapp');
      if (!p.start_date) err('VALIDATION', 'start_date');
      if (p.birth_date && p.birth_date >= p.start_date) err('VALIDATION', 'birth_date');
      let mid = r === 'super_admin' ? p.manager_id || (p.id && S.promoters.find((x) => x.id === p.id)?.manager_id) : S.session;
      if (!S.profiles.some((m) => m.id === mid && m.role === 'manager' && m.status === 'active')) err('VALIDATION', 'manager_id');
      if (S.promoters.some((x) => !x.deleted_at && x.phone === phone && x.id !== p.id)) err('DUPLICATE_PHONE');
      let row;
      if (!p.id) {
        row = { id: uid(), manager_id: mid, full_name: p.full_name.trim(), phone, whatsapp: wa, birth_date: p.birth_date || null, start_date: p.start_date,
                status: p.status || 'active', notes: p.notes || null, created_by: S.session, created_at: nowISO(), updated_at: nowISO(), deleted_at: null };
        S.promoters.push(row); audit('promoters', 'INSERT', row);
      } else {
        row = assertPromoter(p.id); if (mid !== row.manager_id) err('USE_REASSIGN');
        const old = clone(row);
        Object.assign(row, { full_name: p.full_name.trim(), phone, whatsapp: wa, birth_date: p.birth_date || null, start_date: p.start_date, status: p.status || 'active', notes: p.notes || null, updated_at: nowISO() });
        audit('promoters', 'UPDATE', row, old);
      }
      persist(); return clone(row);
    },
    async archivePromoter(id, reason) {
      const p = assertPromoter(id); if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      if (S.registrations.some((r) => r.promoter_id === id && r.reg_count > 0) || S.ledger.some((e) => e.promoter_id === id && e.status === 'approved')) err('HAS_HISTORY');
      const old = clone(p); p.deleted_at = nowISO(); p.status = 'terminated'; audit('promoters', 'UPDATE', p, old, reason); persist();
    },
    async reassignPromoters(to, ids, reason) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      if (!S.profiles.some((m) => m.id === to && m.role === 'manager' && m.status === 'active')) err('VALIDATION', 'manager_id');
      let n = 0;
      for (const id of ids) {
        const p = S.promoters.find((x) => x.id === id && !x.deleted_at); if (!p) continue;
        const old = clone(p); p.manager_id = to; audit('promoters', 'UPDATE', p, old, reason); n++;
        for (const coll of [S.registrations, S.ledger, S.payrolls]) coll.filter((x) => x.promoter_id === id).forEach((x) => { x.manager_id = to; });
      }
      persist(); return n;
    },

    async getDay(date, managerId) {
      await sleep(120); const mid = scope(managerId);
      const promoters = S.promoters.filter((p) => !p.deleted_at && (!mid || p.manager_id === mid)).sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar'));
      const ids = new Set(promoters.map((p) => p.id));
      const ws = weekStartOf(date);
      return clone({ promoters, regs: S.registrations.filter((r) => r.work_date === date && ids.has(r.promoter_id)),
        locked: Object.fromEntries(S.payrolls.filter((p) => p.week_start === ws && ids.has(p.promoter_id) && p.status !== 'pending').map((p) => [p.promoter_id, p.status])),
        rule: S.rules[date] ? { work_date: date, ...S.rules[date] } : null, plan: planForWeek(S.plans, ws),
        bonuses: Object.entries(S.bonuses).filter(([k]) => k.startsWith(date + '|')).map(([, b]) => b).filter((b) => !mid || b.manager_id === mid),
        week_regs: S.registrations.filter((r) => r.week_start === ws && ids.has(r.promoter_id)).map((r) => ({ promoter_id: r.promoter_id, work_date: r.work_date, reg_count: r.reg_count, active_count: r.active_count })) });
    },
    async saveRegistrations(date, entries, reasonIn) {
      role(); const reason = String(reasonIn || '').trim() || null;
      if (!date || date > today()) err('FUTURE_DATE');
      const { max_daily_registrations: max } = settings();
      // validate everything first → atomic like the SQL transaction
      const plan = entries.map((e) => {
        if (!isInt(e.count)) err('INVALID_COUNT', e.promoter_id);
        if (e.active != null && e.active !== '' && !isInt(e.active)) err('INVALID_COUNT', e.promoter_id);
        const cnt = Number(e.count); if (cnt < 0 || cnt > max) err('INVALID_COUNT', e.promoter_id);
        const p = assertPromoter(e.promoter_id);
        if (date < p.start_date) err('BEFORE_START_DATE', p.id);
        const ex = S.registrations.find((r) => r.promoter_id === p.id && r.work_date === date);
        const act = e.active != null && e.active !== '' ? Number(e.active) : (ex?.active_count ?? 0);
        if (act < 0 || act > cnt) err('INVALID_ACTIVE', p.id);
        const locked = weekLocked(p.id, date);
        if (!ex) { if (cnt > 0 && locked && !reason) err('WEEK_LOCKED', p.id); }
        else if (ex.reg_count !== cnt || ex.active_count !== act) {
          if (ex.reg_count !== cnt && (!reason || reason.length < 3)) err('DUPLICATE_ENTRY', p.id);
          if (locked && (!reason || reason.length < 3)) err('WEEK_LOCKED', p.id);
          if (e.expected_version != null && e.expected_version !== ex.version) err('CONFLICT', p.id);
        }
        return { p, cnt, act, ex, notes: e.notes };
      });
      const results = [];
      for (const { p, cnt, act, ex, notes } of plan) {
        let action; let row = ex;
        if (!ex) {
          if (cnt === 0) action = 'skipped';
          else {
            row = { id: uid(), promoter_id: p.id, manager_id: p.manager_id, work_date: date, week_start: weekStartOf(date), reg_count: cnt, active_count: act, rate: 0, notes: notes || null,
                    version: 1, created_by: S.session, updated_by: S.session, created_at: nowISO(), updated_at: nowISO() };
            S.registrations.push(row); audit('registrations', 'INSERT', row, null, reason);
            S.regHistory.push({ id: S.regHistory.length + 1, registration_id: row.id, promoter_id: p.id, manager_id: p.manager_id, work_date: date, old_count: null, new_count: cnt, old_active: null, new_active: act, reason, changed_by: S.session, changed_at: nowISO() });
            action = 'created';
          }
        } else if (ex.reg_count === cnt && ex.active_count === act) action = 'unchanged';
        else {
          const old = clone(ex);
          S.regHistory.push({ id: S.regHistory.length + 1, registration_id: ex.id, promoter_id: p.id, manager_id: p.manager_id, work_date: date, old_count: ex.reg_count, new_count: cnt, old_active: ex.active_count, new_active: act, reason, changed_by: S.session, changed_at: nowISO() });
          Object.assign(ex, { reg_count: cnt, active_count: act, version: ex.version + 1, updated_by: S.session, updated_at: nowISO() });
          audit('registrations', 'UPDATE', ex, old, reason); action = 'updated';
        }
        if (action === 'created' || action === 'updated') refreshPayroll(p.id, date);
        results.push({ promoter_id: p.id, action, version: row?.version ?? 0, count: row?.reg_count ?? 0, active: row?.active_count ?? 0 });
      }
      persist(); return results;
    },
    async registrationHistory(pid) { assertPromoter(pid); return clone(S.regHistory.filter((h) => h.promoter_id === pid).reverse()); },

    async listRules(from, to) { await sleep(80); role(); return Object.entries(S.rules).filter(([d]) => d >= from && d <= to).map(([d, r]) => ({ work_date: d, ...clone(r) })); },
    async lockedWeeks(from, to) { role(); return [...new Set(S.payrolls.filter((p) => p.status !== 'pending' && p.week_start >= from && p.week_start <= to).map((p) => p.week_start))]; },
    async listPlans() { role(); return clone([...S.plans].sort((a, b) => b.effective_from.localeCompare(a.effective_from))); },
    async savePlan(p, reasonIn) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      const reason = String(reasonIn || '').trim() || null;
      for (const k of ['price_registered', 'price_active', 'bonus_price', 'bonus_min_cars', 'bonus_activity_pct']) if (!isInt(p[k]) || Number(p[k]) < 0) err('VALIDATION', k);
      if (Number(p.bonus_activity_pct) > 100) err('VALIDATION', 'bonus_activity_pct');
      const from = weekStartOf(p.effective_from || today());
      const next = S.plans.map((x) => x.effective_from).filter((d) => d > from).sort()[0] || null;
      if (S.payrolls.some((x) => x.status !== 'pending' && x.week_start >= from && (!next || x.week_start < next)) && (!reason || reason.length < 3)) err('PLAN_LOCKED', from);
      const row = { effective_from: from, price_registered: Number(p.price_registered), price_active: Number(p.price_active), bonus_enabled: p.bonus_enabled !== false,
        bonus_price: Number(p.bonus_price), bonus_min_cars: Number(p.bonus_min_cars), bonus_activity_pct: Number(p.bonus_activity_pct), notes: p.notes || null, updated_at: nowISO() };
      const old = S.plans.find((x) => x.effective_from === from);
      if (old) Object.assign(old, row); else S.plans.push(row);
      audit('pricing_plans', old ? 'UPDATE' : 'INSERT', { id: from, ...row }, null, reason);
      [...new Set(S.registrations.filter((r) => r.week_start >= from && (!next || r.week_start < next)).map((r) => r.promoter_id + '|' + r.week_start))]
        .forEach((k) => { const [pid, ws] = k.split('|'); refreshPayroll(pid, ws); });
      persist(); return clone(row);
    },
    async deletePlan(from, reason) {
      role(); if (!isAdmin()) err('FORBIDDEN'); if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      const min = S.plans.map((x) => x.effective_from).sort()[0];
      if (from === min) err('PLAN_REQUIRED');
      const i = S.plans.findIndex((x) => x.effective_from === from); if (i < 0) err('NOT_FOUND');
      const next = S.plans.map((x) => x.effective_from).filter((d) => d > from).sort()[0] || null;
      audit('pricing_plans', 'DELETE', null, { id: from, ...S.plans[i] }, reason); S.plans.splice(i, 1);
      [...new Set(S.registrations.filter((r) => r.week_start >= from && (!next || r.week_start < next)).map((r) => r.promoter_id + '|' + r.week_start))]
        .forEach((k) => { const [pid, ws] = k.split('|'); refreshPayroll(pid, ws); });
      persist();
    },
    async saveDailyBonus(date, managerId, p, reasonIn) {
      const r = role(); const reason = String(reasonIn || '').trim() || null;
      if (!date) err('VALIDATION', 'date');
      for (const k of ['tier2', 'tier3', 'tier4', 'tier5', 'extra_amount']) if (!isInt(p[k] ?? 0) || Number(p[k] ?? 0) < 0) err('VALIDATION', k);
      if (!['all', 'active'].includes(p.applies_to ?? 'all')) err('VALIDATION', 'applies_to');
      const mgrs = S.profiles.filter((m) => m.role === 'manager' && m.status === 'active' && (r === 'super_admin' ? (!managerId || m.id === managerId) : m.id === S.session));
      if (!mgrs.length) err('FORBIDDEN');
      for (const m of mgrs) if (S.payrolls.some((x) => x.manager_id === m.id && x.week_start === weekStartOf(date) && x.status !== 'pending') && (!reason || reason.length < 3)) err('RULE_LOCKED', date);
      for (const m of mgrs) {
        const k = date + '|' + m.id; const old = S.bonuses[k] ? clone(S.bonuses[k]) : null;
        S.bonuses[k] = { work_date: date, manager_id: m.id, enabled: p.enabled !== false, applies_to: p.applies_to ?? 'all',
          tier2: Number(p.tier2 ?? 0), tier3: Number(p.tier3 ?? 0), tier4: Number(p.tier4 ?? 0), tier5: Number(p.tier5 ?? 0),
          extra_enabled: !!p.extra_enabled, extra_amount: Number(p.extra_amount ?? 0), notes: p.notes || null, version: (old?.version || 0) + 1, updated_by: S.session, updated_at: nowISO() };
        audit('daily_bonuses', old ? 'UPDATE' : 'INSERT', { id: k, ...S.bonuses[k] }, old, reason);
        S.registrations.filter((x) => x.work_date === date && x.manager_id === m.id && x.reg_count > 0).forEach((x) => refreshPayroll(x.promoter_id, date));
      }
      persist(); return mgrs.length;
    },
    async inventoryReport(from, to, managerId, promoterId) {
      await sleep(160); const mid = scope(managerId);
      if (!from || !to || from > to) err('VALIDATION', 'range');
      if (promoterId) assertPromoter(promoterId);
      const wf = weekStartOf(from);
      const ps = S.promoters.filter((p) => !p.deleted_at && (!promoterId || p.id === promoterId) && (!mid || p.manager_id === mid));
      const ids = new Set(ps.map((p) => p.id));
      const P = (id) => S.promoters.find((p) => p.id === id);
      return clone({
        from, to, generated_at: nowISO(), plan: planForWeek(S.plans, to),
        promoters: ps.map((p) => ({ id: p.id, full_name: p.full_name, phone: p.phone, whatsapp: p.whatsapp || null, manager_id: p.manager_id,
          manager_name: S.profiles.find((m) => m.id === p.manager_id)?.full_name, status: p.status, start_date: p.start_date,
          debt_balance: debtBalance(S.ledger.filter((e) => e.promoter_id === p.id)) })).sort((a, b) => a.full_name.localeCompare(b.full_name, 'ar')),
        days: S.registrations.filter((r) => ids.has(r.promoter_id) && r.work_date >= from && r.work_date <= to && r.reg_count > 0)
          .sort((a, b) => a.work_date.localeCompare(b.work_date) || P(a.promoter_id).full_name.localeCompare(P(b.promoter_id).full_name, 'ar'))
          .map((r) => ({ date: r.work_date, promoter_id: r.promoter_id, count: r.reg_count, active: r.active_count,
            incentive: calcDailyIncentive(S.rules[r.work_date] || null, r.reg_count, r.active_count, diffDays(r.work_date, P(r.promoter_id).start_date), r.manager_id),
            bonus: calcDailyBonus(S.bonuses[r.work_date + '|' + r.manager_id] || null, r.reg_count, r.active_count) })),
        weeks: S.payrolls.filter((x) => ids.has(x.promoter_id) && x.week_start >= wf && x.week_start <= to).map(overview).sort((a, b) => a.week_start.localeCompare(b.week_start)),
      });
    },
    async listDebtEntries({ promoterId, managerId, from, to, status } = {}) {
      await sleep(100); const mid = scope(managerId);
      return clone(S.ledger.filter((e) => ['opening_debt', 'debt', 'debt_repayment'].includes(e.category) && (!mid || e.manager_id === mid) && (!promoterId || e.promoter_id === promoterId)
        && (!from || e.entry_date >= from) && (!to || e.entry_date <= to) && (!status || e.status === status))
        .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at))
        .map((e) => { const pr = S.promoters.find((p) => p.id === e.promoter_id); return { ...e, promoter_name: pr?.full_name, promoter_phone: pr?.phone }; }));
    },
    async saveRule(dates, rule, reasonIn) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      const reason = String(reasonIn || '').trim() || null;
      let n;
      try { n = normalizeRule(rule); } catch (e) { err('INVALID_RULE', e.detail); }
      if (!dates?.length) err('VALIDATION', 'dates');
      for (const d of dates) if (S.payrolls.some((p) => p.week_start === weekStartOf(d) && p.status !== 'pending') && (!reason || reason.length < 3)) err('RULE_LOCKED', d);
      for (const d of dates) {
        const old = S.rules[d] ? clone(S.rules[d]) : null;
        S.rules[d] = { ...n, version: (old?.version || 0) + 1, updated_by: S.session, updated_at: nowISO() };
        audit('incentive_rules', old ? 'UPDATE' : 'INSERT', { work_date: d, ...S.rules[d] }, old && { work_date: d, ...old }, reason);
        [...new Set(S.registrations.filter((r) => r.work_date === d && r.reg_count > 0).map((r) => r.promoter_id))].forEach((pid) => refreshPayroll(pid, d));
      }
      persist(); return dates.length;
    },
    async clearRule(dates, reasonIn) {
      role(); if (!isAdmin()) err('FORBIDDEN'); const reason = String(reasonIn || '').trim() || null; let n = 0;
      for (const d of dates) {
        if (S.payrolls.some((p) => p.week_start === weekStartOf(d) && p.status !== 'pending') && (!reason || reason.length < 3)) err('RULE_LOCKED', d);
        if (S.rules[d]?.is_incentive_day) {
          const old = clone(S.rules[d]); S.rules[d].is_incentive_day = false; S.rules[d].version++; n++;
          audit('incentive_rules', 'UPDATE', { work_date: d, ...S.rules[d] }, { work_date: d, ...old }, reason);
          [...new Set(S.registrations.filter((r) => r.work_date === d && r.reg_count > 0).map((r) => r.promoter_id))].forEach((pid) => refreshPayroll(pid, d));
        }
      }
      persist(); return n;
    },

    async listPayrolls({ weekStart: ws, managerId, status } = {}) {
      await sleep(140); const mid = scope(managerId);
      return S.payrolls.filter((p) => p.week_start === ws && (!mid || p.manager_id === mid) && (!status || p.status === status)).map(overview)
        .sort((a, b) => a.promoter_name.localeCompare(b.promoter_name, 'ar'));
    },
    async getPayroll(id) {
      const p = S.payrolls.find((x) => x.id === id); if (!p) err('NOT_FOUND'); assertMgr(p.manager_id);
      return clone({ payroll: overview(p), payments: S.payments.filter((x) => x.payroll_id === id), adjustments: S.adjustments.filter((a) => a.payroll_id === id) });
    },
    async previewPayroll(pid, week) { assertPromoter(pid); return clone(computeFor(pid, week)); },
    async generatePayrolls(week, managerId) {
      const mid = scope(managerId); const ws = weekStartOf(week); if (ws > today()) err('FUTURE_DATE');
      let n = 0;
      for (const p of S.promoters.filter((x) => !x.deleted_at && (!mid || x.manager_id === mid))) if (refreshPayroll(p.id, ws)) n++;
      persist(); return { week_start: ws, payrolls: n };
    },
    async approvePayrolls(ids) {
      role(); let n = 0;
      for (const id of ids) {
        let p = S.payrolls.find((x) => x.id === id); if (!p) err('NOT_FOUND', 'payroll'); assertMgr(p.manager_id);
        if (p.status !== 'pending') err('INVALID_STATUS', id);
        if (addDays(p.week_start, 6) >= today()) err('WEEK_NOT_ENDED', id);
        if (S.ledger.some((e) => e.promoter_id === p.promoter_id && weekStartOf(e.entry_date) === p.week_start && e.status === 'pending')) err('PENDING_ENTRIES', id);
        refreshPayroll(p.promoter_id, p.week_start);
        const old = clone(p);
        S.ledger.filter((e) => e.promoter_id === p.promoter_id && weekStartOf(e.entry_date) === p.week_start && e.status === 'approved' && !e.payroll_id && PAYROLL_CATEGORIES.includes(e.category))
          .forEach((e) => { e.payroll_id = p.id; });
        p.carry_entry_id = null;
        if (p.net_amount < 0) {
          const e = ledgerRow(p.promoter_id, p.manager_id, addDays(p.week_start, 10), 'debt', -p.net_amount, 'ترحيل رصيد سالب من أسبوع ' + p.week_start, 'approved');
          e.idempotency_key = 'carry:' + p.id; p.carry_entry_id = e.id;
        }
        Object.assign(p, { status: 'approved', approved_by: S.session, approved_at: nowISO(), carry_forward_debt: Math.max(-p.net_amount, 0), payable_amount: Math.max(p.net_amount, 0) });
        audit('payrolls', 'UPDATE', p, old); n++;
      }
      persist(); return n;
    },
    async reopenPayroll(id, reason) {
      const p = S.payrolls.find((x) => x.id === id); if (!p) err('NOT_FOUND'); assertMgr(p.manager_id);
      if (p.status !== 'approved') err('INVALID_STATUS'); if (S.payments.some((x) => x.payroll_id === id)) err('HAS_PAYMENTS');
      if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      const old = clone(p);
      S.ledger.filter((e) => e.payroll_id === id).forEach((e) => { e.payroll_id = null; });
      if (p.carry_entry_id) { const e = S.ledger.find((x) => x.id === p.carry_entry_id); if (e) { e.status = 'void'; e.void_reason = 'reopen payroll'; } }
      Object.assign(p, { status: 'pending', approved_by: null, approved_at: null, carry_forward_debt: 0, carry_entry_id: null });
      refreshPayroll(p.promoter_id, p.week_start); audit('payrolls', 'UPDATE', p, old, reason); persist();
    },
    async payPayroll(id, { amount, method, reference, paidAt, notes, key } = {}) {
      role();
      if (key && S.payments.some((x) => x.idempotency_key === key)) return { duplicate: true };
      const raw = S.payrolls.find((x) => x.id === id); if (!raw) err('NOT_FOUND'); assertMgr(raw.manager_id);
      const o = overview(raw);
      if (!['approved', 'adjusted'].includes(o.status)) err('INVALID_STATUS');
      if (!method) err('VALIDATION', 'method');
      const when = paidAt ? new Date(paidAt + 'T12:00:00+03:00').toISOString() : nowISO();
      const old = clone(raw);
      if (o.outstanding === 0 && !amount) {
        Object.assign(raw, { status: o.status === 'adjusted' ? 'adjusted' : 'paid', paid_at: when, payment_method: method, payment_reference: reference || null });
        audit('payrolls', 'UPDATE', raw, old); persist(); return { paid: 0, outstanding: 0 };
      }
      const amt = amount == null || amount === '' ? o.outstanding : Number(amount);
      if (!Number.isSafeInteger(amt) || amt <= 0) err('VALIDATION', 'amount');
      if (amt > o.outstanding) err('OVERPAYMENT', o.outstanding);
      const pay = { id: uid(), payroll_id: id, promoter_id: raw.promoter_id, manager_id: raw.manager_id, amount: amt, method, reference: reference || null,
                    paid_at: when, notes: notes || null, idempotency_key: key || null, created_by: S.session, created_at: nowISO() };
      S.payments.push(pay); audit('payroll_payments', 'INSERT', pay);
      const e = ledgerRow(raw.promoter_id, raw.manager_id, baghdadToday(new Date(when)), 'salary_payment', amt, 'دفع راتب أسبوع ' + raw.week_start, 'approved');
      e.payroll_id = id;
      const out = o.outstanding - amt;
      Object.assign(raw, { status: out === 0 ? (o.status === 'adjusted' ? 'adjusted' : 'paid') : raw.status, paid_at: when, payment_method: method, payment_reference: reference || null });
      audit('payrolls', 'UPDATE', raw, old); persist();
      return { payment_id: pay.id, paid: amt, outstanding: out };
    },
    async adjustPayroll(id, reason) {
      role(); if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      const raw = S.payrolls.find((x) => x.id === id); if (!raw) err('NOT_FOUND'); assertMgr(raw.manager_id);
      const o = overview(raw); if (!['paid', 'adjusted'].includes(o.status)) err('INVALID_STATUS');
      const c = computeFor(raw.promoter_id, raw.week_start);
      const delta = c.net_amount - o.effective_net;
      if (delta === 0) { raw.needs_recalc = false; persist(); return { delta: 0 }; }
      const out = o.outstanding + delta; let carried = 0; let debtId = null;
      if (out < 0) { carried = -out; debtId = ledgerRow(raw.promoter_id, raw.manager_id, today(), 'debt', carried, `فرق تسوية راتب أسبوع ${raw.week_start}: ${reason}`, 'approved').id; }
      const adj = { id: uid(), payroll_id: id, manager_id: raw.manager_id, previous_net: o.effective_net, new_net: c.net_amount, delta, carried_to_debt: carried,
                    debt_entry_id: debtId, old_snapshot: raw.snapshot, new_snapshot: c, reason, created_by: S.session, created_at: nowISO() };
      S.adjustments.push(adj); audit('payroll_adjustments', 'INSERT', adj, null, reason);
      const old = clone(raw); raw.status = 'adjusted'; raw.needs_recalc = false; audit('payrolls', 'UPDATE', raw, old, reason);
      persist(); return { adjustment_id: adj.id, delta, carried_to_debt: carried, outstanding: Math.max(out, 0) };
    },

    async listLedger({ promoterId, managerId, from, to, category, status, limit = 500 } = {}) {
      await sleep(120); const mid = scope(managerId);
      return clone(S.ledger.filter((e) => (!mid || e.manager_id === mid) && (!promoterId || e.promoter_id === promoterId) && (!from || e.entry_date >= from)
        && (!to || e.entry_date <= to) && (!category || e.category === category) && (!status || e.status === status))
        .sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at)).slice(0, limit)
        .map((e) => ({ ...e, promoter_name: S.promoters.find((p) => p.id === e.promoter_id)?.full_name })));
    },
    async addLedgerEntry(p) {
      role();
      if (p.idempotency_key) { const ex = S.ledger.find((e) => e.idempotency_key === p.idempotency_key); if (ex) return clone(ex); }
      const pr = assertPromoter(p.promoter_id);
      const cat = p.category;
      if (!['opening_debt', 'debt', 'debt_repayment', 'withdrawal', 'advance', 'expense_charge', 'deduction', 'bonus', 'correction'].includes(cat)) err('VALIDATION', 'category');
      if (!isInt(p.amount)) err('VALIDATION', 'amount');
      const amt = Number(p.amount);
      if ((cat === 'correction' && amt === 0) || (cat !== 'correction' && amt <= 0)) err('VALIDATION', 'amount');
      const d = p.entry_date || today(); if (d > today()) err('FUTURE_DATE');
      const affects = PAYROLL_CATEGORIES.includes(cat);
      if (affects && weekLocked(pr.id, d)) err('WEEK_LOCKED');
      const bal = debtBalance(S.ledger.filter((e) => e.promoter_id === pr.id));
      if (cat === 'debt_repayment' && amt > bal) err('EXCEEDS_DEBT', bal);
      if (['correction', 'deduction'].includes(cat) && !String(p.notes || '').trim()) err('REASON_REQUIRED');
      const st = settings().ledger_requires_approval && !isAdmin() ? 'pending' : 'approved';
      const e = ledgerRow(pr.id, pr.manager_id, d, cat, amt, p.notes || null, st);
      e.idempotency_key = p.idempotency_key || null; e.expense_id = p.expense_id || null;
      if (affects) refreshPayroll(pr.id, d);
      persist(); return clone(e);
    },
    async reviewLedgerEntry(id, decision, note) {
      role(); if (!isAdmin()) err('FORBIDDEN');
      const e = S.ledger.find((x) => x.id === id); if (!e) err('NOT_FOUND');
      if (e.status !== 'pending' || !['approved', 'rejected'].includes(decision)) err('INVALID_STATUS');
      if (decision === 'approved' && e.category === 'debt_repayment' && e.amount > debtBalance(S.ledger.filter((x) => x.promoter_id === e.promoter_id))) err('EXCEEDS_DEBT');
      const old = clone(e); Object.assign(e, { status: decision, approved_by: S.session, approved_at: nowISO(), void_reason: decision === 'rejected' ? note : null });
      audit('ledger_entries', 'UPDATE', e, old, note); refreshPayroll(e.promoter_id, e.entry_date); persist();
    },
    async voidLedgerEntry(id, reason) {
      role(); if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      const e = S.ledger.find((x) => x.id === id); if (!e) err('NOT_FOUND'); assertMgr(e.manager_id);
      if (['void', 'rejected'].includes(e.status)) err('INVALID_STATUS');
      if (e.payroll_id || e.category === 'salary_payment') err('ENTRY_CONSUMED');
      if (PAYROLL_CATEGORIES.includes(e.category) && weekLocked(e.promoter_id, e.entry_date)) err('WEEK_LOCKED');
      if (['opening_debt', 'debt'].includes(e.category) && debtBalance(S.ledger.filter((x) => x.promoter_id === e.promoter_id)) - e.amount < 0) err('DEBT_NEGATIVE');
      const old = clone(e); e.status = 'void'; e.void_reason = reason; audit('ledger_entries', 'UPDATE', e, old, reason);
      refreshPayroll(e.promoter_id, e.entry_date); persist();
    },

    async listExpenses({ from, to, managerId, category } = {}) {
      await sleep(120); const mid = scope(managerId);
      return clone(S.expenses.filter((x) => x.expense_date >= from && x.expense_date <= to && (!mid || x.manager_id === mid) && (!category || x.category === category))
        .sort((a, b) => b.expense_date.localeCompare(a.expense_date) || b.created_at.localeCompare(a.created_at))
        .map((x) => ({ ...x, promoter_name: x.charged_promoter_id ? S.promoters.find((p) => p.id === x.charged_promoter_id)?.full_name : null })));
    },
    async addExpense(p, file) {
      const r = role();
      if (p.idempotency_key) { const ex = S.expenses.find((x) => x.idempotency_key === p.idempotency_key); if (ex) return clone(ex); }
      const mid = r === 'super_admin' ? p.manager_id : S.session;
      if (!S.profiles.some((m) => m.id === mid && m.role === 'manager')) err('VALIDATION', 'manager_id');
      if (!isInt(p.amount) || Number(p.amount) <= 0) err('VALIDATION', 'amount');
      if (!S.categories.some((c) => c.key === p.category)) err('VALIDATION', 'category');
      if (String(p.description || '').trim().length < 2) err('VALIDATION', 'description');
      const d = p.expense_date || today(); if (d > today()) err('FUTURE_DATE');
      if (p.charged_promoter_id && S.promoters.find((x) => x.id === p.charged_promoter_id && !x.deleted_at)?.manager_id !== mid) err('VALIDATION', 'charged_promoter_id');
      let attachment_path = null;
      if (file) { if (file.size > 1_500_000) err('VALIDATION', 'attachment'); attachment_path = await fileToDataURL(file); }
      const x = { id: uid(), manager_id: mid, expense_date: d, week_start: weekStartOf(d), category: p.category, description: p.description.trim(), amount: Number(p.amount),
                  attachment_path, charged_promoter_id: p.charged_promoter_id || null, ledger_entry_id: null, status: 'approved', void_reason: null,
                  idempotency_key: p.idempotency_key || null, created_by: S.session, created_at: nowISO() };
      if (x.charged_promoter_id) {
        const e = await api.addLedgerEntry({ promoter_id: x.charged_promoter_id, category: 'expense_charge', amount: x.amount, entry_date: d, notes: x.description, expense_id: x.id, idempotency_key: 'exp:' + x.id });
        x.ledger_entry_id = e.id;
      }
      S.expenses.push(x); audit('expenses', 'INSERT', x); persist(); return clone(x);
    },
    async voidExpense(id, reason) {
      role(); if (String(reason || '').trim().length < 3) err('REASON_REQUIRED');
      const x = S.expenses.find((e) => e.id === id); if (!x) err('NOT_FOUND'); assertMgr(x.manager_id);
      if (x.status === 'void') err('INVALID_STATUS');
      if (x.ledger_entry_id) await api.voidLedgerEntry(x.ledger_entry_id, reason);
      const old = clone(x); x.status = 'void'; x.void_reason = reason; audit('expenses', 'UPDATE', x, old, reason); persist();
    },
    async expenseSummary(from, to, group, managerId) {
      const mid = scope(managerId); const out = new Map();
      for (const x of S.expenses) {
        if (x.status !== 'approved' || x.expense_date < from || x.expense_date > to || (mid && x.manager_id !== mid)) continue;
        const b = group === 'day' ? x.expense_date : group === 'week' ? x.week_start : x.expense_date.slice(0, 8) + '01';
        const k = b + '|' + x.category; const v = out.get(k) || { bucket: b, category: x.category, total: 0, items: 0 };
        v.total += x.amount; v.items++; out.set(k, v);
      }
      return [...out.values()].sort((a, b) => a.bucket.localeCompare(b.bucket) || a.category.localeCompare(b.category));
    },
    async attachmentUrl(path) { return path; },

    async getDashboard(from, to, managerId) {
      await sleep(220); const mid = scope(managerId);
      if (!from || !to || from > to) err('VALIDATION', 'range');
      const T = today(); const ws = weekStartOf(T); const ms = T.slice(0, 8) + '01'; const wf = weekStartOf(from);
      const inScope = (x) => !mid || x.manager_id === mid;
      const regs = S.registrations.filter(inScope);
      const rng = regs.filter((r) => r.work_date >= from && r.work_date <= to);
      const P = (id) => S.promoters.find((p) => p.id === id);
      const led = S.ledger.filter((e) => e.status === 'approved' && inScope(e));
      const pays = S.payrolls.filter(inScope).map(overview);
      const wk = pays.filter((p) => p.week_start >= wf && p.week_start <= to);
      const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
      const since = Date.now() - 86400000;
      const thisWeek = regs.filter((r) => r.work_date >= ws && r.work_date <= addDays(ws, 6));
      const kpis = {
        today: sum(regs.filter((r) => r.work_date === T), (r) => r.reg_count),
        today_active: sum(regs.filter((r) => r.work_date === T), (r) => r.active_count),
        last_24h: sum(regs.filter((r) => Date.parse(r.updated_at > r.created_at ? r.updated_at : r.created_at) >= since), (r) => r.reg_count),
        this_week: sum(thisWeek, (r) => r.reg_count), this_week_active: sum(thisWeek, (r) => r.active_count),
        this_month: sum(regs.filter((r) => r.work_date >= ms && r.work_date <= T), (r) => r.reg_count),
        range_registrations: sum(rng, (r) => r.reg_count), range_active: sum(rng, (r) => r.active_count),
        range_revenue: sum(wk, (p) => p.base_amount), range_incentives: sum(wk, (p) => p.incentive_amount), bonus_weeks: wk.filter((p) => p.bonus_applied).length,
        payroll_liabilities: sum(pays.filter((p) => ['pending', 'approved', 'adjusted'].includes(p.status)), (p) => p.outstanding),
        unpaid_salaries: sum(pays.filter((p) => ['approved', 'adjusted'].includes(p.status)), (p) => p.outstanding),
        paid_salaries: sum(S.payments.filter((x) => inScope(x) && baghdadToday(new Date(x.paid_at)) >= from && baghdadToday(new Date(x.paid_at)) <= to), (x) => x.amount),
        outstanding_debts: debtBalance(led),
        withdrawals: sum(led.filter((e) => ['withdrawal', 'advance'].includes(e.category) && e.entry_date >= from && e.entry_date <= to), (e) => e.amount),
        expenses: sum(S.expenses.filter((x) => x.status === 'approved' && inScope(x) && x.expense_date >= from && x.expense_date <= to), (x) => x.amount),
        active_promoters: S.promoters.filter((p) => !p.deleted_at && p.status === 'active' && inScope(p)).length,
      };
      const series = eachDay(from, to).map((d) => { const rs = rng.filter((r) => r.work_date === d); return { date: d, registrations: sum(rs, (r) => r.reg_count), active: sum(rs, (r) => r.active_count) }; });
      const wmap = new Map();
      for (const p of wk) { const v = wmap.get(p.week_start) || { week_start: p.week_start, earnings: 0, incentives: 0, cars: 0, active: 0 }; v.earnings += p.base_amount; v.incentives += p.incentive_amount; v.cars += p.reg_count; v.active += p.active_count; wmap.set(p.week_start, v); }
      const managers = S.profiles.filter((m) => m.role === 'manager' && (!mid || m.id === mid) && (m.status === 'active' || S.promoters.some((p) => p.manager_id === m.id))).map((m) => {
        const rs = rng.filter((r) => r.manager_id === m.id);
        return { manager_id: m.id, manager_name: m.full_name, registrations: sum(rs, (r) => r.reg_count), active: sum(rs, (r) => r.active_count),
          revenue: sum(S.payrolls.filter((y) => y.manager_id === m.id && y.week_start >= wf && y.week_start <= to), (y) => y.base_amount + y.incentive_amount),
          promoters: S.promoters.filter((p) => p.manager_id === m.id && !p.deleted_at && p.status === 'active').length,
          expenses: sum(S.expenses.filter((x) => x.manager_id === m.id && x.status === 'approved' && x.expense_date >= from && x.expense_date <= to), (x) => x.amount) };
      }).sort((a, b) => b.registrations - a.registrations);
      const byP = new Map();
      for (const r of rng) { const v = byP.get(r.promoter_id) || { promoter_id: r.promoter_id, full_name: P(r.promoter_id).full_name, manager_name: S.profiles.find((m) => m.id === r.manager_id)?.full_name, registrations: 0, active: 0, days: 0,
        revenue: sum(S.payrolls.filter((y) => y.promoter_id === r.promoter_id && y.week_start >= wf && y.week_start <= to), (y) => y.base_amount + y.incentive_amount) };
        v.registrations += r.reg_count; v.active += r.active_count; if (r.reg_count > 0) v.days++; byP.set(r.promoter_id, v); }
      const top = [...byP.values()].filter((v) => v.registrations > 0).sort((a, b) => b.registrations - a.registrations || a.full_name.localeCompare(b.full_name)).slice(0, 10);
      const ec = new Map();
      S.expenses.filter((x) => x.status === 'approved' && inScope(x) && x.expense_date >= from && x.expense_date <= to).forEach((x) => ec.set(x.category, (ec.get(x.category) || 0) + x.amount));
      return { kpis, series, weeks: [...wmap.values()].sort((a, b) => a.week_start.localeCompare(b.week_start)), managers, top_promoters: top,
        expenses_by_category: [...ec].map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
        plan: planForWeek(S.plans, T), generated_at: nowISO() };
    },
    async reportPerformance(from, to, managerId) {
      await sleep(150); const mid = scope(managerId); const wf = weekStartOf(from);
      return S.promoters.filter((p) => !p.deleted_at && (!mid || p.manager_id === mid)).map((p) => {
        const rs = S.registrations.filter((r) => r.promoter_id === p.id && r.work_date >= from && r.work_date <= to);
        const ys = S.payrolls.filter((y) => y.promoter_id === p.id && y.week_start >= wf && y.week_start <= to);
        const L = S.ledger.filter((e) => e.promoter_id === p.id && e.status === 'approved' && e.entry_date >= from && e.entry_date <= to);
        const s = (cats) => L.filter((e) => cats.includes(e.category)).reduce((a, e) => a + e.amount, 0);
        const regsN = rs.reduce((a, r) => a + r.reg_count, 0); const act = rs.reduce((a, r) => a + r.active_count, 0);
        return { promoter_id: p.id, full_name: p.full_name, phone: p.phone, manager_name: S.profiles.find((m) => m.id === p.manager_id)?.full_name, status: p.status,
          registrations: regsN, active: act, activity_pct: regsN ? Math.round((act * 100) / regsN) : 0, days_worked: rs.filter((r) => r.reg_count > 0).length,
          bonus_weeks: ys.filter((y) => y.bonus_applied).length, base_amount: ys.reduce((a, y) => a + y.base_amount, 0), incentive_amount: ys.reduce((a, y) => a + y.incentive_amount, 0),
          withdrawals: s(['withdrawal', 'advance']), deductions: s(['deduction', 'expense_charge', 'debt_repayment']), bonuses: s(['bonus']),
          debt_balance: debtBalance(S.ledger.filter((e) => e.promoter_id === p.id)) };
      }).sort((a, b) => b.registrations - a.registrations || a.full_name.localeCompare(b.full_name, 'ar'));
    },
    async listAudit({ table, from, to, limit = 100, offset = 0 } = {}) {
      await sleep(100); role(); if (!isAdmin()) err('FORBIDDEN');
      return clone(S.audit.filter((a) => (!table || a.table_name === table) && (!from || baghdadToday(new Date(a.at)) >= from) && (!to || baghdadToday(new Date(a.at)) <= to)).slice(offset, offset + limit));
    },
  };

  function ledgerRow(pid, mid, date, category, amount, notes, status) {
    const e = { id: uid(), promoter_id: pid, manager_id: mid, entry_date: date, week_start: weekStartOf(date), category, amount, notes, status, payroll_id: null,
      expense_id: null, reverses_entry_id: null, idempotency_key: null, created_by: S.session, created_at: nowISO(),
      approved_by: status === 'approved' ? S.session : null, approved_at: status === 'approved' ? nowISO() : null, void_reason: null };
    S.ledger.push(e); audit('ledger_entries', 'INSERT', e); return e;
  }

  // Same structure as db/seed.sql, generated through the API itself so all rules apply.
  function seed() {
    seeding = true;
    S = { v: 4, bonuses: {}, plans: [{ ...DEFAULT_PLAN, notes: 'التسعير الأساسي' }], session: null, prefs: {}, audit: [], regHistory: [], registrations: [], promoters: [], payrolls: [], payments: [], adjustments: [], ledger: [], expenses: [], rules: {},
      settings: { id: 1, company_name: 'شركة الرافدين للتسويق', base_rate: 15000, default_extra_amount: 8000, ledger_requires_approval: false, max_daily_registrations: 100, timezone: 'Asia/Baghdad', currency: 'IQD' },
      categories: [
        { key: 'team', name_ar: 'مصاريف الفريق', name_en: 'Team expenses', is_system: true, sort_order: 10 },
        { key: 'operational', name_ar: 'مصاريف تشغيلية', name_en: 'Operational', is_system: true, sort_order: 20 },
        { key: 'fuel', name_ar: 'وقود', name_en: 'Fuel', is_system: true, sort_order: 30 },
        { key: 'harqiyat', name_ar: 'حَرْقيات', name_en: 'Harqiyat (petty)', is_system: true, sort_order: 40 },
        { key: 'transport', name_ar: 'نقل ومواصلات', name_en: 'Transport', is_system: true, sort_order: 50 },
        { key: 'misc', name_ar: 'متفرقة', name_en: 'Miscellaneous', is_system: true, sort_order: 90 }],
      profiles: DEMO_USERS.map((u) => ({ ...u, status: 'active', created_at: nowISO() })) };
    const as = (id) => { S.session = id; };
    const T = today(); const first = addDays(weekStartOf(T), -35); const mgrs = ['demo-m1', 'demo-m2', 'demo-m3'];
    const names = ['علي حسين', 'زينب كاظم', 'مصطفى جاسم', 'فاطمة عباس', 'حسن عبد الأمير', 'مريم سلمان', 'سجاد كريم', 'نور الهدى قاسم', 'أحمد فاضل', 'رقية محمد', 'عباس ناصر', 'دعاء حميد', 'محمد رضا', 'هبة علي', 'كرار صباح'];
    const run = (f) => { f(); };
    as('demo-admin');
    // no predefined incentive/bonus amounts — managers set daily bonuses themselves
    const sync = (p) => { let v; p.then((x) => { v = x; }); return v; }; // API methods are sync-safe (no awaits on the write path)
    names.forEach((n, i) => {
      as(mgrs[i % 3]);
      const row = { id: uid(), manager_id: mgrs[i % 3], full_name: n, phone: '0770' + String(1000000 + (i + 1) * 7919).padStart(7, '0'),
        birth_date: addDays('1995-01-01', (i + 1) * 211), start_date: addDays(first, -30 + ((i + 1) % 4) * 7), status: i === 14 ? 'inactive' : 'active',
        notes: (i + 1) % 5 === 0 ? 'مروج متميز' : null, created_by: mgrs[i % 3], created_at: nowISO(), updated_at: nowISO(), deleted_at: null };
      S.promoters.push(row); audit('promoters', 'INSERT', row);
    });
    for (const d of eachDay(first, T)) for (const m of mgrs) {
      as(m);
      const entries = [];
      for (const p of S.promoters.filter((x) => x.manager_id === m)) {
        if (p.status !== 'active' && d > addDays(T, -10)) continue;
        let n = hash(p.id + d) % 5; n = n === 0 || (d === T && n > 2) ? 0 : n;
        if ([4, 5].includes(new Date(d + 'T00:00:00Z').getUTCDay())) n += 1;
        if (n > 0) entries.push({ promoter_id: p.id, count: n, active: Math.min(n, Math.round((n * (35 + (hash(d + p.full_name) % 66))) / 100)) });
      }
      if (entries.length) directRegs(d, entries);
    }
    function directRegs(d, entries) {
      for (const e of entries) {
        const p = S.promoters.find((x) => x.id === e.promoter_id);
        const row = { id: uid(), promoter_id: p.id, manager_id: p.manager_id, work_date: d, week_start: weekStartOf(d), reg_count: e.count, active_count: e.active, rate: 0, notes: null, version: 1,
          created_by: p.manager_id, updated_by: p.manager_id, created_at: d === T ? nowISO() : new Date(d + 'T18:00:00+03:00').toISOString(), updated_at: d === T ? nowISO() : new Date(d + 'T18:00:00+03:00').toISOString() };
        S.registrations.push(row);
        S.regHistory.push({ id: S.regHistory.length + 1, registration_id: row.id, promoter_id: p.id, manager_id: p.manager_id, work_date: d, old_count: null, new_count: e.count, old_active: null, new_active: e.active, reason: null, changed_by: p.manager_id, changed_at: row.created_at });
      }
    }
    const weeks = []; for (let w = first; w <= weekStartOf(T); w = addDays(w, 7)) weeks.push(w);
    for (const m of mgrs) {
      as(m);
      S.promoters.filter((p) => p.manager_id === m).forEach((p, idx) => {
        const i = idx + 1;
        if (i % 2 === 1) ledgerRow(p.id, m, addDays(first, -1), 'opening_debt', 50000 * i, 'رصيد دين سابق', 'approved');
        for (const w of weeks) {
          const n = hash(p.id + w);
          if (n % 3 !== 0 && addDays(w, 1) <= T) ledgerRow(p.id, m, addDays(w, 1), 'withdrawal', 10000 * (1 + (n % 4)), 'سحب يومي', 'approved');
          if (n % 5 === 0 && addDays(w, 3) <= T) ledgerRow(p.id, m, addDays(w, 3), 'advance', 25000, 'سلفة', 'approved');
          if (n % 7 === 0 && addDays(w, 5) <= T) ledgerRow(p.id, m, addDays(w, 5), 'bonus', 20000, 'مكافأة أداء', 'approved');
          if (i % 2 === 1 && addDays(w, 4) <= T && debtBalance(S.ledger.filter((e) => e.promoter_id === p.id)) >= 10000) ledgerRow(p.id, m, addDays(w, 4), 'debt_repayment', 10000, 'استقطاع من الدين', 'approved');
        }
      });
      for (const w of weeks) {
        const ex = (d, category, description, amount) => { const x = { id: uid(), manager_id: m, expense_date: d, week_start: weekStartOf(d), category, description, amount, attachment_path: null, charged_promoter_id: null, ledger_entry_id: null, status: 'approved', void_reason: null, idempotency_key: null, created_by: m, created_at: nowISO() }; S.expenses.push(x); };
        if (addDays(w, 2) <= T) { ex(addDays(w, 2), 'fuel', 'وقود سيارة الفريق', 35000); ex(addDays(w, 2), 'harqiyat', 'حرقيات ومصاريف يومية', 15000 + (hash(m + w) % 5) * 1000); }
        if (addDays(w, 4) <= T) ex(addDays(w, 4), 'team', 'غداء الفريق', 40000);
      }
      for (const w of weeks) {
        sync(api.generatePayrolls(w));
        if (addDays(w, 6) < T) {
          sync(api.approvePayrolls(S.payrolls.filter((p) => p.manager_id === m && p.week_start === w && p.status === 'pending').map((p) => p.id)));
          if (w < addDays(weekStartOf(T), -7)) for (const p of S.payrolls.filter((x) => x.manager_id === m && x.week_start === w)) {
            sync(api.payPayroll(p.id, { method: ['cash', 'zain_cash', 'qi_card'][hash(p.id) % 3], reference: 'REF-' + p.id.slice(0, 6).toUpperCase(), paidAt: addDays(w, 10) }));
          }
        }
      }
    }
    S.audit = S.audit.slice(0, 400);
    S.session = null;
    seeding = false;
    return S;
  }

  return api;
}

function fileToDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
