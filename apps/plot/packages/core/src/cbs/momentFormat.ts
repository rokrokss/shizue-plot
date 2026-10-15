/**
 * moment.js's `format`, for SillyTavern's clock macros (`time-macros.js`):
 * `{{date}}` is `LL`, `{{time}}` `LT`, `{{weekday}}` `dddd`, `{{isotime}}`
 * `HH:mm`, `{{isodate}}` `YYYY-MM-DD`, and `{{datetimeformat::F}}` any format.
 *
 * ST never sets moment's locale for them, so they speak moment's default
 * English (`en`) whatever the reader's language: its month and weekday names,
 * its ordinals, its `L…` formats and its weeks, which start on Sunday with the
 * week that holds January 1st. The fields are read in the reader's zone through
 * `Intl` (`wall`), as RisuAI's clock is here, rather than in the server's.
 *
 * The tokens are moment's own, matched by its own pattern, longest first:
 * `[text]` is written as it stands and `\X` is the character X; anything that is
 * no token is itself. The era tokens read every date as AD.
 */
import { offsetAt, wall, type Wall } from './dateFormat.js';

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

/** moment's `en` long date formats; the `l…` ones are its shortened derivations. */
const LONG_FORMATS: Record<string, string> = {
  LTS: 'h:mm:ss A',
  LT: 'h:mm A',
  L: 'MM/DD/YYYY',
  LL: 'MMMM D, YYYY',
  LLL: 'MMMM D, YYYY h:mm A',
  LLLL: 'dddd, MMMM D, YYYY h:mm A',
  l: 'M/D/YYYY',
  ll: 'MMM D, YYYY',
  lll: 'MMM D, YYYY h:mm A',
  llll: 'ddd, MMM D, YYYY h:mm A',
};

