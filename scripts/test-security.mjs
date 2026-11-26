// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
// Security regression scanner. Runs as a pre-deploy gate.
// Every time a security audit surfaces a finding, we add a check here so the
// same class of issue can't silently regress in a future change.
//
// Run: node scripts/test-security.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'vendor' || entry === 'node_modules' || entry === '.wrangler' || entry === 'dist' || entry === 'build') continue;
      listFiles(full, exts, out);
    } else if (exts.some(e => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function flag(severity, file, line, rule, detail) {
  findings.push({ severity, file: relative(repoRoot, file), line, rule, detail });
}

// ── Source code checks (src/) ──────────────────────────────────────────────
const srcFiles = listFiles(join(repoRoot, 'src'), ['.js']);

for (const f of srcFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // SELECT * — never allowed; columns must be explicit.
    if (/\bSELECT\s+\*/i.test(line) && !/--.*SELECT \*/i.test(line)) {
      flag('HIGH', f, ln, 'SELECT *', 'Explicitly list columns. Prevents leaking new sensitive columns added later (e.g. password_hash, token_version).');
    }

    // CORS wildcard.
    if (/Access-Control-Allow-Origin['"\s:,]+\*/.test(line)) {
      flag('HIGH', f, ln, 'CORS wildcard', 'Origin allowlist is required when credentials are sent. Never `*`.');
    }

    // Hardcoded secret patterns.
    if (/sk-ant-api03-[A-Za-z0-9_-]{20,}/.test(line)) flag('HIGH', f, ln, 'hardcoded ANTHROPIC key', 'Move to wrangler secret.');
    if (/\bre_[A-Za-z0-9]{20,}/.test(line))            flag('HIGH', f, ln, 'hardcoded RESEND key', 'Move to wrangler secret.');
    if (/sk_live_[A-Za-z0-9]{20,}/.test(line))         flag('HIGH', f, ln, 'hardcoded STRIPE live key', 'Move to wrangler secret.');
    if (/sk-[A-Za-z0-9]{40,}/.test(line) && !/sk-ant/.test(line)) flag('HIGH', f, ln, 'hardcoded OpenAI-shaped key', 'Move to wrangler secret.');
    if (/xox[baprs]-[A-Za-z0-9-]{20,}/.test(line))     flag('HIGH', f, ln, 'hardcoded Slack token', 'Move to secret store.');
    if (/AIza[A-Za-z0-9_-]{30,}/.test(line))           flag('HIGH', f, ln, 'hardcoded Google API key', 'Move to secret store.');
    if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(line)) flag('HIGH', f, ln, 'hardcoded GitHub PAT', 'Move to secret store.');

    // localStorage with explicit sensitive label.
    if (/(localStorage|sessionStorage)\.setItem\s*\(\s*['"`][^'"`]*(password|api[_-]?key|secret|credit|card|ssn)/i.test(line)) {
      flag('HIGH', f, ln, 'sensitive data in browser storage', 'Use HttpOnly cookies for secrets; never localStorage.');
    }

    // 429 without Retry-After (warn — we use a generic message handler).
    if (/\bstatus\s*[:=]\s*429\b/.test(line) || /\.status\(429\)/.test(line) || /,\s*429\b/.test(line)) {
      const window = lines.slice(Math.max(0, idx - 5), Math.min(lines.length, idx + 10)).join('\n');
      if (!/Retry-After/i.test(window)) {
        flag('MEDIUM', f, ln, '429 without Retry-After', 'Add Retry-After header so clients know when to retry.');
      }
    }
  });

  // Module-level mutable CORS state — the race we just fixed.
  // Per-request buildCors() is required; never `let CORS = {}` at module scope.
  if (/^\s*let\s+CORS\s*=/m.test(content) || /^\s*let\s+_cors\s*=/m.test(content)) {
    flag('HIGH', f, 0, 'module-level CORS state', 'Use per-request buildCors(request) so concurrent requests on the same isolate don\'t race.');
  }

  // Password length minimum < 10.
  // Look for explicit < 10 checks; a `< 6` check is a regression.
  const lt6 = content.match(/password.{0,40}\.length\s*<\s*(\d+)/gi);
  if (lt6) {
    for (const m of lt6) {
      const n = parseInt((m.match(/<\s*(\d+)/) || [])[1] || '0', 10);
      if (n > 0 && n < 10) {
        flag('HIGH', f, 0, 'password min < 10', `Audit requires min 10 chars (found "${m}"). Bump to 10 in all auth handlers.`);
      }
    }
  }

  // Raw reset / verification token write.
  // We require sha256Hex(rawToken) before INSERT INTO reset_tokens or
  // INSERT INTO email_verification_tokens.
  if (/INSERT\s+(OR\s+REPLACE\s+)?INTO\s+reset_tokens/i.test(content) && !/sha256Hex/.test(content)) {
    flag('HIGH', f, 0, 'plaintext reset token storage', 'Store SHA-256(token) in DB; email the raw token. See sha256Hex().');
  }
  if (/INSERT\s+INTO\s+email_verification_tokens/i.test(content) && !/sha256Hex/.test(content)) {
    flag('HIGH', f, 0, 'plaintext email-verification token storage', 'Store SHA-256(token) in DB; email the raw token.');
  }

  // CSP `'unsafe-inline'` for scripts. Style is acceptable for this app right
  // now. Track removal separately.
  // (Intentionally NOT flagging style unsafe-inline here.)
}

// ── HTML asset checks (public/) ────────────────────────────────────────────
const htmlFiles = listFiles(join(repoRoot, 'public'), ['.html']);

for (const f of htmlFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // target=_blank without rel=noopener.
    const linkRe = /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi;
    const matches = line.match(linkRe);
    if (matches) {
      for (const tag of matches) {
        if (!/\brel\s*=\s*["'][^"']*\bnoopener\b/i.test(tag)) {
          flag('LOW', f, ln, 'target=_blank without rel=noopener', tag.slice(0, 80));
        }
      }
    }

    // Password input with minlength < 10.
    const pwInput = line.match(/<input\b[^>]*type\s*=\s*["']password["'][^>]*>/gi);
    if (pwInput) {
      for (const tag of pwInput) {
        const m = tag.match(/minlength\s*=\s*["'](\d+)["']/i);
        const min = m ? parseInt(m[1], 10) : 0;
        if (!m || min < 10) {
          flag('HIGH', f, ln, 'password input minlength < 10', `Audit requires minlength="10" (found "${m ? m[0] : 'no minlength'}").`);
        }
      }
    }

    // Newsletter / marketing consent checkbox default-checked — GDPR violation.
    const checkboxMatches = line.match(/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>/gi);
    if (checkboxMatches) {
      for (const tag of checkboxMatches) {
        if (/\b(newsletter|marketing|subscribe|opt[-_]?in|promo)\b/i.test(tag) && /\bchecked\b/i.test(tag)) {
          flag('HIGH', f, ln, 'consent checkbox default-checked', 'Pre-checked consent boxes violate GDPR/ePrivacy. Default unchecked.');
        }
      }
    }

    // Stripe price_id rendered in HTML.
    if (/price_[A-Za-z0-9]{14,}/.test(line)) {
      flag('HIGH', f, ln, 'Stripe price_id in HTML', 'Server should choose price_id by tier name, never trust client.');
    }
  });
}

// ── Legal pages must exist ─────────────────────
for (const required of ['public/legal/privacy.html', 'public/legal/terms.html', 'public/legal/do-not-sell.html']) {
  if (!existsSync(join(repoRoot, required))) {
    flag('HIGH', join(repoRoot, required), 0, 'missing legal page', `Required page ${required} not found.`);
  }
}

// ── Schema completeness ─────────────────────────────────
const schemaPath = join(repoRoot, 'schema.sql');
if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, 'utf8');
  for (const tbl of ['users', 'reset_tokens', 'email_verification_tokens', 'goals', 'deposits', 'rate_limits']) {
    if (!new RegExp('CREATE TABLE[^;]*\\b' + tbl + '\\b', 'i').test(schema)) {
      flag('HIGH', schemaPath, 0, 'schema missing table', `${tbl} table missing from schema.sql.`);
    }
  }
  for (const col of ['token_version', 'email_verified', 'verified_at']) {
    if (!new RegExp('\\b' + col + '\\b', 'i').test(schema)) {
      flag('HIGH', schemaPath, 0, 'schema missing column', `users.${col} missing from schema.sql.`);
    }
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(`   scanned ${srcFiles.length} src + ${htmlFiles.length} html files, no security regressions found`);
  process.exit(0);
}

const high = findings.filter(f => f.severity === 'HIGH');
const med  = findings.filter(f => f.severity === 'MEDIUM');
const low  = findings.filter(f => f.severity === 'LOW');

console.error(`   x security scan: ${high.length} HIGH, ${med.length} MEDIUM, ${low.length} LOW`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`     [${f.severity}] ${where}  '${f.rule}'  - ${f.detail}`);
}

// Block the deploy on HIGH; warn-only on MEDIUM/LOW.
if (high.length > 0) process.exit(1);
console.error('   (warnings only - deploy continues)');
process.exit(0);
