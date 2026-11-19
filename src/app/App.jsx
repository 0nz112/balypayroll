import React, { useCallback, useEffect, useMemo, useState, Suspense } from 'react';
import { AppCtx, useHashRoute, navigate } from './context.js';
import { I18nContext, translate, LANGUAGES } from '../lib/i18n.js';
import { PrefsContext, applyPrefs, loadLocalPrefs, saveLocalPrefs, mergePrefs } from '../lib/prefs.js';
import { ToastProvider, ConfirmProvider, Icon, Button, Skeleton, ErrorState } from '../ui/ui.jsx';
import Login from '../pages/Login.jsx';
import Dashboard from '../pages/Dashboard.jsx';
import Registrations from '../pages/Registrations.jsx';
import { PromotersList, PromoterDetail } from '../pages/Promoters.jsx';
import Payroll from '../pages/Payroll.jsx';
import Ledger from '../pages/Ledger.jsx';
import Expenses from '../pages/Expenses.jsx';
import Incentives from '../pages/Incentives.jsx';
import Reports from '../pages/Reports.jsx';
import { Managers, Audit, SystemSettings } from '../pages/Admin.jsx';
import Appearance from '../pages/Appearance.jsx';
import Debts from '../pages/Debts.jsx';
import { AmbientBackground, useGlobalEffects, useInstall, InstallGuide, InstallBanner } from '../ui/motion.jsx';

const NAV = [
  { id: 'dashboard', icon: 'dashboard', label: 'nav_dashboard' },
  { id: 'registrations', icon: 'register', label: 'nav_registrations' },
  { id: 'promoters', icon: 'users', label: 'nav_promoters' },
  { id: 'payroll', icon: 'wallet', label: 'nav_payroll' },
  { id: 'debts', icon: 'debt', label: 'nav_debts' },
  { id: 'ledger', icon: 'ledger', label: 'nav_ledger' },
  { id: 'expenses', icon: 'receipt', label: 'nav_expenses' },
  { id: 'incentives', icon: 'gift', label: 'nav_incentives' },
  { id: 'reports', icon: 'chart', label: 'nav_reports' },
  { id: 'managers', icon: 'shield', label: 'nav_managers', admin: true },
  { id: 'audit', icon: 'history', label: 'nav_audit', admin: true },
  { id: 'settings', icon: 'settings', label: 'nav_settings', admin: true },
  { id: 'appearance', icon: 'palette', label: 'nav_appearance' },
];
const BOTTOM = ['dashboard', 'registrations', 'payroll', 'promoters'];

export default function App({ api }) {
  const [prefs, setPrefsState] = useState(loadLocalPrefs);
  const lang = prefs.lang;
  const dir = LANGUAGES.find((l) => l.code === lang)?.dir || 'rtl';
  const i18n = useMemo(() => ({ lang, dir, t: (k, v) => translate(lang, k, v) }), [lang, dir]);
  useEffect(() => { applyPrefs(prefs, dir); }, [prefs, dir]);
  useGlobalEffects();
  useEffect(() => {
    if (prefs.theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)'); const on = () => applyPrefs(prefs, dir);
    mq.addEventListener('change', on); return () => mq.removeEventListener('change', on);
  }, [prefs, dir]);

  const [session, setSession] = useState({ loading: true, me: null, error: null });
  const [meta, setMeta] = useState({ settings: null, managers: [], categories: [] });

  const setPrefs = useCallback((patch) => {
    setPrefsState((p) => {
      const next = mergePrefs({ ...p, ...(typeof patch === 'function' ? patch(p) : patch) });
      saveLocalPrefs(next);
      api.savePrefs(next).catch(() => {});
      return next;
    });
  }, [api]);

  const loadMe = useCallback(async () => {
    try {
      const me = await api.me();
      if (!me) { setSession({ loading: false, me: null }); return; }
      if (me.status !== 'active') { setSession({ loading: false, me: null, error: { code: 'ACCOUNT_INACTIVE' } }); await api.signOut(); return; }
      const [settings, categories, managers, remotePrefs] = await Promise.all([
        api.getSettings(), api.expenseCategories(), me.role === 'super_admin' ? api.listManagers() : Promise.resolve([]), api.getPrefs().catch(() => null),
      ]);
      if (remotePrefs) { const m = mergePrefs(remotePrefs); setPrefsState(m); saveLocalPrefs(m); }
      setMeta({ settings, categories, managers });
      setSession({ loading: false, me });
    } catch (error) { setSession({ loading: false, me: null, error }); }
  }, [api]);

  useEffect(() => { loadMe(); return api.onAuthChange(() => loadMe()); }, [api, loadMe]);

  const refreshMeta = useCallback(async () => {
    if (!session.me) return;
    const [settings, categories, managers] = await Promise.all([api.getSettings(), api.expenseCategories(), session.me.role === 'super_admin' ? api.listManagers() : []]);
    setMeta({ settings, categories, managers });
  }, [api, session.me]);

  const ctx = useMemo(() => ({ api, me: session.me, ...meta, refreshMeta, isAdmin: session.me?.role === 'super_admin' }), [api, session.me, meta, refreshMeta]);

  return (
    <I18nContext.Provider value={i18n}>
      <PrefsContext.Provider value={{ prefs, setPrefs }}>
        <ToastProvider>
          <ConfirmProvider>
            <AmbientBackground />
            {session.loading ? <Splash /> : !session.me ? <Login api={api} error={session.error} /> : (
              <AppCtx.Provider value={ctx}><Shell /></AppCtx.Provider>
            )}
          </ConfirmProvider>
        </ToastProvider>
      </PrefsContext.Provider>
    </I18nContext.Provider>
  );
}

