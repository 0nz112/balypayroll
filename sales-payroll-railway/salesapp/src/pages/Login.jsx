import React, { useState } from 'react';
import { useI18n, errorText } from '../lib/i18n.js';
import { usePrefs } from '../lib/prefs.js';
import { Button, Field, Input, Icon, Alert } from '../ui/ui.jsx';

export default function Login({ api, error }) {
  const { t, lang } = useI18n();
  const { prefs, setPrefs } = usePrefs();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(error ? errorText(lang, error) : '');

  async function submit(e, asEmail) {
    e?.preventDefault();
    setBusy(true); setErr('');
    try { await api.signIn(asEmail || email.trim(), password); }
    catch (e2) { setErr(['ACCOUNT_INACTIVE', 'LOCKED', 'NETWORK'].includes(e2.code) ? errorText(lang, e2) : t('login_failed')); }
    finally { setBusy(false); }
  }

  return (
    <div className="login">
      <div className="login-art">
        <div className="grid-bg" />
        <div className="orbit" style={{ width: 520, height: 520, top: '18%', insetInlineStart: '8%' }} />
        <div className="orbit o2" style={{ width: 340, height: 340, top: '30%', insetInlineStart: '20%' }} />
        <div className="brand" style={{ position: 'relative' }}>
          <div className="brand-mark"><Icon name="trend" size={22} stroke={2.4} /></div>
          <div><div className="brand-name">{t('app_name')}</div><div className="brand-sub">IQD · Asia/Baghdad</div></div>
        </div>
        <div style={{ position: 'relative' }}>
          <h1>{lang === 'ar' ? <>إدارة المبيعات والرواتب<br /><span style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', color: 'transparent' }}>بدقة محاسبية كاملة</span></> : <>Sales & payroll<br /><span style={{ background: 'var(--grad)', WebkitBackgroundClip: 'text', color: 'transparent' }}>with accounting precision</span></>}</h1>
          <p className="muted" style={{ maxWidth: 460 }}>{lang === 'ar' ? 'تسجيلات يومية، حوافز قابلة للضبط، رواتب أسبوعية من السبت إلى الجمعة، دفاتر حسابات غير قابلة للتلاعب، وكشوفات جاهزة للمشاركة عبر واتساب.' : 'Daily registrations, configurable incentives, Saturday–Friday weekly payroll, tamper-proof ledgers and WhatsApp-ready statements.'}</p>
        </div>
        <div className="floating-stats">
          {(lang === 'ar'
            ? [['register', 'تسجيلات يومية محمية من التكرار'], ['wallet', 'رواتب أسبوعية من السبت إلى الجمعة'], ['shield', 'عزل كامل لبيانات كل مدير + سجل تدقيق']]
            : [['register', 'Duplicate-safe daily registrations'], ['wallet', 'Saturday–Friday weekly payroll'], ['shield', 'Per-manager data isolation + audit log']]
          ).map(([ic, l], i) => (
            <div key={l} className={`card glass float d${i + 1}`} style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12, marginInlineStart: i * 34 }}>
              <span className="kpi-icon"><Icon name={ic} size={16} /></span><span className="grow small">{l}</span><Icon name="check" size={16} style={{ color: 'var(--success)' }} />
            </div>
          ))}
        </div>
      </div>
      <div className="login-form">
        <form className="login-box" onSubmit={submit}>
          <div className="row between">
            <div><h2 style={{ margin: 0 }}>{t('login_title')}</h2><div className="muted small">{t('login_sub')}</div></div>
            <Button variant="ghost" size="sm" icon="globe" onClick={() => setPrefs({ lang: prefs.lang === 'ar' ? 'en' : 'ar' })}>{prefs.lang === 'ar' ? 'English' : 'العربية'}</Button>
          </div>
          {err && <Alert tone="error">{err}</Alert>}
          <Field label={t('email')}><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required dir="ltr" /></Field>
          <Field label={t('password')}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required={api.kind !== 'demo'} dir="ltr" /></Field>
          <Button variant="primary" type="submit" loading={busy} className="block">{t('sign_in')}</Button>
          {api.kind === 'demo' && (
            <div className="card" style={{ padding: 14 }}>
              <div className="small muted" style={{ marginBottom: 10 }}>{t('demo_login_as')}</div>
              <div className="grid" style={{ gap: 8 }}>
                {api.demoUsers.map((u) => (
                  <Button key={u.id} onClick={(e) => submit(e, u.email)} disabled={busy} icon={u.role === 'super_admin' ? 'shield' : 'users'} style={{ justifyContent: 'flex-start' }}>
                    <span className="grow" style={{ textAlign: 'start' }}>{u.full_name}</span><span className="tiny faint">{t('role_' + u.role)}</span>
                  </Button>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 10 }}>{t('demo_banner')}</div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}
