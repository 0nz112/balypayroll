// Motion graphics & effects: animated progress rings, confetti celebration,
// button ripples, pointer-follow glow, ambient animated background, scroll reveal,
// and the PWA install experience (Android prompt + iPhone guide).
// Everything respects the "animations" preference and prefers-reduced-motion.
import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n.js';
import { Button, Icon, Modal } from './ui.jsx';

const motionOn = () => document.documentElement.dataset.motion !== 'off' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function Ring({ value = 0, size = 64, stroke = 6, tone, label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const r = (size - stroke) / 2; const C = 2 * Math.PI * r;
  const color = tone === 'success' ? 'var(--success)' : v >= 60 ? 'var(--success)' : v >= 40 ? 'var(--warning)' : 'var(--accent)';
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="ring" role="img" aria-label={`${v}%`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={C * (1 - v / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} className="ring-arc" style={{ '--c': C }} />
      <text x="50%" y="52%" dominantBaseline="middle" textAnchor="middle" fontSize={size * 0.26} fontWeight="800" fill="var(--text)">{label ?? `${v}%`}</text>
    </svg>
  );
}

/** Confetti burst from the top of the screen. */
export function celebrate() {
  if (!motionOn()) return;
  const c = document.createElement('canvas');
  c.className = 'confetti'; c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio;
  document.body.appendChild(c);
  const ctx = c.getContext('2d'); ctx.scale(devicePixelRatio, devicePixelRatio);
  const colors = ['#22d3ee', '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#ffffff'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.5, y: -20 - Math.random() * 80,
    vx: (Math.random() - 0.5) * 9, vy: Math.random() * 3 + 2, s: Math.random() * 7 + 4, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
    c: colors[(Math.random() * colors.length) | 0], shape: Math.random() > 0.5 ? 'rect' : 'circle',
  }));
  const start = performance.now();
  (function frame(now) {
    const t = now - start; ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.12; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - t / 2600); ctx.fillStyle = p.c;
      if (p.shape === 'rect') ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); else { ctx.beginPath(); ctx.arc(0, 0, p.s / 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
    if (t < 2700) requestAnimationFrame(frame); else c.remove();
  })(start);
}

/** Global effects: button ripples, pointer glow on cards, scroll-reveal. Mount once. */
export function useGlobalEffects() {
  useEffect(() => {
    const onDown = (e) => {
      if (!motionOn()) return;
      const b = e.target.closest?.('.btn, .nav-item, .bn-item, .chip');
      if (!b) return;
      const r = b.getBoundingClientRect(); const d = Math.max(r.width, r.height) * 2;
      const s = document.createElement('span'); s.className = 'ripple';
      s.style.cssText = `width:${d}px;height:${d}px;left:${e.clientX - r.left - d / 2}px;top:${e.clientY - r.top - d / 2}px`;
      b.appendChild(s); setTimeout(() => s.remove(), 650);
    };
    const onMove = (e) => {
      const card = e.target.closest?.('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`); card.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    document.addEventListener('pointerdown', onDown); document.addEventListener('pointermove', onMove, { passive: true });
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((x) => { if (x.isIntersecting) { x.target.classList.add('in'); io.unobserve(x.target); } }), { rootMargin: '0px 0px -40px 0px' }) : null;
    const scan = () => document.querySelectorAll('.card:not(.reveal)').forEach((el) => { el.classList.add('reveal'); io ? io.observe(el) : el.classList.add('in'); });
    const mo = new MutationObserver(() => scan()); mo.observe(document.body, { childList: true, subtree: true }); scan();
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('pointermove', onMove); mo.disconnect(); io?.disconnect(); };
  }, []);
}

export function AmbientBackground() {
  return (
    <div className="ambient" aria-hidden="true">
      <span className="blob b1" /><span className="blob b2" /><span className="blob b3" />
      <div className="grid-glow" />
    </div>
  );
}

// ------------------------------------------------------------------ PWA install
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

export function useInstall() {
  const [evt, setEvt] = useState(null);
  const [installed, setInstalled] = useState(isStandalone());
  useEffect(() => {
    const bi = (e) => { e.preventDefault(); setEvt(e); };
    const ok = () => { setInstalled(true); setEvt(null); };
    window.addEventListener('beforeinstallprompt', bi); window.addEventListener('appinstalled', ok);
    return () => { window.removeEventListener('beforeinstallprompt', bi); window.removeEventListener('appinstalled', ok); };
  }, []);
  return { installed, canPrompt: !!evt, ios: isIOS(), prompt: async () => { if (!evt) return false; evt.prompt(); const r = await evt.userChoice; setEvt(null); return r.outcome === 'accepted'; } };
}

export function InstallGuide({ open, onClose, install }) {
  const { t } = useI18n();
  const [tab, setTab] = useState(install.ios ? 'ios' : 'android');
  const steps = tab === 'ios' ? ['ios_step1', 'ios_step2', 'ios_step3'] : ['android_step1', 'android_step2', 'android_step3'];
  return (
    <Modal open={open} onClose={onClose} title={t('install_title')}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{t('later')}</Button>
        {install.canPrompt && <Button variant="primary" icon="download" onClick={async () => { if (await install.prompt()) onClose(); }}>{t('install_now')}</Button>}
      </>}>
      <div className="install-hero">
        <div className="phone"><div className="phone-screen"><div className="app-icon float"><Icon name="trend" size={30} stroke={2.6} /></div></div></div>
        <p className="muted small" style={{ margin: 0 }}>{t('install_sub')}</p>
      </div>
      <div className="seg" style={{ alignSelf: 'center' }}>
        <button className={tab === 'android' ? 'on accent' : ''} onClick={() => setTab('android')}>{t('install_android')}</button>
        <button className={tab === 'ios' ? 'on accent' : ''} onClick={() => setTab('ios')}>{t('install_ios')}</button>
      </div>
      <ol className="install-steps">
        {steps.map((k, i) => (
          <li key={k} style={{ '--i': i }}>
            <span className="step-num">{i + 1}</span>
            <span className="grow">{t(k)}</span>
            {tab === 'ios' && i === 0 && <span className="ios-share" aria-hidden>⎙</span>}
          </li>
        ))}
      </ol>
      {tab === 'ios' && <div className="hint">{t('ios_needs_safari')}</div>}
    </Modal>
  );
}

/** Small banner shown once on phones until installed or dismissed. */
export function InstallBanner({ install, onOpen }) {
  const { t } = useI18n();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('salesapp-install-dismissed') === '1'; } catch { return false; } });
  const mobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 900px)').matches;
  if (install.installed || hidden || !(mobile || install.canPrompt)) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem('salesapp-install-dismissed', '1'); } catch { /* */ } };
  return (
    <div className="install-banner">
      <div className="app-icon sm"><Icon name="trend" size={18} stroke={2.6} /></div>
      <div className="grow"><b className="small">{t('install_title')}</b><div className="tiny faint">{install.ios ? t('install_ios') : t('install_android')}</div></div>
      <Button size="sm" variant="primary" onClick={onOpen}>{t('install_app')}</Button>
      <Button size="sm" variant="ghost" icon="x" onClick={dismiss} aria-label={t('close')} />
    </div>
  );
}