function Splash() {
  return <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}><div className="brand-mark float" style={{ width: 56, height: 56 }}><Icon name="trend" size={28} /></div></div>;
}

function Shell() {
  const { me, api, isAdmin, settings } = React.useContext(AppCtx);
  const { t, dir } = React.useContext(I18nContext);
  const { prefs, setPrefs } = React.useContext(PrefsContext);
  const route = useHashRoute();
  const install = useInstall();
  const [guide, setGuide] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => { setDrawer(false); window.scrollTo({ top: 0 }); }, [route.path]);

  const section = route.parts[0] || 'dashboard';
  const items = NAV.filter((n) => !n.admin || isAdmin);
  const current = items.find((n) => n.id === section);
  const collapsed = prefs.sidebar === 'collapsed';

  let page;
  switch (section) {
    case 'dashboard': page = <Dashboard />; break;
    case 'registrations': page = <Registrations query={route.query} />; break;
    case 'promoters': page = route.parts[1] ? <PromoterDetail id={route.parts[1]} /> : <PromotersList />; break;
    case 'payroll': page = <Payroll query={route.query} />; break;
    case 'debts': page = <Debts />; break;
    case 'ledger': page = <Ledger query={route.query} />; break;
    case 'expenses': page = <Expenses />; break;
    case 'incentives': page = <Incentives />; break;
    case 'reports': page = <Reports />; break;
    case 'managers': page = isAdmin ? <Managers /> : <Forbidden />; break;
    case 'audit': page = isAdmin ? <Audit /> : <Forbidden />; break;
    case 'settings': page = isAdmin ? <SystemSettings /> : <Forbidden />; break;
    case 'appearance': page = <Appearance />; break;
    default: page = <Dashboard />;
  }
  const initials = (me.full_name || me.email || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

  return (
    <>
      {api.kind === 'demo' && <div className="demo-banner">{t('demo_banner')}</div>}
      {!online && <div className="demo-banner" style={{ color: 'var(--danger)' }}>{t('offline')}</div>}
      <div className={`app ${collapsed ? 'collapsed' : ''}`}>
        <aside className="sidebar" aria-label="main navigation">
          <div className="brand">
            <div className="brand-mark"><Icon name="trend" size={22} stroke={2.4} /></div>
            <div className="brand-text"><div className="brand-name">{settings?.company_name || t('app_name')}</div><div className="brand-sub">{t('app_name')}</div></div>
          </div>
          {items.map((n, i) => (
            <React.Fragment key={n.id}>
              {n.admin && !items[i - 1]?.admin && <div className="nav-group">{t('role_super_admin')}</div>}
              <button className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => navigate('/' + n.id)} title={t(n.label)}>
                <Icon name={n.icon} size={19} /><span>{t(n.label)}</span>
              </button>
            </React.Fragment>
          ))}
          <div className="sidebar-foot">
            <button className="nav-item" onClick={() => setPrefs({ sidebar: collapsed ? 'expanded' : 'collapsed' })} title={t('sidebar')}><Icon name="sidebar" size={19} /><span>{collapsed ? t('sb_expanded') : t('sb_collapsed')}</span></button>
            <div className="user-card">
              <div className="avatar">{initials}</div>
              <div className="col grow" style={{ gap: 0 }}><b className="small ellipsis">{me.full_name}</b><span className="tiny faint">{t('role_' + me.role)}</span></div>
            </div>
            <button className="nav-item" onClick={() => api.signOut()}><Icon name="logout" size={19} /><span>{t('sign_out')}</span></button>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="only-mobile"><div className="brand-mark" style={{ width: 34, height: 34, borderRadius: 10 }}><Icon name="trend" size={18} /></div></div>
            <b className="grow ellipsis" style={{ fontSize: '1.02rem' }}>{current ? t(current.label) : ''}</b>
            {!install.installed && <Button size="sm" icon="download" onClick={() => setGuide(true)} title={t('install_app')}><span className="hide-mobile">{t('install_app')}</span></Button>}
            <Button variant="ghost" size="sm" icon="globe" onClick={() => setPrefs({ lang: prefs.lang === 'ar' ? 'en' : 'ar' })} title={t('language')}>{prefs.lang === 'ar' ? 'EN' : 'ع'}</Button>
            <Button variant="ghost" size="sm" icon={prefs.theme === 'light' ? 'moon' : 'sun'} onClick={() => setPrefs({ theme: prefs.theme === 'light' ? 'dark' : 'light' })} aria-label={t('theme')} />
            <div className="avatar hide-mobile" title={me.full_name} style={{ width: 34, height: 34, fontSize: '.8rem' }}>{initials}</div>
          </header>
          <main className="page" key={route.path}>
            <Suspense fallback={<Skeleton h={300} />}>{page}</Suspense>
          </main>
        </div>
      </div>
      <nav className="bottom-nav" aria-label="mobile navigation">
        {BOTTOM.map((id) => { const n = NAV.find((x) => x.id === id); return (
          <button key={id} className={`bn-item ${section === id ? 'active' : ''}`} onClick={() => navigate('/' + id)}><Icon name={n.icon} size={21} />{t(n.label).split(' ')[0]}</button>
        ); })}
        <button className={`bn-item ${!BOTTOM.includes(section) ? 'active' : ''}`} onClick={() => setDrawer(true)}><Icon name="menu" size={21} />{t('nav_more')}</button>
      </nav>
      <InstallBanner install={install} onOpen={() => setGuide(true)} />
      {guide && <InstallGuide open onClose={() => setGuide(false)} install={install} />}
      {drawer && (
        <div className="drawer" onClick={() => setDrawer(false)}>
          <div className="drawer-panel" onClick={(e) => e.stopPropagation()} dir={dir}>
            <div className="drawer-grip" />
            <div className="user-card" style={{ marginBottom: 8 }}>
              <div className="avatar">{initials}</div>
              <div className="col grow" style={{ gap: 0 }}><b>{me.full_name}</b><span className="tiny faint">{t('role_' + me.role)}</span></div>
            </div>
            <div className="grid g2" style={{ gap: 6 }}>
              {items.filter((n) => !BOTTOM.includes(n.id)).map((n) => (
                <button key={n.id} className={`nav-item ${section === n.id ? 'active' : ''}`} onClick={() => navigate('/' + n.id)}><Icon name={n.icon} size={19} /><span>{t(n.label)}</span></button>
              ))}
              <button className="nav-item" onClick={() => api.signOut()}><Icon name="logout" size={19} /><span>{t('sign_out')}</span></button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Forbidden() { return <ErrorState error={{ code: 'FORBIDDEN' }} />; }
