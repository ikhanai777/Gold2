// Node-only setup: load .env, apply keys/caps, and install the SQLite store and
// undici transport (with HTTPS_PROXY support).
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fetch, EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { applySettings } from '../config.js';
import { setStore } from '../store.js';
import { setTransport } from '../transport.js';
import { sqliteStore } from './sqliteStore.js';

// Minimal .env loader (no dependency). Real environment variables win.
const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const serverConfig = {
  port: num(process.env.PORT, 8787),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: process.env.DB_PATH ?? resolve(process.cwd(), 'data/gold.db'),
};

applySettings(process.env);
setStore(sqliteStore(serverConfig.dbPath));

if (process.env.HTTPS_PROXY || process.env.https_proxy) setGlobalDispatcher(new EnvHttpProxyAgent());
setTransport(async (url, { headers, timeoutMs }) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  return { status: res.status, text: () => res.text(), bytes: async () => new Uint8Array(await res.arrayBuffer()) };
});
