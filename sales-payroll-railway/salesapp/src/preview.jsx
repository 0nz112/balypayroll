// Standalone preview: in-browser demo data, opens directly signed in as the Super Admin.
// (Sign out to switch to a sales manager's view from the demo login buttons.)
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App.jsx';
import { createDemoBackend } from './lib/backend.demo.js';
import './styles.css';

const api = createDemoBackend();
(async () => {
  try { if (!(await api.getSessionUser())) await api.signIn('admin@demo.iq'); } catch { /* falls back to the demo login screen */ }
  createRoot(document.getElementById('root')).render(<App api={api} />);
})();
