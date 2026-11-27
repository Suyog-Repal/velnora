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
    // Case-insensitive, like the JS rule (`new RegExp(senderPattern, 'i')`): some banks send mixed-case sender ids.
    val compiled = patterns.mapNotNull { pattern ->
      runCatching { Regex(pattern, RegexOption.IGNORE_CASE) }.getOrNull()
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
    val sender = messages?.firstOrNull()?.originatingAddress
    // A text from a person's phone number leaves no trace: its body is not read, and nothing is stored, logged or passed on.
    if (VelnoraCaptureRules.isPersonalNumber(sender)) return false

    val store = VelnoraSmsStagingStore.get(context)
    if (messages.isNullOrEmpty()) {
      store.log(VelnoraCaptureRules.SMS, "other", "receiver", "dropped", "empty_message")
      return false
    }

    try {
      val body = messages.joinToString(separator = "") { it.messageBody ?: "" }.trim()
      val timestamp = messages.maxOf { it.timestampMillis }
      val partCount = messages.size

      // After process death the in-memory patterns are empty: re-read them from the manifest.
      synchronized(lock) { if (senderPatterns.isEmpty()) configureFromManifest(context) }
      // Authentication codes are never written to disk, not even briefly.
      val dropReason = synchronized(lock) { VelnoraCaptureRules.smsDropReason(sender, body, senderPatterns) }
      if (sender == null || dropReason != null) {
        store.log(VelnoraCaptureRules.SMS, VelnoraCaptureRules.logSmsSender(sender), "receiver", "dropped", dropReason ?: "no_sender")
        return false
      }

      val staged = store.stage(sender, body, timestamp, partCount) > 0
      if (!staged) store.log(VelnoraCaptureRules.SMS, VelnoraCaptureRules.logSmsSender(sender), "staging", "dropped", "already_staged")
      if (staged && VelnoraCaptureRules.looksLikeTransaction(body)) VelnoraBankAlerts.wakeCapture(context)
      return staged
    } catch (_: Throwable) {
      // Never log SMS content. A failed stage is rare (disk full); only the fact is noted, if the log can still be written.
      store.log(VelnoraCaptureRules.SMS, VelnoraCaptureRules.logSmsSender(sender), "staging", "dropped", "staging_error")
      return false
    }
  }

  private object PackageManagerFlags {
    const val GET_META_DATA = 128
  }
}

class VelnoraSmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    val appContext = context.applicationContext
    // The person's switch comes first: with SMS off the message is not read, stored, logged or passed on.
    if (!VelnoraCapturePrefs.isEnabled(appContext, VelnoraCaptureRules.SMS)) return
    val pending = goAsync()
    EXECUTOR.execute {
      try {
        // Staged durably first; the JS signal is only an optimization for when the app is already running.
        if (VelnoraSmsReceiverState.receive(appContext, intent)) {
          VelnoraSmsModule.current?.emitSmsStaged()
        }
      } catch (_: Throwable) {
        // Nothing is logged here: the sender may be unknown, so this could be a personal text. receive() notes its own failures.
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    val EXECUTOR: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
  }
}
