// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
// A copy stands on its own: no outside sign-in, no Pro it can't deliver, no setup traps.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const ORIGIN = 'https://copy.example.com';
const stmt = (first) => { const st = { bind() { return st; }, async first() { return first; }, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return st; };
const DB = { prepare() { return stmt(null); }, async batch(s) { return s.map(() => ({ results: [], meta: { changes: 1 } })); } };
const userDB = (row) => ({ ...DB, prepare(sql) { return stmt(/FROM users/.test(sql) ? row : null); } });
const b64 = (s) => Buffer.from(s).toString('base64url');
async function hs256(payload, secret) {
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;
const call = (req, env) => worker.fetch(req, { JWT_SECRET: SECRET, DB, ...env }, { waitUntil() {} });

test('pro-status: everyone is on the free plan, whatever a visitor sends', async () => {
  const forged = await hs256({ email: 'a@example.com', pro: true, exp: exp() }, SECRET);
  for (const headers of [{}, { Authorization: 'Bearer ' + forged, 'X-Pro': forged }]) {
    const d = await call(new Request(ORIGIN + '/api/pro-status', { headers }), {}).then(r => r.json());
    assert.deepEqual(Object.keys(d).sort(), ['feedback_available', 'is_pro']);
    assert.equal(d.is_pro, false);
  }
});

test('pro-status: feedback_available follows FEEDBACK_WEBHOOK_URL', async () => {
  const get = (env) => call(new Request(ORIGIN + '/api/pro-status'), env).then(r => r.json());
  assert.equal((await get({})).feedback_available, false);
  assert.equal((await get({ FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb' })).feedback_available, true);
});

test('feedback is off when FEEDBACK_WEBHOOK_URL is blank, and nothing is sent', async () => {
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { sent.push(String(url)); return new Response('{}'); };
  try {
    const r = await call(new Request(ORIGIN + '/api/feedback', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'hello there' }) }), {});
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /isn't set up/);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, []);
});

test('an unknown API route signs nobody in: 401 signed out, 404 signed in, never a cookie or a redirect', async () => {
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  const env = { DB: userDB({ token_version: 0, email: 'a@example.com', email_verified: 1 }) };
  for (const [method, path] of [['POST', '/api/auth/sso'], ['GET', '/api/auth/callback?code=abc&state=abc'], ['POST', '/api/checkout'], ['GET', '/api/billing']]) {
    for (const [headers, want] of [[{}, 401], [{ Cookie: cookie }, 404]]) {
      const r = await call(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? '{}' : undefined }), env);
      assert.equal(r.status, want, `${method} ${path}`);
      assert.equal(r.headers.get('Set-Cookie'), null, path);
      assert.equal(r.headers.get('Location'), null, path);
    }
  }
});

test('the page sells nothing: Go Pro points at the hosted version and says so', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="unlock-pro-btn" class="unlock-pro-btn" href="https:\/\/emergencyfundaquarium\.com" /);
  assert.doesNotMatch(html, /\$7\/mo|all five|class="pro-required-price"/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Pro isn't available on this copy of Emergency Fund Aquarium/);
  assert.match(js, /cta\.textContent = 'Open emergencyfundaquarium\.com'/);
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /upgrade_url|checkout/i);
});

test('Pro-only choices stay locked with a plain 402', async () => {
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  const env = { DB: userDB({ token_version: 0 }) };
  const r = await call(new Request(ORIGIN + '/api/goals', { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Fund', target_amount: 1000, biome: 'arctic' }) }), env);
  assert.equal(r.status, 402);
  assert.deepEqual(await r.json(), { error: 'Pro required', feature: 'pro-biomes' });
});

test('account delete asks for the password, nothing else works', async () => {
  const cookie = 'efa_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  const r = await call(new Request(ORIGIN + '/api/auth/account', { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE', token: 'anything' }) }),
    { DB: userDB({ token_version: 0, email: 'a@example.com', password_hash: 'pbkdf2:00:00' }) });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /password/i);
});

test('no session secret: sign up, verify and log in answer with a setup message and write nothing', async () => {
  const realError = console.error; console.error = () => {};
  const wrote = [];
  const spyDB = { prepare(sql) { const st = { bind() { return st; }, async first() { return null; }, async run() { wrote.push(sql); return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { wrote.push('batch'); return s.map(() => ({ results: [] })); } };
  try {
    for (const secret of [undefined, '', 'too-short']) {
      for (const [path, body] of [['signup', { email: 'a@example.com', password: 'correct horse 99' }], ['login', { email: 'a@example.com', password: 'correct horse 99' }], ['verify-code', { email: 'a@example.com', code: '123456', password: 'correct horse 99' }]]) {
        const r = await worker.fetch(new Request(ORIGIN + '/api/auth/' + path, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { JWT_SECRET: secret, DB: spyDB }, { waitUntil() {} });
        assert.equal(r.status, 503, path);
        const j = await r.json();
        assert.equal(j.code, 'setup_required');
        assert.match(j.error, /JWT_SECRET/);
      }
    }
    assert.deepEqual(wrote, []);
  } finally { console.error = realError; }
});

test('pages get this site address in og:url, og:image and the canonical link', async () => {
  const page = '<html><head><meta property="og:url" content="/guide"><meta property="og:image" content="/og.png"><meta name="twitter:image" content="/og.png"/></head><body></body></html>';
  const ASSETS = { async fetch() { return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); } };
  const html = await call(new Request(ORIGIN + '/guide'), { APP_URL: ORIGIN + '/', ASSETS }).then(r => r.text());
  assert.match(html, /<meta property="og:url" content="https:\/\/copy\.example\.com\/guide">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/copy\.example\.com\/og\.png">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/copy\.example\.com\/guide"\/>/);
  const real = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(real, /emergencyfundaquarium\.com\/og\.png|rel="canonical"/);
});
