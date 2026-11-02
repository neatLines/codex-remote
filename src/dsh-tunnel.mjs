// One acknowledged chunk per direction keeps slow browsers/uploads bounded.
export const CHUNK_BYTES = 64 * 1024;
export const MAX_BODY_BYTES = 256 * 1024 * 1024;
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authorization', 'proxy-authenticate', 'cookie', 'set-cookie', 'authorization', 'host', 'origin']);

export function cleanHeaders(headers, websocket = false) {
  const clean = Object.create(null);
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || lower.startsWith('x-forwarded-') || lower === 'forwarded') continue;
    if (!websocket && lower.startsWith('sec-websocket-')) continue;
    if (lower === 'sec-fetch-site' || lower === 'sec-fetch-mode' || lower === 'sec-fetch-dest') continue;
    if (typeof value === 'string' || Array.isArray(value)) clean[lower] = value;
  }
  return clean;
}

export function decodeChunk(value) {
  if (typeof value !== 'string' || value.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid DSH tunnel chunk');
  }
  return Buffer.from(value, 'base64');
}

export function queueChunk(entry, chunk) {
  entry.source.pause();
  if (entry.outbound?.length) throw new Error('DSH tunnel flow-control violation');
  entry.outbound = [];
  for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
    entry.outbound.push(chunk.subarray(offset, offset + CHUNK_BYTES));
  }
  if (entry.outbound.length) entry.send({ type: 'dsh/data', id: entry.id, data: entry.outbound[0].toString('base64') });
  else entry.source.resume();
}

export function acknowledge(entry) {
  if (!entry.outbound?.length) return;
  entry.outbound.shift();
  if (entry.outbound.length) entry.send({ type: 'dsh/data', id: entry.id, data: entry.outbound[0].toString('base64') });
  else {
    if (entry.endPending) {
      entry.endPending = false;
      entry.send({ type: 'dsh/end', id: entry.id });
      entry.onEndSent?.();
    }
    entry.source.resume();
  }
}

export function endStream(entry) {
  if (entry.outbound?.length) entry.endPending = true;
  else {
    entry.send({ type: 'dsh/end', id: entry.id });
    entry.onEndSent?.();
  }
}
