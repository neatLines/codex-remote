import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ID = /^[a-f0-9]{32}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function positive(value, fallback, name) {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

export function validFileName(value) {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f/\\]/.test(value) &&
    value !== '.' && value !== '..' && Buffer.byteLength(value) <= 255;
}

export function createFileStore({ dataDir, env = {}, authStore, isAuthenticated, onChange = () => {} }) {
  const directory = path.join(dataDir, 'files');
  const maxFileBytes = positive(env.CODEX_FILES_MAX_BYTES, 256 * 1024 ** 2, 'CODEX_FILES_MAX_BYTES');
  const maxStorageBytes = positive(env.CODEX_FILES_MAX_STORAGE_BYTES, 10 * 1024 ** 3, 'CODEX_FILES_MAX_STORAGE_BYTES');
  const records = new Map(), pending = new Map();
  let usedBytes = 0, reservedBytes = 0, closed = false;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('File storage directory must not be a symlink');
  for (const name of fs.readdirSync(directory)) {
    if (/^[a-f0-9]{32}\.(part|tmp)$/.test(name)) fs.unlinkSync(path.join(directory, name));
    if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
    try {
      const metadataPath = path.join(directory, name);
      if (fs.lstatSync(metadataPath).isSymbolicLink() || fs.statSync(metadataPath).size > 65536) continue;
      const file = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      if (!ID.test(file.id) || name !== `${file.id}.json` || !validFileName(file.name) ||
          !Number.isSafeInteger(file.size) || file.size < 0 || !Number.isSafeInteger(file.createdAt) ||
          !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.agentId !== 'string') continue;
      const stat = fs.lstatSync(path.join(directory, `${file.id}.blob`));
      if (!stat.isFile() || stat.size !== file.size) continue;
      records.set(file.id, file); usedBytes += file.size;
    } catch { /* Incomplete or invalid records are never served. */ }
  }
  for (const name of fs.readdirSync(directory)) {
    if (/^[a-f0-9]{32}\.blob$/.test(name) && !records.has(name.slice(0, -5))) fs.unlinkSync(path.join(directory, name));
  }

  function json(res, status, body) {
    if (res.destroyed || res.headersSent) return;
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function uploader(req) {
    const id = req.headers['x-codex-agent-id'];
    const match = /^Bearer (fup_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
    const trusted = typeof id === 'string' && Object.hasOwn(authStore.state.trustedAgents, id) ? authStore.state.trustedAgents[id] : null;
    if (!trusted || !match || !/^[a-f0-9]{64}$/.test(trusted.fileUploadTokenHash || '')) return null;
    if (!crypto.timingSafeEqual(Buffer.from(hashToken(match[1]), 'hex'), Buffer.from(trusted.fileUploadTokenHash, 'hex'))) return null;
    return { agentId: id, agentName: trusted.name || id };
  }

  function publicFile(file) {
    return { id: file.id, name: file.name, size: file.size, sha256: file.sha256, createdAt: file.createdAt,
      agentId: file.agentId, agentName: file.agentName, threadId: file.threadId,
      downloadUrl: `/api/files/${file.id}/download` };
  }

  async function upload(req, res) {
    const agent = uploader(req);
    if (!agent) { req.resume(); throw fail(403, '上传凭据无效或设备未受信任，请重启 codex-up 同步状态'); }
    if (closed) throw fail(503, '文件服务正在关闭');
    let name;
    try { name = decodeURIComponent(req.headers['x-file-name'] || ''); } catch { throw fail(400, '无效的文件名'); }
    if (!validFileName(name)) throw fail(400, '文件名无效，不能包含路径或控制字符');
    const length = req.headers['content-length'];
    if (typeof length !== 'string' || !/^\d+$/.test(length)) throw fail(411, '上传必须提供 Content-Length');
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size > maxFileBytes) throw fail(413, '文件超过单文件大小限制');
    const threadId = req.headers['x-codex-thread-id'] || null;
    if (threadId && (typeof threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId))) throw fail(400, '无效的会话标识');
    if (pending.size >= 4 || [...pending.values()].filter((entry) => entry.agentId === agent.agentId).length >= 2) {
      throw fail(429, '同时上传的文件过多，请稍后重试');
    }
    if (records.size + pending.size >= 10000 || usedBytes + reservedBytes + size > maxStorageBytes) throw fail(507, '云端文件存储空间不足');
    const id = crypto.randomBytes(16).toString('hex');
    const partial = path.join(directory, `${id}.part`), blob = path.join(directory, `${id}.blob`);
    const metadataTemp = path.join(directory, `${id}.tmp`), metadataPath = path.join(directory, `${id}.json`);
    const controller = new AbortController();
    pending.set(id, { agentId: agent.agentId, controller }); reservedBytes += size;
    let bytes = 0, committed = false;
    const digest = crypto.createHash('sha256');
    const limit = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > size || bytes > maxFileBytes) { callback(fail(413, '上传内容超过声明大小')); return; }
      digest.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(req, limit, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
      if (bytes !== size) throw fail(400, '文件上传不完整');
      if (!uploader(req)) throw fail(403, '上传权限已被撤销');
      const file = { id, name, size, sha256: digest.digest('hex'), createdAt: Date.now(), ...agent, threadId };
      await fs.promises.rename(partial, blob);
      await fs.promises.writeFile(metadataTemp, JSON.stringify(file), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(metadataTemp, metadataPath);
      records.set(id, file); usedBytes += size; committed = true;
      json(res, 201, { ok: true, file: publicFile(file) });
      onChange(publicFile(file));
    } finally {
      pending.delete(id); reservedBytes -= size;
      for (const temporary of [partial, metadataTemp, ...(!committed ? [blob, metadataPath] : [])]) {
        await fs.promises.unlink(temporary).catch(() => {});
      }
    }
  }

  function list(url, res) {
    const rawLimit = url.searchParams.get('limit') || '50';
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw fail(400, '无效的分页大小');
    let after = null;
    const cursor = url.searchParams.get('cursor');
    if (cursor) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(cursor)) throw fail(400, '无效的分页游标');
      try { after = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { throw fail(400, '无效的分页游标'); }
      if (!Array.isArray(after) || after.length !== 2 || !Number.isSafeInteger(after[0]) || !ID.test(after[1])) throw fail(400, '无效的分页游标');
    }
    const filtered = [...records.values()].filter((file) =>
      (!url.searchParams.has('agentId') || file.agentId === url.searchParams.get('agentId')) &&
      (!url.searchParams.has('threadId') || file.threadId === url.searchParams.get('threadId')) &&
      (!after || file.createdAt < after[0] || (file.createdAt === after[0] && file.id < after[1])))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const page = filtered.slice(0, Number(rawLimit)), last = page.at(-1);
    const nextCursor = filtered.length > page.length ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString('base64url') : null;
    json(res, 200, { ok: true, files: page.map(publicFile), nextCursor, maxFileBytes,
      storage: { usedBytes, maxBytes: maxStorageBytes, fileCount: records.size } });
  }

  async function download(req, res, id) {
    const file = records.get(id);
    if (!file) throw fail(404, '文件不存在');
    let handle;
    try { handle = await fs.promises.open(path.join(directory, `${id}.blob`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch { throw fail(404, '文件不存在'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== file.size) throw fail(404, '文件不存在或不完整');
      let start = 0, end = file.size - 1, status = 200;
      if (req.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
        if (!match || (!match[1] && !match[2]) || file.size === 0) throw fail(416, '无效的下载范围');
        if (!match[1]) start = Math.max(0, file.size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= file.size) throw fail(416, '无效的下载范围');
        status = 206;
      }
      const fallback = file.name.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/"/g, '_');
      const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
      res.writeHead(status, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
        'Content-Length': file.size === 0 ? 0 : end - start + 1, 'Accept-Ranges': 'bytes',
        ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${file.size}` } : {}),
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer' });
      if (req.method === 'HEAD' || file.size === 0) res.end();
      else { await pipeline(handle.createReadStream({ start, end, autoClose: false }), res); }
    } finally { await handle.close().catch(() => {}); }
  }

  return {
    revoke(agentId) {
      for (const entry of pending.values()) if (entry.agentId === agentId) entry.controller.abort();
    },
    issueCredentials(agentId, { token, allowCreate = false, reset = false } = {}) {
      const trusted = Object.hasOwn(authStore.state.trustedAgents, agentId) ? authStore.state.trustedAgents[agentId] : null;
      if (!trusted) return null;
      // A reconnect must prove possession of the credential already paired with
      // this device. Knowing an Agent ID cannot retrieve or rotate that secret.
      if (trusted.fileUploadTokenHash && !reset) {
        if (!/^fup_[A-Za-z0-9_-]{43}$/.test(token || '') || hashToken(token) !== trusted.fileUploadTokenHash) return null;
      } else {
        if (!allowCreate && !reset) return null;
        token = `fup_${crypto.randomBytes(32).toString('base64url')}`;
        trusted.fileUploadTokenHash = hashToken(token); authStore.save();
      }
      return { type: 'relay/fileUploadCredentials', agentId, token, maxFileBytes };
    },
    async handleHttp(req, res) {
      const url = new URL(req.url, 'http://file-service.invalid');
      if (url.pathname !== '/api/files' && !url.pathname.startsWith('/api/files/')) return false;
      try {
        if (req.method === 'POST' && url.pathname === '/api/files') await upload(req, res);
        else {
          if (!isAuthenticated(req)) throw fail(401, '请先登录后访问文件');
          if (req.method === 'GET' && url.pathname === '/api/files') list(url, res);
          else {
            const match = /^\/api\/files\/([a-f0-9]{32})\/download$/.exec(url.pathname);
            if (!match || !['GET', 'HEAD'].includes(req.method)) throw fail(404, 'Not Found');
            try { await download(req, res, match[1]); }
            catch (error) {
              if (error.status === 416) res.setHeader('Content-Range', `bytes */${records.get(match[1])?.size || 0}`);
              throw error;
            }
          }
        }
      } catch (error) {
        req.resume();
        if (res.headersSent) res.destroy();
        else json(res, error.status || 500, { ok: false, error: error.status ? error.message : '文件操作失败，请稍后重试' });
      }
      return true;
    },
    close() { closed = true; for (const entry of pending.values()) entry.controller.abort(); },
  };
}
