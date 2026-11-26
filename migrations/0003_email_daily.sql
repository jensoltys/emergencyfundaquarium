-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Emergency Fund Aquarium authors. See LICENSE.
-- Daily email ceilings. One row per key per
-- UTC day, bumped atomically with INSERT ... ON CONFLICT DO UPDATE ... RETURNING n.
-- Keys: 'mail:reset' (password-reset mail) and 'mail:verify' (signup + resend
-- verification mail). Old days are deleted on the first hit of a new day and by
-- the daily purge cron.
CREATE TABLE IF NOT EXISTS email_daily (
  k   TEXT NOT NULL,
  day TEXT NOT NULL,
  n   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);
