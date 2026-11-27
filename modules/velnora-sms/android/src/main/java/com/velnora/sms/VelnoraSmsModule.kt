package com.velnora.sms

import android.content.Context
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
      return@Function VelnoraCaptureHealth.smsPermissionGranted(context)
    }

    Function("isNotificationAccessGranted") {
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraCaptureHealth.notificationAccessGranted(context)
    }

    /** Which sources the person has switched off. Read natively by the receiver and listener. */
    Function("getDisabledCaptureSources") {
      val context = appContext.reactContext ?: return@Function null
      return@Function VelnoraCapturePrefs.disabled(context).toList()
    }

    Function("setCaptureSourceEnabled") { id: String, enabled: Boolean ->
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraCapturePrefs.setEnabled(context, id, enabled)
    }

    Function("getCaptureHealth") {
      val context = appContext.reactContext ?: return@Function null
      return@Function VelnoraCaptureHealth.read(context)
    }

    Function("openCaptureSettings") { page: String ->
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraCaptureHealth.openSettings(context, page)
    }

    Function("requestListenerRebind") {
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraCaptureHealth.requestListenerRebind(context)
    }

    AsyncFunction("queueSummary") { owner: String? -> store().queueSummary(owner) }

    AsyncFunction("readCaptureLog") { store().readLog() }

    AsyncFunction("clearCaptureLog") { store().clearLog() }

    AsyncFunction("logStagedOutcome") { id: Double, stage: String, result: String, reason: String ->
      store().logStaged(id.toLong(), stage, result, reason)
    }

    /** An entry about Velnora itself (for example "signed out"), with no message source. */
    AsyncFunction("logCaptureEvent") { stage: String, result: String, reason: String ->
      store().log("app", "app", stage, result, reason)
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

    /** Daily check-in: the schedule and "confirmed today" live natively so they work with the app closed. */
    Function("configureDailyCheckIn") { enabled: Boolean, time: String ->
      appContext.reactContext?.let { VelnoraCheckIn.configure(it, enabled, time) }
      return@Function null
    }

    Function("getCheckInConfirmedDay") {
      val context = appContext.reactContext ?: return@Function null
      return@Function VelnoraCheckIn.confirmedDay(context)
    }

    Function("markCheckInConfirmed") { day: String ->
      appContext.reactContext?.let { VelnoraCheckIn.markConfirmed(it, day) }
      return@Function null
    }

    Function("postDailyCheckIn") { title: String, body: String ->
      val context = appContext.reactContext ?: return@Function false
      return@Function VelnoraCheckIn.post(context, title, body)
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
