/**
 * When several transactions need review close together, one summary replaces individual notifications.
 * Pure so the rule is unit-tested; reviewNotifications.ts applies it.
 */
export const GROUP_WINDOW_MS = 2 * 60 * 1000;

export interface GroupingInput {
  /** Transactions about to be announced. */
  due: number;
  /** Already covered by the standing summary. */
  summarized: number;
  /** Notifications (single or summary members) announced within GROUP_WINDOW_MS. */
  recentlyAnnounced: number;
  /** Most individual notifications to show at once. */
  maxIndividual: number;
}

export function shouldGroup({ due, summarized, recentlyAnnounced, maxIndividual }: GroupingInput): boolean {
  if (due <= 0) return false;
  if (due + summarized > maxIndividual) return true; // a backlog or a busy day
  return due + recentlyAnnounced >= 2; // a burst: do not stack notifications
}

export function isWithinGroupWindow(announcedAtIso: string, now: number): boolean {
  const at = Date.parse(announcedAtIso);
  return Number.isFinite(at) && now - at < GROUP_WINDOW_MS && now >= at - 1000;
}
