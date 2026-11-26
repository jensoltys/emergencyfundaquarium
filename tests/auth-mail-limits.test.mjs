// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
// Auth mail limits: verify-code needs the password, per-address and daily email
// caps, and feedback goes through a rate-limited relay.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const ORIGIN = 'https://emergencyfundaquarium.com';
const IP = '203.0.113.88';

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

// Small stateful D1 stand-in: rate_limits rows, email_daily counters, one user.
function memDB({ user = null, codeHash = null, raceVerify = false } = {}) {
  const rl = [];
  const daily = new Map();
  const log = [];
  const handle = (sql, a) => {
    log.push({ sql, args: a });
    if (/^UPDATE users SET email_verified/.test(sql)) {
      // Mirrors the conditional WHERE: unverified + same hash + code still there.
      if (raceVerify || !user || user.email_verified || a[2] !== user.password_hash) return { meta: { changes: 0 } };
      user.email_verified = 1; return { meta: { changes: 1 } };
    }
    if (/^UPDATE email_verification_tokens SET used=1 WHERE user_id=\? AND token=\?/.test(sql)) return { meta: { changes: user && user.email_verified ? 1 : 0 } };
    if (/INSERT INTO email_daily/.test(sql)) { const k = a[0] + '|' + a[1]; const n = (daily.get(k) || 0) + 1; daily.set(k, n); return { n }; }
    if (/COUNT\(\*\) AS n FROM rate_limits/.test(sql)) return { results: [{ n: rl.filter(r => r.key === a[0] && r.created_at >= a[1]).length }] };
    if (/INSERT INTO rate_limits/.test(sql)) { rl.push({ key: a[0], created_at: a[1] }); return { meta: { changes: 1 } }; }
    if (/^DELETE FROM rate_limits WHERE rowid IN/.test(sql)) { const i = rl.map(r => r.key).lastIndexOf(a[0]); if (i >= 0) rl.splice(i, 1); return { meta: { changes: i >= 0 ? 1 : 0 } }; }
    if (/^DELETE FROM rate_limits WHERE key = \? AND created_at </.test(sql)) { for (let i = rl.length - 1; i >= 0; i--) if (rl[i].key === a[0] && rl[i].created_at < a[1]) rl.splice(i, 1); return { meta: { changes: 1 } }; }
    if (/FROM users WHERE email/.test(sql)) return user && a[0] === user.email ? user : null;
    if (/^SELECT token FROM email_verification_tokens WHERE user_id/.test(sql)) return codeHash && a.includes(codeHash) ? { token: codeHash } : null;
    return undefined;
  };
  return {
    log, daily, rl,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...x) { args = x; return stmt; },
        async first() { return handle(sql, args) ?? null; },
        async all() { return { results: [] }; },
        async run() { return handle(sql, args) ?? { meta: { changes: 1 } }; },
        exec() { return handle(sql, args) ?? { meta: { changes: 1 } }; },
      };
      return stmt;
    },
    // A D1 batch is one transaction: its statements run together, in order.
    async batch(stmts) { return stmts.map(s => s.exec()); },
  };
}
function post(path, body, ip = IP) {
  return new Request(ORIGIN + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip },
    body: JSON.stringify(body),
  });
}
async function call(req, env) {
  const r = await worker.fetch(req, { AUTH_MAIL_MIN_MS: '0', ...env }, { waitUntil() {} });
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

test('verify-code: missing password 400, wrong password 400 (not verified), right password 200 + cookie', async () => {
  const user = { id: 'u1', email: 'owner@example.com', email_verified: 0, token_version: 0, newsletter_consent: 0, password_hash: await hashPw('right-password-1') };
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB: memDB({ user, codeHash: await sha256Hex('u1:123456') }) };
  const none = await call(post('/api/auth/verify-code', { email: user.email, code: '123456' }), env);
  assert.equal(none.status, 400);
  assert.equal(none.body.error, 'Enter your password along with the code.');
  const wrong = await call(post('/api/auth/verify-code', { email: user.email, code: '123456', password: 'attacker-chose-this' }), env);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error, "That password doesn't match this account.");
  assert.equal(wrong.headers.get('Set-Cookie'), null);
  assert.equal(user.email_verified, 0);
  const ok = await call(post('/api/auth/verify-code', { email: user.email, code: '123456', password: 'right-password-1' }), env);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('Set-Cookie') || '', /efa_session=/);
  assert.equal(user.email_verified, 1);
});

test('verify-code: a row that changed between the check and the write gets the generic 400 and no session', async () => {
  const user = { id: 'u1', email: 'owner@example.com', email_verified: 0, token_version: 0, newsletter_consent: 0, password_hash: await hashPw('right-password-1') };
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB: memDB({ user, codeHash: await sha256Hex('u1:123456'), raceVerify: true }) };
  const r = await call(post('/api/auth/verify-code', { email: user.email, code: '123456', password: 'right-password-1' }), env);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /invalid or expired/);
  assert.equal(r.headers.get('Set-Cookie'), null);
  const upd = env.DB.log.find(l => /^UPDATE users SET email_verified/.test(l.sql));
  assert.match(upd.sql, /email_verified=0 AND password_hash=\? AND COALESCE\(token_version,0\)=\?/);
});

