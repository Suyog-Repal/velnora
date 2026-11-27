package com.velnora.sms

/**
 * Every decision about what Velnora may read, what it drops, and what the capture log may say. Plain Kotlin with no Android
 * imports, so it is unit-tested on the JVM (see src/test). Never log message content.
 */
object VelnoraCaptureRules {
  const val SMS = "sms"
  const val TRUECALLER_PACKAGE = "com.truecaller"
  const val PAYMENT = "payment_notification"
  const val TRUECALLER = "truecaller_notification"

  data class Origin(val source: String, val label: String)

  /** The complete allow-list. A notification from any other package is ignored before its text is read. */
  val NOTIFICATION_SOURCES: Map<String, Origin> = mapOf(
    TRUECALLER_PACKAGE to Origin(TRUECALLER, "Truecaller"),
    "com.google.android.apps.nbu.paisa.user" to Origin(PAYMENT, "Google Pay"),
    "com.phonepe.app" to Origin(PAYMENT, "PhonePe"),
    "net.one97.paytm" to Origin(PAYMENT, "Paytm"),
    "in.org.npci.upiapp" to Origin(PAYMENT, "BHIM"),
    "com.dreamplug.androidapp" to Origin(PAYMENT, "CRED"),
  )

  /** Everything the person can switch on or off: SMS plus one entry per allow-listed app (identified by package). */
  val SOURCE_IDS: List<String> = listOf(SMS) + NOTIFICATION_SOURCES.keys

  /** Only the switched-off ids are stored, so an install that never touched the switches reads everything, as before. */
  fun isEnabled(disabled: Set<String>, id: String): Boolean = id in SOURCE_IDS && id !in disabled

  // ───────────────────────── pre-filters ─────────────────────────

  private val CURRENCY = Regex("""(?:\bINR|\bRs\.?|₹)\s*[\d,]+|[\d,]+(?:\.\d{1,2})?\s*(?:INR|Rs\.?|₹)|\b(?:debited|credited)\s*(?:by|with|for|of)\s*[\d,]+""", RegexOption.IGNORE_CASE)
  private val MOVEMENT = Regex("""debit|credit|paid|received|withdrawn|spent|deposit|transferred|\bsent\b|purchase|refund|revers|successful""", RegexOption.IGNORE_CASE)
  private val SAFETY_ADVICE = Regex("""\b(?:never|do not|don'?t|dont)\s+share\b[^.]*""", RegexOption.IGNORE_CASE)
  private const val OTP_WORD = """(?:otp|one[- ]time[- ](?:password|pin)|verification code|security code|passcode)"""
  private val OTP_PATTERNS = listOf(
    Regex("""\b$OTP_WORD\b[^.]{0,40}?\b\d{4,8}\b""", RegexOption.IGNORE_CASE),
    Regex("""\b\d{4,8}\b[^.]{0,30}?\b$OTP_WORD\b""", RegexOption.IGNORE_CASE),
    Regex("""\b(?:use|enter)\b[^.]{0,20}\b$OTP_WORD\b""", RegexOption.IGNORE_CASE),
  )

  /** An authentication code. Bank alerts that only add "never share your OTP" as advice are not one. */
  fun isOtp(text: String): Boolean {
    val cleaned = SAFETY_ADVICE.replace(text, " ")
    return OTP_PATTERNS.any { it.containsMatchIn(cleaned) }
  }

  /** Why a text is not worth treating as a payment, as a capture-log reason code; null when it looks like one. */
  fun notTransactionReason(text: String): String? = when {
    text.length < 12 -> "too_short"
    isOtp(text) -> "otp"
    !CURRENCY.containsMatchIn(text) -> "no_amount"
    !MOVEMENT.containsMatchIn(text) -> "no_payment_word"
    else -> null
  }

  fun looksLikeTransaction(text: String): Boolean = notTransactionReason(text) == null

  /** Why the receiver drops an SMS before staging it; null when it should be staged. */
  fun smsDropReason(sender: String?, body: String, senderPatterns: List<Regex>): String? = when {
    sender == null -> "no_sender"
    body.isEmpty() -> "empty_message"
    senderPatterns.none { it.matches(sender) } -> "sender_filtered"
    isOtp(body) -> "otp"
    else -> null
  }

  /** Either [dropReason] is set, or [sender] and [body] are what should be staged. */
  data class NotificationDecision(val dropReason: String?, val sender: String = "", val body: String = "")

  /**
   * Truecaller's title is the bank and its text is the SMS. Payment apps often put the amount in the title itself
   * ("Asha paid you Rs 500"), so both parts are the message and the sender is the app.
   */
  fun decideNotification(origin: Origin, groupSummary: Boolean, ongoing: Boolean, title: String, text: String): NotificationDecision {
    // Group summaries only repeat their children; ongoing/foreground entries are never a transaction.
    if (groupSummary) return NotificationDecision("group_summary")
    if (ongoing) return NotificationDecision("ongoing")
    if (title.isEmpty()) return NotificationDecision("no_title")
    val isPaymentApp = origin.source == PAYMENT
    val body = if (isPaymentApp) (if (text.isEmpty()) title else "$title. $text") else text
    val reason = notTransactionReason(body)
    if (reason != null) return NotificationDecision(reason)
    return NotificationDecision(null, if (isPaymentApp) origin.label else title, body)
  }

