package com.velnora.sms

import android.content.Context
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VelnoraSmsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VelnoraSms")
    Events("onSmsReceived")

    Function("setSupportedSenderPatterns") { patterns: List<String> ->
      VelnoraSmsReceiverState.configurePatterns(patterns)
    }

    Function("isReceiveSmsPermissionGranted") {
      val context = appContext.reactContext ?: return@Function false
      return@Function context.checkSelfPermission(android.Manifest.permission.RECEIVE_SMS) ==
        PackageManager.PERMISSION_GRANTED
    }

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

  internal fun emitSmsReceived(sender: String, receivedAt: Long, partCount: Int, body: String) {
    sendEvent(
      "onSmsReceived",
      mapOf(
        "sender" to sender,
        "receivedAt" to receivedAt,
        "partCount" to partCount,
        "body" to body,
      ),
    )
  }

  companion object {
    @Volatile
    var current: VelnoraSmsModule? = null
  }
}
