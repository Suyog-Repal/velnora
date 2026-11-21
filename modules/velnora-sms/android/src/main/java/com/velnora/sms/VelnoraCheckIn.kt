package com.velnora.sms

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import java.util.Calendar

/**
 * The end-of-day "Did we miss anything?" check-in. Native owns only the schedule, the "Nothing missed" confirmation and
 * the notification itself; the counts come from the JS ledger (headless task), so no transaction data lives here.
 * The alarm is inexact (setAndAllowWhileIdle: no special permission, may drift a few minutes in Doze) and re-armed by
 * every fire, reboot, app update and time or timezone change. Never log notification content.
 */
object VelnoraCheckIn {
  const val CHANNEL_ID = "velnora_daily_checkin"
  const val NOTIFICATION_ID = 7310
  const val ACTION_FIRE = "com.velnora.sms.action.CHECKIN_FIRE"
  const val ACTION_NOTHING_MISSED = "com.velnora.sms.action.CHECKIN_NOTHING_MISSED"
  const val DEFAULT_TIME = "21:00"
  private const val PREFS = "velnora_checkin"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_TIME = "time"
  private const val KEY_CONFIRMED_DAY = "confirmed_day"
  private val TIME_PATTERN = Regex("([01]\\d|2[0-3]):[0-5]\\d")

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  /** Called from JS whenever the setting changes and at app start. Persists, then re-arms or cancels the alarm. */
  fun configure(context: Context, enabled: Boolean, time: String) {
    val safeTime = if (TIME_PATTERN.matches(time)) time else DEFAULT_TIME
    // Choosing a new time (or switching the check-in back on) is a fresh request for today: forget an earlier
    // "done for today" so a later time still notifies today. The same values re-sent at app start change nothing.
    val changed = !isEnabled(context) && enabled || time(context) != safeTime
    val edit = prefs(context).edit().putBoolean(KEY_ENABLED, enabled).putString(KEY_TIME, safeTime)
    if (changed) edit.remove(KEY_CONFIRMED_DAY)
    edit.apply()
    if (enabled) schedule(context) else { cancelAlarm(context); cancelNotification(context) }
  }

  fun isEnabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)
  fun time(context: Context): String = prefs(context).getString(KEY_TIME, DEFAULT_TIME) ?: DEFAULT_TIME
  fun confirmedDay(context: Context): String? = prefs(context).getString(KEY_CONFIRMED_DAY, null)

  fun today(): String {
    val c = Calendar.getInstance()
    return "%04d-%02d-%02d".format(c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH))
  }

  fun isConfirmedToday(context: Context) = confirmedDay(context) == today()

  /** "Nothing missed", or a quick-add save: today is done. Does not need JS, so it works with the app closed. */
  fun markConfirmed(context: Context, day: String = today()) {
    prefs(context).edit().putString(KEY_CONFIRMED_DAY, day).apply()
    cancelNotification(context)
  }

  /** Next occurrence of the chosen local time: today if still ahead, otherwise tomorrow. */
  fun nextTriggerAt(time: String, now: Long = System.currentTimeMillis()): Long {
    val (h, m) = (if (TIME_PATTERN.matches(time)) time else DEFAULT_TIME).split(":").map { it.toInt() }
    val c = Calendar.getInstance().apply {
      timeInMillis = now
      set(Calendar.HOUR_OF_DAY, h); set(Calendar.MINUTE, m); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }
    if (c.timeInMillis <= now) c.add(Calendar.DAY_OF_YEAR, 1)
    return c.timeInMillis
  }

  private fun alarmIntent(context: Context): PendingIntent {
    val intent = Intent(ACTION_FIRE).setClass(context, VelnoraCheckInReceiver::class.java)
    return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  /** Idempotent: always replaces the one pending alarm. Safe to call after any trigger. */
  fun schedule(context: Context) {
    try {
      val alarms = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      if (!isEnabled(context)) { alarms.cancel(alarmIntent(context)); return }
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTriggerAt(time(context)), alarmIntent(context))
    } catch (_: Throwable) {
      // Re-armed on the next app start, boot or time change.
    }
  }

  private fun cancelAlarm(context: Context) {
    try { (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(alarmIntent(context)) } catch (_: Throwable) {}
  }

  fun cancelNotification(context: Context) {
    try { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(NOTIFICATION_ID) } catch (_: Throwable) {}
  }

  private fun builder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(context)

  /** Both actions are explicit, not exported. "Add expense" opens the app on the quick-add screen. */
  fun post(context: Context, title: String, body: String): Boolean {
    return try {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !manager.areNotificationsEnabled()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Daily check-in", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A once-a-day reminder to add anything Velnora did not capture, such as cash spends."
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
          },
        )
      }
      val component = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component ?: return false
      val open = Intent(Intent.ACTION_VIEW, Uri.parse("velnora://quick-add")).setComponent(component)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val add = PendingIntent.getActivity(context, 7311, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val done = PendingIntent.getBroadcast(
        context, 7312, Intent(ACTION_NOTHING_MISSED).setClass(context, VelnoraCheckInReceiver::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
      // The lock screen shows no counts or amounts; the full text appears only on an unlocked phone.
      val hidden = builder(context).setSmallIcon(context.applicationInfo.icon).setContentTitle("Daily check-in").build()
      val notification = builder(context)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(Notification.BigTextStyle().bigText(body))
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setPublicVersion(hidden)
        .setAutoCancel(true)
        .setContentIntent(add)
        .addAction(0, "Add expense", add)
        .addAction(0, "Nothing missed", done)
        .build()
      manager.notify(NOTIFICATION_ID, notification)
      true
    } catch (_: Throwable) {
      false
    }
  }
}
