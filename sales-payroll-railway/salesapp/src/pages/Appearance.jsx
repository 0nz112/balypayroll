import React, { useState } from 'react';
import { useApp } from '../app/context.js';
import { useI18n, LANGUAGES } from '../lib/i18n.js';
import { usePrefs, ACCENTS, FONTS, DEFAULT_PREFS } from '../lib/prefs.js';
import { Badge, Button, Card, Field, Icon, Input, Kpi, PageHead, Seg, Switch, useFmt, useToast } from '../ui/ui.jsx';

export default function Appearance() {
  const { t } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const f = useFmt(); const toast = useToast();
  const w = prefs.widgets;
  const move = (i, d) => { const a = [...w]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setPrefs({ widgets: a }); };

  return (
    <>
      <PageHead title={t('ap_title')} sub={t('ap_sub')} actions={<Button icon="refresh" onClick={() => { setPrefs({ ...DEFAULT_PREFS, lang: prefs.lang }); toast.ok(t('done')); }}>{t('reset_defaults')}</Button>} />
      <div className="grid split">
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title={t('language')} icon="globe">
            <div className="row wrap" style={{ gap: 8 }}>
              {LANGUAGES.map((l) => (
                <button key={l.code} type="button" className={`chip ${prefs.lang === l.code ? 'on' : ''}`} style={{ padding: '10px 18px', fontSize: '.95rem' }} onClick={() => setPrefs({ lang: l.code })}>
                  {l.name} <span className="tiny faint">{l.dir.toUpperCase()}</span>
                </button>
              ))}
            </div>
          </Card>
          <Card title={t('theme')} icon="sun">
            <div className="grid g3" style={{ gap: 10 }}>
              {['dark', 'light', 'system'].map((th) => (
                <button key={th} type="button" onClick={() => setPrefs({ theme: th })} className="card" style={{ padding: 10, cursor: 'pointer', borderColor: prefs.theme === th ? 'var(--accent)' : undefined, boxShadow: prefs.theme === th ? '0 0 0 3px var(--accent-soft)' : undefined, textAlign: 'start' }}>
                  <div style={{ height: 54, borderRadius: 8, marginBottom: 8, background: th === 'dark' ? 'linear-gradient(135deg,#060b1a,#13203f)' : th === 'light' ? 'linear-gradient(135deg,#f3f6fc,#fff)' : 'linear-gradient(135deg,#060b1a 50%,#f3f6fc 50%)', border: '1px solid var(--border)', position: 'relative' }}>
                    <span style={{ position: 'absolute', insetInlineStart: 8, bottom: 8, width: 28, height: 6, borderRadius: 3, background: 'var(--accent)' }} />
                  </div>
                  <b className="small">{t('th_' + th)}</b>
                </button>
              ))}
            </div>
          </Card>
          <Card title={t('accent')} icon="palette">
            <div className="row wrap" style={{ gap: 10 }}>
              {Object.entries(ACCENTS).map(([k, c]) => (
                <button key={k} type="button" aria-label={k} onClick={() => setPrefs({ accent: k })}
                  style={{ width: 38, height: 38, borderRadius: 12, background: c, border: 0, cursor: 'pointer', boxShadow: prefs.accent === k ? `0 0 0 3px var(--surface), 0 0 0 5px ${c}` : 'none', transition: '.2s' }}>
                  {prefs.accent === k && <Icon name="check" size={18} style={{ color: '#fff' }} />}
                </button>
              ))}
              <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="color" value={prefs.customAccent} onChange={(e) => setPrefs({ accent: 'custom', customAccent: e.target.value })}
                  style={{ width: 38, height: 38, border: 0, borderRadius: 12, padding: 0, background: 'none', cursor: 'pointer', boxShadow: prefs.accent === 'custom' ? `0 0 0 3px var(--surface), 0 0 0 5px ${prefs.customAccent}` : 'none' }} />
                <span className="small muted">{t('custom_color')}</span>
              </label>
            </div>
          </Card>
          <Card title={t('font')} icon="edit">
            <div className="row wrap" style={{ gap: 8 }}>
              {Object.entries(FONTS).map(([k, v]) => (
                <button key={k} type="button" className={`chip ${prefs.font === k ? 'on' : ''}`} style={{ fontFamily: v.css, padding: '9px 16px', fontSize: '.95rem' }} onClick={() => setPrefs({ font: k })}>{k === 'system' ? t('th_system') : v.label} — أبجد</button>
              ))}
            </div>
            <Field label={`${t('font_size')} — ${Math.round(prefs.fontScale * 100)}%`} className="" >
              <input type="range" min="0.85" max="1.25" step="0.05" value={prefs.fontScale} onChange={(e) => setPrefs({ fontScale: Number(e.target.value) })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
            </Field>
          </Card>
          <Card title={t('density')} icon="sidebar">
            <div className="grid g2" style={{ gap: 14 }}>
              <Field label={t('density')}><Seg accent value={prefs.density} onChange={(v) => setPrefs({ density: v })} options={[{ value: 'comfortable', label: t('d_comfortable') }, { value: 'compact', label: t('d_compact') }]} /></Field>
              <Field label={t('corners')}><Seg accent value={prefs.radius} onChange={(v) => setPrefs({ radius: v })} options={[{ value: 'sharp', label: t('r_sharp') }, { value: 'rounded', label: t('r_rounded') }, { value: 'soft', label: t('r_soft') }]} /></Field>
              <Field label={t('numerals')}><Seg accent value={prefs.digits} onChange={(v) => setPrefs({ digits: v })} options={[{ value: 'latn', label: t('num_latn') }, { value: 'arab', label: t('num_arab') }]} /></Field>
              <Field label={t('sidebar')}><Seg accent value={prefs.sidebar} onChange={(v) => setPrefs({ sidebar: v })} options={[{ value: 'expanded', label: t('sb_expanded') }, { value: 'collapsed', label: t('sb_collapsed') }]} /></Field>
              <Switch checked={prefs.glass} onChange={(c) => setPrefs({ glass: c })} label={t('glass')} />
              <Switch checked={prefs.animations} onChange={(c) => setPrefs({ animations: c })} label={t('animations')} />
            </div>
          </Card>
          <Card title={t('dash_widgets')} icon="dashboard">
            {w.map((x, i) => (
              <div key={x.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <Switch checked={x.visible} onChange={(c) => setPrefs({ widgets: w.map((y) => (y.id === x.id ? { ...y, visible: c } : y)) })} />
                <span className="grow">{t('w_' + x.id)}</span>
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)}>{t('move_up')}</Button>
                <Button size="sm" variant="ghost" disabled={i === w.length - 1} onClick={() => move(i, 1)}>{t('move_down')}</Button>
              </div>
            ))}
          </Card>
        </div>
        <div className="grid sticky-side">
          <PasswordCard />
          <Card glass title={t('ap_preview')}>
            <div className="grid" style={{ gap: 12 }}>
              <Kpi hero label={t('kpi_today')} value={42} icon="register" />
              <Kpi money label={t('net_salary')} value={1250000} icon="wallet" color="#10b981" />
              <div className="row wrap"><Badge tone="green">{t('ps_paid')}</Badge><Badge tone="amber">{t('ps_pending')}</Badge><Badge tone="accent">{t('incentive_day')}</Badge></div>
              <div className="row wrap"><Button variant="primary" icon="check">{t('save')}</Button><Button>{t('cancel')}</Button></div>
              <div className="small muted">{f.date('2026-11-14')} · {f.money(15000)} · {f.num(1234567)}</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function PasswordCard() {
  const { api } = useApp(); const { t } = useI18n(); const toast = useToast();
  const [cur, setCur] = useState(''); const [next, setNext] = useState(''); const [busy, setBusy] = useState(false);
  if (!api.changePassword) return null;
  async function save() {
    setBusy(true);
    try { await api.changePassword(cur, next); toast.ok(t('password_changed')); setTimeout(() => api.signOut(), 1200); }
    catch (e) { toast.error(e); } finally { setBusy(false); }
  }
  return (
    <Card title={t('change_password')} icon="lock">
      <div className="grid" style={{ gap: 10 }}>
        <Field label={t('current_password')}><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" dir="ltr" /></Field>
        <Field label={t('new_password')} hint="≥ 8"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" dir="ltr" /></Field>
        <div className="row end"><Button variant="primary" loading={busy} disabled={!cur || next.length < 8} onClick={save}>{t('save')}</Button></div>
      </div>
    </Card>
  );
}
