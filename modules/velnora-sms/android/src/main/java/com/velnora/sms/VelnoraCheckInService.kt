package com.velnora.sms

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Counts today's captured transactions from the local ledger and posts the check-in. Carries no data. */
class VelnoraCheckInService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig =
    HeadlessJsTaskConfig("VelnoraDailyCheckIn", Arguments.createMap(), 30_000L, true)
}
