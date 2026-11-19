import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import { createDemoBackend } from './lib/backend.demo.js';
import { createServerBackend } from './lib/backend.server.js';
import './styles.css';

const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
const demo = String(env.VITE_DEMO_MODE || '') === 'true' || new URLSearchParams(location.search).has('demo');
const api = demo ? createDemoBackend() : createServerBackend('/api');
createRoot(document.getElementById('root')).render(<App api={api} />);

if (!demo && 'serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
