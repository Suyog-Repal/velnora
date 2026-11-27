package com.velnora.sms

import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.facebook.react.HeadlessJsTaskService

/**
 * Native-side pre-filters and Velnora's own "new payment" alert. JS applies the authoritative parser; these only keep
 * authentication codes out of storage and avoid alerting on messages that are clearly not payments.
 * Never log message content.
 */
object VelnoraBankAlerts {
  private const val CHANNEL_ID = "velnora_detected_payments"
  private const val NOTIFICATION_ID = 7301
  private const val REVIEW_CHANNEL_ID = "velnora_transaction_review"
  private const val REVIEW_NOTIFICATION_ID = 7302
  private const val REVIEW_SUMMARY_ID = 7303
  private const val MAX_CATEGORY_ACTIONS = 2

  /**
   * A payment was staged. With Velnora on screen the JS listener already handles it. Otherwise start the headless JS
   * pipeline, which decides whether this payment needs the person at all. Only if Android refuses to start it does the
   * content-free alert stand in; the event stays staged either way.
   */
  fun wakeCapture(context: Context) {
    if (isAppInForeground()) return
    try {
      context.startService(Intent(context, VelnoraCaptureService::class.java))
      HeadlessJsTaskService.acquireWakeLockNow(context)
    } catch (_: Throwable) {
      VelnoraSmsStagingStore.get(context).log("app", "app", "headless", "held", "wake_failed")
      notifyDetected(context)
    }
  }

  /** Tag is the transaction id: reposting replaces, so one transaction can never show two notifications. */
  fun postReview(context: Context, transactionId: String, title: String, body: String, categories: List<String> = emptyList()): Boolean =
    show(context, tag(transactionId), REVIEW_NOTIFICATION_ID, title, body, "velnora://review/$transactionId", transactionId, categories)

  fun postReviewSummary(context: Context, count: Int): Boolean =
    show(context, null, REVIEW_SUMMARY_ID, "Transactions need your attention", "$count transactions need review.", "velnora://review", null, emptyList())

  fun cancelReview(context: Context, transactionId: String) {
    manager(context).cancel(tag(transactionId), REVIEW_NOTIFICATION_ID)
  }

  fun cancelReviewSummary(context: Context) {
    manager(context).cancel(REVIEW_SUMMARY_ID)
  }

  /** Explicit, non-exported receiver. The data URI makes each (transaction, category) a distinct PendingIntent. */
  private fun categoryIntent(context: Context, transactionId: String, category: String): PendingIntent {
    val intent = Intent(VelnoraReviewActionReceiver.ACTION_CHOOSE_CATEGORY)
      .setClass(context, VelnoraReviewActionReceiver::class.java)
      .setData(Uri.Builder().scheme("velnora-action").authority(transactionId).appendPath(category).build())
      .putExtra(VelnoraReviewActionReceiver.EXTRA_TRANSACTION_ID, transactionId)
      .putExtra(VelnoraReviewActionReceiver.EXTRA_CATEGORY, category)
    return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun tag(transactionId: String) = "review:$transactionId"

  private fun manager(context: Context) = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun builder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, REVIEW_CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(context)

  /** The full text appears only on an unlocked phone; the lock screen gets a version with no amount or name. */
  private fun show(
    context: Context, tag: String?, id: Int, title: String, body: String, link: String,
    transactionId: String?, categories: List<String>,
  ): Boolean {
    return try {
      val manager = manager(context)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !manager.areNotificationsEnabled()) return false
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        // Same id as before: renaming it would orphan the sound/visibility settings the person already chose for it.
        manager.createNotificationChannel(
          NotificationChannel(REVIEW_CHANNEL_ID, "Transactions to review", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Asks you to categorise or confirm a payment Velnora detected. Shows only the amount and who it was for."
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
          },
        )
      }
      val component = context.packageManager.getLaunchIntentForPackage(context.packageName)?.component ?: return false
      // Explicit component: only Velnora can receive this, and the link is the data RN's Linking delivers.
      val open = Intent(Intent.ACTION_VIEW, Uri.parse(link)).setComponent(component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val tap = PendingIntent.getActivity(context, link.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val hidden = builder(context).setSmallIcon(context.applicationInfo.icon).setContentTitle("Transaction needs review").build()
      val notificationBuilder = builder(context)
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(Notification.BigTextStyle().bigText(body))
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setPublicVersion(hidden)
        .setAutoCancel(true)
        .setContentIntent(tap)
      // Single-transaction notifications only. Android allows 3 actions: up to two categories, then "More".
      if (transactionId != null && categories.isNotEmpty()) {
        for (category in categories.take(MAX_CATEGORY_ACTIONS)) {
          notificationBuilder.addAction(0, category, categoryIntent(context, transactionId, category))
        }
        notificationBuilder.addAction(0, "More", tap)
      }
      manager.notify(tag, id, notificationBuilder.build())
      true
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Content-free on purpose: the lock screen never shows an amount, a merchant or a bank. One fixed id, so several
   * payments collapse into one alert. Silently does nothing when the person has not allowed notifications.
   */
  fun notifyDetected(context: Context) {
    try {
      if (isAppInForeground()) return
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && !manager.areNotificationsEnabled()) return

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        manager.createNotificationChannel(NotificationChannel(CHANNEL_ID, "Detected payments", NotificationManager.IMPORTANCE_DEFAULT))
      }
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val tap = launch?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID) else @Suppress("DEPRECATION") Notification.Builder(context)
      val notification = builder
        .setSmallIcon(context.applicationInfo.icon)
        .setContentTitle("New payment detected")
        .setContentText("Open Velnora to see it.")
        .setAutoCancel(true)
        .apply { if (tap != null) setContentIntent(tap) }
        .build()
      manager.notify(NOTIFICATION_ID, notification)
    } catch (_: Throwable) {
      // An alert is a convenience; the event is already staged durably.
    }
  }

  private fun isAppInForeground(): Boolean {
    val state = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(state)
    return state.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }
}
