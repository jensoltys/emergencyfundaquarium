// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
// Rate limits hold under parallel requests, the wrong-password lockout can't be
// used to lock a real owner out, signup codes have a wrong-guess budget, and one
// used reset link ends all of them.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { overLimit, ipKey } from '../src/lib/ratelimit.js';

const ORIGIN = 'https://emergencyfundaquarium.com';
const SECRET = 'test-secret-test-secret-test-secret-1234';

async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hex = (u) => [...u].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${hex(salt)}:${hex(new Uint8Array(bits))}`;
}
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const b64 = (s) => Buffer.from(s).toString('base64url');
async function hs256(payload, secret) {
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

// Stateful D1 stand-in. Single statements answer after a tick, like a real
// round trip, so parallel requests interleave. A batch runs as one unit, the
// way a D1 batch (one transaction) does.
function memDB({ user = null, codeHash = null, resetHash = null } = {}) {
  const rl = [];
  const log = [];
  let resetUsed = false;
  const handle = (sql, a) => {
    log.push({ sql, args: a });
    if (/COUNT\(\*\) AS n FROM rate_limits/.test(sql)) return { results: [{ n: rl.filter(r => r.key === a[0] && r.created_at >= a[1]).length }] };
    if (/COUNT\(\*\) as c FROM rate_limits/.test(sql)) return { c: rl.filter(r => r.key === a[0] && r.created_at > a[1]).length };
    if (/^INSERT INTO rate_limits/.test(sql)) { rl.push({ key: a[0], created_at: a[1] }); return { meta: { changes: 1 } }; }
    if (/^DELETE FROM rate_limits WHERE rowid IN/.test(sql)) { const i = rl.map(r => r.key).lastIndexOf(a[0]); if (i >= 0) rl.splice(i, 1); return { meta: { changes: i >= 0 ? 1 : 0 } }; }
    if (/^DELETE FROM rate_limits WHERE substr\(key/.test(sql)) { for (let i = rl.length - 1; i >= 0; i--) if (rl[i].key.startsWith(a[1]) || rl[i].key === a[2]) rl.splice(i, 1); return { meta: { changes: 1 } }; }
    if (/^DELETE FROM rate_limits/.test(sql)) return { meta: { changes: 0 } };
    if (/INSERT INTO email_daily/.test(sql)) return { n: 1 };
    if (/^SELECT .* FROM users WHERE email/.test(sql)) return user && a[0] === user.email ? { ...user } : null;
    if (/^SELECT .* FROM users WHERE id/.test(sql)) return user ? { ...user } : null;
    if (/^SELECT token FROM email_verification_tokens WHERE user_id/.test(sql)) return codeHash && a.includes(codeHash) ? { token: codeHash } : null;
    if (/^SELECT token, user_id, expires_at, used FROM reset_tokens/.test(sql)) return resetHash && a[0] === resetHash && !resetUsed ? { token: resetHash, user_id: user.id, expires_at: new Date(Date.now() + 3600000).toISOString(), used: 0 } : null;
    if (/^UPDATE reset_tokens SET used=1 WHERE token=\? AND used=0/.test(sql)) { const ok = !resetUsed && a[0] === resetHash; if (ok) resetUsed = true; return { meta: { changes: ok ? 1 : 0 } }; }
    if (/^UPDATE users SET password_hash/.test(sql)) { user.password_hash = a[0]; user.token_version = (user.token_version || 0) + 1; if (/email_verified=1/.test(sql)) user.email_verified = 1; return { meta: { changes: 1 } }; }
    return undefined;
  };
  const tick = () => new Promise(r => setTimeout(r, 0));
  return {
    log, rl,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...x) { args = x; return stmt; },
        async first() { await tick(); const v = handle(sql, args); return v && v.results ? v.results[0] : (v ?? null); },
        async all() { await tick(); return handle(sql, args) ?? { results: [] }; },
        async run() { await tick(); return handle(sql, args) ?? { meta: { changes: 1 } }; },
        exec() { return handle(sql, args) ?? { meta: { changes: 1 } }; },
      };
      return stmt;
    },
    async batch(stmts) { await tick(); return stmts.map(s => s.exec()); },
  };
}
function post(path, body, { ip = '203.0.113.5', method = 'POST', cookie } = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}
async function call(req, env) {
  const r = await worker.fetch(req, { AUTH_MAIL_MIN_MS: '0', ...env }, { waitUntil() {} });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

test('overLimit: 20 parallel hits on a cap of 5 let exactly 5 through', async () => {
  const env = { DB: memDB() };
  const out = await Promise.all(Array.from({ length: 20 }, () => overLimit(env, 'k', 5, 60)));
  assert.equal(out.filter(x => x === false).length, 5);
  // Refused hits are taken back out, so the key holds only the 5 that counted.
  assert.equal(env.DB.rl.filter(r => r.key === 'k').length, 5);
});

test('a burst of 20 parallel feedback posts from one network: exactly 5 get through, no 500', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const env = { JWT_SECRET: SECRET, FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb', DB: memDB() };
    const rs = await Promise.all(Array.from({ length: 20 }, () => call(post('/api/feedback', { type: 'bug', message: 'The tank is blank' }), env)));
    const count = (s) => rs.filter(r => r.status === s).length;
    assert.equal(count(200), 5);
    assert.equal(count(429), 15);
  } finally { globalThis.fetch = realFetch; }
});

test('ipKey: IPv6 addresses in one /64 share a key, IPv4 is kept whole', () => {
  const k = (ip) => ipKey(new Request(ORIGIN, { headers: { 'CF-Connecting-IP': ip } }));
  assert.equal(k('2001:db8:1:2:aaaa::1'), k('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(k('2001:db8:1:2::1'), k('2001:db8:1:3::1'));
  assert.equal(k('198.51.100.7'), '198.51.100.7');
});

test('login lockout: 5 wrong tries lock that network only, the owner still gets in from another', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 1, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user }) };
  await quiet(async () => {
    const login = (password, ip) => call(post('/api/auth/login', { email: user.email, password }, { ip }), env);
    for (let i = 0; i < 5; i++) assert.equal((await login('wrong-password-1', '203.0.113.9')).status, 401);
    const locked = await login('correct-horse-1', '203.0.113.9');
    assert.equal(locked.status, 429, 'the guessing network is locked, even with the right password');
    assert.equal(locked.headers.get('Set-Cookie'), null);
    const owner = await login('correct-horse-1', '198.51.100.20');
    assert.equal(owner.status, 200, 'the owner on another network is not locked out');
    assert.match(owner.headers.get('Set-Cookie') || '', /efa_session=/);
    // No raw address in any stored key.
    assert.ok(env.DB.rl.every(r => !/203\.0\.113\.9|198\.51\.100\.20/.test(r.key)));
  });
});

test('login lockout: a right password hands its try back, so normal use never locks', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 1, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user }) };
  await quiet(async () => {
    for (let i = 0; i < 8; i++) assert.equal((await call(post('/api/auth/login', { email: user.email, password: 'correct-horse-1' }, { ip: '203.0.113.50' }), env)).status, 200);
    assert.equal(env.DB.rl.filter(r => r.key.startsWith('failed-login')).length, 0);
  });
});

test('login lockout: 10 parallel wrong passwords from one network, exactly 5 are checked', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 1, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user }) };
  await quiet(async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => call(post('/api/auth/login', { email: user.email, password: 'wrong-password-1' }, { ip: '203.0.113.77' }), env)));
    assert.equal(rs.filter(r => r.status === 401).length, 5);
    assert.equal(rs.filter(r => r.status === 429).length, 5);
    assert.equal(rs.filter(r => r.status >= 500).length, 0);
  });
});

test('change password: a signed-in session cannot guess the current password past the lockout', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 1 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user }) };
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const tryPw = (current_password) => call(post('/api/auth/password', { current_password, password: 'brand-new-pass-1' }, { method: 'PUT', cookie }), env);
  for (let i = 0; i < 5; i++) assert.equal((await tryPw('wrong-password-' + i)).status, 401);
  assert.equal((await tryPw('correct-horse-1')).status, 429);
  assert.equal(user.token_version, 0, 'password unchanged');
});

test('a session token with no version is refused', async () => {
  const env = { JWT_SECRET: SECRET, DB: memDB({ user: { id: 'u1', email: 'a@example.com', token_version: 0 } }) };
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const r = await worker.fetch(new Request(ORIGIN + '/api/me', { headers: { Cookie: cookie } }), env, { waitUntil() {} });
  assert.equal(r.status, 401);
});

test('verify-code: a guessing network runs out of tries, and the owner on another network still verifies', async () => {
  const user = { id: 'u1', email: 'new@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 0, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user, codeHash: await sha256Hex('u1:123456') }) };
  const guess = (code, ip) => call(post('/api/auth/verify-code', { email: user.email, code, password: 'correct-horse-1' }, { ip }), env);
  const lookups = () => env.DB.log.filter(l => /^SELECT token FROM email_verification_tokens/.test(l.sql)).length;
  for (let i = 0; i < 5; i++) assert.equal((await guess('00000' + i, '203.0.113.10')).status, 400);
  assert.equal(lookups(), 5);
  // 6th try from the same network: refused before the code is even looked up, right code or not.
  assert.equal((await guess('123456', '203.0.113.10')).status, 400);
  assert.equal(lookups(), 5);
  // Nobody's code was burned by the stranger.
  assert.equal(env.DB.log.filter(l => /^UPDATE email_verification_tokens SET used=1 WHERE user_id=\? AND used=0$/.test(l.sql)).length, 0);
  // The owner, on their own network, still gets in with the real code.
  // No clearing needed: the stranger's per-minute tries are counted against the stranger's network only.
  const owner = await guess('123456', '198.51.100.44');
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('Set-Cookie') || '', /efa_session=/);
});

test('verify-code: 100 misses a day across all networks close guessing for that account', async () => {
  const user = { id: 'u1', email: 'new@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 0, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user, codeHash: await sha256Hex('u1:123456') }) };
  for (let i = 0; i < 100; i++) env.DB.rl.push({ key: 'verify-miss-all:u1', created_at: Math.floor(Date.now() / 1000) });
  const r = await call(post('/api/auth/verify-code', { email: user.email, code: '123456', password: 'correct-horse-1' }, { ip: '192.0.2.77' }), env);
  assert.equal(r.status, 400);
  assert.equal(env.DB.log.filter(l => /^SELECT token FROM email_verification_tokens/.test(l.sql)).length, 0);
  // The refused try is handed back on every counter.
  assert.equal(env.DB.rl.filter(r => r.key.startsWith('verify-miss:') || r.key.startsWith('verify-miss-day:')).length, 0);
});

test('verify-code: the right code is not charged to the wrong-guess budget', async () => {
  const user = { id: 'u1', email: 'new@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 0, newsletter_consent: 0 };
  const env = { JWT_SECRET: SECRET, DB: memDB({ user, codeHash: await sha256Hex('u1:123456') }) };
  await call(post('/api/auth/verify-code', { email: user.email, code: '123456', password: 'correct-horse-1' }), env);
  assert.equal(env.DB.rl.filter(r => r.key.startsWith('verify-miss')).length, 0);
});

test('reset-confirm: one used link ends every reset link, verifies the account and cannot be replayed', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('old-password-11'), token_version: 0, email_verified: 0, newsletter_consent: 0 };
  const raw = 'a'.repeat(64);
  const env = { JWT_SECRET: SECRET, DB: memDB({ user, resetHash: await sha256Hex(raw) }) };
  env.DB.rl.push({ key: 'failed-login-all:owner@example.com', created_at: Math.floor(Date.now() / 1000) });
  await quiet(async () => {
    const [a, b] = await Promise.all([1, 2].map(() => call(post('/api/auth/reset-confirm', { token: raw, password: 'brand-new-pass-1' }), env)));
    assert.deepEqual([a.status, b.status].sort(), [200, 400], 'two requests racing with one link: one wins');
  });
  assert.equal(user.email_verified, 1);
  assert.equal(user.token_version, 1);
  assert.ok(env.DB.log.some(l => l.sql === 'UPDATE reset_tokens SET used=1 WHERE user_id=?'));
  assert.equal(env.DB.rl.filter(r => r.key.startsWith('failed-login')).length, 0, 'wrong-password counts cleared');
  assert.equal((await call(post('/api/auth/reset-confirm', { token: 'short', password: 'brand-new-pass-1' }), env)).status, 400);
});

test('JSON answers are never cached', async () => {
  const r = await worker.fetch(new Request(ORIGIN + '/api/pro-status'), { JWT_SECRET: SECRET, DB: memDB() }, { waitUntil() {} });
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
});

test('mail: one network naming many addresses stops at 10 verification mails a day', async () => {
  const realFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{}', { status: 200 }); };
  try {
    const env = { JWT_SECRET: SECRET, RESEND_API_KEY: 'test', DB: memDB() };
    for (let i = 0; i < 14; i++) {
      // Clear the per-network auth cap between calls: this test is about mail, not the 10-per-5-minutes cap.
      env.DB.rl.splice(0, env.DB.rl.length, ...env.DB.rl.filter(r => !r.key.startsWith('auth:')));
      const r = await call(post('/api/auth/signup', { email: `person${i}@example.com`, password: 'correct-horse-1' }, { ip: '203.0.113.200' }), env);
      assert.equal(r.status, 200);
      assert.equal(r.body.email_sent, true, 'the answer never changes');
    }
    assert.equal(sent.filter(u => u.includes('api.resend.com')).length, 10);
    // Another network still gets its mail.
    await call(post('/api/auth/signup', { email: 'other@example.com', password: 'correct-horse-1' }, { ip: '198.51.100.1' }), env);
    assert.equal(sent.filter(u => u.includes('api.resend.com')).length, 11);
  } finally { globalThis.fetch = realFetch; }
});

test('deposits: the per-account cap answers 400, not a write', async () => {
  const env = { JWT_SECRET: SECRET, DB: memDB({ user: { id: 'u1', email: 'a@example.com', token_version: 0 } }) };
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const st = base(sql);
    if (/^SELECT id FROM goals/.test(sql)) st.first = async () => ({ id: 'g1' });
    if (/^INSERT INTO deposits/.test(sql)) { assert.match(sql, /WHERE \(SELECT COUNT\(\*\) FROM deposits WHERE user_id=\?\) < \?/); st.run = async () => ({ meta: { changes: 0 } }); }
    return st;
  };
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const r = await call(post('/api/deposits', { amount: 5 }, { cookie }), env);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /5,000 deposits/);
});

test('signup, resend and reset answer no sooner than the set wait, whether or not the address has an account', async () => {
  const user = { id: 'u1', email: 'owner@example.com', password_hash: await hashPw('correct-horse-1'), token_version: 0, email_verified: 1, newsletter_consent: 0 };
  const timed = async (path, body) => {
    const env = { JWT_SECRET: SECRET, AUTH_MAIL_MIN_MS: '150', DB: memDB({ user }) };
    const t0 = Date.now();
    const r = await worker.fetch(post(path, body), env, { waitUntil() {} });
    return { ms: Date.now() - t0, status: r.status };
  };
  for (const [path, body] of [
    ['/api/auth/reset-request', { email: 'nobody@example.com' }], ['/api/auth/reset-request', { email: user.email }], ['/api/auth/reset-request', { email: 'not-an-email' }],
    ['/api/auth/resend-verification', { email: 'nobody@example.com' }], ['/api/auth/signup', { email: user.email, password: 'correct-horse-1' }], ['/api/auth/signup', { email: 'bad', password: 'x' }],
  ]) {
    const r = await timed(path, body);
    assert.ok(r.ms >= 145, `${path} ${JSON.stringify(body)} answered in ${r.ms}ms`);
  }
});

test('readJson: a body over 64 KB with no Content-Length is refused without a server error', async () => {
  const big = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(4096))); c.close(); } });
  const req = new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: big, duplex: 'half' });
  const r = await call(req, { JWT_SECRET: SECRET, DB: memDB() });
  assert.equal(r.status, 400);
});

test('goals and achievements: one account cannot grow without limit', async () => {
  const env = { JWT_SECRET: SECRET, DB: memDB({ user: { id: 'u1', email: 'a@example.com', token_version: 0 } }) };
  const base = env.DB.prepare.bind(env.DB);
  let achSql = '';
  env.DB.prepare = (sql) => {
    const st = base(sql);
    if (/^SELECT COUNT\(\*\) AS n FROM goals WHERE user_id=\?$/.test(sql)) st.first = async () => ({ n: 200 });
    if (/INTO achievements/.test(sql)) achSql = sql;
    return st;
  };
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  const g = await call(post('/api/goals', { name: 'One more', target_amount: 100 }, { cookie }), env);
  assert.equal(g.status, 400);
  assert.match(g.body.error, /200 goals/);
  await call(post('/api/achievements', { keys: ['creature:clownfish'] }, { cookie }), env);
  assert.match(achSql, /WHERE \(SELECT COUNT\(\*\) FROM achievements WHERE user_id=\?\) < \?/);
});

test('pages carry HSTS', async () => {
  const ASSETS = { async fetch() { return new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }); } };
  const r = await worker.fetch(new Request(ORIGIN + '/'), { JWT_SECRET: SECRET, ASSETS, DB: memDB() }, { waitUntil() {} });
  assert.match(r.headers.get('Strict-Transport-Security') || '', /max-age=31536000/);
});
