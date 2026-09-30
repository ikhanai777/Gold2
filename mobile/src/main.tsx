import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { setLocalBackend } from '../../web/src/api';
import { App } from '../../web/src/App';
import '../../web/src/styles.css';
import './mobile.css';
import { startEngine } from './engine';
import { SettingsButton } from './Settings';
import { emit } from '../../server/src/jobs';

setLocalBackend(startEngine());

// When the app returns to the foreground, refresh every panel immediately.
if (Capacitor.isNativePlatform()) {
  CapApp.addListener('resume', () => { emit('candles', {}); emit('news', {}); emit('quotes', null); }).catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App headerExtra={<SettingsButton />} />
  </StrictMode>,
);
