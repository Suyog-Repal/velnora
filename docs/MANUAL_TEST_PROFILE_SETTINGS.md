# Manual test: Profile, Settings and Privacy & data restructure

`npm test` covers the logic (`src/services/__tests__/notificationSettings.test.ts`): the review-reminder state mapping
(Off / All / Duplicates only), check-in on/off and time saving plus rescheduling, stored values read back unchanged, and
the blocked-notification rules. It cannot show layout, switches, animation, permission dialogs or alarms, so run this on a
device (Android 13+ is best). No native change: a JS reload is enough.

Stored keys are unchanged (`review_notifications_pref` = all / duplicates / off; check-in enabled flag and time), so
install this build over the previous one and your old choices should still show.

## Profile

| # | Steps | Expected |
|---|-------|----------|
| 1 | Open Profile (signed in). | Header card unchanged, then **Your data**: Categories, Merchant names, Review transactions (green count badge when items need review), Accounts, Import. Then a card with **Settings** and **Privacy & data**, then Sign out. Fits roughly one screen with little scrolling. |
| 2 | Tap **Import**. | A sheet offers **CSV file** and **PDF statement**. Each opens the same import flow as before. |
| 3 | Tap Categories, Merchant names, Review transactions, Accounts. | Same screens as before. Review badge matches the number waiting. |
| 4 | Use Guest mode. | No Privacy & data row (it needs an account); everything else works. |
| 5 | Open `velnora://review/<id>` and `velnora://quick-add` links (e.g. from a review notification, the check-in "Add expense"). | Still open the right transaction / quick-add, also with Settings or Privacy open or closed. |

## Settings

| # | Steps | Expected |
|---|-------|----------|
| 6 | Profile > Settings. | Sections in order: Appearance, Automatic capture, Notifications, General. Theme and accent still work. |
| 7 | Automatic capture. | **Bank SMS detection** and **Payment-app alerts** are switches showing the real state. The note "A payment seen by both SMS and Truecaller is recorded once." is below. |
| 8 | Switch Bank SMS on while SMS permission is missing. | Android permission dialog (or the "Turn on SMS access in Settings" help). The switch shows the real result. Switching it off opens Android's app settings (Android cannot revoke in-app); the switch updates when you come back. |
| 9 | Tap Payment-app alerts (either direction). | Opens Android's Notification access page; the switch follows the real state on return. |
| 10 | Notifications: switch **Review reminders** off, then on. | Off hides "Remind me about". On shows it with **All payments** / **Duplicates only**. Reopen Settings: same state. Old Off, All and Duplicates-only users see off, on+All, on+Duplicates respectively. |
| 11 | With reminders on, send a test bank SMS missing a category (see MANUAL_TEST_REVIEW_NOTIFICATIONS.md) for each of All payments and Duplicates only, and with the switch off. | Same behaviour as before: All notifies; Duplicates only notifies only for duplicates; Off posts nothing and clears existing ones. |
| 12 | **Daily check-in** switch off, then on. | Off: the **Check-in time** row hides with an animation. On: it shows inside the same card, with the time and a chevron. There is no separate duplicate time row anywhere. |
| 13 | Tap Check-in time, pick 3 minutes ahead, OK. | Row shows the new time. The check-in fires then (see MANUAL_TEST_DAILY_CHECKIN.md). Turn the switch off and on: the time is kept. |
| 14 | Settings > Notifications with Android notifications blocked for Velnora (system settings). | The first row is **Notifications are blocked** with **Open settings**; both switches read off; there is no "Velnora notifications" row anywhere. **Open settings** opens Velnora's notification settings. Allow them, return: the banner disappears and the switches show your saved choices. |
| 15 | While blocked, turn a notification switch on. | Android's permission dialog (or Settings if refused for good) appears, as the old rows did. |
| 16 | General > Currency. | Opens the currency picker; choosing one updates amounts as before. |
| 17 | TalkBack on the switches. | Each reads as a switch with on/off, title and what it does. Whole row is the touch target (at least 48dp). |
| 18 | Dark theme, large font size. | Rows readable, nothing clipped. |

## Privacy & data

| # | Steps | Expected |
|---|-------|----------|
| 19 | Profile > Privacy & data. | **Delete local data** in destructive (red) style, then the bank SMS processing note (Truecaller line and any SMS needing attention). |
| 20 | Tap Delete local data, then Cancel. | A confirmation shows the counts and any unsynced warning. Cancel deletes nothing. |
| 21 | Delete local data, confirm (use a test account). | Local transactions are removed as before; other accounts and settings are untouched. |
