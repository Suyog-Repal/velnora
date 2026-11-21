package com.velnora.sms

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Durable, app-private queue of category choices made from a notification button. A tap is written here BEFORE anything
 * else happens, so it survives process death and a failed headless start; JS drains it into the ledger idempotently
 * (also when the app is next opened). Holds only a transaction id and a category name: never message content.
 *
 * One row per transaction: choosing again before the first is applied replaces it.
 */
class VelnoraReviewActionStore private constructor(context: Context) :
  SQLiteOpenHelper(context.applicationContext, "velnora_review_actions.db", null, 1) {

  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL(
      """CREATE TABLE review_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL UNIQUE,
        category TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0
      )""",
    )
  }

  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

  @Synchronized
  fun enqueue(transactionId: String, category: String, now: Long) {
    writableDatabase.execSQL(
      "INSERT OR REPLACE INTO review_actions (transaction_id, category, created_at, attempts, lease_until) VALUES (?, ?, ?, 0, 0)",
      arrayOf<Any?>(transactionId, category, now),
    )
  }

  /** Leases due rows; abandons rows that are too old or have failed too often. */
  @Synchronized
  fun claim(limit: Int, now: Long, leaseMs: Long): List<Map<String, Any?>> {
    val db = writableDatabase
    val out = ArrayList<Map<String, Any?>>()
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM review_actions WHERE created_at < ? OR attempts >= ?", arrayOf<Any?>(now - MAX_AGE_MS, MAX_ATTEMPTS))
      db.rawQuery(
        "SELECT id, transaction_id, category FROM review_actions WHERE lease_until < ? ORDER BY id ASC LIMIT ?",
        arrayOf(now.toString(), limit.toString()),
      ).use { c ->
        while (c.moveToNext()) {
          out.add(mapOf("id" to c.getLong(0), "transactionId" to c.getString(1), "category" to c.getString(2)))
        }
      }
      for (row in out) {
        db.execSQL("UPDATE review_actions SET attempts = attempts + 1, lease_until = ? WHERE id = ?", arrayOf<Any?>(now + leaseMs, row["id"]))
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return out
  }

  @Synchronized
  fun complete(id: Long) {
    writableDatabase.execSQL("DELETE FROM review_actions WHERE id = ?", arrayOf<Any?>(id))
  }

  /** Not applicable right now (e.g. another account is signed in): keep it, but let the next drain try again. */
  @Synchronized
  fun release(id: Long) {
    writableDatabase.execSQL("UPDATE review_actions SET lease_until = 0 WHERE id = ?", arrayOf<Any?>(id))
  }

  companion object {
    const val MAX_ATTEMPTS = 8
    const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000

    @Volatile private var instance: VelnoraReviewActionStore? = null
    fun get(context: Context): VelnoraReviewActionStore =
      instance ?: synchronized(this) { instance ?: VelnoraReviewActionStore(context).also { instance = it } }
  }
}
