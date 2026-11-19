// UI customization: theme, accent, font, size, density, corners, glass, motion,
// numerals, sidebar, dashboard widgets and language. Saved per user (DB) + cached locally.
import { createContext, useContext } from 'react';

export const ACCENTS = {
  cyan: '#22d3ee', blue: '#3b82f6', violet: '#8b5cf6', emerald: '#10b981', amber: '#f59e0b', rose: '#f43f5e', teal: '#14b8a6', gold: '#d4a63a',
};
export const FONTS = {
  cairo: { label: 'Cairo', css: "'Cairo', 'IBM Plex Sans Arabic', system-ui, sans-serif" },
  tajawal: { label: 'Tajawal', css: "'Tajawal', 'Cairo', system-ui, sans-serif" },
  plex: { label: 'IBM Plex Sans Arabic', css: "'IBM Plex Sans Arabic', 'Cairo', system-ui, sans-serif" },
  almarai: { label: 'Almarai', css: "'Almarai', 'Cairo', system-ui, sans-serif" },
  system: { label: 'System', css: "system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif" },
};
export const WIDGETS = ['kpis_regs', 'kpis_money', 'chart', 'managers', 'top', 'expenses'];

export const DEFAULT_PREFS = {
  lang: 'ar', theme: 'dark', accent: 'cyan', customAccent: '#22d3ee', font: 'cairo', fontScale: 1, density: 'comfortable',
  radius: 'rounded', glass: true, animations: true, digits: 'latn', sidebar: 'expanded',
  widgets: WIDGETS.map((id) => ({ id, visible: true })),
};

const LOCAL = 'salesapp-prefs';
export function loadLocalPrefs() {
  try { return mergePrefs(JSON.parse(localStorage.getItem(LOCAL))); } catch { return { ...DEFAULT_PREFS }; }
}
export function saveLocalPrefs(p) { try { localStorage.setItem(LOCAL, JSON.stringify(p)); } catch { /* */ } }

export function mergePrefs(p) {
  const out = { ...DEFAULT_PREFS, ...(p && typeof p === 'object' ? p : {}) };
  const known = new Map((out.widgets || []).filter((w) => WIDGETS.includes(w.id)).map((w) => [w.id, w]));
  out.widgets = [...known.values(), ...WIDGETS.filter((id) => !known.has(id)).map((id) => ({ id, visible: true }))];
  out.fontScale = Math.min(1.25, Math.max(0.85, Number(out.fontScale) || 1));
  return out;
}

function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return [188, 86, 53];
  const n = parseInt(m[1], 16); const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
}

export function resolvedTheme(p) {
  if (p.theme !== 'system') return p.theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyPrefs(p, dir) {
  const root = document.documentElement;
  const theme = resolvedTheme(p);
  const accent = p.accent === 'custom' ? p.customAccent : ACCENTS[p.accent] || ACCENTS.cyan;
  const [h, s, l] = hexToHsl(accent);
  root.dataset.theme = theme;
  root.dataset.density = p.density;
  root.dataset.glass = p.glass ? 'on' : 'off';
  root.dataset.motion = p.animations ? 'on' : 'off';
  root.lang = p.lang;
  root.dir = dir;
  root.style.setProperty('--accent-h', h);
  root.style.setProperty('--accent-s', s + '%');
  root.style.setProperty('--accent-l', (theme === 'light' ? Math.min(l, 45) : Math.max(l, 52)) + '%');
  root.style.setProperty('--font', (FONTS[p.font] || FONTS.cairo).css);
  root.style.setProperty('--fs', String(p.fontScale));
  root.style.setProperty('--radius', p.radius === 'sharp' ? '6px' : p.radius === 'soft' ? '22px' : '14px');
  root.style.setProperty('--radius-sm', p.radius === 'sharp' ? '4px' : p.radius === 'soft' ? '14px' : '10px');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#f4f7fc' : '#070d1f';
}

export const PrefsContext = createContext({ prefs: DEFAULT_PREFS, setPrefs: () => {} });
export const usePrefs = () => useContext(PrefsContext);
