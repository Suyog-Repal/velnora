package com.velnora.sms

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Applies queued notification category choices to the ledger without UI. Carries no data: JS reads the native store. */
class VelnoraReviewActionService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("VelnoraReviewActionDrain", Arguments.createMap(), 30_000L, true)
}