  // ───────────────────────── capture log vocabulary and privacy ─────────────────────────

  const val LOG_MAX_ROWS = 500
  const val LOG_MAX_AGE_MS = 14L * 24 * 60 * 60 * 1000
  /** Identical entries this close together are counted on one row, so a chatty app cannot push everything else out. */
  const val LOG_COALESCE_MS = 60L * 1000

  /** "app" marks an entry about Velnora itself (no message source). */
  val LOG_SOURCES = setOf(SMS, PAYMENT, TRUECALLER, "app")
  val LOG_STAGES = setOf("receiver", "listener", "staging", "headless", "queue", "parse", "match", "insert")
  val LOG_RESULTS = setOf("dropped", "held", "retry", "dead", "saved")
  val LOG_REASONS = setOf(
    // native filters
    "no_sender", "empty_message", "sender_filtered", "otp", "group_summary", "ongoing", "no_content", "no_title", "too_short",
    "no_amount", "no_payment_word",
    // native queue and wake-up
    "already_staged", "repeat", "staging_error", "wake_failed", "max_attempts", "no_account", "other_account",
    // JavaScript: parse, duplicate match, insert
    "signed_out", "drain_failed", "sender_not_supported", "promotion", "failed_wording", "pending_wording", "no_status_word",
    "excluded_wording", "no_direction_or_amount", "invalid_fields", "same_reference", "same_fingerprint",
    "same_payment_other_source", "possible_duplicate", "saved", "no_owner", "persist_failed", "processor_exception",
  )

  /** An Indian bank-style sender header: "VM-HDFCBK-S", "AD-SBIUPI", or a bare six-letter header. */
  private val BANK_HEADER = Regex("""^(?:[A-Z]{2}-[A-Z0-9]{3,9}(?:-[A-Z])?|[A-Z]{6})$""", RegexOption.IGNORE_CASE)
  private val NUMERIC = Regex("""^\+?[\d\s().-]+$""")

  /** Marks a person's phone number inside the log rules. An entry with this origin is never written. */
  const val PERSONAL = "personal"
  private const val PERSONAL_MIN_DIGITS = 10

  /**
   * A person's phone number: written in "+" international form, or ten or more digits. A text from one leaves no trace.
   * Shorter all-digit senders are short codes, which businesses use.
   */
  fun isPersonalNumber(sender: String?): Boolean {
    val value = sender?.trim().orEmpty()
    return NUMERIC.matches(value) && (value.startsWith("+") || value.count { it.isDigit() } >= PERSONAL_MIN_DIGITS)
  }

  /** What the log may say about an SMS sender: the header itself, "numeric" (a short code) or "other"; [PERSONAL] is never logged. */
  fun logSmsSender(sender: String?): String {
    val value = sender?.trim().orEmpty()
    return when {
      isPersonalNumber(value) -> PERSONAL
      NUMERIC.matches(value) -> "numeric"
      BANK_HEADER.matches(value) -> value.uppercase()
      else -> "other"
    }
  }

  /**
   * What the log may say about where a staged event came from. A notification is identified by its app's package only:
   * a Truecaller title is free text (it can be a person's name) and is never used.
   */
  fun logOriginForStaged(source: String, sender: String?, sourceApp: String?): String = when (source) {
    SMS -> logSmsSender(sender)
    TRUECALLER -> TRUECALLER_PACKAGE
    else -> NOTIFICATION_SOURCES.entries.firstOrNull { it.value.source == source && it.value.label == sourceApp }?.key ?: "other"
  }

  /** Last gate before a row is written: an origin that is not one of the allowed shapes becomes "other". */
  fun safeLogOrigin(source: String, origin: String): String = when {
    source == "app" -> "app"
    source == SMS -> if (origin == "numeric" || origin == "other" || origin == PERSONAL) origin else logSmsSender(origin)
    NOTIFICATION_SOURCES[origin]?.source == source -> origin
    else -> "other"
  }

  /**
   * The switch that governs a log entry; null for entries about the app itself. A switched-off source leaves no log row, and
   * a payment entry whose app is not on the allow-list ("other") matches no switch, so it is not written either.
   */
  fun logSwitchId(source: String, origin: String): String? = when (source) {
    SMS -> SMS
    TRUECALLER -> TRUECALLER_PACKAGE
    PAYMENT -> origin
    else -> null
  }

  fun isLoggable(disabled: Set<String>, source: String, origin: String, stage: String, result: String, reason: String): Boolean {
    if (source !in LOG_SOURCES || stage !in LOG_STAGES || result !in LOG_RESULTS || reason !in LOG_REASONS) return false
    if (source == SMS && origin == PERSONAL) return false
    val switchId = logSwitchId(source, origin) ?: return true
    return isEnabled(disabled, switchId)
  }
}
