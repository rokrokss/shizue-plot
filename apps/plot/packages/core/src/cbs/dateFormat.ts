/**
 * RisuAI's clock functions, for `cbs.ts`, without a date library.
 *
 * RisuAI reads the device's own clock and zone. Here the clock is the host's —
 * the prompt is built on a server, for a reader somewhere else — so every field
 * is read in the reader's zone through `Intl`, and `new Date()` appears nowhere:
 * without a clock the macros stay as written, which keeps the variable fold
 * deterministic. Month and weekday names are RisuAI's English ones, fixed here
 * rather than asked of the runtime, so a server and a browser cannot disagree.
 */

export interface CbsClock {
  now: Date;
  /** IANA zone the reader is in. */
  timeZone: string;
  /** BCP 47 locale, for `{{messagetime}}` and `{{messagedate}}`. */
  locale: string;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_MS = 86_400_000;

export interface Wall {
  year: number;
  /** 1–12. */
  month: number;
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** 0 is Sunday. */
  weekday: number;
}

/** One formatter per zone; a handful at most, but the zone comes from a request header. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in `timeZone` at `date`. */
export function wall(date: Date, timeZone: string): Wall {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
    });
    if (formatters.size >= 64) formatters.clear();
    formatters.set(timeZone, format);
  }
  const parts: Record<string, string> = {};
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS.findIndex((name) => name.startsWith(parts.weekday ?? '')),
  };
}

/** How far `timeZone` is ahead of UTC at `time`, in ms. */
export function offsetAt(time: number, timeZone: string): number {
  const at = wall(new Date(time), timeZone);
  const ms = ((time % 1000) + 1000) % 1000;
  return Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute, at.second) + ms - time;
}

/**
 * RisuAI's `DDDD`: whole days since local midnight on the last day of the year
 * before — Jan 1 is 1. Measured in elapsed time as upstream measures it, so in a
 * zone that moved its clocks since then the first hour of a day still counts
 * to the day before, exactly as it does in RisuAI there.
 */
function dayOfYear(time: number, year: number, timeZone: string): number {
  const start = Date.UTC(year, 0, 0);
  let epoch = start - offsetAt(start - offsetAt(time, timeZone), timeZone);
  epoch = start - offsetAt(epoch, timeZone);
  return Math.floor((time - epoch) / DAY_MS);
}

const pad = (value: number): string => value.toString().padStart(2, '0');

/**
 * RisuAI's `dateTimeFormat`, for `{{date::FMT}}`, `{{time::FMT}}` and
 * `{{datetimeformat::FMT}}`: the tokens below, replaced one after another over
 * the text the last one left — so `MMMM` writes `April` and `A` then turns it
 * into `PMpril`, as it does in RisuAI. No single-letter tokens, no escaping.
 *
 * `time` is what the caller made of the third argument, which upstream divides
 * by 1000 and then reads as milliseconds: a timestamp lands in January 1970.
 * Kept, because a card that used it was written against what RisuAI showed.
 * 0 is now.
 */
export function dateTimeFormat(main: string, time: number, clock: CbsClock): string {
  const date = time === 0 ? clock.now : new Date(time);
  if (!main) return '';
  const format = main.startsWith(':') ? main.substring(1) : main;
  if (format.length > 300) return '';
  const at = wall(date, clock.timeZone);
  const epoch = date.getTime();
  return format
    .replace(/YYYY/g, at.year.toString())
    .replace(/YY/g, at.year.toString().substring(2))
    .replace(/MMMM/g, MONTHS[at.month - 1]!)
    .replace(/MMM/g, MONTHS[at.month - 1]!.slice(0, 3))
    .replace(/MM/g, pad(at.month))
    .replace(/DDDD/g, dayOfYear(epoch, at.year, clock.timeZone).toString())
    .replace(/DD/g, pad(at.day))
    .replace(/dddd/g, WEEKDAYS[at.weekday]!)
    .replace(/ddd/g, WEEKDAYS[at.weekday]!.slice(0, 3))
    .replace(/HH/g, pad(at.hour))
    .replace(/hh/g, pad(at.hour % 12 || 12))
    .replace(/mm/g, pad(at.minute))
    .replace(/ss/g, pad(at.second))
    .replace(/X/g, Math.floor(epoch / 1000).toString())
    .replace(/x/g, epoch.toString())
    .replace(/A/g, at.hour >= 12 ? 'PM' : 'AM');
}

/** RisuAI's argument-less date (`{{datetimeformat}}`): `Y-M-D`, unpadded, local. */
export function localDate(clock: CbsClock): string {
  const at = wall(clock.now, clock.timeZone);
  return `${at.year}-${at.month}-${at.day}`;
}

/** `{{isotime}}`: UTC `H:M:S`, unpadded. */
export const isoTime = (clock: CbsClock): string =>
  `${clock.now.getUTCHours()}:${clock.now.getUTCMinutes()}:${clock.now.getUTCSeconds()}`;

/** `{{isodate}}`: UTC `Y-M-D`, unpadded. */
export const isoDate = (clock: CbsClock): string =>
  `${clock.now.getUTCFullYear()}-${clock.now.getUTCMonth() + 1}-${clock.now.getUTCDate()}`;

/** `{{unixtime}}`: seconds, rounded rather than floored, as upstream. */
export const unixTime = (clock: CbsClock): string => (clock.now.getTime() / 1000).toFixed(0);

/** RisuAI's durations: `H:MM:SS`, the hours unpadded and unbounded. */
export function duration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}
