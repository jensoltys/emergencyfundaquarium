// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
// worker.js — Emergency Fund Aquarium API
// Cloudflare Worker + D1 database
// Auth: PBKDF2 password hashing + HS256 JWT (30-day sessions)

import { reportServerError, alertPayloadFor, stripAlertHeader, markNoAlert } from './lib/alert.js';
import { emailLayout, emailPara, emailSmall, emailCode, emailButton } from './lib/email-look.js';
import { overLimit, dropNewest, ipKey } from './lib/ratelimit.js';

// Email theme ("Anglerfish" + Puff). Layout: lib/email-look.js.
const EMAIL_THEME = {
  name: 'Emergency Fund Aquarium', get mascotUrl() { return APP_BASE + '/email-mascot.png'; }, mascotAlt: 'Puff the pufferfish', mascotW: 98,
  bg: '#070A12', card: '#171E30', line: '#26304A', pri: '#CFF25A', pri2: '#A9D63A', on: '#1C2604', a2: '#5CE1E6', text: '#EEF2F8', muted: '#9AA3B8',
};

// Pro on a copy. Pro is part of the hosted version.
// A copy has no billing, so nobody has Pro here: the free plan caps apply to
// everyone and the Pro-only choices answer 402. This is the one place that decides.
function hasProAccess() {
  return false;
}

// Free plan cap: active savings goals per account. Everyone on a copy is on the
// free plan, so change this number if you want more goals on your own copy.
const FREE_GOALS = 1;

// Link previews and search engines need full addresses. The pages ship with
// site-relative ones, so this fills in the site's own address (APP_URL) and adds
// the canonical link on the way out.
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function absoluteMeta(html, base) {
  const b = escapeAttr(base);
  let canonical = '';
  html = html.replace(/(<meta (?:property|name)="(og:url|og:image|twitter:image)" content=")(\/[^"]*)"/g, (m, head, name, path) => {
    if (name === 'og:url') canonical = b + path;
    return head + b + path + '"';
  });
  if (canonical && !html.includes('<link rel="canonical"')) {
    html = html.replace('</head>', () => `<link rel="canonical" href="${canonical}"/>\n</head>`);
  }
  return html;
}

// DEV_LOG_CODES prints signup codes and reset links to the terminal. It only works
// while APP_URL is a localhost address, so it can't leak codes into the logs of a live site.
function devLogOn(env) {
  return env.DEV_LOG_CODES === 'true' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(APP_BASE);
}

// This site's own address, from APP_URL in wrangler.toml. Set on every request.
let APP_BASE = '';
function setAppBase(env) {
  APP_BASE = String(env.APP_URL || '').replace(/\/+$/, '');
}

// Biome tiers. LEGACY_BIOMES are the four choices that were free before
// Pro biomes shipped: a goal whose stored biome is still NULL may be stamped
// with any of them once, regardless of Pro (grandfather rule).
const FREE_BIOMES = ['ocean', 'tropical'];
const ALL_BIOMES = ['ocean', 'tropical', 'lake', 'deep', 'coralreef', 'arctic'];
const LEGACY_BIOMES = ['ocean', 'tropical', 'lake', 'deep'];
const PRO_BIOMES_402 = {
  error: 'Pro required',
  feature: 'pro-biomes',
};

