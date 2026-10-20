import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { hubSessionReady } from './lib/session';

// Apply the saved theme before the first paint, so a person who chose the light theme does not see a dark flash.
try {
  const saved = localStorage.getItem('chatmcp:theme');
  const light = saved === 'light' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
} catch { /* storage can be unavailable; the default theme stays */ }

// The sign-in ticket in the address is traded for the Hub secret once, here, before anything renders or requests.
const rootElement = document.getElementById('root');
if (rootElement) {
  void hubSessionReady.finally(() => {
    ReactDOM.createRoot(rootElement).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
}
