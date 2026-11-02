import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Encode a Buffer into RFC 4648 Base32 (without padding).
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Decode an RFC 4648 Base32 string into a Buffer.
 * @param {string} input
 * @returns {Buffer}
 */
export function base32Decode(input) {
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/=+$/g, '')
    .replace(/[\s-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${cleaned[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate a 160-bit (20-byte / 32-char Base32) random TOTP secret.
 * @returns {string}
 */
export function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Compute a 6-digit RFC 6238 TOTP code for a given timestamp.
 * @param {string} base32Secret
 * @param {number} [timestampMs]
 * @param {number} [stepSeconds]
 * @returns {string}
 */
export function generateTotpCode(base32Secret, timestampMs = Date.now(), stepSeconds = 30) {
  const key = base32Decode(base32Secret);
  const counter = BigInt(Math.floor(timestampMs / 1000 / stepSeconds));
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter, 0);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const otp = binary % 1_000_000;
  return String(otp).padStart(6, '0');
}

/**
 * Verify a 6-digit TOTP code with ±windowSteps tolerance.
 * @param {string} base32Secret
 * @param {string} code
 * @param {{ timestampMs?: number, windowSteps?: number, stepSeconds?: number }} [options]
 * @returns {boolean}
 */
export function verifyTotpCode(base32Secret, code, options = {}) {
  const cleanedCode = String(code || '').trim();
  if (!/^\d{6}$/.test(cleanedCode)) return false;

  const timestampMs = options.timestampMs ?? Date.now();
  const windowSteps = options.windowSteps ?? 1;
  const stepSeconds = options.stepSeconds ?? 30;

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidate = generateTotpCode(
      base32Secret,
      timestampMs + offset * stepSeconds * 1000,
      stepSeconds
    );
    if (safeCompareStrings(candidate, cleanedCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Build an otpauth:// URI for authenticator apps.
 * @param {{ secret: string, accountName?: string, issuer?: string }} params
 * @returns {string}
 */
export function buildOtpAuthUri({ secret, accountName = 'admin', issuer = 'CodexRemote' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/**
 * Constant-time string comparison.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompareStrings(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Hash a password with random salt using scrypt.
 * @param {string} password
 * @returns {string}
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

/**
 * Verify a password against a stored scrypt hash.
 * @param {string} password
 * @param {string} storedHash
 * @returns {boolean}
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derivedHex = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return safeCompareStrings(derivedHex, expectedHex);
}

/**
 * Sign a browser session token (valid for maxAgeMs, default 30 days).
 * @param {string} cookieSecret
 * @param {{ sub?: string, maxAgeMs?: number, nowMs?: number }} [options]
 * @returns {string}
 */
export function signSessionToken(cookieSecret, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000;
  const payload = {
    sub: options.sub || 'owner',
    iat: nowMs,
    exp: nowMs + maxAgeMs,
    jti: crypto.randomBytes(8).toString('hex'),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sigB64 = crypto
    .createHmac('sha256', cookieSecret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a browser session token.
 * @param {string} cookieSecret
 * @param {string | undefined | null} token
 * @param {number} [nowMs]
 * @returns {{ valid: boolean, payload?: object }}
 */
export function verifySessionToken(cookieSecret, token, nowMs = Date.now()) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { valid: false };
  }
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return { valid: false };

  const expectedSig = crypto
    .createHmac('sha256', cookieSecret)
    .update(payloadB64)
    .digest('base64url');

  if (!safeCompareStrings(expectedSig, sigB64)) {
    return { valid: false };
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp <= nowMs) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

/**
 * Parse HTTP Cookie header into key-value object.
 * @param {string | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Brute-force & rate limit guard per IP.
 * Default: max 5 attempts per 60s window; 5 consecutive failures locks IP for 24h.
 */
export class LoginRateLimiter {
  constructor({
    maxAttemptsPerWindow = 5,
    windowMs = 60 * 1000,
    maxConsecutiveFailures = 5,
    lockoutMs = 24 * 60 * 60 * 1000,
  } = {}) {
    this.maxAttemptsPerWindow = maxAttemptsPerWindow;
    this.windowMs = windowMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.lockoutMs = lockoutMs;
    this.records = new Map();
  }

  _getRecord(ip, nowMs) {
    let rec = this.records.get(ip);
    if (!rec) {
      rec = { attempts: [], consecutiveFailures: 0, lockedUntil: 0 };
      this.records.set(ip, rec);
    }
    rec.attempts = rec.attempts.filter((ts) => nowMs - ts < this.windowMs);
    if (rec.lockedUntil > 0 && nowMs >= rec.lockedUntil) {
      rec.lockedUntil = 0;
      rec.consecutiveFailures = 0;
    }
    return rec;
  }

  check(ip, nowMs = Date.now()) {
    const rec = this._getRecord(ip, nowMs);
    if (rec.lockedUntil > nowMs) {
      return {
        allowed: false,
        reason: 'locked',
        retryAfterSeconds: Math.ceil((rec.lockedUntil - nowMs) / 1000),
      };
    }
    if (rec.attempts.length >= this.maxAttemptsPerWindow) {
      return {
        allowed: false,
        reason: 'rate_limit',
        retryAfterSeconds: Math.ceil((this.windowMs - (nowMs - rec.attempts[0])) / 1000),
      };
    }
    return { allowed: true };
  }

  recordAttempt(ip, success, nowMs = Date.now()) {
    const rec = this._getRecord(ip, nowMs);
    rec.attempts.push(nowMs);
    if (success) {
      rec.consecutiveFailures = 0;
      rec.lockedUntil = 0;
    } else {
      rec.consecutiveFailures += 1;
      if (rec.consecutiveFailures >= this.maxConsecutiveFailures) {
        rec.lockedUntil = nowMs + this.lockoutMs;
      }
    }
  }
}

/**
 * Compute E2E HMAC-SHA256 signature over { timestamp, nonce, bodyString }.
 * @param {string} localSigningKey
 * @param {{ timestamp: number, nonce: string, bodyString: string }} data
 * @returns {string}
 */
export function signE2EPayload(localSigningKey, { timestamp, nonce, bodyString }) {
  return crypto
    .createHmac('sha256', String(localSigningKey))
    .update(`${timestamp}.${nonce}.${bodyString}`)
    .digest('hex');
}

/**
 * Verify E2E HMAC-SHA256 envelope on the local machine.
 */
export class E2EVerifier {
  constructor(localSigningKey, { maxSkewMs = 60 * 1000 } = {}) {
    this.localSigningKey = String(localSigningKey);
    this.maxSkewMs = maxSkewMs;
    this.seenNonces = new Map();
  }

  verify({ timestamp, nonce, bodyString, signature }, nowMs = Date.now()) {
    if (
      typeof timestamp !== 'number' ||
      !Number.isFinite(timestamp) ||
      typeof nonce !== 'string' ||
      nonce.length < 6 ||
      typeof bodyString !== 'string' ||
      typeof signature !== 'string'
    ) {
      return { ok: false, reason: 'malformed_e2e_envelope' };
    }

    if (Math.abs(nowMs - timestamp) > this.maxSkewMs) {
      return { ok: false, reason: 'timestamp_out_of_range' };
    }

    // Prune expired nonces
    for (const [k, ts] of this.seenNonces.entries()) {
      if (nowMs - ts > this.maxSkewMs * 2) {
        this.seenNonces.delete(k);
      }
    }

    if (this.seenNonces.has(nonce)) {
      return { ok: false, reason: 'replay_detected' };
    }

    const expected = signE2EPayload(this.localSigningKey, { timestamp, nonce, bodyString });
    if (!safeCompareStrings(expected, signature)) {
      return { ok: false, reason: 'invalid_e2e_signature' };
    }

    this.seenNonces.set(nonce, nowMs);
    return { ok: true };
  }
}