// Build per-request CORS headers. Returned by every handler via res(...).
// No module-level mutable CORS state.
// Vary: Origin so caches don't cross-pollinate.
// A request is trusted only when its Origin is this site's own address, so a
// self-hosted copy works on any domain with nothing to configure.
function buildCors(request) {
  const allowOrigin = new URL(request.url).origin;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

// CSRF Origin/Referer check. The session is an HttpOnly cookie, which the
// browser attaches to every request to this host no matter which site started
// it, so every state-changing request has to prove it came from one of our own
// pages: the origin the request was sent to.
// Returns null if OK, or a 403 Response.
function checkOrigin(request, corsHeaders) {
  const own = [new URL(request.url).origin];
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (origin) return own.includes(origin) ? null : res({ error: 'Forbidden' }, 403, corsHeaders);
  if (referer && own.some(o => referer.startsWith(o + '/'))) return null;
  return res({ error: 'Forbidden' }, 403, corsHeaders);
}

// State-changing routes that skip the Origin check, each with its reason.
// A route belongs here only if no browser ever calls it with our cookie.
// Emergency Fund Aquarium has none: the cron runs as scheduled() not fetch(),
// and there is no payment webhook in this app.
const CSRF_EXEMPT = new Set([]);

// ── Session cookie ──────────────────────────────────────────────────────────
// The login session is an HS256 JWT held in an HttpOnly cookie, so page
// scripts can never read it. Same 30-day life as the JWT inside it.
const SESSION_COOKIE = 'efa_session';
const SESSION_TTL = 30 * 86400;
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

function sessionCookie(jwt, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${jwt}; ${COOKIE_ATTRS}; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
async function mintSession(uid, tokenVersion, env) {
  return makeJWT({ sub: uid, tv: tokenVersion ?? 0, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.JWT_SECRET);
}
// A JSON response that also starts (or replaces) the session cookie.
function resWithSession(data, jwt, corsHeaders) {
  const r = res(data, 200, corsHeaders);
  r.headers.append('Set-Cookie', sessionCookie(jwt));
  return r;
}
function hasSession(request) {
  return !!readCookie(request, SESSION_COOKIE);
}

export default {
  // Any 5xx that leaves this worker fires an email beacon (alert.js) so a
  // real visitor hitting a server error is a same-minute email, not a
  // someday discovery in the logs.
  async fetch(request, env, ctx) {
    setAppBase(env);
    // A THROW out of handle() has to become a Response before the 5xx branch
    // below can see it. Without this catch the exception escaped the worker,
    // the runtime returned its own 500, and NO alert email was sent — silent on
    // exactly the crash class the beacon exists for.
    let response;
    let errDetail = '';
    try {
      response = await this.handle(request, env, ctx);
    } catch (e) {
      console.error('unhandled route error', request.method, new URL(request.url).pathname, (e && e.stack) || e);
      response = new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      // The message the beacon reads comes off this body, so name the cause.
      errDetail = String((e && e.message) || e).slice(0, 200);
    }
    try {
      if (response && response.status >= 500) {
        // The message is read off a clone of the response body inside
        // waitUntil, so it never delays the client. Responses tagged by
        // markNoAlert() are skipped.
        const job = alertPayloadFor(request, response, errDetail)
          .then(info => (info ? reportServerError(env, null, info) : null))
          .catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch { /* never block the response */ }
    return stripAlertHeader(response);
  },

  async handle(request, env, ctx) {
    const corsHeaders = buildCors(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    if (!p.startsWith('/api/')) {
      // /reset/<token> is a virtual route: there is no asset at that path, so
      // ask ASSETS for the SPA shell instead. Without this the reset link 404s.
      const assetReq = /^\/reset\/[A-Za-z0-9._-]{16,256}\/?$/.test(p)
        ? new Request(new URL('/', request.url), request)
        : request;
      const asset = await env.ASSETS.fetch(assetReq);
      const headers = new Headers(asset.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      headers.set('Vary', 'Origin');
      // Per-request CSP nonce: Cloudflare's edge parses the script-src nonce
      // from this header and stamps it onto the inline snippets it injects
      // (Web Analytics bootstrap, bot JS detections), keeping the console
      // clean without 'unsafe-inline'. Our own scripts are external ('self').
      const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
      headers.set('Content-Security-Policy',
        "default-src 'self'; " +
        `script-src 'self' https://static.cloudflareinsights.com 'nonce-${nonce}'; ` +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' https://cloudflareinsights.com; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';");
      headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-cache');
      if (asset.status === 200 && request.method === 'GET' && APP_BASE && (headers.get('Content-Type') || '').includes('text/html')) {
        headers.delete('Content-Length');
        return new Response(absoluteMeta(await asset.text(), APP_BASE), { status: 200, headers });
      }
      return new Response(asset.body, { status: asset.status, headers });
    }

    // Reject oversized request bodies (64KB max)
    const contentLength = parseInt(request.headers.get('Content-Length') || '0');
    if (contentLength > 65536) {
      return res({ error: 'Request too large' }, 413, corsHeaders);
    }

    try {
      // ── What this server offers (no login needed) ─
      if (p === '/api/pro-status' && request.method === 'GET') {
        return res({
          is_pro: hasProAccess(),
          // False when FEEDBACK_WEBHOOK_URL is blank: the page then hides the Feedback button.
          feedback_available: !!env.FEEDBACK_WEBHOOK_URL,
        }, 200, corsHeaders);
      }

      // A copy with no session secret can't log anyone in. Say so before any
      // account is written, instead of failing halfway with "Server error".
      if (p.startsWith('/api/auth/') && request.method === 'POST' && p !== '/api/auth/logout'
          && (typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length < 32)) {
        console.error('JWT_SECRET is not set (or is shorter than 32 characters). Sign up and log in are off until it is.');
        return markNoAlert(res({ error: "This server isn't set up yet. Its owner needs to set JWT_SECRET to a random string of 32 or more characters.", code: 'setup_required' }, 503, corsHeaders));
      }

      // ── Rate-limit auth routes ──────────────────────────
      if (p.startsWith('/api/auth/') && request.method === 'POST' && p !== '/api/auth/logout') {
        const rl = await rateLimit(request, env, 'auth', 10, 300, undefined, corsHeaders);
        if (rl) return rl;
      }

      // ── CSRF: every state-changing request must come from our own pages ──
      // The session rides in a cookie the browser sends automatically, so
      // this runs on ALL POST/PUT/PATCH/DELETE, not a hand-picked list.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !CSRF_EXEMPT.has(p)) {
        const csrf = checkOrigin(request, corsHeaders);
        if (csrf) return csrf;
      }

      // ── Feedback relay (no login needed) ────────────────
      // The Feedback button posts here, never straight to the webhook, so its
      // URL stays server-side and spam is capped at 5 per 10 minutes per IP.
      // Same-origin only (the CSRF check above already ran).
      if (p === '/api/feedback' && request.method === 'POST') {
        const rl = await rateLimit(request, env, 'feedback', 5, 600, undefined, corsHeaders);
        if (rl) return rl;
        return feedback(request, env, corsHeaders);
      }

      // ── Unauthenticated routes ──────────────────────────
      // Logout needs no valid session: it always clears the cookie, so a
      // stale or revoked cookie can still be removed.
      if (p === '/api/auth/logout'        && request.method === 'POST') return logout(corsHeaders);
      if (p === '/api/auth/signup'        && request.method === 'POST') return steady(env, () => signup(request, env, corsHeaders));
      if (p === '/api/auth/login'         && request.method === 'POST') return login(request, env, corsHeaders);
      if (p === '/api/auth/reset-request' && request.method === 'POST') return steady(env, () => resetRequest(request, env, corsHeaders));
      if (p === '/api/auth/resend-verification' && request.method === 'POST') return steady(env, () => resendVerification(request, env, corsHeaders));
      if (p === '/api/auth/verify-code'   && request.method === 'POST') return steady(env, () => verifyCode(request, env, corsHeaders));
      if (p === '/api/auth/reset-confirm' && request.method === 'POST') return resetConfirm(request, env, corsHeaders);
      if (p === '/api/auth/verify-email'  && request.method === 'GET')  return verifyEmail(url, env);

      // ── Authenticated routes ────────────────────────────
      const uid = await requireAuth(request, env, corsHeaders);

      // Per-user write rate limit: 120 writes per minute per user
      if (['POST','PUT','DELETE','PATCH'].includes(request.method)) {
        const userRL = await rateLimit(request, env, '', 120, 60, `user:${uid}:writes`, corsHeaders);
        if (userRL) return userRL;
      }

      // GDPR Right to Access — export account data
      if (p === '/api/account/export' && request.method === 'GET') return exportAccount(uid, env, corsHeaders);

      // Goals
      if (p === '/api/goals' && request.method === 'GET')  return getGoals(uid, env, corsHeaders);
      if (p === '/api/goals' && request.method === 'POST') return addGoal(uid, request, env, corsHeaders);

      const goalMatch = p.match(/^\/api\/goals\/([^/]+)$/);
      if (goalMatch && request.method === 'PUT')    return updateGoal(uid, goalMatch[1], request, env, corsHeaders);
      if (goalMatch && request.method === 'DELETE')  return deleteGoal(uid, goalMatch[1], env, corsHeaders);

      const completeMatch = p.match(/^\/api\/goals\/([^/]+)\/complete$/);
      if (completeMatch && request.method === 'POST') return completeGoal(uid, completeMatch[1], env, corsHeaders);

      // Deposits
      if (p === '/api/deposits' && request.method === 'GET')  return getDeposits(uid, url, env, corsHeaders);
      if (p === '/api/deposits' && request.method === 'POST') return addDeposit(uid, request, env, corsHeaders);

      const depMatch = p.match(/^\/api\/deposits\/([^/]+)$/);
      if (depMatch && request.method === 'PUT')    return updateDeposit(uid, depMatch[1], request, env, corsHeaders);
      if (depMatch && request.method === 'DELETE')  return deleteDeposit(uid, depMatch[1], env, corsHeaders);

      // Achievements (server is truth for milestones + fish-dex)
      if (p === '/api/achievements' && request.method === 'GET')  return getAchievements(uid, env, corsHeaders);
      if (p === '/api/achievements' && request.method === 'POST') return addAchievements(uid, request, env, corsHeaders);

      // Profile & settings. /api/me is the boot check: the page can't read
      // the HttpOnly cookie, so one GET here decides "logged in?" (401 = no).
      if (p === '/api/me'            && request.method === 'GET')    return getProfile(uid, env, corsHeaders);
      if (p === '/api/profile'       && request.method === 'GET')    return getProfile(uid, env, corsHeaders);
      if (p === '/api/profile'       && request.method === 'PUT')    return updateProfile(uid, request, env, corsHeaders);
      if (p === '/api/auth/password' && request.method === 'PUT')    return changePassword(uid, request, env, corsHeaders);
      if (p === '/api/auth/account'  && request.method === 'DELETE') return deleteAccount(uid, request, env, corsHeaders);

      return res({ error: 'Not found' }, 404, corsHeaders);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error(e.stack || e);
      return res({ error: 'Server error' }, 500, corsHeaders);
    }
  },

  // Daily (wrangler.toml [triggers]): purge expired rate-limit rows and old tokens.
  async scheduled(event, env, ctx) {
    setAppBase(env);
    ctx.waitUntil(purgeExpired(env));
  },
};

// ── Feedback relay ──────────────────────────────────────────────────────────
// POST /api/feedback  body: { type, message, email?, url?, website? }
// Forwards to FEEDBACK_WEBHOOK_URL with this payload: app, type, message, email,
// url, user_agent. `website` is a honeypot people never see: bots fill it and
// get a fake success. Unset FEEDBACK_WEBHOOK_URL = feedback is off.
async function feedback(request, env, corsHeaders) {
  const body = await readJson(request);
  if (!body) return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  if (body.website) return res({ ok: true }, 200, corsHeaders);
  if (!env.FEEDBACK_WEBHOOK_URL) return markNoAlert(res({ error: "Feedback isn't set up on this server." }, 503, corsHeaders));
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const message = str(body.message, 2000);
  if (message.length < 3) return res({ error: 'Please write a bit more so I know what you mean.' }, 400, corsHeaders);
  const email = str(body.email, 200);
  if (email && !isValidEmail(email)) return res({ error: "That email doesn't look right. Fix it or leave it blank." }, 400, corsHeaders);
  const type = ['bug', 'feature', 'other'].includes(body.type) ? body.type : 'other';
  const r = await fetch(env.FEEDBACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: env.APP_NAME || 'Emergency Fund Aquarium',
      type,
      message,
      email,
      url: str(body.url, 500),
      user_agent: (request.headers.get('User-Agent') || '').slice(0, 500),
    }),
  }).catch(() => null);
  // markNoAlert keeps a webhook outage out of the error beacon.
  if (!r || !r.ok) return markNoAlert(res({ error: 'Could not send. Try again in a minute.' }, 502, corsHeaders));
  return res({ ok: true }, 200, corsHeaders);
}

// ── Same-time answers for routes that may send mail ─────────────────────────
// Signup, resend, reset and the code check do more work for some addresses than others (a new
// address gets an email, a known one doesn't), and that difference showed in
// how fast the answer came back, which told a stranger which emails have
// accounts. Every answer from those routes now leaves no sooner than
// MAIL_ROUTE_MS after the request arrived, whatever happened inside.
// AUTH_MAIL_MIN_MS overrides the wait (the unit tests set 0).
const MAIL_ROUTE_MS = 1200;
async function steady(env, run) {
  const started = Date.now();
  const n = Number(env.AUTH_MAIL_MIN_MS);
  const min = env.AUTH_MAIL_MIN_MS !== undefined && Number.isFinite(n) ? Math.min(Math.max(n, 0), 5000) : MAIL_ROUTE_MS;
  let out, err;
  try { out = await run(); } catch (e) { err = e; }
  const left = started + min - Date.now();
  if (left > 0) await new Promise(r => setTimeout(r, left));
  if (err) throw err;
  return out;
}

// ── Safe JSON body ──────────────────────────────────────────────────────────
// Read as a stream and capped at 64 KB: the Content-Length check in
// handle() can't see a chunked body with no length. Bad JSON, null, an array
// or a number all read as null, so `(await readJson(r)) || {}` never
// destructures null (that TypeError was a 500 + alert email).
const MAX_BODY_BYTES = 65536;
async function readJson(request) {
  // Read in pieces and stop at the cap, so an oversized body is never held in
  // memory whole (a chunked upload carries no Content-Length to refuse up front).
  let text;
  try {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const parts = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) { try { await reader.cancel(); } catch { /* already closed */ } return null; }
      parts.push(value);
    }
    const all = new Uint8Array(total); let at = 0;
    for (const part of parts) { all.set(part, at); at += part.byteLength; }
    text = new TextDecoder().decode(all);
  } catch { return null; }
  let body;
  try { body = JSON.parse(text); } catch { return null; }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

// ── Security event log ──────────────────────────────────────────────────────
// Workers Logs ([observability] in wrangler.toml). One JSON line per auth
// event. Never a raw password, token, email or IP: email and IP are hashed
// with a server-side pepper so events can be linked without holding either.
async function peppered(env, kind, value) {
  if (!value) return null;
  return (await sha256Hex(`${env.JWT_SECRET || ''}:${kind}:${value}`)).slice(0, 24);
}
async function secLog(env, request, type, { uid = null, email = null } = {}) {
  try {
    const ip = request?.headers?.get('CF-Connecting-IP') || '';
    console.log(JSON.stringify({
      evt: 'auth', type,
      ...(uid ? { uid } : {}),
      ...(email ? { email_hash: await peppered(env, 'email', String(email).toLowerCase()) } : {}),
      ip_hash: await peppered(env, 'ip', ip),
    }));
  } catch { /* logging must never break a request */ }
}

// ── Daily purge (retention) ─────────────────────────────────────────────────
// Expired rate-limit rows go the day they lapse. Reset and email-verification
// tokens are kept 7 days past expiry (used ones included), then deleted.
async function purgeExpired(env) {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
      env.DB.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').bind(new Date(weekAgo * 1000).toISOString()),
      env.DB.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').bind(weekAgo),
      env.DB.prepare('DELETE FROM email_daily WHERE day < ?').bind(new Date().toISOString().slice(0, 10)),
    ]);
  } catch (e) {
    console.error('purgeExpired failed', e && e.message);
  }
}

