# Manual test: end-of-day check-in and quick-add

`npm test` covers the day counts, wording, skip rules, settings, quick-add ranking and the cash-entry save
(`src/services/__tests__/dailyCheckIn.test.ts`). It cannot show the real Android alarm, notification or reboot
behaviour, so run this on a device (USB debugging) or emulator. Android 13+ is best, since it asks for notification permission.

## Build and install

`android/` is generated, so regenerate it to pick up the new receiver, service and boot permission:

```
npx expo prebuild --platform android
npx expo run:android --device
```

The merged manifest should contain `VelnoraCheckInReceiver` (not exported, with BOOT_COMPLETED, MY_PACKAGE_REPLACED,
TIMEZONE_CHANGED, TIME_SET), `VelnoraCheckInService` (not exported) and `RECEIVE_BOOT_COMPLETED`.

## Setup

1. Open Velnora, choose Guest or sign in, allow notifications.
2. Profile > Preferences: **Daily check-in** reads "Daily at 9:00 PM". Tap the row to turn it off and on again; the
   **Check-in time** row appears when on. Turning it on while notifications are blocked asks for permission.
3. Set the check-in time to **3 minutes from now** (the clock dial lets you pick any minute).

## Tests

| # | Steps | Expected |
|---|-------|----------|
| 1 | Send 2 bank SMS first: `adb emu sms send AX-HDFCBK-S "Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678901"` (change the Ref each time). Wait for the time. | "Did we miss anything?" - "Velnora captured 2 transactions today (₹… total). Anything missed?" Alarm is inexact; allow a few minutes of drift. |
| 2 | Tap **Add expense**. | App opens the **Add expense** sheet. Most-used category is already chosen; amount chips show your past hand-entered amounts. |
| 3 | Tap an amount chip, then **Save**. | Entry saved as a cash expense; appears in Transactions, Analytics, monthly report. Today's check-in is marked done. |
| 4 | When the notification appears (any day with no entry yet), tap **Nothing missed**. | Notification dismisses. Setting the time again to a few minutes ahead in the same day does not post a second one. |
| 5 | A day with no captured transactions. | Wording: "Velnora didn't capture any transactions today. Spent cash or paid some other way? Add it now." |
| 6 | Turn **Daily check-in** off, wait past the time. | Nothing is posted. |
| 7 | Close the app (swipe away) before the alarm. | The check-in still posts (headless task). |
| 8 | Reboot the device without opening Velnora; set time 3 minutes ahead before rebooting. | After boot, the check-in still fires (alarm re-armed by the boot receiver). |
| 9 | Change the device timezone / manual time. | Next alarm follows the new local time. Check with `adb shell dumpsys alarm \| grep -A3 velnora`. |
| 10 | `adb install -r` a fresh build over the old one (app update). | Alarm survives (MY_PACKAGE_REPLACED). |
| 11 | Revoke the notification permission, then wait for the time. | Nothing is posted; no crash. Profile row says "Allow Velnora notifications to receive this". |
| 12 | Sign-in account: save a quick entry offline, then go online. | Entry syncs; guest data never syncs. |

Changing the check-in time (or switching the check-in back on) resets "done for today", so a later time still notifies
today even after you tapped **Nothing missed** or saved a quick entry. Reopening the app with the same time does not reset it.

## Useful commands

```
adb shell dumpsys alarm | grep -B2 -A6 com.velnora          # pending check-in alarm and its trigger time
adb shell dumpsys notification --noredact | grep -A8 velnora_daily_checkin
```

To test quickly, set the check-in time 2 to 3 minutes ahead; the receiver is not exported, so it cannot be fired
from `adb shell` directly.

## Privacy checks

- Lock screen shows only "Daily check-in" (no counts or amounts).
- `adb logcat | grep -i velnora` shows no message text, amounts or merchant names.
