import fs from 'node:fs';

const ID = /^[a-zA-Z0-9_-]{1,64}$/;
export function normalizeWebServices(value, { credentials = true } = {}) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('网页服务清单必须为数组，最多 32 项');
  const ids = new Set(), ports = new Set(), managed = new Set();
  return value.map(entry => {
    if (!entry || !ID.test(entry.id) || entry.id === 'codex' || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100) throw new Error('网页服务需要有效的 id 和 name（codex 为基础能力保留）');
    const kind = entry.kind || 'http', port = entry.port;
    if (!['http', 'dsh', 'opencode'].includes(kind) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('网页服务 kind 或 port 无效');
    if (ids.has(entry.id) || ports.has(port) || (kind !== 'http' && managed.has(kind))) throw new Error('网页服务 id、端口或托管应用重复');
    ids.add(entry.id); ports.add(port); if (kind !== 'http') managed.add(kind);
    const pathname = entry.path || '/';
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//') || /[\\\x00-\x20\x7f]/.test(pathname)) throw new Error('网页服务 path 必须为本地绝对路径');
    const result = { id: entry.id, name: entry.name.trim(), kind, port, path: pathname,
      status: ['starting', 'ready', 'error', 'offline'].includes(entry.status) ? entry.status : 'ready' };
    if (credentials && entry.auth) {
      const auth = {};
      for (const field of ['headers', 'query']) {
        if (entry.auth[field] === undefined) continue;
        const values = entry.auth[field];
        if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) throw new Error('认证注入规则无效');
        auth[field] = Object.fromEntries(Object.entries(values).map(([key, value]) => {
          if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value) || !key || key.length > 100 || /[\x00-\x20\x7f]/.test(key)) throw new Error('认证注入值无效');
          if (field === 'headers' && (!/^[a-zA-Z0-9_-]+$/.test(key) || /^(?:host|origin|connection|upgrade|content-length|transfer-encoding|sec-.*|x-forwarded-.*|forwarded)$/i.test(key))) throw new Error('不支持覆盖该请求头');
          return [field === 'headers' ? key.toLowerCase() : key, value];
        }));
      }
      if (entry.auth.token !== undefined) {
        if (typeof entry.auth.token !== 'string' || entry.auth.token.length > 1024 || /[\x00-\x1f\x7f]/.test(entry.auth.token)) throw new Error('启动 token 无效');
        auth.token = entry.auth.token;
      }
      result.auth = auth;
    }
    return result;
  });
}
export function readWebServices(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return normalizeWebServices(Array.isArray(value) ? value : value.services);
}
export function publicWebServices(services) {
  return services === undefined ? undefined : services.map(({ auth, ...service }) => service);
}
