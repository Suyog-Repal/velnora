package com.velnora.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** All messages here are invented. */
class VelnoraCaptureRulesTest {
  private val rules = VelnoraCaptureRules
  private val patterns = listOf(Regex("^[A-Z0-9 -]{4,30}$", RegexOption.IGNORE_CASE))
  private val gpay = "com.google.android.apps.nbu.paisa.user"
  private val payment = rules.NOTIFICATION_SOURCES.getValue(gpay)
  private val truecaller = rules.NOTIFICATION_SOURCES.getValue(rules.TRUECALLER_PACKAGE)
  private val debit = "Rs 500.00 debited from A/c XX0000 to DEMO STORE"

  @Test fun allowListIsExactlyTheSupportedApps() {
    assertEquals(
      setOf("com.truecaller", gpay, "com.phonepe.app", "net.one97.paytm", "in.org.npci.upiapp", "com.dreamplug.androidapp"),
      rules.NOTIFICATION_SOURCES.keys,
    )
    assertEquals(7, rules.SOURCE_IDS.size)
  }

  @Test fun everythingIsOnUntilSwitchedOffAndUnknownIdsAreNeverOn() {
    for (id in rules.SOURCE_IDS) assertTrue(rules.isEnabled(emptySet(), id))
    assertFalse(rules.isEnabled(setOf(gpay), gpay))
    assertTrue(rules.isEnabled(setOf(gpay), rules.SMS))
    assertFalse(rules.isEnabled(emptySet(), "com.google.android.apps.messaging"))
  }

  @Test fun smsFilterKeepsItsOrderAndReasons() {
    assertEquals("no_sender", rules.smsDropReason(null, debit, patterns))
    assertEquals("empty_message", rules.smsDropReason("VM-DEMOBK-S", "", patterns))
    assertEquals("sender_filtered", rules.smsDropReason("+910000000000", debit, patterns))
    assertEquals("sender_filtered", rules.smsDropReason("VM-DEMOBK-S", debit, emptyList()))
    assertEquals("otp", rules.smsDropReason("VM-DEMOBK-S", "Your OTP is 123456 for login", patterns))
    assertNull(rules.smsDropReason("VM-DEMOBK-S", debit, patterns))
    assertNull(rules.smsDropReason("VM-DEMOBK-S", "$debit. Never share your OTP 123456", patterns))
  }

  @Test fun prefilterReasons() {
    assertEquals("too_short", rules.notTransactionReason("Rs 5 paid"))
    assertEquals("otp", rules.notTransactionReason("OTP 123456 to pay Rs 500"))
    assertEquals("no_amount", rules.notTransactionReason("Payment received from Demo Person"))
    assertEquals("no_payment_word", rules.notTransactionReason("Rs 500 to Demo Store today"))
    assertNull(rules.notTransactionReason(debit))
    assertTrue(rules.looksLikeTransaction("A/c XX0000 debited by 250.0 today"))
  }

  @Test fun notificationDecisions() {
    fun decide(origin: VelnoraCaptureRules.Origin, title: String, text: String, summary: Boolean = false, ongoing: Boolean = false) =
      rules.decideNotification(origin, summary, ongoing, title, text)
    assertEquals("group_summary", decide(payment, "₹500 paid", debit, summary = true).dropReason)
    assertEquals("ongoing", decide(payment, "₹500 paid", debit, ongoing = true).dropReason)
    assertEquals("no_title", decide(payment, "", debit).dropReason)
    val paid = decide(payment, "You paid ₹500", "Paid to Demo Store")
    assertNull(paid.dropReason)
    assertEquals("Google Pay", paid.sender)
    assertEquals("You paid ₹500. Paid to Demo Store", paid.body)
    assertEquals("You paid ₹500 today", decide(payment, "You paid ₹500 today", "").body)
    val bank = decide(truecaller, "Demo Bank", debit)
    assertEquals("Demo Bank", bank.sender)
    assertEquals(debit, bank.body)
    assertEquals("too_short", decide(truecaller, "Demo Bank", "").dropReason)
  }

  @Test fun logNeverHoldsAPhoneNumberOrAName() {
    assertEquals("VM-DEMOBK-S", rules.logSmsSender("vm-demobk-s"))
    assertEquals("AD-DEMOUP", rules.logSmsSender("AD-DEMOUP"))
    assertEquals("DEMOBK", rules.logSmsSender("DEMOBK"))
    assertEquals("numeric", rules.logSmsSender("+91 00000 00000"))
    assertEquals("numeric", rules.logSmsSender("56767"))
    assertEquals("other", rules.logSmsSender("Demo Person"))
    assertEquals("other", rules.logSmsSender("DEMO PERSON"))
    assertEquals("other", rules.logSmsSender(null))
  }

  @Test fun stagedOriginIsAHeaderOrAPackageNeverATitle() {
    assertEquals("com.truecaller", rules.logOriginForStaged(rules.TRUECALLER, "Demo Person", "Truecaller"))
    assertEquals(gpay, rules.logOriginForStaged(rules.PAYMENT, "Google Pay", "Google Pay"))
    assertEquals("other", rules.logOriginForStaged(rules.PAYMENT, "Demo Person", "Unknown App"))
    assertEquals("numeric", rules.logOriginForStaged(rules.SMS, "+910000000000", null))
  }

  @Test fun lastGateRewritesUnsafeOrigins() {
    assertEquals("other", rules.safeLogOrigin(rules.TRUECALLER, "Demo Person"))
    assertEquals("other", rules.safeLogOrigin(rules.PAYMENT, "Demo Person"))
    assertEquals("other", rules.safeLogOrigin(rules.PAYMENT, "com.truecaller"))
    assertEquals("numeric", rules.safeLogOrigin(rules.SMS, "numeric"))
    assertEquals("other", rules.safeLogOrigin(rules.SMS, "Demo Person"))
    assertEquals("app", rules.safeLogOrigin("app", "anything"))
  }

  @Test fun onlyFixedVocabularyAndSwitchedOnSourcesAreLogged() {
    assertTrue(rules.isLoggable(emptySet(), rules.SMS, "numeric", "receiver", "dropped", "sender_filtered"))
    assertFalse(rules.isLoggable(setOf(rules.SMS), rules.SMS, "numeric", "receiver", "dropped", "sender_filtered"))
    assertFalse(rules.isLoggable(setOf(gpay), rules.PAYMENT, gpay, "listener", "dropped", "no_amount"))
    assertFalse(rules.isLoggable(setOf("com.truecaller"), rules.TRUECALLER, "com.truecaller", "parse", "dropped", "otp"))
    assertFalse(rules.isLoggable(emptySet(), rules.PAYMENT, "other", "parse", "dropped", "otp"))
    assertFalse(rules.isLoggable(emptySet(), rules.SMS, "numeric", "receiver", "dropped", "Rs 500 to Demo Person"))
    assertTrue(rules.isLoggable(rules.SOURCE_IDS.toSet(), "app", "app", "headless", "held", "signed_out"))
  }
}
