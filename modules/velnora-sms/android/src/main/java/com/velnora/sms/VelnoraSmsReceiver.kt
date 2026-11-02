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
  private val deliveredKeys = LinkedHashMap<String, Long>()

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

  fun receive(context: Context, intent: Intent) {
    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent)
    if (messages.isNullOrEmpty()) return

    val sender = messages.firstOrNull()?.originatingAddress ?: return
    val body = messages.joinToString(separator = "") { it.messageBody ?: "" }.trim()
    if (body.isEmpty()) return
    val timestamp = messages.maxOf { it.timestampMillis }
    val partCount = messages.size
    val key = "$sender:$timestamp:$partCount"

    synchronized(lock) {
      if (senderPatterns.none { it.matches(sender) }) return
      if (deliveredKeys.containsKey(key)) return
      deliveredKeys[key] = timestamp
      while (deliveredKeys.size > 256) {
        val oldestKey = deliveredKeys.keys.firstOrNull() ?: break
        deliveredKeys.remove(oldestKey)
      }
    }

    VelnoraSmsModule.current?.emitSmsReceived(sender, timestamp, partCount, body)
  }

  private object PackageManagerFlags {
    const val GET_META_DATA = 128
  }
}

class VelnoraSmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION) {
      VelnoraSmsReceiverState.receive(context, intent)
    }
  }
}
