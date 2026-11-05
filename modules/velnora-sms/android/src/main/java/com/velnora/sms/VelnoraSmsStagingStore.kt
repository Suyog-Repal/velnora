package com.velnora.sms

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Durable, app-private staging of received SMS events. Independent of React Native / Expo bridge
 * lifetime, so events survive process death. JS claims rows with a lease, processes them into the
 * app's SQLite database, then completes them. Bodies are wiped on completion (tombstone kept for dedupe).
 *
 * States: STAGED -> PROCESSING -> COMPLETED | RETRY -> PROCESSING ... | DEAD
 * Never log sender/body/amount here.
 */
class VelnoraSmsStagingStore private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "velnora_sms_staging.db", null, 1) {

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """CREATE TABLE sms_staging (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        owner_user_id TEXT,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )""",
    )
    db.execSQL("CREATE INDEX idx_sms_staging_owner_state ON sms_staging(owner_user_id, state)")
    db.execSQL("CREATE TABLE staging_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // Forward-only; v1 is the first version.
  }

  /** Returns the new row id, or -1 if this broadcast was already staged (durable dedupe). */
  @Synchronized
  fun stage(sender: String, body: String, receivedAt: Long, partCount: Int): Long {
    val db = writableDatabase
    val now = System.currentTimeMillis()
    val values = ContentValues().apply {
      put("dedupe_key", "$sender:$receivedAt:$partCount")
      put("sender", sender)
      put("body", body)
      put("received_at", receivedAt)
      put("part_count", partCount)
      put("owner_user_id", ownerHintLocked(db))
      put("state", "STAGED")
      put("created_at", now)
      put("updated_at", now)
    }
    val id = db.insertWithOnConflict("sms_staging", null, values, SQLiteDatabase.CONFLICT_IGNORE)
    pruneLocked(db, now)
    return id
  }

  @Synchronized
  fun setOwnerHint(userId: String) {
    writableDatabase.execSQL(
      "INSERT INTO staging_meta (k, v) VALUES ('owner_hint', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      arrayOf(userId),
    )
  }

  private fun ownerHintLocked(db: SQLiteDatabase): String? =
    db.rawQuery("SELECT v FROM staging_meta WHERE k = 'owner_hint'", null).use { c ->
      if (c.moveToFirst()) c.getString(0) else null
    }

  @Synchronized
  fun claim(owner: String, limit: Int, now: Long, leaseMs: Long, maxAttempts: Int): List<Map<String, Any?>> {
    val db = writableDatabase
    val out = ArrayList<Map<String, Any?>>()
    db.beginTransaction()
    try {
      val dueClause =
        "owner_user_id = ? AND ((state IN ('STAGED','RETRY') AND next_retry_at <= ?) OR (state = 'PROCESSING' AND lease_until < ?))"
      // Crash-looping events (lease expired repeatedly) stop at maxAttempts instead of retrying forever.
      db.execSQL(
        "UPDATE sms_staging SET state = 'DEAD', last_error = 'max_attempts', updated_at = ? WHERE $dueClause AND attempts >= ?",
        arrayOf(now, owner, now, now, maxAttempts),
      )
      db.rawQuery(
        "SELECT id, sender, body, received_at, part_count, attempts FROM sms_staging WHERE $dueClause ORDER BY received_at ASC LIMIT ?",
        arrayOf(owner, now.toString(), now.toString(), limit.toString()),
      ).use { c ->
        while (c.moveToNext()) {
          out.add(
            mapOf(
              "id" to c.getLong(0),
              "sender" to c.getString(1),
              "body" to c.getString(2),
              "receivedAt" to c.getLong(3),
              "partCount" to c.getInt(4),
              "attempts" to c.getInt(5) + 1,
            ),
          )
        }
      }
      for (row in out) {
        db.execSQL(
          "UPDATE sms_staging SET state = 'PROCESSING', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ?",
          arrayOf(now + leaseMs, now, row["id"]),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return out
  }

  @Synchronized
  fun complete(id: Long) {
    writableDatabase.execSQL(
      "UPDATE sms_staging SET state = 'COMPLETED', body = '', sender = '', last_error = NULL, updated_at = ? WHERE id = ?",
      arrayOf(System.currentTimeMillis(), id),
    )
  }

  @Synchronized
  fun scheduleRetry(id: Long, errorCode: String, nextRetryAt: Long) {
    writableDatabase.execSQL(
      "UPDATE sms_staging SET state = 'RETRY', last_error = ?, next_retry_at = ?, lease_until = 0, updated_at = ? WHERE id = ?",
      arrayOf(errorCode, nextRetryAt, System.currentTimeMillis(), id),
    )
  }

  @Synchronized
  fun markDead(id: Long, errorCode: String) {
    writableDatabase.execSQL(
      "UPDATE sms_staging SET state = 'DEAD', last_error = ?, updated_at = ? WHERE id = ?",
      arrayOf(errorCode, System.currentTimeMillis(), id),
    )
  }

  @Synchronized
  fun counts(owner: String?): Map<String, Int> {
    val db = readableDatabase
    fun scalar(sql: String, args: Array<String>): Int =
      db.rawQuery(sql, args).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
    val pendingStates = "state IN ('STAGED','PROCESSING','RETRY')"
    return if (owner == null) {
      mapOf(
        "pending" to 0,
        "dead" to 0,
        "heldForOthers" to 0,
        "ownerless" to scalar("SELECT COUNT(*) FROM sms_staging WHERE $pendingStates AND owner_user_id IS NULL", emptyArray()),
      )
    } else {
      mapOf(
        "pending" to scalar("SELECT COUNT(*) FROM sms_staging WHERE $pendingStates AND owner_user_id = ?", arrayOf(owner)),
        "dead" to scalar("SELECT COUNT(*) FROM sms_staging WHERE state = 'DEAD' AND owner_user_id = ?", arrayOf(owner)),
        "heldForOthers" to scalar(
          "SELECT COUNT(*) FROM sms_staging WHERE $pendingStates AND owner_user_id IS NOT NULL AND owner_user_id != ?",
          arrayOf(owner),
        ),
        "ownerless" to scalar("SELECT COUNT(*) FROM sms_staging WHERE $pendingStates AND owner_user_id IS NULL", emptyArray()),
      )
    }
  }

  @Synchronized
  fun purgeOwner(owner: String) {
    writableDatabase.execSQL("DELETE FROM sms_staging WHERE owner_user_id = ?", arrayOf(owner))
  }

  /** Keep only the newest 500 body-less tombstones, and drop those older than 14 days. */
  private fun pruneLocked(db: SQLiteDatabase, now: Long) {
    db.execSQL(
      "DELETE FROM sms_staging WHERE state = 'COMPLETED' AND (updated_at < ? OR id NOT IN (SELECT id FROM sms_staging WHERE state = 'COMPLETED' ORDER BY id DESC LIMIT 500))",
      arrayOf(now - 14L * 24 * 60 * 60 * 1000),
    )
  }

  companion object {
    @Volatile private var instance: VelnoraSmsStagingStore? = null
    fun get(context: Context): VelnoraSmsStagingStore =
      instance ?: synchronized(this) {
        instance ?: VelnoraSmsStagingStore(context).also { instance = it }
      }
  }
}
