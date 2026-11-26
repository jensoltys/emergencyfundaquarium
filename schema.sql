-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
-- Emergency Fund Aquarium — D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  newsletter_consent INTEGER DEFAULT 0,
  newsletter_consent_at TEXT,
  currency TEXT DEFAULT 'USD',
  token_version INTEGER DEFAULT 0,
  email_verified INTEGER DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

-- reset_tokens stores SHA-256(raw_token) as the PK so a DB snapshot leak does
-- not directly compromise pending password resets. Raw token is emailed once.
CREATE TABLE IF NOT EXISTS reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

-- email_verification_tokens mirrors reset_tokens: PK is SHA-256(raw_token).
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT 'Emergency Fund',
  target_amount REAL NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  biome TEXT,           -- NULL = older goal awaiting client migration (grandfather sentinel)
  completed_at TEXT     -- set when the goal is graduated to the trophy shelf
);

-- Server-side record of milestone + fish-dex unlocks. Milestone rows
-- carry the goal_id; creature rows are user-level with goal_id=''.
CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  UNIQUE(user_id, goal_id, key)
);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  deposit_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_goal ON deposits(goal_id);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, created_at);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);

-- Daily email ceilings (migrations/0003_email_daily.sql).
CREATE TABLE IF NOT EXISTS email_daily (
  k   TEXT NOT NULL,
  day TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);
