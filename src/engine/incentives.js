// Daily incentive engine — exact mirror of public.calc_daily_incentive() in SQL.
// An incentive day adds a fixed amount per car registered that day (all cars, or
// active cars only), optionally from a minimum number of cars. Nothing is hardcoded.

const isInt = (v) => Number.isSafeInteger(v);

export function emptyRule() {
  return { is_incentive_day: true, per_car_amount: 0, applies_to: 'all', min_cars: 1, min_tenure_days: 0, manager_ids: null, notes: '' };
}

/** Validate & normalise (same rules as public.normalize_incentive_rule). Throws Error('INVALID_RULE'). */
export function normalizeRule(p) {
  const fail = (d) => { const e = new Error('INVALID_RULE'); e.detail = d; throw e; };
  if (!p || typeof p !== 'object') fail('payload');
  const amt = Number(p.per_car_amount ?? 0); if (!isInt(amt) || amt < 0) fail('per_car_amount');
  const min = Number(p.min_cars ?? 1); if (!isInt(min) || min < 1) fail('min_cars');
  const ten = Number(p.min_tenure_days ?? 0); if (!isInt(ten) || ten < 0) fail('min_tenure_days');
  const applies = p.applies_to ?? 'all'; if (!['all', 'active'].includes(applies)) fail('applies_to');
  return {
    is_incentive_day: !!p.is_incentive_day, per_car_amount: amt, applies_to: applies, min_cars: min, min_tenure_days: ten,
    manager_ids: Array.isArray(p.manager_ids) && p.manager_ids.length ? [...p.manager_ids] : null, notes: p.notes ?? null,
  };
}

export function calcDailyIncentive(rule, count, active, tenureDays, managerId) {
  if (!rule || !(count > 0)) return 0;
  if (!rule.is_incentive_day) return 0;
  if (Array.isArray(rule.manager_ids) && rule.manager_ids.length > 0 && !rule.manager_ids.includes(managerId ?? '')) return 0;
  if ((tenureDays ?? 0) < (rule.min_tenure_days ?? 0)) return 0;
  if (count < (rule.min_cars ?? 1)) return 0;
  const units = rule.applies_to === 'active' ? Math.min(active ?? 0, count) : count;
  return units * Number(rule.per_car_amount ?? 0);
}

// Manager-defined daily bonus — exact mirror of public.calc_daily_bonus() in SQL.
// bonus: { enabled, tier2, tier3, tier4, tier5, extra_enabled, extra_amount, applies_to: 'all' | 'active' }
// Only the highest tier reached is paid; from the 6th car each extra car adds extra_amount.
export const BONUS_TIERS = [2, 3, 4, 5];
export function emptyBonus() { return { enabled: false, tier2: 0, tier3: 0, tier4: 0, tier5: 0, extra_enabled: false, extra_amount: 0, applies_to: 'all', notes: '' }; }
export function calcDailyBonus(bonus, count, active) {
  if (!bonus || !bonus.enabled || !(count > 0)) return 0;
  const units = bonus.applies_to === 'active' ? Math.min(active ?? 0, count) : count;
  if (units < 2) return 0;
  let amt = 0;
  for (let k = Math.min(units, 5); k >= 2; k--) { const v = Number(bonus['tier' + k] ?? 0); if (v > 0) { amt = v; break; } }
  if (units > 5 && bonus.extra_enabled) amt += (units - 5) * Number(bonus.extra_amount ?? 0);
  return amt;
}
