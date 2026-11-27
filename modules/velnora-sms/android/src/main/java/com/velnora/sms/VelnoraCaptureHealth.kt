package com.velnora.sms

import android.app.ActivityManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/** Reads the Android settings that decide whether capture can work, and opens the page where each one is changed. */
object VelnoraCaptureHealth {
  fun smsPermissionGranted(context: Context): Boolean =
    context.checkSelfPermission(android.Manifest.permission.RECEIVE_SMS) == PackageManager.PERMISSION_GRANTED

  /** Notification access is a special grant (Settings > Notification access), not a runtime permission. */
  fun notificationAccessGranted(context: Context): Boolean {
    val enabled = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
    return enabled?.split(":")?.any { ComponentName.unflattenFromString(it)?.packageName == context.packageName } ?: false
  }

  /** A value is null when this Android version has no such setting or it cannot be read. */
  fun read(context: Context): Map<String, Any?> {
    val packageName = context.packageName
    return mapOf(
      "smsPermission" to smsPermissionGranted(context),
      "notificationAccess" to notificationAccessGranted(context),
      "listenerConnected" to VelnoraListenerState.connected,
      "listenerLastEventAt" to VelnoraCapturePrefs.lastListenerEvent(context),
      "ignoringBatteryOptimizations" to runCatching {
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(packageName)
      }.getOrNull(),
      "backgroundRestricted" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) runCatching {
        (context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isBackgroundRestricted
      }.getOrNull() else null,
      "pauseIfUnusedExempt" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) runCatching {
        context.packageManager.isAutoRevokeWhitelisted
      }.getOrNull() else null,
      "installerPackage" to installer(context),
      "sdkInt" to Build.VERSION.SDK_INT,
      "manufacturer" to Build.MANUFACTURER,
      "brand" to Build.BRAND,
    )
  }

  private fun installer(context: Context): String? = runCatching {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
    } else {
      @Suppress("DEPRECATION")
      context.packageManager.getInstallerPackageName(context.packageName)
    }
  }.getOrNull()

  /** `page`: "app_info", "notification_access" or "battery". Falls back to App info if the phone lacks the page. */
  fun openSettings(context: Context, page: String): Boolean {
    val appInfo = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
    val candidates = mutableListOf<Intent>()
    when (page) {
      "notification_access" -> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
          candidates.add(
            Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(
              Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
              ComponentName(context, VelnoraNotificationListener::class.java).flattenToString(),
            ),
          )
        }
        candidates.add(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
      }
      // The list of optimised apps: opening it needs no permission.
      "battery" -> candidates.add(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }
    candidates.add(appInfo)
    return candidates.any { intent ->
      runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }.isSuccess
    }
  }

  /** Asks Android to bind the notification listener again. Only meaningful while access is granted. */
  fun requestListenerRebind(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N || !notificationAccessGranted(context)) return false
    return runCatching {
      android.service.notification.NotificationListenerService.requestRebind(
        ComponentName(context, VelnoraNotificationListener::class.java),
      )
    }.isSuccess
  }
}
