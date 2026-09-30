import { useState } from 'react';
import { loadSettings, saveSettings, type AppSettings } from './engine';

const FIELDS: { key: keyof AppSettings; label: string; adds: string; url: string }[] = [
  { key: 'TWELVEDATA_API_KEY', label: 'Twelve Data', adds: 'Spot XAU/USD candles (otherwise the chart uses COMEX futures)', url: 'https://twelvedata.com/pricing' },
  { key: 'FRED_API_KEY', label: 'FRED', adds: 'Seasonally adjusted CPI and official release dates', url: 'https://fred.stlouisfed.org/docs/api/api_key.html' },
  { key: 'FINNHUB_API_KEY', label: 'Finnhub', adds: 'Extra market headlines', url: 'https://finnhub.io/register' },
];

export function SettingsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>Settings</button>
      {open && <SettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AppSettings>(() => loadSettings());
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    saveSettings(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, (v ?? '').trim()])) as AppSettings);
    location.reload(); // restart the in-app engine with the new keys
  };
  return (
    <div className="overlay modal-center" onClick={onClose} role="dialog" aria-modal="true" aria-label="Settings">
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={save} style={{ maxWidth: 520 }}>
        <div className="row"><h3 style={{ margin: 0 }}>Settings</h3><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Close</button></div>
        <p className="small secondary">
          The app works without any keys, using only free sources. Each optional key below is a free sign-up with no credit card.
          Keys are stored only on this phone.
        </p>
        {FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            <span><strong>{f.label}</strong> <span className="tiny muted">· {f.adds}</span></span>
            <input
              id={f.key}
              type="text"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              value={s[f.key] ?? ''}
              onChange={(e) => setS({ ...s, [f.key]: e.target.value })}
              placeholder="Not set"
              style={{ background: 'var(--surface-2)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 14 }}
            />
            <a className="tiny muted" href={f.url} target="_blank" rel="noopener noreferrer">Get a free key: {f.url}</a>
          </label>
        ))}
        <div className="row"><span className="spacer" /><button type="submit" className="btn active">Save and restart data</button></div>
      </form>
    </div>
  );
}
