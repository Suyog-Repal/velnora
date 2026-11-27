package com.velnora.sms

import android.content.Context
import android.content.SharedPreferences

/**
 * The person's capture choices, in SharedPreferences so the receiver and listener can read them when no JavaScript is running.
 * Only switched-off sources are stored: an install that has never touched the switches keeps reading everything it did before.
 */
object VelnoraCapturePrefs {
  private const val FILE = "velnora_capture"
  private const val DISABLED = "disabled_sources"
  private const val LAST_EVENT = "listener_last_event_at"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun disabled(context: Context): Set<String> = prefs(context).getStringSet(DISABLED, null)?.toSet() ?: emptySet()

  fun isEnabled(context: Context, id: String): Boolean = VelnoraCaptureRules.isEnabled(disabled(context), id)

  /** Returns false for an id that is not a supported source. */
  @Synchronized
  fun setEnabled(context: Context, id: String, enabled: Boolean): Boolean {
    if (id !in VelnoraCaptureRules.SOURCE_IDS) return false
    val next = disabled(context).toMutableSet()
    if (enabled) next.remove(id) else next.add(id)
    // commit(), not apply(): the choice must survive the process being killed right after the switch is flipped.
    return prefs(context).edit().putStringSet(DISABLED, next).commit()
  }

  /** The newest notification the listener received from a switched-on, allow-listed app. A time only. */
  fun markListenerEvent(context: Context, postedAt: Long) {
    // A replay of older notifications after reconnecting must not move the time backwards.
    if (postedAt <= (lastListenerEvent(context) ?: 0L)) return
    prefs(context).edit().putLong(LAST_EVENT, postedAt).apply()
  }

  fun lastListenerEvent(context: Context): Long? = prefs(context).getLong(LAST_EVENT, 0L).takeIf { it > 0L }
}
