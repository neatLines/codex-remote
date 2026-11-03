import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { validFileName } from './file-store.mjs';

export const uploadCredentialsPath = (codexHome) => path.join(codexHome, 'remote-agent-upload.json');

function cloudOrigin(relayUrl) {
  const url = new URL(relayUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error('无效的云端连接地址');
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

export function registrationUploadToken(codexHome, relayUrl, agentId) {
  try {
    const saved = JSON.parse(fs.readFileSync(uploadCredentialsPath(codexHome), 'utf8'));
    if (saved.origin === cloudOrigin(relayUrl) && saved.agentId === agentId && /^fup_[A-Za-z0-9_-]{43}$/.test(saved.token || '')) return saved.token;
  } catch {}
  return undefined;
}

export function saveUploadCredentials(codexHome, relayUrl, agentId, message) {
  if (message.agentId !== agentId || !/^fup_[A-Za-z0-9_-]{43}$/.test(message.token || '') ||
      !Number.isSafeInteger(message.maxFileBytes) || message.maxFileBytes <= 0) return;
  const target = uploadCredentialsPath(codexHome), temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ agentId, origin: cloudOrigin(relayUrl), token: message.token, maxFileBytes: message.maxFileBytes }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}

export function clearUploadCredentials(codexHome, relayUrl) {
  const target = uploadCredentialsPath(codexHome);
  try { if (JSON.parse(fs.readFileSync(target)).origin === cloudOrigin(relayUrl)) fs.unlinkSync(target); } catch {}
}

export async function uploadAgentFile(filePath, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  relayUrl = process.env.CODEX_RELAY_URL || 'ws://127.0.0.1:3280/ws/agent',
  relayCaFile = process.env.CODEX_RELAY_CA_FILE, name, threadId } = {}) {
  let credentials;
  try { credentials = JSON.parse(await fs.promises.readFile(uploadCredentialsPath(codexHome), 'utf8')); }
  catch { throw new Error('尚未取得上传凭据，请先运行新版 codex-up，并在网页上信任该设备'); }
  if (credentials.origin !== cloudOrigin(relayUrl) || !/^fup_[A-Za-z0-9_-]{43}$/.test(credentials.token || '')) {
    throw new Error('上传凭据与当前云端不匹配，请重启 codex-up 同步凭据');
  }
  if (threadId && !/^[A-Za-z0-9_-]{1,128}$/.test(threadId)) throw new Error('无效的会话标识');
  const filename = name || path.basename(filePath);
  if (!validFileName(filename)) throw new Error('无效的文件名');
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('只能上传普通文件');
    if (stat.size > credentials.maxFileBytes) throw new Error('文件超过云端单文件大小限制');
    const url = new URL('/api/files', credentials.origin);
    const transport = url.protocol === 'https:' ? https : http;
    return await new Promise((resolve, reject) => {
      const source = handle.createReadStream({ autoClose: false });
      const request = transport.request(url, { method: 'POST', agent: false, timeout: 120000,
        ...(url.protocol === 'https:' && relayCaFile ? { ca: fs.readFileSync(relayCaFile) } : {}),
        headers: { Authorization: `Bearer ${credentials.token}`, 'X-Codex-Agent-Id': credentials.agentId,
          'X-File-Name': encodeURIComponent(filename), 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
          ...(threadId ? { 'X-Codex-Thread-Id': threadId } : {}) } }, (response) => {
        const chunks = []; let bytes = 0;
        response.on('data', (chunk) => { bytes += chunk.length; if (bytes > 65536) response.destroy(new Error('上传响应过大')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          source.destroy();
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (response.statusCode !== 201 || !data.ok || !data.file) throw new Error(data.error || `上传失败 (HTTP ${response.statusCode})`);
            resolve({ ...data.file, url: new URL(data.file.downloadUrl, credentials.origin).href });
          } catch (error) { reject(error); }
        });
      });
      request.on('timeout', () => request.destroy(new Error('上传连接超时')));
      request.on('error', (error) => { source.destroy(); reject(new Error(`文件上传失败：${error.message}`)); });
      source.on('error', (error) => request.destroy(error));
      source.pipe(request);
    });
  } finally { await handle.close().catch(() => {}); }
}
