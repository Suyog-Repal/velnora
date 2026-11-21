package com.velnora.sms

import android.content.Context
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VelnoraSmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VelnoraSms")
    Events("onSmsStaged")

    Function("setSupportedSenderPatterns") { patterns: List<String> ->
      VelnoraSmsReceiverState.configurePatterns(patterns)
    }

    Function("isReceiveSmsPermissionGranted") {
      val context = appContext.reactContext ?: return@Function false
      return@Function context.checkSelfPermission(android.Manifest.permission.RECEIVE_SMS) ==
        PackageManager.PERMISSION_GRANTED
    }

    /** Notification access is a special grant (Settings > Notification access), not a runtime permission. */
    Function("isNotificationAccessGranted") {
      val context = appContext.reactContext ?: return@Function false
      val enabled = android.provider.Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
      return@Function enabled?.split(":")?.any {
        android.content.ComponentName.unflattenFromString(it)?.packageName == context.packageName
      } ?: false
    }

    Function("openNotificationAccessSettings") {
      val context = appContext.reactContext ?: return@Function false
      val intent = android.content.Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      return@Function true
    }

    /** Whether Android lets Velnora post its own notifications (POST_NOTIFICATIONS on 13+, the app toggle before that). */
    Function("areNotificationsEnabled") {
      val context = appContext.reactContext ?: return@Function false
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
      return@Function android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.N || manager.areNotificationsEnabled()
    }

    Function("openAppNotificationSettings") {
      val context = appContext.reactContext ?: return@Function false
      val intent = android.content.Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      return@Function true
    }

    Function("postReviewNotification") { transactionId: String, title: String, body: String, categories: List<String> ->
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraBankAlerts.postReview(context, transactionId, title, body, categories)
    }

    /** Category choices tapped on notifications, drained by JS into the ledger (see VelnoraReviewActionStore). */
    AsyncFunction("claimReviewActions") { limit: Int, nowMs: Double, leaseMs: Double ->
      reviewActions().claim(limit, nowMs.toLong(), leaseMs.toLong())
    }

    AsyncFunction("completeReviewAction") { id: Double -> reviewActions().complete(id.toLong()) }

    AsyncFunction("releaseReviewAction") { id: Double -> reviewActions().release(id.toLong()) }

    Function("postReviewSummary") { count: Int ->
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraBankAlerts.postReviewSummary(context, count)
    }

    Function("cancelReviewNotification") { transactionId: String ->
      appContext.reactContext?.let { VelnoraBankAlerts.cancelReview(it, transactionId) }
      return@Function null
    }

    Function("cancelReviewSummary") {
      appContext.reactContext?.let { VelnoraBankAlerts.cancelReviewSummary(it) }
      return@Function null
    }

    AsyncFunction("setOwnerHint") { userId: String -> store().setOwnerHint(userId) }

    AsyncFunction("clearOwnerHint") { store().clearOwnerHint() }

    AsyncFunction("claim") { owner: String?, limit: Int, nowMs: Double, leaseMs: Double, maxAttempts: Int ->
      store().claim(owner, limit, nowMs.toLong(), leaseMs.toLong(), maxAttempts)
    }

    AsyncFunction("complete") { id: Double -> store().complete(id.toLong()) }

    AsyncFunction("scheduleRetry") { id: Double, errorCode: String, nextRetryAtMs: Double ->
      store().scheduleRetry(id.toLong(), errorCode, nextRetryAtMs.toLong())
    }

    AsyncFunction("markDead") { id: Double, errorCode: String -> store().markDead(id.toLong(), errorCode) }

    AsyncFunction("counts") { owner: String? -> store().counts(owner) }

    AsyncFunction("purgeOwner") { owner: String -> store().purgeOwner(owner) }

    OnCreate {
      current = this@VelnoraSmsModule
      VelnoraSmsReceiverState.configureFromManifest(appContext.reactContext)
    }

    OnDestroy {
      if (current === this@VelnoraSmsModule) {
        current = null
      }
    }
  }

  private fun store(): VelnoraSmsStagingStore {
    val context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
    return VelnoraSmsStagingStore.get(context)
  }

  private fun reviewActions(): VelnoraReviewActionStore {
    val context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")
    return VelnoraReviewActionStore.get(context)
  }

  /** Content-free signal: JS then drains the durable staging store. */
  internal fun emitSmsStaged() {
    sendEvent("onSmsStaged", emptyMap<String, Any>())
  }

  companion object {
    @Volatile
    var current: VelnoraSmsModule? = null
  }
}
