-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  newsletter_consent INTEGER DEFAULT 0,
  newsletter_consent_at TEXT,
  currency TEXT DEFAULT 'USD',
  created_at TEXT NOT NULL
, token_version INTEGER DEFAULT 0, email_verified INTEGER DEFAULT 0, verified_at TEXT);
CREATE TABLE reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Emergency Fund',
  target_amount REAL NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  deposit_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE email_verification_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_goals_user ON goals(user_id);
CREATE INDEX idx_deposits_user ON deposits(user_id);
CREATE INDEX idx_deposits_goal ON deposits(goal_id);
CREATE INDEX idx_reset_tokens_user ON reset_tokens(user_id);
CREATE INDEX idx_rate_limits_key ON rate_limits(key, created_at);
CREATE INDEX idx_email_verification_tokens_user ON email_verification_tokens(user_id);
