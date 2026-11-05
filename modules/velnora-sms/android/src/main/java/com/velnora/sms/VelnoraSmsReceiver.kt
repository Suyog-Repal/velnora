package com.velnora.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.provider.Telephony
import org.json.JSONArray

object VelnoraSmsReceiverState {
  private const val PATTERNS_METADATA_NAME = "com.velnora.sms.SUPPORTED_SENDER_PATTERNS"
  private val lock = Any()
  private var senderPatterns: List<Regex> = emptyList()

  fun configureFromManifest(context: Context?) {
    if (context == null) return
    val metadata = context.packageManager
      .getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
      .metaData
    val encodedPatterns = metadata?.getString(PATTERNS_METADATA_NAME) ?: return
    val patterns = JSONArray(encodedPatterns).let { array ->
      (0 until array.length()).map { index -> array.getString(index) }
    }
    configurePatterns(patterns)
  }

  fun configurePatterns(patterns: List<String>) {
    val compiled = patterns.mapNotNull { pattern ->
      runCatching { Regex(pattern) }.getOrNull()
    }
    synchronized(lock) {
      senderPatterns = compiled
    }
  }

  /**
   * Parses the broadcast and stages it durably. Returns true if a NEW event was staged.
   * Only a single small INSERT happens here; all parsing/financial processing is done later by JS.
   */
  fun receive(context: Context, intent: Intent): Boolean {
    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
    if (messages.isNullOrEmpty()) return false

    val sender = messages.firstOrNull()?.originatingAddress ?: return false
    val body = messages.joinToString(separator = "") { it.messageBody ?: "" }.trim()
    if (body.isEmpty()) return false
    val timestamp = messages.maxOf { it.timestampMillis }
    val partCount = messages.size

    // After process death the in-memory patterns are empty: re-read them from the manifest.
    synchronized(lock) { if (senderPatterns.isEmpty()) configureFromManifest(context) }
    synchronized(lock) { if (senderPatterns.none { it.matches(sender) }) return false }

    return VelnoraSmsStagingStore.get(context).stage(sender, body, timestamp, partCount) > 0
  }

  private object PackageManagerFlags {
    const val GET_META_DATA = 128
  }
}

class VelnoraSmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val pending = goAsync()
    val appContext = context.applicationContext
    EXECUTOR.execute {
      try {
        // Staged durably first; the JS signal is only an optimization for when the app is already running.
        if (VelnoraSmsReceiverState.receive(appContext, intent)) {
          VelnoraSmsModule.current?.emitSmsStaged()
        }
      } catch (_: Throwable) {
        // Never log SMS content. A failed stage is rare (disk full); nothing else can be done here.
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    val EXECUTOR: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
  }
}
