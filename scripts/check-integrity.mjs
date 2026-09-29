#!/usr/bin/env node
// Guards the two hard constraints (SPEC §1.3, §1.4):
//  1. No synthetic data: production code must not contain random/mock/sample data generators.
//  2. Zero cost / secrets: no paid endpoints, and no API keys in the built frontend.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const walk = (d) => readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

const prodFiles = [...walk(join(root, 'server/src')), ...walk(join(root, 'web/src'))].filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));
const problems = [];

const SYNTHETIC = [/Math\.random\s*\(/, /\bfaker\b/i, /\bmock(Data|Price|Candles?)\b/i, /\b(sample|dummy|fake)(Data|Prices?|Candles?|News)\b/i, /\bgenerate(Random|Fake|Synthetic)/i];
for (const f of prodFiles) {
  const src = readFileSync(f, 'utf8');
  for (const re of SYNTHETIC) if (re.test(src)) problems.push(`synthetic-data pattern ${re} in ${f.replace(root, '')}`);
}

// Paid endpoints/plans that must never be configured.
const PAID = [/finnhub\.io\/api\/v1\/calendar\/economic/, /api\.anthropic\.com/, /api\.openai\.com/, /twelvedata\.com\/.*(pro|enterprise)/i, /metalpriceapi\.com/, /polygon\.io/];
for (const f of prodFiles) {
  const src = readFileSync(f, 'utf8');
  for (const re of PAID) if (re.test(src)) problems.push(`paid endpoint ${re} referenced in ${f.replace(root, '')}`);
}

// Test fixtures must not be imported by production code.
for (const f of prodFiles) if (/from ['"][^'"]*\/test\//.test(readFileSync(f, 'utf8'))) problems.push(`production code imports test files: ${f}`);

// Built frontend must not contain secrets.
const dist = join(root, 'web/dist');
if (existsSync(dist)) {
  const keys = ['TWELVEDATA_API_KEY', 'FRED_API_KEY', 'FINNHUB_API_KEY'].map((k) => process.env[k]).filter(Boolean);
  for (const f of walk(dist)) {
    const src = readFileSync(f, 'utf8');
    for (const k of keys) if (src.includes(k)) problems.push(`API key value found in ${f.replace(root, '')}`);
    if (/apikey=|api_key=|token=/i.test(src) && /\.js$/.test(f)) problems.push(`key-like query parameter in ${f.replace(root, '')}`);
  }
}

if (problems.length) {
  console.error('Integrity check FAILED:\n' + problems.map((p) => ' - ' + p).join('\n'));
  process.exit(1);
}
console.log(`Integrity check passed (${prodFiles.length} source files${existsSync(dist) ? ', web/dist scanned' : ''}).`);
