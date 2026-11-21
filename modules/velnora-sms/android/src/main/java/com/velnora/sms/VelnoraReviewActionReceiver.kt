package com.velnora.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.facebook.react.HeadlessJsTaskService

/**
 * A category button on a review notification. Order matters: persist the choice first (durable), dismiss the
 * notification, and only then try to start the headless JS drain. If Android refuses the start, nothing is lost:
 * the choice stays in [VelnoraReviewActionStore] and is applied the next time JS runs or the app opens.
 */
class VelnoraReviewActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_CHOOSE_CATEGORY) return
    val transactionId = intent.getStringExtra(EXTRA_TRANSACTION_ID) ?: return
    val category = intent.getStringExtra(EXTRA_CATEGORY)?.trim() ?: return
    if (!ID_PATTERN.matches(transactionId) || category.isEmpty() || category.length > 40) return
    val pending = goAsync()
    val appContext = context.applicationContext
    EXECUTOR.execute {
      try {
        VelnoraReviewActionStore.get(appContext).enqueue(transactionId, category, System.currentTimeMillis())
        VelnoraBankAlerts.cancelReview(appContext, transactionId)
        try {
          appContext.startService(Intent(appContext, VelnoraReviewActionService::class.java))
          HeadlessJsTaskService.acquireWakeLockNow(appContext)
        } catch (_: Throwable) {
          // Background start refused: the durable row is drained when JS next runs.
        }
      } catch (_: Throwable) {
        // Nothing sensitive to log; a failed write is rare (disk full).
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    const val ACTION_CHOOSE_CATEGORY = "com.velnora.sms.action.CHOOSE_REVIEW_CATEGORY"
    const val EXTRA_TRANSACTION_ID = "transactionId"
    const val EXTRA_CATEGORY = "category"
    private val ID_PATTERN = Regex("[A-Za-z0-9-]{8,64}")
    private val EXECUTOR: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
  }
}