// ── Response helper ─────────────────────────────────────────────────────────

function res(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── Crypto: SHA-256 helper ──────────────────────────────────────────────────
// Token storage uses sha256(raw_token); raw token is emailed, hash is in DB.
async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Email validation ────────────────────────────────────────────────────────
// Shared email normalization + validation used at signup and login.
function isValidEmail(s) {
  return typeof s === 'string' && s.length > 3 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// ── Email footer ────────────────────────────────────────────────────────────
// Every email this Worker sends ends with the same footer. Put your own company
// name and postal address here (many countries require one in email).
const EMAIL_SENDER_LINE = 'YOUR COMPANY NAME · YOUR BUSINESS ADDRESS';
const emailPrivacyUrl = () => `${APP_BASE}/legal/privacy`;
const emailFooterText = () => `${EMAIL_SENDER_LINE} · Privacy: ${emailPrivacyUrl()}`;
function emailFooterHtml(color = '#9AA3B8', rule = '#171E30') {
  return `<p style="font-size:12px;color:${color};margin-top:24px;text-align:center;border-top:1px solid ${rule};padding-top:12px;line-height:1.5">${EMAIL_SENDER_LINE.replace(' · ', ' &middot; ')} &middot; Privacy: <a href="${emailPrivacyUrl()}" style="color:${color}">${emailPrivacyUrl()}</a></p>`;
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

// Email a 6-digit CODE, not a magic link. A long tokenized verify-link to a
// young domain reads as phishing to Gmail, which accepts then silently drops
// it (Resend shows "delivered" but it never reaches the inbox). A code has no
// clickable credential link, so it lands normally. Store only the hash.
async function sendVerificationEmail(userId, email, env) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  // Salt the hash with the user id so two users drawing the same 6-digit code
  // produce different hashes. token is a PRIMARY KEY: a bare sha256(code) would
  // collide across users → second INSERT hits a PK violation → non-JSON 500.
  const codeHash = await sha256Hex(userId + ':' + code);
  const now = Math.floor(Date.now() / 1000);
  // One live code per user: clear any prior unused codes first. Wrapped so a
  // DB hiccup logs and bails rather than throwing a 500 out of signup.
  try {
    await env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id=? AND used=0').bind(userId).run();
    await env.DB.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(codeHash, userId, now + 1800, now).run(); // 30-minute window
  } catch (e) {
    console.error('sendVerificationEmail: token store failed', e);
    return false;
  }
  // Returns true only when Resend accepted the message, so callers can tell
  // the user when nothing went out instead of promising an inbox.
  if (!env.RESEND_API_KEY) {
    // Local testing only: DEV_LOG_CODES=true prints the code when no email key is set.
    if (devLogOn(env)) { console.log('[dev] verify code for', email, code); return true; }
    console.error('sendVerificationEmail: RESEND_API_KEY not set'); return false;
  }
  // Awaited so the send completes before the request ends (un-awaited fetches
  // get cancelled when the Worker returns). Errors logged, not thrown.
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Emergency Fund Aquarium <onboarding@resend.dev>',
        to: email,
        subject: `Your Emergency Fund Aquarium code is ${code}`,
        text: `Your Emergency Fund Aquarium verification code is: ${code}\n\nEnter it on the sign-in screen to finish setting up your account. It expires in 30 minutes.\n\nIf you didn't sign up for Emergency Fund Aquarium, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Your verification code',
          body: emailPara(EMAIL_THEME, 'Enter this code on the sign-in screen to finish setting up your Emergency Fund Aquarium account:')
            + emailCode(EMAIL_THEME, code)
            + emailSmall(EMAIL_THEME, "This code expires in 30 minutes. If you didn't sign up for Emergency Fund Aquarium, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    });
    if (!r.ok) { console.error('sendVerificationEmail: Resend FAIL', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('sendVerificationEmail threw', e.message); return false; }
}

// Legacy GET link from before codes replaced links (nothing sends one now).
// It no longer verifies anything: verifying without the password would let
// whoever last signed up on an unverified address keep the password they
// chose. It points people to the code flow.
async function verifyEmail(url, env) {
  const base = escapeAttr(APP_BASE || '/');
  const htmlPage = (title, body) => new Response(`<!DOCTYPE html><html><head><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:-apple-system,sans-serif;background:#070A12;color:#EEF2F8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#CFF25A}h1{color:#CFF25A}</style></head><body><div>${body}</div></body></html>`, { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
  return htmlPage('Use your code', '<h1>This link has retired</h1><p>We verify with a 6-digit code now. Log in with your email and password and we\'ll send you one.</p><p><a href="' + base + '">Go to Emergency Fund Aquarium</a></p>');
}

// overLimit / hitCount live in ./lib/ratelimit.js (record-then-count in one D1
// batch, so parallel requests can't slip past a cap).
//
// A caller's network as it is stored in rate-limit keys: a peppered hash,
// never the raw address. IPv6 is cut to its /64 first (see ipKey).
async function netKey(env, request) {
  return peppered(env, 'ip', ipKey(request));
}

// Wrong-password lockout, keyed by account AND network: someone guessing at an
// address locks out their own network only, so the real owner (on another
// network) still gets in with the right password. Each try is recorded BEFORE
// the password check, and a correct password takes its own try back.
const LOGIN_LOCKOUT_MAX = 5;          // tries per account + network per window
const LOGIN_LOCKOUT_WINDOW_S = 900;   // 15 min
// Ceiling on wrong-password tries against ONE account from every network added
// together, so guessing spread across many networks stays slow. Above one
// network's 5 so a single guesser can't lock the owner out, and a password
// reset always gets the owner back in.
const LOGIN_ALL_MAX = 20;
const lockKeyFor = async (env, email, request) => `failed-login:${email}|${await netKey(env, request)}`;
const lockedOut = (corsHeaders) => res({ error: 'Too many failed attempts. Try again in 15 minutes, or use Forgot password to get back in now.' }, 429, { ...corsHeaders, 'Retry-After': String(LOGIN_LOCKOUT_WINDOW_S) });
// True when this try is over a lockout cap. Call BEFORE checking the password.
async function passwordTryRefused(env, email, request) {
  return (await overLimit(env, await lockKeyFor(env, email, request), LOGIN_LOCKOUT_MAX, LOGIN_LOCKOUT_WINDOW_S))
    || (await overLimit(env, `failed-login-all:${email}`, LOGIN_ALL_MAX, LOGIN_LOCKOUT_WINDOW_S));
}
// A right password hands its try back to both counters.
async function passwordTryOk(env, email, request) {
  await dropNewest(env, await lockKeyFor(env, email, request));
  await dropNewest(env, `failed-login-all:${email}`);
}
// Every wrong-password count for one account, from every network.
async function clearPasswordTries(env, email) {
  try {
    const prefix = 'failed-login:' + email + '|';
    await env.DB.prepare('DELETE FROM rate_limits WHERE substr(key, 1, ?) = ? OR key = ?')
      .bind(prefix.length, prefix, 'failed-login-all:' + email).run();
  } catch (e) { console.error('lock clear failed:', (e && e.message) || e); }
}

// One cap, keyed by `customKey` or by `prefix` + the caller's network (hashed).
// Returns null when the request may go on, or the 429 to send back.
async function rateLimit(request, env, prefix, maxAttempts, windowSecs, customKey, corsHeaders = {}) {
  const key = customKey || `${prefix}:ip:${await netKey(env, request)}`;
  if (!(await overLimit(env, key, maxAttempts, windowSecs))) return null;
  return res({ error: 'Too many attempts. Please try again later.' }, 429,
    { ...corsHeaders, 'Retry-After': String(windowSecs) });
}

// ── Email flood limits ──────────────────
// Every unauthenticated route that mails a typed address has three limits:
// the existing per-IP one, a per-address window (3 mails per 15 minutes to any
// one address) and a daily ceiling for the whole app. Reset mail and
// verification mail have separate ceilings so signup spam can't block a
// locked-out user's reset.
// Both counts are charged ONLY when a mail is about to go out to a real
// account, never for unknown or already-verified addresses, so junk requests
// can't burn a stranger's per-address budget or the app's day. When a limit is
// hit the send is skipped and the route answers exactly as if it had sent
// (no 429 that only shows up for real accounts). The per-address slot is taken
// and counted in one batch, and the daily count is one row per key per UTC day
// in email_daily, checked and charged in one atomic upsert, so a burst of
// parallel requests can't get past either.
const MAIL_PER_ADDRESS = 3;
const MAIL_PER_ADDRESS_WINDOW = 900;
// And at most 10 a day to one address, so nobody's inbox can be filled slowly.
const MAIL_PER_ADDRESS_DAY = 10;
// And at most 10 a day caused by one network, whatever addresses it names.
const MAIL_PER_NETWORK_DAY = 10;
const RESET_MAIL_DAILY = 150;
const VERIFY_MAIL_DAILY = 150;

// Adds one to today's count for `key` and says whether it's still within `max`.
// The upsert both charges and returns the new count, so the check is atomic.
async function withinDaily(env, key, max) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    'INSERT INTO email_daily (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(key, day).first();
  // First hit of a new day clears earlier days. Best-effort, never blocks.
  if (r && r.n === 1) {
    try { await env.DB.prepare('DELETE FROM email_daily WHERE day < ?').bind(day).run(); } catch { /* cron retries */ }
  }
  return !!r && r.n <= max;
}

// Call right before a real send. kind: 'reset' | 'verify'. Returns true when
// the mail may go out. Order: the sender's network for the day, the address's 15-minute slot, its daily slot,
// then the app's daily charge. A send that a later cap stops gives its earlier
// slots back, so a capped address never spends the app's daily budget.
async function mayMail(env, kind, email, request) {
  const key = `${kind}-mail:${email}`;
  // One network can cause at most 10 mails of each kind a day, so a single
  // sender naming many addresses can't spend the whole app's daily ceiling
  // and leave real signups and resets with no mail.
  const netDay = `${kind}-mail-net:${await netKey(env, request)}`;
  if (await overLimit(env, netDay, MAIL_PER_NETWORK_DAY, 86400)) {
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, why: 'per_network_day' }));
    return false;
  }
  if (await overLimit(env, key, MAIL_PER_ADDRESS, MAIL_PER_ADDRESS_WINDOW)) {
    await dropNewest(env, netDay);
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, why: 'per_address_cap' }));
    return false;
  }
  if (await overLimit(env, `${key}|day`, MAIL_PER_ADDRESS_DAY, 86400)) {
    await dropNewest(env, netDay);
    await dropNewest(env, key);
    console.log(JSON.stringify({ evt: 'mail_skipped', kind, why: 'per_address_day' }));
    return false;
  }
  const dayKey = kind === 'reset' ? 'mail:reset' : 'mail:verify';
  const dayMax = kind === 'reset' ? RESET_MAIL_DAILY : VERIFY_MAIL_DAILY;
  if (!(await withinDaily(env, dayKey, dayMax))) {
    await dropNewest(env, netDay);
    await dropNewest(env, key);
    await dropNewest(env, `${key}|day`);
    console.error(JSON.stringify({ evt: 'mail_skipped', kind, why: 'daily_ceiling' }));
    return false;
  }
  return true;
}

