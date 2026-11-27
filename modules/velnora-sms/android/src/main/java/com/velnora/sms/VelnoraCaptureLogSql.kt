package com.velnora.sms

/**
 * SQL for the local capture log, kept apart so the JS test suite can run these exact statements against SQLite
 * (src/services/__tests__/captureLog.test.ts reads this file). Keep each statement as one `const val NAME = """..."""`.
 *
 * The table has no column that could hold a message body, an amount, a name or an account id, and it is never synced.
 */
object VelnoraCaptureLogSql {
  const val CREATE_LOG = """CREATE TABLE IF NOT EXISTS capture_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, origin TEXT NOT NULL, stage TEXT NOT NULL, result TEXT NOT NULL, reason TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 1)"""

  /** Staged events already reported as held, so each is logged once. */
  const val CREATE_HOLD_SEEN = """CREATE TABLE IF NOT EXISTS capture_hold_seen (staging_id INTEGER PRIMARY KEY)"""

  /** Params: new time, source, origin, stage, result, reason, oldest time that still counts as "the same entry". */
  const val COALESCE = """UPDATE capture_log SET count = count + 1, at = ? WHERE id = (SELECT id FROM capture_log WHERE source = ? AND origin = ? AND stage = ? AND result = ? AND reason = ? AND at >= ? ORDER BY id DESC LIMIT 1)"""

  const val INSERT = """INSERT INTO capture_log (at, source, origin, stage, result, reason) VALUES (?, ?, ?, ?, ?, ?)"""

  /** Params: cut-off time, number of rows to keep. */
  const val PRUNE = """DELETE FROM capture_log WHERE at < ? OR id NOT IN (SELECT id FROM capture_log ORDER BY at DESC, id DESC LIMIT ?)"""

  const val READ = """SELECT at, source, origin, stage, result, reason, count FROM capture_log ORDER BY at DESC, id DESC"""

  const val CLEAR = """DELETE FROM capture_log"""
}
