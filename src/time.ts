import * as chrono from "chrono-node";

const DAY = 86_400_000;

/** A date the user referred to, as a half-open window [start, end) in UTC. */
export interface DateRef {
  text: string; // the words the user used, e.g. "Last Tuesday"
  label: string; // "2026-11-10" or "week of 2026-11-02"
  start: Date;
  end: Date;
}

/** Offset of `tz` from UTC at instant `at`, in minutes (IST = 330). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!m) return 0; // "GMT" exactly
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -mins : mins;
}

/** Calendar date of `at` in `tz`, as YYYY-MM-DD. */
export function localDate(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Human timestamp in `tz`, e.g. "Wed, 11 Nov 2026, 15:00". */
export function formatLocal(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(at);
}

function localMidnightUtc(y: number, m: number, d: number, tz: string): Date {
  const utcMidnight = new Date(Date.UTC(y, m - 1, d));
  return new Date(utcMidnight.getTime() - tzOffsetMinutes(tz, utcMidnight) * 60_000);
}

/**
 * Find date references ("on 3 November", "last Tuesday", "today", "last week")
 * and turn each into a whole-day (or whole-week) window in the user's timezone.
 * Done in code because models are unreliable at relative dates.
 *
 * Two chrono-node quirks are corrected here: a bare weekday resolves to the *nearest*
 * one ("on Monday" said on a Friday gives next Monday), and "this week" anchors on the
 * previous Sunday.
 */
export function resolveDateRefs(text: string, now: Date, tz: string): DateRef[] {
  const parsed = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(tz, now) }, { forwardDate: false });
  const refs: DateRef[] = [];
  for (const r of parsed) {
    let y = r.start.get("year")!, m = r.start.get("month")!, d = r.start.get("day")!;
    if (/\bthis week\b/i.test(r.text)) {
      [y, m, d] = localDate(now, tz).split("-").map(Number);
    } else if (r.start.isCertain("weekday") && !r.start.isCertain("day") && localMidnightUtc(y, m, d, tz).getTime() > now.getTime()) {
      const back = new Date(Date.UTC(y, m - 1, d) - 7 * DAY);
      [y, m, d] = [back.getUTCFullYear(), back.getUTCMonth() + 1, back.getUTCDate()];
    }
    let start = localMidnightUtc(y, m, d, tz);
    let days = 1;
    if (/\bweek\b/i.test(r.text)) {
      const mondayOffset = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
      start = new Date(start.getTime() - mondayOffset * DAY);
      days = 7;
    }
    if (start.getTime() > now.getTime()) continue; // future: nothing to recall
    refs.push({
      text: r.text,
      label: days === 7 ? `week of ${localDate(start, tz)}` : localDate(start, tz),
      start,
      end: new Date(start.getTime() + days * DAY),
    });
  }
  return refs;
}
