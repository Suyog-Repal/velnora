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
  SQLiteOpenHelper(context.applicationContext, "velnora_sms_staging.db", null, 3) {

  private val app: Context = context.applicationContext

  /**
   * The capture-log tables are additive and created here, not through a version bump, so an older build installed over this one
   * can still open the file. A failure here must never stop capture.
   */
  override fun onOpen(db: SQLiteDatabase) {
    super.onOpen(db)
    if (db.isReadOnly) return
    try {
      db.execSQL(VelnoraCaptureLogSql.CREATE_LOG)
      db.execSQL(VelnoraCaptureLogSql.CREATE_HOLD_SEEN)
    } catch (_: Throwable) {
    }
  }

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
        updated_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'sms',
        content_hash TEXT,
        source_app TEXT
      )""",
    )
    db.execSQL("CREATE INDEX idx_sms_staging_owner_state ON sms_staging(owner_user_id, state)")
    db.execSQL("CREATE TABLE staging_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
    // Forward-only.
    if (oldVersion < 2) {
      // v2: events can come from the Truecaller notification listener as well as the SMS receiver.
      db.execSQL("ALTER TABLE sms_staging ADD COLUMN source TEXT NOT NULL DEFAULT 'sms'")
      db.execSQL("ALTER TABLE sms_staging ADD COLUMN content_hash TEXT")
    }
    if (oldVersion < 3) {
      // v3: payment-app notifications record which app posted them.
      db.execSQL("ALTER TABLE sms_staging ADD COLUMN source_app TEXT")
    }
  }

  /** Returns the new row id, or -1 if this broadcast was already staged (durable dedupe). */
  @Synchronized
  fun stage(sender: String, body: String, receivedAt: Long, partCount: Int): Long {
    return stageInternal("sms", "$sender:$receivedAt:$partCount", sender, body, receivedAt, partCount, null, null)
  }

  /**
   * Stages an app notification. Returns -1 when it is a replay (same notification key + post time, e.g. the
   * listener reconnecting and re-delivering active notifications), or [REPEATED] when it is a repeat/update of text already
   * staged for the same notification key within [REPEAT_WINDOW_MS] (the app re-posting or updating an existing notification).
   */
  @Synchronized
  fun stageNotification(source: String, notificationKey: String, sender: String, body: String, postTime: Long, sourceApp: String): Long {
    val db = writableDatabase
    val hash = sha256(body)
    val repeated = db.rawQuery(
      "SELECT 1 FROM sms_staging WHERE source = ? AND content_hash = ? AND dedupe_key LIKE ? AND received_at >= ? LIMIT 1",
      arrayOf(source, hash, "tc:" + notificationKey + ":%", (postTime - REPEAT_WINDOW_MS).toString()),
    ).use { it.moveToFirst() }
    if (repeated) return REPEATED
    return stageInternal(source, "tc:$notificationKey:$postTime:$hash", sender, body, postTime, 1, hash, sourceApp)
  }

  private fun stageInternal(
    source: String, dedupeKey: String, sender: String, body: String, receivedAt: Long, partCount: Int, contentHash: String?, sourceApp: String?,
  ): Long {
    val db = writableDatabase
    val now = System.currentTimeMillis()
    val values = ContentValues().apply {
      put("dedupe_key", dedupeKey)
      put("source", source)
      put("content_hash", contentHash)
      put("source_app", sourceApp)
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

  /** Forget the owner hint (guest mode / signed out): new events are then stamped with no owner (the guest scope). */
  @Synchronized
  fun clearOwnerHint() {
    writableDatabase.execSQL("DELETE FROM staging_meta WHERE k = 'owner_hint'")
  }

  /** `owner == null` claims the guest scope (events stamped with no owner); otherwise exactly that user's events. */
  @Synchronized
  fun claim(owner: String?, limit: Int, now: Long, leaseMs: Long, maxAttempts: Int): List<Map<String, Any?>> {
    val db = writableDatabase
    val out = ArrayList<Map<String, Any?>>()
    val gaveUp = ArrayList<Long>()
    db.beginTransaction()
    try {
      val ownerClause = if (owner == null) "owner_user_id IS NULL" else "owner_user_id = ?"
      val ownerArgs: Array<String> = if (owner == null) emptyArray() else arrayOf(owner)
      val dueClause =
        "$ownerClause AND ((state IN ('STAGED','RETRY') AND next_retry_at <= ?) OR (state = 'PROCESSING' AND lease_until < ?))"
      // Crash-looping events (lease expired repeatedly) stop at maxAttempts instead of retrying forever.
      db.rawQuery(
        "SELECT id FROM sms_staging WHERE $dueClause AND attempts >= ?",
        arrayOf(*ownerArgs, now.toString(), now.toString(), maxAttempts.toString()),
      ).use { c -> while (c.moveToNext()) gaveUp.add(c.getLong(0)) }
      db.execSQL(
        "UPDATE sms_staging SET state = 'DEAD', last_error = 'max_attempts', updated_at = ? WHERE $dueClause AND attempts >= ?",
        arrayOf<Any?>(now, *ownerArgs, now, now, maxAttempts),
      )
      db.rawQuery(
        "SELECT id, sender, body, received_at, part_count, attempts, source, source_app FROM sms_staging WHERE $dueClause ORDER BY received_at ASC LIMIT ?",
        arrayOf(*ownerArgs, now.toString(), now.toString(), limit.toString()),
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
              "source" to c.getString(6),
              "sourceApp" to c.getString(7),
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
    gaveUp.forEach { logStaged(it, "insert", "dead", "max_attempts") }
    logHeld(owner)
    return out
  }

  /** Reports, once each, the waiting events this scope cannot process: no account, or a different account. */
  private fun logHeld(owner: String?) {
    try {
      val db = writableDatabase
      val elsewhere = if (owner == null) "owner_user_id IS NOT NULL" else "(owner_user_id IS NULL OR owner_user_id != ?)"
      val args: Array<String> = if (owner == null) emptyArray() else arrayOf(owner)
      val held = ArrayList<Pair<Long, Boolean>>()
      db.rawQuery(
        "SELECT id, owner_user_id IS NULL FROM sms_staging WHERE state IN ($PENDING_STATES) AND $elsewhere AND id NOT IN (SELECT staging_id FROM capture_hold_seen) LIMIT 50",
        args,
      ).use { c -> while (c.moveToNext()) held.add(c.getLong(0) to (c.getInt(1) == 1)) }
      for ((id, ownerless) in held) {
        logStaged(id, "queue", "held", if (ownerless) "no_account" else "other_account")
        db.execSQL("INSERT OR IGNORE INTO capture_hold_seen (staging_id) VALUES (?)", arrayOf<Any>(id))
      }
    } catch (_: Throwable) {
    }
  }

  /**
   * Appends one capture-log row. Anything outside the fixed vocabulary, or from a switched-off source, is not written, and
   * the origin is reduced to a bank-style header, an allowed package, "numeric" or "other". Never throws.
   */
  @Synchronized
  fun log(source: String, origin: String, stage: String, result: String, reason: String, at: Long = System.currentTimeMillis()) {
    try {
      val safeOrigin = VelnoraCaptureRules.safeLogOrigin(source, origin)
      if (!VelnoraCaptureRules.isLoggable(VelnoraCapturePrefs.disabled(app), source, safeOrigin, stage, result, reason)) return
      val db = writableDatabase
      val counted = db.compileStatement(VelnoraCaptureLogSql.COALESCE).use { statement ->
        statement.bindLong(1, at)
        listOf(source, safeOrigin, stage, result, reason).forEachIndexed { i, value -> statement.bindString(i + 2, value) }
        statement.bindLong(7, at - VelnoraCaptureRules.LOG_COALESCE_MS)
        statement.executeUpdateDelete()
      }
      if (counted == 0) db.execSQL(VelnoraCaptureLogSql.INSERT, arrayOf<Any>(at, source, safeOrigin, stage, result, reason))
      pruneLogLocked(db, at)
    } catch (_: Throwable) {
    }
  }

  /** Logs an outcome for a staged event. The origin is derived here from the stored row, so callers never pass a sender. */
  @Synchronized
  fun logStaged(id: Long, stage: String, result: String, reason: String) {
    try {
      readableDatabase.rawQuery("SELECT source, sender, source_app FROM sms_staging WHERE id = ?", arrayOf(id.toString())).use { c ->
        if (!c.moveToFirst()) return
        val source = c.getString(0)
        log(source, VelnoraCaptureRules.logOriginForStaged(source, c.getString(1), c.getString(2)), stage, result, reason)
      }
    } catch (_: Throwable) {
    }
  }

  @Synchronized
  fun readLog(): List<Map<String, Any?>> {
    val db = writableDatabase
    pruneLogLocked(db, System.currentTimeMillis())
    val out = ArrayList<Map<String, Any?>>()
    db.rawQuery(VelnoraCaptureLogSql.READ, emptyArray()).use { c ->
      while (c.moveToNext()) {
        out.add(
          mapOf(
            "at" to c.getLong(0),
            "source" to c.getString(1),
            "origin" to c.getString(2),
            "stage" to c.getString(3),
            "result" to c.getString(4),
            "reason" to c.getString(5),
            "count" to c.getInt(6),
          ),
        )
      }
    }
    return out
  }

  @Synchronized
  fun clearLog() {
    writableDatabase.execSQL(VelnoraCaptureLogSql.CLEAR)
  }

  private fun pruneLogLocked(db: SQLiteDatabase, now: Long) {
    db.execSQL(
      VelnoraCaptureLogSql.PRUNE,
      arrayOf<Any>(now - VelnoraCaptureRules.LOG_MAX_AGE_MS, VelnoraCaptureRules.LOG_MAX_ROWS),
    )
  }

  /** Raw device-wide counts for Capture health (no identities). `owner == null` is the guest scope. */
  @Synchronized
  fun queueSummary(owner: String?): Map<String, Int> {
    val db = readableDatabase
    fun scalar(where: String, args: Array<String> = emptyArray()): Int =
      db.rawQuery("SELECT COUNT(*) FROM sms_staging WHERE $where", args).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
    val pending = "state IN ($PENDING_STATES)"
    return mapOf(
      "pendingMine" to if (owner == null) 0 else scalar("$pending AND owner_user_id = ?", arrayOf(owner)),
      "pendingOwnerless" to scalar("$pending AND owner_user_id IS NULL"),
      "pendingOther" to
        if (owner == null) scalar("$pending AND owner_user_id IS NOT NULL")
        else scalar("$pending AND owner_user_id IS NOT NULL AND owner_user_id != ?", arrayOf(owner)),
      "dead" to scalar("state = 'DEAD'"),
    )
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
    const val REPEAT_WINDOW_MS = 2L * 60 * 1000
    const val REPEATED = -2L
    private const val PENDING_STATES = "'STAGED','PROCESSING','RETRY'"

    private fun sha256(text: String): String =
      java.security.MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }

    @Volatile private var instance: VelnoraSmsStagingStore? = null
    fun get(context: Context): VelnoraSmsStagingStore =
      instance ?: synchronized(this) {
        instance ?: VelnoraSmsStagingStore(context).also { instance = it }
      }
  }
}
