import { useEffect, useRef, useState } from 'react';

export async function api<T>(path: string): Promise<T> {
  const r = await fetch(`/api/${path}`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json() as Promise<T>;
}

/** Poll an endpoint; `bump` forces an immediate refetch (e.g. from an SSE event). */
export function usePoll<T>(path: string | null, ms: number, bump = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pathRef = useRef(path);
  pathRef.current = path;
  useEffect(() => {
    if (!path) return;
    let alive = true;
    const run = () =>
      api<T>(path)
        .then((d) => { if (alive && pathRef.current === path) { setData(d); setError(null); } })
        .catch((e) => alive && setError(String(e.message ?? e)))
        .finally(() => alive && setLoading(false));
    run();
    const id = setInterval(run, ms);
    return () => { alive = false; clearInterval(id); };
  }, [path, ms, bump]);
  return { data, error, loading };
}

type Handler = (data: any) => void;
const handlers = new Map<string, Set<Handler>>();
let es: EventSource | null = null;
let connected = false;
const connListeners = new Set<(c: boolean) => void>();

function ensureStream() {
  if (es) return;
  es = new EventSource('/api/stream');
  es.onopen = () => { connected = true; connListeners.forEach((l) => l(true)); };
  es.onerror = () => { connected = false; connListeners.forEach((l) => l(false)); };
  for (const ev of ['quote', 'candles', 'news', 'quotes', 'hello']) {
    es.addEventListener(ev, (m) => {
      let d: unknown = null;
      try { d = JSON.parse((m as MessageEvent).data); } catch { /* ignore */ }
      handlers.get(ev)?.forEach((h) => h(d));
    });
  }
}

export function useStream(event: string, h: Handler) {
  const ref = useRef(h);
  ref.current = h;
  useEffect(() => {
    ensureStream();
    const fn: Handler = (d) => ref.current(d);
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(fn);
    return () => { handlers.get(event)!.delete(fn); };
  }, [event]);
}

export function useStreamConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => { ensureStream(); connListeners.add(setC); return () => { connListeners.delete(setC); }; }, []);
  return c;
}

/** Counter that increments on each SSE event of the given type (for usePoll bumps). */
export function useEventBump(event: string) {
  const [n, setN] = useState(0);
  useStream(event, () => setN((x) => x + 1));
  return n;
}

// localStorage is a per-viewer convenience only; always guarded.
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`gsd:${key}`);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function savePref(key: string, v: unknown) {
  try { localStorage.setItem(`gsd:${key}`, JSON.stringify(v)); } catch { /* ignore */ }
}
