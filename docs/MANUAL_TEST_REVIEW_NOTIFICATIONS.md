# Manual test: review notifications with quick-category buttons

Automated tests cover the ranking, grouping, and ledger updates (`npm test`). They cannot show how a real phone
delivers, displays, or reacts to a notification, so run this on a device. Use Android 12 or newer, ideally also 13+.

## Build and install

The `android/` folder is generated, so the manifest must be regenerated to pick up the new receiver and service:

```
npx expo prebuild --platform android
npx expo run:android --device        # or: cd android && ./gradlew installDebug
```

Confirm the merged manifest has `VelnoraReviewActionReceiver` and `VelnoraReviewActionService`, both `exported="false"`.

## Setup

1. Open Velnora, choose Guest (or sign in), and allow SMS and notifications when asked (Android 13+ shows a dialog).
2. Profile > Settings > Notifications: the "Review reminders" switch is on and "Remind me about" is **All payments**.
3. Create some history so suggestions exist: add 3 expenses to the merchant `RAHUL KUMAR` under **Groceries**, and a few
   other expenses under **Food & Dining**.
4. Fake bank SMS needs no SIM. On an emulator:
   `adb emu sms send AX-HDFCBK-S "Rs.450.00 debited from A/c XX1234 to RAHUL KUMAR Ref 412345678901"`
   On a real phone, send the same text from another phone, using a sender id that matches the pattern `^[A-Z0-9 -]{4,30}$`.
   Use a different `Ref` number for each message.

Wait about 15 to 20 seconds after each SMS: the app deliberately waits for a second source (payment-app alert) first.

## Test script

| # | Do | Expect |
|---|----|--------|
| 1 | **Force-stop** Velnora (Settings > Apps > Velnora > Force stop). Send the SMS above. | Within ~20 s a notification "Complete your transaction": "₹450 payment detected at RAHUL KUMAR…". No SMS text, no account number, no reference. |
| 2 | Look at its buttons. | Three: **Groceries**, one more category from your history (not "Other Expenses"), and **More**. |
| 3 | With the app still force-stopped, tap **Groceries**. | Notification disappears at once. The app does not open. |
| 4 | Wait 10 s, then open Velnora. | The transaction is under Groceries and no longer in the review list. Totals and charts include it under Groceries. |
| 5 | Repeat 1, then tap **More**. | App opens directly on that transaction's review sheet. |
| 6 | Sign in, repeat 1 and 3 with network on, then check the account on another device or the backend. | The category change is synced. In guest mode nothing is uploaded. |
| 7 | Airplane mode, repeat 1 and 3, then turn the network back on. | Works offline; syncs afterwards (account mode). |
| 8 | Send two different SMS (different `Ref`) within 2 minutes. | One summary: "2 transactions need review", no category buttons; tapping opens the review list. Any earlier single notification is replaced. |
| 9 | Send an SMS, then categorise it **inside the app** before the notification appears, or while it is showing. | The notification is removed or never appears. |
| 10 | Send an SMS, tap **Groceries**, then categorise it differently in the app (tap the button, then open the app and change it before the background task has run). | The in-app choice wins. |
| 11 | Send an SMS for a merchant with no history on a fresh install. | Notification has no buttons (nothing to suggest); tapping it opens the transaction. |
| 12 | Settings: set "Review reminders" to **Off** and send an SMS. | No notification. The transaction waits in the in-app review list. |
| 13 | With notifications blocked in Android settings, set Review reminders to On. | Android 13+: the permission dialog appears. If refused for good, system settings open. The row reads "Allow Velnora notifications to receive these". |
| 14 | Send an SMS and **swipe the notification away**, then restart the phone. | It does not come back. The transaction is still in the in-app review list. |
| 15 | Send an SMS and tap **Groceries** while the phone is in Doze (screen off for 10+ minutes, `adb shell dumpsys deviceidle force-idle`). | Applied when the phone is next active at the latest; the choice is never lost (it is queued natively). |
| 16 | Lock the phone and send an SMS. | Lock screen shows only "Transaction needs review" with no amount or merchant. |

## Useful adb commands

```
adb shell am force-stop com.anonymous.velnora
adb shell dumpsys notification --noredact | grep -A8 com.anonymous.velnora     # what is showing
adb shell dumpsys activity services com.anonymous.velnora                       # headless services
adb logcat -s ReactNativeJS:V AndroidRuntime:E                                   # JS errors, crashes
```

Do not paste SMS text into bug reports; the app never logs it.

## Known limits

- Some manufacturers (aggressive battery savers) stop apps from starting background services. If a tap in
  scenario 3 is not applied until the app opens, that is the manufacturer restriction. The choice is still saved and is applied on open (scenario 4).
- Notification channel settings are per-device; if you changed the channel's sound earlier it stays as you set it.
