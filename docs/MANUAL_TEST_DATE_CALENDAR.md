# Manual test: Transactions date calendar

`npm test` covers the logic (`src/services/__tests__/calendarMarks.test.ts`): the grouped query (scope, soft-deleted rows,
local-day grouping under several timezones, midnight edges), month list, single-day vs range taps, summary and chip
label. It cannot show real layout, scrolling, theming or device timezone behaviour, so run this on a device or emulator.
No native change: a normal JS reload / `npx expo run:android` is enough.

## Setup

Have transactions on several days across at least 2 months (add some by hand with the date picker, backdated):
- a day with only an **expense**, a day with only **income**, a day with **both**, and days with nothing;
- one transaction at **11:55 PM** and one at **12:05 AM** on consecutive days;
- one transaction older than 3 months so the list has several months.

## Tests

| # | Steps | Expected |
|---|-------|----------|
| 1 | Transactions > tap the date chip (reads "All dates"). | "Filter by date" sheet: small legend (Expense / Income), Sun-Sat header, months listed from the current month downwards, newest first. |
| 2 | Scroll down through the months. | Goes back to the month of your oldest transaction and stops. Smooth scrolling, no blank flashes, the sheet does not scroll instead of the calendar. |
| 3 | Look at the days from the setup. | Expense-only: red dot on the **left** under the date. Income-only: green dot on the **right**. Both: two dots. None: no dots. Check a grayscale/colour-blind view if you can: position alone tells them apart. |
| 4 | Look at future dates and today. | Future dates are dim and do nothing when tapped. Today has a green ring. |
| 5 | Tap one date. | That day gets a solid green circle. Summary shows the date, its transaction count, Spent and Received. Matches the day's rows. |
| 6 | Tap a second, later date. | Both ends are solid green with a light green band between them. Summary covers the whole range, both days included. |
| 7 | With a range selected, tap an **earlier** date than the first after tapping one single day. | Range runs earlier date to later date (order does not matter). |
| 8 | Tap a third date. | Selection restarts with only that single day. |
| 9 | Tap the same date twice. | Stays a single day. |
| 10 | Tap **Apply**. | Sheet closes. Chip reads e.g. "21 Nov 2026" (one day) or "10 Nov to 21 Nov" (range this year; years are shown when the range is not in the current year). List shows only transactions in that day/range. |
| 11 | With a range applied, use the search box, the All/Expenses/Income tabs and a category chip. | Each narrows the list further inside the date range; the chip stays. |
| 12 | Reopen the chip. | Opens at the month of the applied date with it still highlighted. **Clear filter** resets to "All dates" and the full list. The x next to the chip also clears. |
| 13 | Open the sheet, change nothing, close with X or swipe down. | Applied filter is unchanged. |
| 14 | The 11:55 PM and 12:05 AM transactions. | They show under their own, different days, and the day dots/summary agree with the list for both. |
| 15 | Add a new expense dated today, then reopen the calendar. | Today now shows a red dot. Delete a transaction that was the only one on a day: its dot disappears. |
| 16 | Switch between guest and an account (or sign in as another user). | Dots and totals only reflect the current scope. |
| 17 | Turn on airplane mode, open the calendar. | Works exactly the same. |
| 18 | Change the device timezone (e.g. to Los Angeles), return to Velnora without restarting, reopen the calendar. | Dots move to the new local days and agree with what the list shows for those days. Change it back afterwards. (SQLite is not used for the local-date conversion, but confirm this on a real device.) |
| 19 | Fresh install / Guest with no transactions, or the first day of use. | Calendar shows only the current month, no dots, no errors. Apply with a day gives the "Nothing matches" empty state with a clear option. |
| 20 | Dark theme, large font size, TalkBack. | Readable contrast. TalkBack reads each day like "21 Nov 2026, today, expenses and income, selected". |
| 21 | An account with a large history (1000+ transactions or several years). | Sheet opens quickly; scrolling stays smooth. |
