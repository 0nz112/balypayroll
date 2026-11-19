import { createContext, useContext, useEffect, useState, useCallback } from 'react';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function useHashRoute() {
  const parse = () => {
    const h = (window.location.hash || '#/dashboard').slice(1);
    const [path, qs] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    return { path, parts, query: Object.fromEntries(new URLSearchParams(qs || '')) };
  };
  const [route, setRoute] = useState(parse);
  useEffect(() => { const on = () => setRoute(parse()); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  return route;
}
export const navigate = (p) => { window.location.hash = p; };

/** Small helper so pages can run an action with toast + error handling. */
export function useAction(toast) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast.ok(okMsg); return r; }
    catch (e) { toast.error(e); return undefined; }
    finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}
