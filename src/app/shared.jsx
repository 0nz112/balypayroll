// Shared page-level widgets: manager filter, date range, week picker, promoter picker.
import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from './context.js';
import { useI18n } from '../lib/i18n.js';
import { Button, Icon, Input, Select, useFmt } from '../ui/ui.jsx';
import { rangePreset, baghdadToday, addDays, weekStartOf } from '../engine/dates.js';

export function ManagerFilter({ value, onChange, allowAll = true }) {
  const { me, managers } = useApp();
  const { t } = useI18n();
  if (me.role !== 'super_admin') return null;
  return (
    <Select value={value || ''} onChange={(e) => onChange(e.target.value || null)} style={{ width: 200 }}
      placeholder={allowAll ? t('all_managers') : t('select_manager')} options={(managers || []).map((m) => ({ value: m.id, label: m.full_name }))} />
  );
}

const PRESETS = ['today', 'yesterday', 'week', 'last_week', 'month', 'last_month', 'last_30'];
const PRESET_LABEL = { today: 'today', yesterday: 'yesterday', week: 'this_week', last_week: 'last_week', month: 'this_month', last_month: 'last_month', last_30: 'last_30' };

export function DateRange({ value, onChange }) {
  const { t } = useI18n();
  const today = baghdadToday();
  const preset = PRESETS.find((p) => { const r = rangePreset(p, today); return r.from === value.from && r.to === value.to; }) || 'custom';
  return (
    <div className="row wrap" style={{ gap: 8 }}>
      <Select value={preset} onChange={(e) => e.target.value !== 'custom' && onChange(rangePreset(e.target.value, today))} style={{ width: 150 }}
        options={[...PRESETS.map((p) => ({ value: p, label: t(PRESET_LABEL[p]) })), { value: 'custom', label: t('custom') }]} />
      <Input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} style={{ width: 150 }} aria-label={t('from')} />
      <Input type="date" value={value.to} min={value.from} max={today} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} style={{ width: 150 }} aria-label={t('to')} />
    </div>
  );
}

export function WeekPicker({ value, onChange }) {
  const { t, dir } = useI18n();
  const f = useFmt();
  const cur = weekStartOf(baghdadToday());
  const [prevIcon, nextIcon] = dir === 'rtl' ? ['chevR', 'chevL'] : ['chevL', 'chevR'];
  return (
    <div className="weekbar">
      <Button icon={prevIcon} onClick={() => onChange(addDays(value, -7))} aria-label={t('prev_week')} />
      <div className="week-label">
        <b className="num">{t('week_range', { from: f.short(value), to: f.short(addDays(value, 6)) })}</b>
        <span>{t('pay_day')}: {f.weekday(addDays(value, 10))} {f.date(addDays(value, 10))}</span>
      </div>
      <Button icon={nextIcon} onClick={() => onChange(addDays(value, 7))} disabled={value >= cur} aria-label={t('next_week')} />
      {value !== cur && <Button variant="ghost" size="sm" onClick={() => onChange(cur)}>{t('current_week')}</Button>}
    </div>
  );
}

export function PromoterPicker({ value, onChange, managerId, placeholder, onlyActive }) {
  const { api } = useApp();
  const { t } = useI18n();
  const [list, setList] = useState([]);
  useEffect(() => { let on = true; api.listPromoters({ managerId }).then((r) => on && setList(r)).catch(() => {}); return () => { on = false; }; }, [api, managerId]);
  const opts = useMemo(() => list.filter((p) => !onlyActive || p.status === 'active' || p.id === value).map((p) => ({ value: p.id, label: `${p.full_name} — ${p.phone}` })), [list, onlyActive, value]);
  return <Select value={value || ''} onChange={(e) => onChange(e.target.value || null, list.find((p) => p.id === e.target.value))} placeholder={placeholder ?? t('promoter')} options={opts} />;
}

export function SearchBox({ value, onChange, placeholder }) {
  const [v, setV] = useState(value);
  useEffect(() => { const h = setTimeout(() => onChange(v), 250); return () => clearTimeout(h); }, [v]); // eslint-disable-line
  return (
    <div className="input-wrap" style={{ minWidth: 220, flex: 1, maxWidth: 380 }}>
      <Icon name="search" size={16} />
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} type="search" />
    </div>
  );
}