// ── Crypto: PBKDF2 password hashing ─────────────────────────────────────────

async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function checkPw(pw, stored) {
  const [, saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('') === hashHex;
}

// ── Crypto: HS256 JWT ────────────────────────────────────────────────────────

function b64(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function unb64(str) { const p = str.replace(/-/g, '+').replace(/_/g, '/'); return atob(p + '='.repeat((4 - p.length % 4) % 4)); }

function requireSecret(secret) {
  // Refuse to sign or check logins without a real secret. A missing one would turn
  // into the word 'undefined', and anyone could forge a session.
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('JWT_SECRET must be set to a random string of 32+ characters.');
}

async function makeJWT(payload, secret) {
  requireSecret(secret);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64(String.fromCharCode(...new Uint8Array(sig)))}`;
}

// A malformed token (bad base64 or JSON) is just an invalid token. It must get a
// 401, not a 500: every 500 fires the optional alert webhook.
async function verifyJWT(token, secret) {
  try { return await verifyJWTStrict(token, secret); } catch { return null; }
}

async function verifyJWTStrict(token, secret) {
  requireSecret(secret);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key,
    Uint8Array.from(unb64(s), c => c.charCodeAt(0)),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;
  const payload = JSON.parse(unb64(p));
  if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(request, env, corsHeaders = {}) {
  // Session cookie only. The old localStorage `Authorization: Bearer` path
  // is gone, so a Bearer header alone is a 401.
  const cookieJwt = readCookie(request, SESSION_COOKIE);
  if (!cookieJwt) throw res({ error: 'Unauthorized' }, 401, corsHeaders);
  const payload = await verifyJWT(cookieJwt, env.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'string') throw res({ error: 'Invalid or expired token' }, 401, corsHeaders);
  // Every session carries its token_version. One without it can't be revoked, so it is refused.
  if (typeof payload.tv !== 'number') throw res({ error: 'Invalid or expired token' }, 401, corsHeaders);
  const user = await env.DB.prepare('SELECT token_version FROM users WHERE id=?').bind(payload.sub).first();
  if (!user || (user.token_version ?? 0) !== payload.tv) throw res({ error: 'Token revoked' }, 401, corsHeaders);
  return payload.sub;
}

// POST /api/auth/logout: clears the cookie. Emergency Fund Aquarium keeps no
// server-side session list, so there is nothing else to revoke here; a
// password change or reset still ends every session via token_version.
function logout(corsHeaders) {
  const r = res({ ok: true }, 200, corsHeaders);
  r.headers.append('Set-Cookie', clearSessionCookie());
  return r;
}

// ── Auth routes ──────────────────────────────────────────────────────────────

async function signup(request, env, corsHeaders) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const { email: rawEmail, password, newsletter_consent = false } = reqBody;
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res({ error: 'Please enter a valid email address.' }, 400, corsHeaders);
  }
  // Enforce min 10 / max 200 password length.
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res({ error: 'Password must be 10–200 characters.' }, 400, corsHeaders);
  }
  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    if (!existing.email_verified) {
      // Nobody has proved they own this address yet. The newest signer-up
      // takes over the credentials and gets a fresh code; entering it is what
      // proves ownership. Before this, a row squatted by someone else kept ITS
      // password after the real owner verified (pre-hijack account takeover).
      const hash = await hashPw(password);
      await env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').bind(hash, existing.id).run();
      // over a mail limit, skip the send but answer as if it went out.
      const sent = (await mayMail(env, 'verify', email, request)) ? await sendVerificationEmail(existing.id, email, env) : true;
      return res({ ok: true, awaiting_verification: true, email, email_sent: sent, message: 'Check your inbox to verify your email before logging in.' }, 200, corsHeaders);
    }
    // Don't leak account existence. Burn PBKDF2 cycles to match timing and
    // answer with the exact shape of a fresh signup.
    await hashPw(password);
    return res({ ok: true, awaiting_verification: true, email, email_sent: true, message: 'Check your inbox to verify your email before logging in.' }, 200, corsHeaders);
  }

  const id = crypto.randomUUID();
  const hash = await hashPw(password);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (id,email,password_hash,newsletter_consent,newsletter_consent_at,currency,created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(id, email, hash, newsletter_consent ? 1 : 0, newsletter_consent ? now : null, 'USD', now).run();

  // Await it: an un-awaited background send gets cancelled when the response
  // returns, which silently dropped both the token row and the email.
  // over a mail limit the account is still created and the answer is the
  // same; the mail is skipped and the user can resend later.
  const emailSent = (await mayMail(env, 'verify', email, request)) ? await sendVerificationEmail(id, email, env) : true;
  // Optional operator ping on each signup (SIGNUP_WEBHOOK_URL). Off when unset.
  await notifySignup(env, 'emergency-fund-aquarium', email, newsletter_consent === true);

  return res({ ok: true, awaiting_verification: true, email, email_sent: emailSent, message: 'Check your inbox to verify your email before logging in.' }, 200, corsHeaders);
}

async function resendVerification(request, env, corsHeaders) {
  const { email } = (await readJson(request)) || {};
  if (!email) return res({ ok: true }, 200, corsHeaders);
  const emailLower = String(email).trim().toLowerCase();
  if (!isValidEmail(emailLower)) return res({ ok: true }, 200, corsHeaders);
  const emailLimited = await rateLimit(request, env, 'verify-resend', 1, 60, `verify-resend:${emailLower}`, corsHeaders);
  if (emailLimited) return emailLimited;
  const ipLimited = await rateLimit(request, env, 'verify-resend-ip', 10, 60, null, corsHeaders);
  if (ipLimited) return ipLimited;
  const user = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(emailLower).first();
  // An unknown or already-verified email still reads as sent (no enumeration);
  // only a real send that Resend refused reports email_sent:false.
  let emailSent = true;
  // mail limits are charged only for a real send; over one, skip it
  // silently with the same answer.
  if (user && !user.email_verified && (await mayMail(env, 'verify', emailLower, request))) {
    emailSent = await sendVerificationEmail(user.id, emailLower, env);
  }
  return res({ ok: true, email_sent: emailSent, message: 'If that account exists and needs verification, an email has been sent.' }, 200, corsHeaders);
}

const BAD_CODE_MSG = "That code is invalid or expired. Already verified? Log in instead.";
const NEED_PW_MSG = 'Enter your password along with the code.';
const BAD_PW_MSG = "That password doesn't match this account.";

// POST /api/auth/verify-code  body: { email, code, password } — finish email
// verification with the 6-digit code. Rate-limited (codes are low-entropy) and
// single-use. Sets the session cookie on success so the user is logged in.
// The password is required: signup on an
// unverified row replaces its password, so without it someone who re-signed-up
// on the owner's address could ride the owner's code into an account whose
// password they chose. The code proves the inbox, the password proves who set it.
async function verifyCode(request, env, corsHeaders) {
  const csrf = checkOrigin(request, corsHeaders);
  if (csrf) return csrf;
  const { email, code, password } = (await readJson(request)) || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanCode = String(code || '').replace(/\D/g, '');
  if (!isValidEmail(cleanEmail) || cleanCode.length !== 6) return res({ error: 'Enter the 6-digit code from your email.' }, 400, corsHeaders);
  if (typeof password !== 'string' || !password || password.length > 200) return res({ error: NEED_PW_MSG }, 400, corsHeaders);
  // Throttle guesses: 8/min per email + 30/min per network, plus the wrong-code budget below.
  // The per-address cap is counted per network, so a stranger hammering this
  // route with someone else's address can't use up the owner's tries.
  const emailLimited = await rateLimit(request, env, 'verify-code', 8, 60, `verify-code:${cleanEmail}|${await netKey(env, request)}`, corsHeaders);
  if (emailLimited) return emailLimited;
  const ipLimited = await rateLimit(request, env, 'verify-code-ip', 30, 60, null, corsHeaders);
  if (ipLimited) return ipLimited;

  // Unknown email, already-verified email and wrong code all get this same
  // 400. A distinct "already verified" 409 told anyone which emails had
  // accounts.
  const badCode = () => res({ error: BAD_CODE_MSG }, 400, corsHeaders);
  const user = await env.DB.prepare('SELECT id, email, newsletter_consent, token_version, email_verified, password_hash FROM users WHERE email = ?').bind(cleanEmail).first();
  if (!user) return badCode();
  // Already verified → DON'T issue a session. Minting a token here just because
  // the email is verified would be a password-free login bypass. A session is
  // only issued on a real code match below.
  if (user.email_verified) return badCode();
  // Wrong-code budget, only for a real unverified account, so junk requests
  // naming an address with no pending signup can't use it up. It is counted
  // per account AND network, like the login lockout: someone guessing at
  // another person's code spends only their own network's tries, and the
  // owner's code keeps working from the owner's network. One network gets 5
  // misses per 30 minutes and 20 a day. All networks together get 100 a day
  // per account, so guessing spread across many networks stays hopeless
  // against a 6-digit code. Each try is reserved before the code is checked
  // (parallel guesses can't race past it) and a right code hands its try
  // back. Over budget answers the same generic 400.
  const net = await netKey(env, request);
  const missKeys = [[`verify-miss:${user.id}|${net}`, 5, 1800], [`verify-miss-day:${user.id}|${net}`, 20, 86400], [`verify-miss-all:${user.id}`, 100, 86400]];
  for (let k = 0; k < missKeys.length; k++) {
    if (await overLimit(env, missKeys[k][0], missKeys[k][1], missKeys[k][2])) {
      for (let b = 0; b < k; b++) await dropNewest(env, missKeys[b][0]);
      return badCode();
    }
  }
  // New rows are salted with the user id; legacyHash matches rows written before
  // the salt fix so in-flight codes still verify.
  const codeHash = await sha256Hex(user.id + ':' + cleanCode);
  const legacyHash = await sha256Hex(cleanCode);
  const now = Math.floor(Date.now() / 1000);
  // Scope the lookup to this user: a bare hash lookup would collide across users
  // who happen to share the same 6-digit code.
  const row = await env.DB.prepare('SELECT token FROM email_verification_tokens WHERE user_id=? AND token IN (?,?) AND used=0 AND expires_at > ?')
    .bind(user.id, codeHash, legacyHash, now).first();
  if (!row) return badCode();
  for (const [key] of missKeys) await dropNewest(env, key); // right code: not a miss
  // Checked only after a valid code, so a wrong password never reveals anything
  // the code holder didn't already know. No verify and no session on mismatch.
  if (!(await checkPw(password, String(user.password_hash || '')).catch(() => false))) return res({ error: BAD_PW_MSG }, 400, corsHeaders);
  // Atomic finish (one D1 batch = one transaction). The user row is verified
  // only if it still has the exact password hash and token_version we just
  // checked, is still unverified, and the code we matched is still unused and
  // live. The code is consumed only if that verify just happened. A re-signup,
  // resend or second verify landing in between changes 0 rows: generic 400,
  // no session.
  const tv = user.token_version ?? 0;
  const out = await env.DB.batch([
    env.DB.prepare('UPDATE users SET email_verified=1, verified_at=? WHERE id=? AND email_verified=0 AND password_hash=? AND COALESCE(token_version,0)=? AND EXISTS (SELECT 1 FROM email_verification_tokens WHERE user_id=? AND token=? AND used=0 AND expires_at > ?)')
      .bind(new Date().toISOString(), user.id, user.password_hash, tv, user.id, row.token, now),
    env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND token=? AND used=0 AND EXISTS (SELECT 1 FROM users WHERE id=? AND email_verified=1 AND password_hash=?)')
      .bind(user.id, row.token, user.id, user.password_hash),
  ]);
  const changed = (r) => !!(r && r.meta && r.meta.changes > 0);
  if (!changed(out[0]) || !changed(out[1])) return badCode();
  await env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND used=0').bind(user.id).run();
  const token = await mintSession(user.id, tv, env);
  return resWithSession({ user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, token, corsHeaders);
}

// Optional signup notification to the operator. Set SIGNUP_WEBHOOK_URL and
// SIGNUP_WEBHOOK_SECRET to get a POST on each signup (the secret rides in the
// X-Signup-Secret header). Must be awaited: an un-awaited fetch is cancelled when
// the response returns.
async function notifySignup(env, appName, email, appNewsletterConsent) {
  if (!env.SIGNUP_WEBHOOK_URL || !env.SIGNUP_WEBHOOK_SECRET) return;
  await fetch(env.SIGNUP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signup-Secret': env.SIGNUP_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      app_name: appName,
      email: (email || '').toLowerCase(),
      app_newsletter_consent: !!appNewsletterConsent,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}

async function login(request, env, corsHeaders) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const { email: rawEmail, password } = reqBody;
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res({ error: 'Invalid email or password' }, 401, corsHeaders);
  }
  // Enforce min 10 / max 200 length (long passwords burn CPU on PBKDF2).
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res({ error: 'Invalid email or password' }, 401, corsHeaders);
  }
  const DUMMY_HASH = 'pbkdf2:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
  // Wrong-password lockout (see Rate Limiting). The try is recorded before the
  // password check, so parallel guesses can't race past it. It is keyed by the
  // address typed, whether or not an account exists, so it reveals nothing.
  if (await passwordTryRefused(env, email, request)) {
    await secLog(env, request, 'login_fail', { email });
    return lockedOut(corsHeaders);
  }
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, newsletter_consent, token_version, email_verified FROM users WHERE email = ?'
  ).bind(email).first();
  const storedHash = user?.password_hash || DUMMY_HASH;
  const pwValid = await checkPw(password, storedHash);
  if (!user || !pwValid) {
    await secLog(env, request, 'login_fail', { email });
    return res({ error: 'Invalid email or password' }, 401, corsHeaders);
  }
  // Right password: take this try back out of both counters.
  await passwordTryOk(env, email, request);
  if (!user.email_verified) {
    return res({ error: 'Please verify your email before logging in.', code: 'email_not_verified', email: user.email }, 403, corsHeaders);
  }
  const token = await mintSession(user.id, user.token_version, env);
  await secLog(env, request, 'login_ok', { uid: user.id });
  return resWithSession({ user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, token, corsHeaders);
}

async function resetRequest(request, env, corsHeaders) {
  const { email } = (await readJson(request)) || {};
  if (!email || typeof email !== 'string' || !isValidEmail(email.trim().toLowerCase())) return res({ success: true }, 200, corsHeaders);
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(String(email).trim().toLowerCase()).first();
  if (!user) return res({ success: true }, 200, corsHeaders);
  // per-address cap + daily ceiling, charged only for this real send.
  // Over either, the same generic success with nothing sent.
  if (!(await mayMail(env, 'reset', email.trim().toLowerCase(), request))) return res({ success: true }, 200, corsHeaders);

  // Hash on write, raw token in email. DB never sees the raw token.
  const rawToken = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(rawToken);
  const expires = new Date(Date.now() + 3600000).toISOString();
  await env.DB.prepare('INSERT OR REPLACE INTO reset_tokens (token,user_id,expires_at,used) VALUES (?,?,?,0)')
    .bind(tokenHash, user.id, expires).run();

  if (!env.RESEND_API_KEY && devLogOn(env)) console.log('[dev] reset link:', `${APP_BASE}/reset/${rawToken}`);
  if (env.RESEND_API_KEY) {
    // /reset/<token>, NOT ?reset=<token>. Mail transfer agents quoted-printable
    // encode the body, and "=" is the QP escape character: the link arrives with
    // the "=" and the next two characters replaced by a control byte, so the
    // token is corrupted and a locked-out user can never get back in. Proven on
    // a real delivered email:
    //   sent    .../?reset=1a2b00f74d...
    //   arrived ...?reset\x041a00f74d...
    // A path segment has no "=" for QP to eat.
    const resetUrl = `${APP_BASE}/reset/${rawToken}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Emergency Fund Aquarium <onboarding@resend.dev>',
        to: String(email).trim().toLowerCase(),
        subject: 'Reset your Emergency Fund Aquarium password',
        text: `Reset your Emergency Fund Aquarium password\n\nOpen this link to reset your password. It expires in 1 hour.\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Reset your password',
          body: emailPara(EMAIL_THEME, 'Tap below to reset your Emergency Fund Aquarium password. This link expires in 1 hour.')
            + emailButton(EMAIL_THEME, resetUrl, 'Reset password')
            + emailSmall(EMAIL_THEME, "If you didn't request this, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    });
  }
  return res({ success: true }, 200, corsHeaders);
}

async function resetConfirm(request, env, corsHeaders) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const { token, password } = reqBody;
  // Enforce min 10 / max 200 password length on reset.
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res({ error: 'Password must be 10–200 characters.' }, 400, corsHeaders);
  }
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) {
    return res({ error: 'Invalid or expired reset link' }, 400, corsHeaders);
  }
  const tokenHash = await sha256Hex(token);
  const rt = await env.DB.prepare('SELECT token, user_id, expires_at, used FROM reset_tokens WHERE token=? AND used=0').bind(tokenHash).first();
  if (!rt || new Date(rt.expires_at) < new Date()) {
    return res({ error: 'Invalid or expired reset link' }, 400, corsHeaders);
  }
  const hash = await hashPw(password);
  // Claim the link in one statement: two requests racing with the same link
  // can't both get through. Then every other reset link for this user dies too.
  const claim = await env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE token=? AND used=0').bind(tokenHash).run();
  if (!claim || !claim.meta || !claim.meta.changes) return res({ error: 'Invalid or expired reset link' }, 400, corsHeaders);
  await env.DB.batch([
    // Opening the emailed link proved the inbox, so the account is verified too.
    env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1, email_verified=1, verified_at=COALESCE(verified_at, ?) WHERE id=?').bind(hash, new Date().toISOString(), rt.user_id),
    env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE user_id=?').bind(rt.user_id),
    env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=?').bind(rt.user_id),
  ]);
  const user = await env.DB.prepare('SELECT id,email,newsletter_consent,token_version FROM users WHERE id=?').bind(rt.user_id).first();
  if (!user) return res({ error: 'Invalid or expired reset link' }, 400, corsHeaders);
  // The owner proved the inbox, so earlier wrong-password counts are cleared.
  await clearPasswordTries(env, String(user.email).toLowerCase());
  await secLog(env, request, 'password_reset', { uid: rt.user_id });
  const jwt = await mintSession(user.id, user.token_version, env);
  return resWithSession({ user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, jwt, corsHeaders);
}

// ── Profile routes ──────────────────────────────────────────────────────────

async function getProfile(uid, env, corsHeaders) {
  const u = await env.DB.prepare('SELECT id,email,currency,newsletter_consent FROM users WHERE id=?').bind(uid).first();
  if (!u) return res({ error: 'Not found' }, 404, corsHeaders);
  return res({ id: u.id, email: u.email, currency: u.currency, newsletter_consent: u.newsletter_consent === 1 }, 200, corsHeaders);
}

async function updateProfile(uid, request, env, corsHeaders) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const sets = [], vals = [];
  if ('currency' in body) {
    if (typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) return res({ error: 'Invalid currency' }, 400, corsHeaders);
    sets.push('currency=?'); vals.push(body.currency);
  }
  if ('newsletter_consent' in body) {
    sets.push('newsletter_consent=?'); vals.push(body.newsletter_consent ? 1 : 0);
    sets.push('newsletter_consent_at=?'); vals.push(body.newsletter_consent ? new Date().toISOString() : null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...vals, uid).run();
  return res({ success: true }, 200, corsHeaders);
}

async function changePassword(uid, request, env, corsHeaders) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const { current_password, password } = reqBody;
  if (!current_password || typeof current_password !== 'string' || current_password.length > 200) return res({ error: 'Current password required' }, 400, corsHeaders);
  // Enforce min 10 / max 200 on new password.
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    return res({ error: 'Password must be 10–200 characters.' }, 400, corsHeaders);
  }
  const user = await env.DB.prepare('SELECT email, password_hash FROM users WHERE id=?').bind(uid).first();
  if (!user) return res({ error: 'Account not found.' }, 404, corsHeaders);
  // Shares the login lockout, so a stolen session can't be used to guess the password.
  const emailLower = String(user.email).toLowerCase();
  if (await passwordTryRefused(env, emailLower, request)) return lockedOut(corsHeaders);
  if (!await checkPw(current_password, user.password_hash)) {
    return res({ error: 'Current password is incorrect' }, 401, corsHeaders);
  }
  await passwordTryOk(env, emailLower, request);
  await env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').bind(await hashPw(password), uid).run();
  await secLog(env, request, 'password_change', { uid });
  // The bump revokes every old session, including this one. Hand back a fresh
  // token so the person who just changed their password stays logged in.
  const fresh = await env.DB.prepare('SELECT token_version FROM users WHERE id=?').bind(uid).first();
  const token = await mintSession(uid, fresh?.token_version, env);
  return resWithSession({ success: true }, token, corsHeaders);
}

// Account deletion now requires a fresh proof, so a stolen session alone
// can't wipe data. The proof is the account's current password.
// Also wipe email_verification_tokens for the user.
async function deleteAccount(uid, request, env, corsHeaders) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const user = await env.DB.prepare('SELECT email, password_hash FROM users WHERE id=?').bind(uid).first();
  if (!user) return res({ error: 'Account not found.' }, 404, corsHeaders);
  const currentPassword = body.current_password;
  if (!currentPassword || typeof currentPassword !== 'string' || currentPassword.length > 200) {
    return res({ error: 'Password is required to delete your account.' }, 400, corsHeaders);
  }
  // Shares the login lockout, so a stolen session can't be used to guess the password.
  if (await passwordTryRefused(env, String(user.email).toLowerCase(), request)) return lockedOut(corsHeaders);
  const ok = await checkPw(currentPassword, user.password_hash);
  if (!ok) return res({ error: 'Password is incorrect.' }, 401, corsHeaders);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM deposits WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM goals WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM achievements WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid),
  ]);
  await clearPasswordTries(env, String(user.email).toLowerCase());
  await secLog(env, request, 'account_delete', { uid });
  const out = res({ success: true }, 200, corsHeaders);
  out.headers.append('Set-Cookie', clearSessionCookie());
  return out;
}

// GDPR Right to Access. Streams the account's own data (no password hash) as a
// downloadable JSON file.
async function exportAccount(uid, env, corsHeaders) {
  const user = await env.DB.prepare(
    'SELECT id, email, currency, newsletter_consent, newsletter_consent_at, created_at FROM users WHERE id=?'
  ).bind(uid).first();
  if (!user) return res({ error: 'Account not found.' }, 404, corsHeaders);
  const goals = await env.DB.prepare(
    'SELECT id, name, target_amount, is_active, created_at, biome, completed_at FROM goals WHERE user_id=?'
  ).bind(uid).all();
  const deposits = await env.DB.prepare(
    'SELECT id, goal_id, amount, note, deposit_date, created_at FROM deposits WHERE user_id=?'
  ).bind(uid).all();
  const achievements = await env.DB.prepare(
    'SELECT goal_id, key, unlocked_at FROM achievements WHERE user_id=?'
  ).bind(uid).all();

  const payload = {
    export_metadata: {
      generated_at: new Date().toISOString(),
      data_controller: 'YOUR COMPANY NAME',
      contact: 'privacy@example.com',
      app: 'Emergency Fund Aquarium',
    },
    user,
    goals: goals.results || [],
    deposits: deposits.results || [],
    achievements: achievements.results || [],
  };
  const filename = `emergency-fund-aquarium-export-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// ── Goals routes ────────────────────────────────────────────────────────────

async function getGoals(uid, env, corsHeaders) {
  const r = await env.DB.prepare(
    'SELECT id, user_id, name, target_amount, is_active, created_at, biome, completed_at FROM goals WHERE user_id=? ORDER BY is_active DESC, created_at DESC'
  ).bind(uid).all();
  return res(r.results || [], 200, corsHeaders);
}

// Atomic 1-goal cap for free tier. We let SQL do the count + insert in
// a single statement so two concurrent POSTs can't both pass the check. Pro
// users bypass the WHERE clause entirely.
const MAX_GOALS = 200;
async function addGoal(uid, request, env, corsHeaders) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const name = body.name ?? 'Emergency Fund';
  const target_amount = body.target_amount;
  if (typeof target_amount !== 'number' || !isFinite(target_amount) || target_amount <= 0 || target_amount > 10000000) {
    return res({ error: 'Target amount must be a positive number under 10,000,000' }, 400, corsHeaders);
  }
  if (typeof name !== 'string' || name.length > 200) return res({ error: 'Invalid name' }, 400, corsHeaders);

  // Most goals one account can hold, finished ones included, so a single
  // account can't fill the database by creating and completing goals in a loop.
  // The per-account write limit bounds any overshoot from parallel requests.
  const held = await env.DB.prepare('SELECT COUNT(*) AS n FROM goals WHERE user_id=?').bind(uid).first();
  if ((held?.n ?? 0) >= MAX_GOALS) {
    return res({ error: `You've reached ${MAX_GOALS} goals, the most one account can hold. Delete an old one to add another.` }, 400, corsHeaders);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const isPro = hasProAccess();

  let biome = typeof body.biome === 'string' ? body.biome : 'ocean';
  if (!ALL_BIOMES.includes(biome)) biome = 'ocean';
  if (!isPro && !FREE_BIOMES.includes(biome)) {
    return res(PRO_BIOMES_402, 402, corsHeaders);
  }

  if (isPro) {
    await env.DB.prepare(
      'INSERT INTO goals (id,user_id,name,target_amount,is_active,created_at,biome) VALUES (?,?,?,?,1,?,?)'
    ).bind(id, uid, name, target_amount, now, biome).run();
    return res({ id, name, target_amount, is_active: 1, created_at: now, biome }, 200, corsHeaders);
  }

  // Free plan: atomic INSERT...SELECT WHERE active-goal count < FREE_GOALS.
  // Two concurrent requests cannot both succeed because SQLite serializes
  // writes; the second sees the first row already present and inserts 0 rows.
  const result = await env.DB.prepare(
    `INSERT INTO goals (id, user_id, name, target_amount, is_active, created_at, biome)
     SELECT ?, ?, ?, ?, 1, ?, ?
     WHERE (SELECT COUNT(*) FROM goals WHERE user_id = ? AND is_active = 1) < ?`
  ).bind(id, uid, name, target_amount, now, biome, uid, FREE_GOALS).run();

  const changes = result?.meta?.changes ?? result?.changes ?? 0;
  if (changes !== 1) {
    return res({
      error: 'Pro required',
      feature: 'unlimited-goals',
    }, 402, corsHeaders);
  }
  return res({ id, name, target_amount, is_active: 1, created_at: now, biome }, 200, corsHeaders);
}

async function updateGoal(uid, goalId, request, env, corsHeaders) {
  const existing = await env.DB.prepare('SELECT id, biome FROM goals WHERE id=? AND user_id=?').bind(goalId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, corsHeaders);
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  if ('target_amount' in body) {
    const n = body.target_amount;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n > 10000000) return res({ error: 'Invalid target_amount' }, 400, corsHeaders);
  }
  if ('name' in body && (typeof body.name !== 'string' || body.name.length > 200)) return res({ error: 'Invalid name' }, 400, corsHeaders);
  const sets = [], vals = [];
  if ('name' in body) { sets.push('name=?'); vals.push(body.name); }
  if ('target_amount' in body) { sets.push('target_amount=?'); vals.push(body.target_amount); }
  if ('biome' in body) {
    const b = body.biome;
    if (typeof b !== 'string' || !ALL_BIOMES.includes(b)) return res({ error: 'Invalid biome' }, 400, corsHeaders);
    // Grandfather rule: a goal that predates Pro biomes (stored biome still
    // NULL) may be stamped once with whichever legacy biome its owner had
    // picked locally, Pro or not. Everything else goes through the Pro gate.
    const isGrandfather = existing.biome === null && LEGACY_BIOMES.includes(b);
    if (!isGrandfather && !hasProAccess() && !FREE_BIOMES.includes(b)) {
      return res(PRO_BIOMES_402, 402, corsHeaders);
    }
    sets.push('biome=?'); vals.push(b);
  }
  if (sets.length) await env.DB.prepare(`UPDATE goals SET ${sets.join(',')} WHERE id=? AND user_id=?`).bind(...vals, goalId, uid).run();
  return res({ success: true }, 200, corsHeaders);
}

async function completeGoal(uid, goalId, env, corsHeaders) {
  const existing = await env.DB.prepare('SELECT id FROM goals WHERE id=? AND user_id=? AND is_active=1').bind(goalId, uid).first();
  if (!existing) return res({ error: 'Not found or already completed' }, 404, corsHeaders);
  const now = new Date().toISOString();
  await env.DB.prepare('UPDATE goals SET is_active=0, completed_at=? WHERE id=? AND user_id=?').bind(now, goalId, uid).run();
  const goal = await env.DB.prepare('SELECT id, name, target_amount, biome, is_active, completed_at FROM goals WHERE id=? AND user_id=?').bind(goalId, uid).first();
  return res({ success: true, goal }, 200, corsHeaders);
}

async function deleteGoal(uid, goalId, env, corsHeaders) {
  const existing = await env.DB.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(goalId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, corsHeaders);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM deposits WHERE goal_id=? AND user_id=?').bind(goalId, uid),
    env.DB.prepare('DELETE FROM achievements WHERE goal_id=? AND user_id=?').bind(goalId, uid),
    env.DB.prepare('DELETE FROM goals WHERE id=? AND user_id=?').bind(goalId, uid),
  ]);
  return res({ success: true }, 200, corsHeaders);
}

