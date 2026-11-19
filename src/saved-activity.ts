// shared by the desktop and web builds, so no node imports in here

export const SAVED_ACTIVITY_ADD = 'Add to my account';
export const SAVED_ACTIVITY_DISCARD = 'Discard';

export const NOT_LOGGED_IN_TEXT = 'Hackatime: not logged in';
export const NOT_LOGGED_IN_TOOLTIP =
  'Hackatime: not logged in. Your coding time is being saved on this computer and will sync once you log in.';
export const LOGIN_REMINDER =
  "You're not logged in to Hackatime. Your coding time is being saved on this computer and will sync once you log in.";

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const clock = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function dayName(d: Date, now: Date): string {
  if (sameDay(d, now)) return 'today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// "today from 2:10 PM to 4:30 PM", "yesterday at 9:05 AM", "from Nov 17, 2:10 PM to Nov 19, 4:30 PM"
export function describeSavedActivity(times: number[], now: Date = new Date()): string {
  const valid = times.filter((t) => Number.isFinite(t) && t > 0);
  if (valid.length === 0) return 'from before you logged in';
  const first = new Date(Math.min(...valid) * 1000);
  const last = new Date(Math.max(...valid) * 1000);

  if (sameDay(first, last)) {
    const day = dayName(first, now);
    if (clock(first) === clock(last)) return `${day} at ${clock(first)}`;
    return `${day} from ${clock(first)} to ${clock(last)}`;
  }
  return `from ${dayName(first, now)}, ${clock(first)} to ${dayName(last, now)}, ${clock(last)}`;
}

// the question asked before activity captured while logged out goes to whoever logs in,
// since on a shared computer it might belong to someone else
export function savedActivityPrompt(
  count: number,
  times: number[],
  now: Date = new Date(),
): { message: string; detail: string } {
  const plural = count === 1 ? 'heartbeat' : 'heartbeats';
  return {
    message: `Add coding activity saved ${describeSavedActivity(times, now)} to your Hackatime account?`,
    detail:
      `Hackatime saved ${count} ${plural} on this computer while nobody was logged in. ` +
      `If someone else used this computer, choose ${SAVED_ACTIVITY_DISCARD} so their time isn't added to your account.`,
  };
}