/** moment's `localFormattingTokens`. */
const LOCAL_TOKENS = /(\[[^[]*\])|(\\)?(LTS|LT|LL?L?L?|l{1,4})/g;
/** moment's `formattingTokens`. */
const TOKENS =
  /(\[[^[]*\])|(\\)?([Hh]mm(ss)?|Mo|MM?M?M?|Do|DDDo|DD?D?D?|ddd?d?|do?|w[o|w]?|W[o|W]?|Qo?|N{1,5}|YYYYYY|YYYYY|YYYY|YY|y{2,4}|yo?|gg(ggg?)?|GG(GGG?)?|e|E|a|A|hh?|HH?|kk?|mm?|ss?|S{1,9}|x|X|zz?|ZZ?|.)/g;

const pad = (value: number, width: number): string => {
  const text = String(Math.abs(value)).padStart(width, '0');
  return value < 0 ? `-${text}` : text;
};

/** moment's English ordinal. */
const ordinal = (value: number): string => {
  const last = value % 10;
  const suffix =
    Math.floor((value % 100) / 10) === 1 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return `${value}${suffix}`;
};

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInYear = (year: number): number => (isLeap(year) ? 366 : 365);
const dayOfYear = (at: Wall): number => (Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(at.year, 0, 1)) / DAY_MS + 1;

/** moment's `firstWeekOffset`: where week 1 starts, against January 1st. */
function firstWeekOffset(year: number, dow: number, doy: number): number {
  const fwd = 7 + dow - doy;
  const fwdlw = (7 + new Date(Date.UTC(year, 0, fwd)).getUTCDay() - dow) % 7;
  return -fwdlw + fwd - 1;
}

const weeksInYear = (year: number, dow: number, doy: number): number =>
  (daysInYear(year) - firstWeekOffset(year, dow, doy) + firstWeekOffset(year + 1, dow, doy)) / 7;

/** moment's `weekOfYear`: the week and the year it counts in. */
function weekOfYear(at: Wall, dow: number, doy: number): { week: number; year: number } {
  const week = Math.floor((dayOfYear(at) - firstWeekOffset(at.year, dow, doy) - 1) / 7) + 1;
  if (week < 1) return { week: week + weeksInYear(at.year - 1, dow, doy), year: at.year - 1 };
  const total = weeksInYear(at.year, dow, doy);
  if (week > total) return { week: week - total, year: at.year + 1 };
  return { week, year: at.year };
}

/** `en`'s week: Sunday first, the week of January 1st the first. */
const localWeek = (at: Wall) => weekOfYear(at, 0, 6);
/** ISO 8601's: Monday first, the week of January 4th the first. */
const isoWeek = (at: Wall) => weekOfYear(at, 1, 4);

/** `+09:00`, or `+0900` with no separator. */
function zone(offsetMinutes: number, separator: string): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const minutes = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(minutes / 60), 2)}${separator}${pad(minutes % 60, 2)}`;
}

/** A moment of time as its format reads it. */
interface Moment {
  at: Wall;
  time: number;
  ms: number;
  /** Minutes ahead of UTC. */
  offset: number;
  /** `z`: moment's own abbreviation — `UTC` in UTC mode, nothing in local time. */
  abbreviation: string;
}

function token(name: string, m: Moment): string | undefined {
  const { at } = m;
  const hour12 = at.hour % 12 || 12;
  switch (name) {
    case 'M':
      return String(at.month);
    case 'Mo':
      return ordinal(at.month);
    case 'MM':
      return pad(at.month, 2);
    case 'MMM':
      return MONTHS[at.month - 1]!.slice(0, 3);
    case 'MMMM':
      return MONTHS[at.month - 1]!;
    case 'Q':
      return String(Math.ceil(at.month / 3));
    case 'Qo':
      return ordinal(Math.ceil(at.month / 3));
    case 'D':
      return String(at.day);
    case 'Do':
      return ordinal(at.day);
    case 'DD':
      return pad(at.day, 2);
    case 'DDD':
      return String(dayOfYear(at));
    case 'DDDo':
      return ordinal(dayOfYear(at));
    case 'DDDD':
      return pad(dayOfYear(at), 3);
    case 'd':
    case 'e':
      return String(at.weekday);
    case 'do':
      return ordinal(at.weekday);
    case 'dd':
      return WEEKDAYS[at.weekday]!.slice(0, 2);
    case 'ddd':
      return WEEKDAYS[at.weekday]!.slice(0, 3);
    case 'dddd':
      return WEEKDAYS[at.weekday]!;
    case 'E':
      return String(at.weekday || 7);
    case 'w':
      return String(localWeek(at).week);
    case 'wo':
      return ordinal(localWeek(at).week);
    case 'ww':
      return pad(localWeek(at).week, 2);
    case 'W':
      return String(isoWeek(at).week);
    case 'Wo':
      return ordinal(isoWeek(at).week);
    case 'WW':
      return pad(isoWeek(at).week, 2);
    case 'Y':
      return at.year <= 9999 ? pad(at.year, 4) : `+${at.year}`;
    case 'YY':
      return pad(at.year % 100, 2);
    case 'YYYY':
      return pad(at.year, 4);
    case 'YYYYY':
      return pad(at.year, 5);
    case 'YYYYYY':
      return `${at.year < 0 ? '-' : '+'}${pad(Math.abs(at.year), 6)}`;
    case 'y':
    case 'yyy':
      return String(at.year);
    case 'yo':
      return ordinal(at.year);
    case 'yy':
      return pad(at.year % 100, 2);
    case 'yyyy':
      return pad(at.year, 4);
    case 'N':
    case 'NN':
    case 'NNN':
    case 'NNNNN':
      return 'AD';
    case 'NNNN':
      return 'Anno Domini';
    case 'gg':
      return pad(localWeek(at).year % 100, 2);
    case 'gggg':
      return pad(localWeek(at).year, 4);
    case 'ggggg':
      return pad(localWeek(at).year, 5);
    case 'GG':
      return pad(isoWeek(at).year % 100, 2);
    case 'GGGG':
      return pad(isoWeek(at).year, 4);
    case 'GGGGG':
      return pad(isoWeek(at).year, 5);
    case 'a':
      return at.hour > 11 ? 'pm' : 'am';
    case 'A':
      return at.hour > 11 ? 'PM' : 'AM';
    case 'H':
      return String(at.hour);
    case 'HH':
      return pad(at.hour, 2);
    case 'h':
      return String(hour12);
    case 'hh':
      return pad(hour12, 2);
    case 'k':
      return String(at.hour || 24);
    case 'kk':
      return pad(at.hour || 24, 2);
    case 'hmm':
      return `${hour12}${pad(at.minute, 2)}`;
    case 'hmmss':
      return `${hour12}${pad(at.minute, 2)}${pad(at.second, 2)}`;
    case 'Hmm':
      return `${at.hour}${pad(at.minute, 2)}`;
    case 'Hmmss':
      return `${at.hour}${pad(at.minute, 2)}${pad(at.second, 2)}`;
    case 'm':
      return String(at.minute);
    case 'mm':
      return pad(at.minute, 2);
    case 's':
      return String(at.second);
    case 'ss':
      return pad(at.second, 2);
    case 'X':
      return String(Math.floor(m.time / 1000));
    case 'x':
      return String(m.time);
    case 'z':
    case 'zz':
      return m.abbreviation;
    case 'Z':
      return zone(m.offset, ':');
    case 'ZZ':
      return zone(m.offset, '');
  }
  // S … SSSSSSSSS: the fraction of the second, to as many digits.
  if (/^S{1,9}$/.test(name)) return pad(m.ms, 3).padEnd(name.length, '0').slice(0, name.length);
  return undefined;
}

/** A format longer than this is not one anyone wrote by hand; it is written as it stands. */
const MAX_FORMAT_LENGTH = 1_000;

/**
 * `moment(date).format(format)` in English, in `timeZone` — or, with `utcOffset`
 * (minutes), at that fixed offset in UTC mode, as `moment().utc().utcOffset(n)`.
 */
export function momentFormat(format: string, date: Date, timeZone: string, utcOffset?: number): string {
  if (format.length > MAX_FORMAT_LENGTH) return format;
  const time = date.getTime();
  const fixed = utcOffset !== undefined;
  const moment: Moment = {
    at: fixed ? wall(new Date(time + utcOffset * 60_000), 'UTC') : wall(date, timeZone),
    time,
    ms: ((time % 1000) + 1000) % 1000,
    offset: fixed ? utcOffset : Math.round(offsetAt(time, timeZone) / 60_000),
    abbreviation: fixed ? 'UTC' : '',
  };
  // moment's `expandFormat`: the long formats, which may name each other, five passes at most.
  let expanded = format;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = expanded.replace(LOCAL_TOKENS, (whole, _escaped, slash, name: string) =>
      slash || !(name in LONG_FORMATS) ? whole : LONG_FORMATS[name]!,
    );
    if (next === expanded) break;
    expanded = next;
  }
  return expanded.replace(TOKENS, (whole, bracketed: string | undefined, slash: string | undefined, name: string) => {
    if (bracketed) return bracketed.slice(1, -1);
    if (slash) return name;
    return token(name, moment) ?? whole.replace(/\\/g, '');
  });
}