// ── Deposits routes ────────────────────────────────────────────────────────

async function getDeposits(uid, url, env, corsHeaders) {
  const goalId = url.searchParams.get('goal_id');
  let query, binds;
  if (goalId) {
    query = 'SELECT id, user_id, goal_id, amount, note, deposit_date, created_at FROM deposits WHERE user_id=? AND goal_id=? ORDER BY deposit_date DESC';
    binds = [uid, goalId];
  } else {
    // Get deposits for active goal
    const active = await env.DB.prepare('SELECT id FROM goals WHERE user_id=? AND is_active=1').bind(uid).first();
    if (!active) return res([], 200, corsHeaders);
    query = 'SELECT id, user_id, goal_id, amount, note, deposit_date, created_at FROM deposits WHERE user_id=? AND goal_id=? ORDER BY deposit_date DESC';
    binds = [uid, active.id];
  }
  const r = await env.DB.prepare(query).bind(...binds).all();
  return res(r.results || [], 200, corsHeaders);
}

// A real calendar date as YYYY-MM-DD.
function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

// Most deposits one account can hold, so a single account can't fill the database.
const MAX_DEPOSITS = 5000;
async function addDeposit(uid, request, env, corsHeaders) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  const { goal_id, amount, deposit_date, note } = reqBody;
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || amount > 1000000) {
    return res({ error: 'Amount must be a positive number under 1,000,000' }, 400, corsHeaders);
  }
  if (note && (typeof note !== 'string' || note.length > 2000)) return res({ error: 'note too long' }, 400, corsHeaders);
  if (goal_id !== undefined && goal_id !== null && (typeof goal_id !== 'string' || goal_id.length > 64)) return res({ error: 'Invalid goal_id' }, 400, corsHeaders);
  if (deposit_date !== undefined && deposit_date !== null && deposit_date !== '' && !isValidDate(deposit_date)) return res({ error: 'deposit_date must be YYYY-MM-DD' }, 400, corsHeaders);
  // If no goal_id, use active goal
  let gid = goal_id;
  if (!gid) {
    const active = await env.DB.prepare('SELECT id FROM goals WHERE user_id=? AND is_active=1').bind(uid).first();
    if (!active) return res({ error: 'No active goal. Create a goal first.' }, 400, corsHeaders);
    gid = active.id;
  }
  // Verify goal belongs to user
  const goal = await env.DB.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(gid, uid).first();
  if (!goal) return res({ error: 'Goal not found' }, 404, corsHeaders);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const date = deposit_date || now.slice(0, 10);
  // Count and insert in one statement, so parallel requests can't pass the cap.
  const added = await env.DB.prepare(
    `INSERT INTO deposits (id,user_id,goal_id,amount,note,deposit_date,created_at)
     SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM deposits WHERE user_id=?) < ?`
  ).bind(id, uid, gid, amount, note || null, date, now, uid, MAX_DEPOSITS).run();
  if ((added?.meta?.changes ?? 0) !== 1) {
    return res({ error: `You've reached ${MAX_DEPOSITS.toLocaleString('en-US')} deposits, the most one account can hold. Delete some old ones in History to add more.` }, 400, corsHeaders);
  }
  return res({ id, goal_id: gid, amount, note, deposit_date: date, created_at: now }, 200, corsHeaders);
}

