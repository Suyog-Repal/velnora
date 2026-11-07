/**
 * Time-of-day greeting for the Home screen, always computed in Indian Standard Time (Asia/Kolkata, UTC+05:30).
 * India has no daylight saving, so a fixed offset is exact and does not depend on the device timezone setting
 * or on Intl/ICU timezone data being present.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening' | 'Good night';

/** Start of each greeting period, in minutes after IST midnight. */
const MORNING = 5 * 60;     // 05:00
const AFTERNOON = 12 * 60;  // 12:00
const EVENING = 17 * 60;    // 17:00
const NIGHT = 21 * 60;      // 21:00

/** Milliseconds since IST midnight for the given instant. */
function istMsOfDay(now: Date): number {
  return (((now.getTime() + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

export function greetingForIndia(now: Date = new Date()): Greeting {
  const minutes = Math.floor(istMsOfDay(now) / MINUTE_MS);
  if (minutes >= MORNING && minutes < AFTERNOON) return 'Good morning';
  if (minutes >= AFTERNOON && minutes < EVENING) return 'Good afternoon';
  if (minutes >= EVENING && minutes < NIGHT) return 'Good evening';
  return 'Good night'; // 21:00 – 04:59, including midnight
}

/** How long until the greeting next changes (always > 0). Lets the UI schedule a single timeout instead of polling. */
export function msUntilGreetingChange(now: Date = new Date()): number {
  const msOfDay = istMsOfDay(now);
  for (const boundary of [MORNING, AFTERNOON, EVENING, NIGHT]) {
    const at = boundary * MINUTE_MS;
    if (at > msOfDay) return at - msOfDay;
  }
  return DAY_MS - msOfDay + MORNING * MINUTE_MS; // after 21:00 the next change is 05:00 tomorrow
}
