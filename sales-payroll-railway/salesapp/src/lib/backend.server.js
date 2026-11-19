// Production backend: the app's own Node API (same origin, HttpOnly session cookie).
export function createServerBackend(base = '/api') {
  let listeners = [];

  async function post(path, body) {
    let res;
    try {
      res = await fetch(`${base}/${path}`, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'salesapp' }, body: JSON.stringify(body || {}) });
    } catch { const e = new Error('NETWORK'); e.code = 'NETWORK'; throw e; }
    let data = null; try { data = await res.json(); } catch { /* */ }
    if (!res.ok) {
      const e = new Error(data?.error || 'SERVER_ERROR'); e.code = data?.error || 'SERVER_ERROR'; e.detail = data?.detail || '';
      if (res.status === 401 && path !== 'auth/login') listeners.forEach((l) => l(null));
      throw e;
    }
    return data;
  }
  const rpc = async (fn, args) => (await post(`rpc/${fn}`, { args })).data;
  const q = async (name, args) => (await post(`q/${name}`, { args })).data;
  const toPaidAt = (d) => (d ? new Date(d + 'T12:00:00+03:00').toISOString() : null);

  const api = {
    kind: 'server',
    async getSessionUser() { try { const me = await post('auth/me'); return me ? { id: me.id } : null; } catch { return null; } },
    onAuthChange(cb) { listeners.push(cb); return () => { listeners = listeners.filter((l) => l !== cb); }; },
    async signIn(email, password) { await post('auth/login', { email, password }); listeners.forEach((l) => l({})); },
    async signOut() { await post('auth/logout').catch(() => {}); listeners.forEach((l) => l(null)); },
    async me() { try { return await post('auth/me'); } catch (e) { if (e.code === 'NOT_AUTHENTICATED') return null; throw e; } },
    changePassword: (current, next) => post('auth/password', { current, next }),

    getSettings: () => q('settings'),
    updateSettings: (p) => rpc('update_settings', { p }),
    expenseCategories: () => q('categories'),
    addExpenseCategory: (key, ar, en) => rpc('add_expense_category', { p_key: key, p_name_ar: ar, p_name_en: en }),
    getPrefs: () => q('prefs'),
    savePrefs: (prefs) => post('prefs', { prefs }),

    listManagers: () => q('managers'),
    createManager: (p) => post('admin/create-manager', p),
    updateManager: (id, p) => rpc('update_manager', { p_id: id, p }),
    setManagerStatus: (id, status, reason) => rpc('set_manager_status', { p_id: id, p_status: status, p_reason: reason || null }),
    resetPassword: (id, password) => post('admin/reset-password', { id, password }),

    listPromoters: (f = {}) => q('promoters', f),
    getPromoter: (id) => q('promoter', { id }),
    upsertPromoter: (p) => rpc('upsert_promoter', { p }),
    archivePromoter: (id, reason) => rpc('archive_promoter', { p_id: id, p_reason: reason }),
    reassignPromoters: (to, ids, reason) => rpc('reassign_promoters', { p_to: to, p_ids: ids, p_reason: reason }),

    getDay: (date, managerId) => q('day', { date, managerId }),
    saveRegistrations: (date, entries, reason) => rpc('save_registrations', { p_date: date, p_entries: entries, p_reason: reason || null }),
    registrationHistory: (promoterId) => q('reg_history', { promoterId }),

    listRules: (from, to) => q('rules', { from, to }),
    saveRule: (dates, rule, reason) => rpc('save_incentive_rule', { p_dates: dates, p_rule: rule, p_reason: reason || null }),
    clearRule: (dates, reason) => rpc('clear_incentive_rule', { p_dates: dates, p_reason: reason || null }),
    lockedWeeks: (from, to) => q('locked_weeks', { from, to }),
    listPlans: () => q('plans'),
    savePlan: (p, reason) => rpc('save_pricing_plan', { p, p_reason: reason || null }),
    deletePlan: (effectiveFrom, reason) => rpc('delete_pricing_plan', { p_effective_from: effectiveFrom, p_reason: reason }),
    listDebtEntries: (f = {}) => q('debt_entries', f),
    saveDailyBonus: (date, managerId, p, reason) => rpc('save_daily_bonus', { p_date: date, p_manager: managerId || null, p, p_reason: reason || null }),
    inventoryReport: (from, to, managerId, promoterId) => rpc('inventory_report', { p_from: from, p_to: to, p_manager: managerId || null, p_promoter: promoterId || null }),

    listPayrolls: (f = {}) => q('payrolls', f),
    getPayroll: (id) => q('payroll', { id }),
    previewPayroll: (promoterId, week) => rpc('preview_payroll', { p_promoter: promoterId, p_week: week }),
    generatePayrolls: (week, managerId) => rpc('generate_payrolls', { p_week: week, p_manager: managerId || null }),
    approvePayrolls: (ids) => rpc('approve_payrolls', { p_ids: ids }),
    reopenPayroll: (id, reason) => rpc('reopen_payroll', { p_id: id, p_reason: reason }),
    payPayroll: (id, p) => rpc('pay_payroll', { p_id: id, p_amount: p.amount ?? null, p_method: p.method, p_reference: p.reference || null,
      p_paid_at: toPaidAt(p.paidAt), p_notes: p.notes || null, p_idempotency_key: p.key || null }),
    adjustPayroll: (id, reason) => rpc('adjust_payroll', { p_id: id, p_reason: reason }),

    listLedger: (f = {}) => q('ledger', f),
    addLedgerEntry: (p) => rpc('add_ledger_entry', { p }),
    reviewLedgerEntry: (id, decision, note) => rpc('review_ledger_entry', { p_id: id, p_decision: decision, p_note: note || null }),
    voidLedgerEntry: (id, reason) => rpc('void_ledger_entry', { p_id: id, p_reason: reason }),

    listExpenses: (f = {}) => q('expenses', f),
    async addExpense(p, file) {
      let attachment_path = null;
      if (file) {
        const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
        attachment_path = await rpc('store_attachment', { p_mime: file.type, p_data_b64: b64, p_manager: p.manager_id || null });
      }
      return rpc('add_expense', { p: { ...p, attachment_path } });
    },
    voidExpense: (id, reason) => rpc('void_expense', { p_id: id, p_reason: reason }),
    expenseSummary: (from, to, group, managerId) => rpc('expense_summary', { p_from: from, p_to: to, p_group: group, p_manager: managerId || null }),
    async attachmentUrl(path) {
      const a = await rpc('get_attachment', { p_id: String(path).replace(/^db:/, '') });
      const bin = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
      return URL.createObjectURL(new Blob([bin], { type: a.mime }));
    },

    getDashboard: (from, to, managerId) => rpc('get_dashboard', { p_from: from, p_to: to, p_manager: managerId || null }),
    reportPerformance: (from, to, managerId) => rpc('report_performance', { p_from: from, p_to: to, p_manager: managerId || null }),
    listAudit: (f = {}) => q('audit', f),
  };
  return api;
}
