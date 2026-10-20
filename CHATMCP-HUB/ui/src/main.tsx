import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { hubSessionReady } from './lib/session';

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
