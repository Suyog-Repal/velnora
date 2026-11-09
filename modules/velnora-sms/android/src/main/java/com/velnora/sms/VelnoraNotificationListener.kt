package com.velnora.sms

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Detection from notifications of an explicit allow-list of apps: Truecaller (which mirrors bank SMS) and UPI/payment
 * apps. Every other app's notification is ignored before its text is read.
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
    try {
      activeNotifications?.forEach { handle(it) }
    } catch (_: Throwable) {
    }
  }

  private fun handle(sbn: StatusBarNotification) {
    val origin = SOURCES[sbn.packageName] ?: return
    val n = sbn.notification ?: return
    // Group summaries only repeat their children; ongoing/foreground entries are never a transaction.
    if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    if (n.flags and Notification.FLAG_ONGOING_EVENT != 0) return

    val extras = n.extras ?: return
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
    val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT))
      ?.toString()?.trim().orEmpty()
    if (title.isEmpty()) return

    // Truecaller's title is the bank and its text is the SMS. Payment apps often put the amount in the title itself
    // ("Asha paid you Rs 500"), so both parts are the message and the sender is the app.
    val isPaymentApp = origin.source == PAYMENT
    val body = if (isPaymentApp) (if (text.isEmpty()) title else "$title. $text") else text
    if (!VelnoraBankAlerts.looksLikeTransaction(body)) return

    val context = applicationContext
    val key = sbn.key ?: "${sbn.packageName}:${sbn.id}:${sbn.tag}"
    val sender = if (isPaymentApp) origin.label else title
    EXECUTOR.execute {
      try {
        if (VelnoraSmsStagingStore.get(context).stageNotification(origin.source, key, sender, body, sbn.postTime, origin.label) > 0) {
          VelnoraSmsModule.current?.emitSmsStaged()
          VelnoraBankAlerts.wakeCapture(context)
        }
      } catch (_: Throwable) {
        // Never log content. A failed stage is rare (disk full); nothing else can be done here.
      }
    }
  }

  private data class Origin(val source: String, val label: String)

  private companion object {
    const val PAYMENT = "payment_notification"
    val SOURCES = mapOf(
      "com.truecaller" to Origin("truecaller_notification", "Truecaller"),
      "com.google.android.apps.nbu.paisa.user" to Origin(PAYMENT, "Google Pay"),
      "com.phonepe.app" to Origin(PAYMENT, "PhonePe"),
      "net.one97.paytm" to Origin(PAYMENT, "Paytm"),
      "in.org.npci.upiapp" to Origin(PAYMENT, "BHIM"),
      "com.dreamplug.androidapp" to Origin(PAYMENT, "CRED"),
    )
    val EXECUTOR: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
  }
}
