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

  /** Content-free signal: JS then drains the durable staging store. */
  internal fun emitSmsStaged() {
    sendEvent("onSmsStaged", emptyMap<String, Any>())
  }

  companion object {
    @Volatile
    var current: VelnoraSmsModule? = null
  }
}