test('legacy GET verify-email link no longer verifies anything', async () => {
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB: memDB() };
  const r = await worker.fetch(new Request(ORIGIN + '/api/auth/verify-email?token=123456'), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.ok(!env.DB.log.some(l => /UPDATE users/.test(l.sql)));
});

test('reset-request: 4th mail to one address in 15 min sends nothing but still answers success', async () => {
  const user = { id: 'u1', email: 'owner@example.com', email_verified: 1 };
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', APP_URL: ORIGIN, DB: memDB({ user }) };
  for (let i = 0; i < 3; i++) {
    const r = await call(post('/api/auth/reset-request', { email: user.email }, `198.51.100.${i}`), env);
    assert.equal(r.status, 200);
  }
  const before = env.DB.log.filter(l => /INSERT OR REPLACE INTO reset_tokens/.test(l.sql)).length;
  const fourth = await call(post('/api/auth/reset-request', { email: user.email }, '198.51.100.9'), env);
  assert.equal(fourth.status, 200);
  assert.deepEqual(fourth.body, { success: true });
  assert.equal(env.DB.log.filter(l => /INSERT OR REPLACE INTO reset_tokens/.test(l.sql)).length, before);
  // Unknown address: identical answer, never charged.
  for (let i = 0; i < 4; i++) await call(post('/api/auth/reset-request', { email: 'nobody@example.com' }, `198.51.100.${20 + i}`), env);
  const unknown = await call(post('/api/auth/reset-request', { email: 'nobody@example.com' }, '198.51.100.30'), env);
  assert.deepEqual(unknown.body, fourth.body);
});

test('reset-request: daily ceiling stops the 151st real send', async () => {
  const user = { id: 'u1', email: 'owner@example.com', email_verified: 1 };
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', APP_URL: ORIGIN, DB: memDB({ user }) };
  env.DB.daily.set('mail:reset|' + new Date().toISOString().slice(0, 10), 150);
  const r = await call(post('/api/auth/reset-request', { email: user.email }), env);
  assert.deepEqual(r.body, { success: true });
  assert.ok(!env.DB.log.some(l => /INSERT OR REPLACE INTO reset_tokens/.test(l.sql)));
});

test('signup + resend: junk requests never charge a cap, real sends cap at 3 per address with the normal answer', async () => {
  const unverified = { id: 'u1', email: 'owner@example.com', email_verified: 0, password_hash: 'x' };
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB: memDB({ user: unverified }) };
  const sends = () => env.DB.log.filter(l => /INSERT INTO email_verification_tokens/.test(l.sql)).length;
  // Unknown and nonexistent addresses: no per-address rows, no daily charge.
  for (let i = 0; i < 5; i++) await call(post('/api/auth/resend-verification', { email: 'nobody@example.com' }, `192.0.2.${i}`), env);
  assert.equal(env.DB.daily.size, 0);
  assert.ok(!env.DB.log.some(l => /INSERT INTO rate_limits/.test(l.sql) && /verify-mail:/.test(l.args[0])));
  // Real unverified account: 3 real sends, then the send is skipped silently.
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push(await call(post('/api/auth/signup', { email: unverified.email, password: 'long-enough-pw' }, `192.0.2.${50 + i}`), env));
  assert.equal(sends(), 3);
  for (const a of answers) { assert.equal(a.status, 200); assert.equal(a.body.awaiting_verification, true); }
  assert.deepEqual(answers[4].body, { ...answers[4].body, email_sent: true });
});

test('signup at the daily verification-mail ceiling still creates the account and answers normally, mail skipped', async () => {
  const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB: memDB() };
  env.DB.daily.set('mail:verify|' + new Date().toISOString().slice(0, 10), 150);
  const r = await call(post('/api/auth/signup', { email: 'x@example.com', password: 'long-enough-pw' }), env);
  assert.equal(r.status, 200);
  assert.equal(r.body.email_sent, true);
  assert.ok(env.DB.log.some(l => /INSERT INTO users/.test(l.sql)));
  assert.ok(!env.DB.log.some(l => /INSERT INTO email_verification_tokens/.test(l.sql)));
});

test('feedback relay: honeypot, validation, server-side forward, 6th call from one IP is 429', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { sent.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  try {
    const env = { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', APP_NAME: 'Emergency Fund Aquarium', FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/feedback', DB: memDB() };
    const bot = await call(post('/api/feedback', { message: 'buy pills', website: 'spam.example' }, '192.0.2.200'), env);
    assert.equal(bot.status, 200);
    assert.equal(sent.length, 0);
    const short = await call(post('/api/feedback', { message: 'x' }, '192.0.2.201'), env);
    assert.equal(short.status, 400);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await call(post('/api/feedback', { type: 'bug', message: 'The fish tank is blank', url: ORIGIN + '/', email: '' }), env)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
    assert.equal(sent.length, 5);
    assert.equal(sent[0].url, 'https://hooks.example.com/feedback');
    assert.deepEqual(Object.keys(sent[0].body).sort(), ['app', 'email', 'message', 'type', 'url', 'user_agent']);
    assert.equal(sent[0].body.app, 'Emergency Fund Aquarium');
    const cross = await call(new Request(ORIGIN + '/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"message":"hello there"}' }), env);
    assert.equal(cross.status, 403);
  } finally { globalThis.fetch = realFetch; }
});
