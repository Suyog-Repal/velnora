package com.velnora.sms

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Runs the JS capture pipeline without UI when a payment arrives while the app is closed. Carries no message content. */
class VelnoraCaptureService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("VelnoraCaptureDrain", Arguments.createMap(), 60_000L, true)
}
