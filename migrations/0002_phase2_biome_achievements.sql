-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
-- Biome + graduation on goals; server-side achievements.
-- goals.biome stays NULL for older goals until the client's one-time
-- migration push stamps it (NULL is the grandfather sentinel — see worker).
ALTER TABLE goals ADD COLUMN biome TEXT;
ALTER TABLE goals ADD COLUMN completed_at TEXT;

CREATE TABLE IF NOT EXISTS achievements (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal_id TEXT NOT NULL DEFAULT '',
  key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  UNIQUE(user_id, goal_id, key)
);
CREATE INDEX IF NOT EXISTS idx_achievements_user ON achievements(user_id);