async function updateDeposit(uid, depId, request, env, corsHeaders) {
  const existing = await env.DB.prepare('SELECT id FROM deposits WHERE id=? AND user_id=?').bind(depId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, corsHeaders);
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, corsHeaders);
  if ('amount' in body) {
    const n = body.amount;
    if (typeof n !== 'number' || !isFinite(n) || n <= 0 || n > 1000000) return res({ error: 'Invalid amount' }, 400, corsHeaders);
  }
  if ('note' in body && body.note && (typeof body.note !== 'string' || body.note.length > 2000)) return res({ error: 'note too long' }, 400, corsHeaders);
  if ('deposit_date' in body && !isValidDate(body.deposit_date)) return res({ error: 'deposit_date must be YYYY-MM-DD' }, 400, corsHeaders);
  const sets = [], vals = [];
  for (const field of ['amount', 'deposit_date', 'note']) {
    if (field in body) { sets.push(`${field}=?`); vals.push(body[field]); }
  }
  if (sets.length) await env.DB.prepare(`UPDATE deposits SET ${sets.join(',')} WHERE id=? AND user_id=?`).bind(...vals, depId, uid).run();
  return res({ success: true }, 200, corsHeaders);
}

async function deleteDeposit(uid, depId, env, corsHeaders) {
  const existing = await env.DB.prepare('SELECT id FROM deposits WHERE id=? AND user_id=?').bind(depId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, corsHeaders);
  await env.DB.prepare('DELETE FROM deposits WHERE id=? AND user_id=?').bind(depId, uid).run();
  return res({ success: true }, 200, corsHeaders);
}

