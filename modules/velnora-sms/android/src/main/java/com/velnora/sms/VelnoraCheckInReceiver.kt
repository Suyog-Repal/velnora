package com.velnora.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/**
 * Alarm, reboot, app update, clock and timezone changes (re-arm the schedule) and the "Nothing missed" button.
 * Every path re-arms first, so the next day's check-in is scheduled even if starting JS is refused.
 */
class VelnoraCheckInReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val app = context.applicationContext
    when (intent.action) {
      VelnoraCheckIn.ACTION_NOTHING_MISSED -> VelnoraCheckIn.markConfirmed(app)
      VelnoraCheckIn.ACTION_FIRE -> {
        VelnoraCheckIn.schedule(app)
        if (!VelnoraCheckIn.isEnabled(app) || VelnoraCheckIn.isConfirmedToday(app)) return
        try {
          app.startService(Intent(app, VelnoraCheckInService::class.java))
          HeadlessJsTaskService.acquireWakeLockNow(app)
        } catch (_: Throwable) {
          // JS could not start: still ask, without counts.
          VelnoraCheckIn.post(app, "Did we miss anything?", "Add any expense Velnora could not capture today.")
        }
      }
      Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_TIME_CHANGED -> VelnoraCheckIn.schedule(app)
    }
  }
}
