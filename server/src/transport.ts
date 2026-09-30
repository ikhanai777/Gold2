// Outbound HTTP transport, injected per platform. Node uses undici (with proxy
// support, node/transport.ts); the Android app uses Capacitor's native HTTP,
// which is not subject to browser CORS rules.

export interface TransportResponse {
  status: number;
  text(): Promise<string>;
  bytes(): Promise<Uint8Array>;
}

export type Transport = (url: string, opts: { headers: Record<string, string>; timeoutMs: number }) => Promise<TransportResponse>;

/** Default: the platform's global fetch. */
const fetchTransport: Transport = async (url, { headers, timeoutMs }) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  return { status: res.status, text: () => res.text(), bytes: async () => new Uint8Array(await res.arrayBuffer()) };
};

let impl: Transport = fetchTransport;
export const setTransport = (t: Transport) => { impl = t; };
export const transport = () => impl;