// ── Achievements ───────────────────────────────────────────
// Server-side record of milestone + fish-dex unlocks so progress survives
// device switches. Idempotent: UNIQUE(user_id, goal_id, key) + INSERT OR IGNORE.
const MILESTONE_KEYS = ['first-drop', 'ten-pct', 'quarter', 'halfway', 'three-quarter', 'goal-reached'];
function isValidAchievementKey(key) {
  if (typeof key !== 'string' || key.length > 60) return false;
  if (MILESTONE_KEYS.includes(key)) return true;
  return /^creature:[a-z]{2,30}$/.test(key);
}

async function getAchievements(uid, env, corsHeaders) {
  const r = await env.DB.prepare('SELECT goal_id, key, unlocked_at FROM achievements WHERE user_id=?').bind(uid).all();
  return res({ achievements: r.results || [] }, 200, corsHeaders);
}

// 49 creatures plus a handful of milestones per goal fits many times over.
const MAX_ACHIEVEMENTS = 2000;
async function addAchievements(uid, request, env, corsHeaders) {
  const body = (await readJson(request)) || {};
  const goalId = typeof body.goal_id === 'string' && body.goal_id.length <= 64 ? body.goal_id : '';
  const keys = Array.isArray(body.keys) ? body.keys.filter(isValidAchievementKey).slice(0, 40) : [];
  if (!keys.length) return res({ ok: true, added: 0 }, 200, corsHeaders);
  // Milestone keys must reference the caller's own goal; creature keys are user-level ('').
  if (goalId) {
    const g = await env.DB.prepare('SELECT id FROM goals WHERE id=? AND user_id=?').bind(goalId, uid).first();
    if (!g) return res({ error: 'Goal not found' }, 404, corsHeaders);
  }
  const now = new Date().toISOString();
  await env.DB.batch(keys.map(k =>
    // Count and insert in one statement: an account holds at most MAX_ACHIEVEMENTS rows.
    env.DB.prepare('INSERT OR IGNORE INTO achievements (id, user_id, goal_id, key, unlocked_at) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM achievements WHERE user_id=?) < ?')
      .bind(crypto.randomUUID(), uid, goalId, k, now, uid, MAX_ACHIEVEMENTS)
  ));
  return res({ ok: true, added: keys.length }, 200, corsHeaders);
}
