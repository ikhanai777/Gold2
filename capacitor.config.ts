import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.goldsignal.dashboard',
  appName: 'Gold Signal',
  webDir: 'mobile/dist',
  android: { allowMixedContent: false },
  plugins: {
    // Called explicitly by the in-app engine; do not patch window.fetch.
    CapacitorHttp: { enabled: false },
  },
};

export default config;
