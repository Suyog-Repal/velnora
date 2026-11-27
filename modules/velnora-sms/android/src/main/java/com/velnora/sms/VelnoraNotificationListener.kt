package com.velnora.sms

import android.app.Notification
import android.content.ComponentName
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/** Whether the system currently has the listener bound. In memory on purpose: a dead process is never "connected". */
object VelnoraListenerState {
  @Volatile
  var connected: Boolean = false
}

/**
 * Detection from notifications of an explicit allow-list of apps (see [VelnoraCaptureRules.NOTIFICATION_SOURCES]): Truecaller,
 * which mirrors bank SMS, and UPI/payment apps. Every other app's notification, and that of an allow-listed app the person
 * has switched off, is ignored before its text is read.
 *
 * Android binds this service on its own once the user grants Notification access, even when the app has no running
 * process or activity, and it never starts the UI. Like the SMS receiver it only stages a small durable row; all
 * parsing and the financial write happen later in JS (same idempotent pipeline as SMS).
 *
 * Coverage is only what an app chooses to post: no notification means nothing to capture.
 * Never log notification title/text.
 */
class VelnoraNotificationListener : NotificationListenerService() {

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    handle(sbn)
  }

  // Android re-delivers active notifications after the listener (re)connects; the staging store drops replays
  // (same key + post time) and the JS pipeline is idempotent, so nothing is inserted twice.
  override fun onListenerConnected() {
    VelnoraListenerState.connected = true
    try {
      activeNotifications?.forEach { handle(it) }
    } catch (_: Throwable) {
    }
  }

  override fun onListenerDisconnected() {
    VelnoraListenerState.connected = false
    // Ask Android to bind again. It has no effect if the person has removed Notification access.
    try {
      requestRebind(ComponentName(this, VelnoraNotificationListener::class.java))
    } catch (_: Throwable) {
    }
  }

  override fun onDestroy() {
    VelnoraListenerState.connected = false
    super.onDestroy()
  }

  private fun handle(sbn: StatusBarNotification) {
    val packageName = sbn.packageName
    val origin = VelnoraCaptureRules.NOTIFICATION_SOURCES[packageName] ?: return
    val context = applicationContext
    // A switched-off app is dropped here: nothing is read, stored, logged or sent to JavaScript.
    if (!VelnoraCapturePrefs.isEnabled(context, packageName)) return
    VelnoraCapturePrefs.markListenerEvent(context, sbn.postTime)

    val n = sbn.notification
    val extras = n?.extras
    if (n == null || extras == null) {
      note(origin.source, packageName, "listener", "no_content")
      return
    }
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
    val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))
      ?.toString()?.trim().orEmpty()

    val decision = VelnoraCaptureRules.decideNotification(
      origin,
      groupSummary = n.flags and Notification.FLAG_GROUP_SUMMARY != 0,
      ongoing = n.flags and Notification.FLAG_ONGOING_EVENT != 0,
      title = title,
      text = text,
    )
    val dropReason = decision.dropReason
    if (dropReason != null) {
      note(origin.source, packageName, "listener", dropReason)
      return
    }

    val key = sbn.key ?: "$packageName:${sbn.id}:${sbn.tag}"
    val postTime = sbn.postTime
    EXECUTOR.execute {
      try {
        val store = VelnoraSmsStagingStore.get(context)
        val id = store.stageNotification(origin.source, key, decision.sender, decision.body, postTime, origin.label)
        if (id > 0) {
          VelnoraSmsModule.current?.emitSmsStaged()
          VelnoraBankAlerts.wakeCapture(context)
        } else {
          val reason = if (id == VelnoraSmsStagingStore.REPEATED) "repeat" else "already_staged"
          store.log(origin.source, packageName, "staging", "dropped", reason)
        }
      } catch (_: Throwable) {
        // Never log content. A failed stage is rare (disk full); only the fact is noted, if the log can still be written.
        runCatching { VelnoraSmsStagingStore.get(context).log(origin.source, packageName, "staging", "dropped", "staging_error") }
      }
    }
  }

  /** Records why a notification from a switched-on source was dropped, off the main thread. */
  private fun note(source: String, packageName: String, stage: String, reason: String) {
    val context = applicationContext
    EXECUTOR.execute {
      runCatching { VelnoraSmsStagingStore.get(context).log(source, packageName, stage, "dropped", reason) }
    }
  }

  private companion object {
    val EXECUTOR: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
  }
}
