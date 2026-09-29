// Calendar layout for the Token usage heatmap (O6).
//
// A heatmap is a calendar first: every cell of a year has to land on the right
// weekday column, and a day the projection has no row for must still get a cell
// (that is what makes "no recorded call" visible instead of missing). Only pure
// date arithmetic lives here - no React, no API - so the layout is testable
// without a window.
//
// Dates are `YYYY-MM-DD` calendar keys, not instants: the projection already
// bucketed every attempt into its local day, and this module never re-derives a
// day from a timestamp. Arithmetic uses `Date.UTC` so a DST change cannot move a
// cell, and the day-of-week is taken at noon UTC to stay clear of any boundary.

/** One day cell of the year grid. */
export interface UsageHeatmapCell {
  /** `YYYY-MM-DD`, the projection's own calendar key. */
  date: string
  /** Monday = 0 … Sunday = 6. */
  weekday: number
  /** Monday-based week index inside the range (0 … weeks - 1). */
  week: number
  /** The month number, 1-12, for the month band above the grid. */
  month: number
  /** Day of month, 1-31: what the tooltip and the detail panel name. */
  dayOfMonth: number
}

export interface UsageHeatmapWeeks {
  /** Monday-based rows; each row is always 7 slots so columns line up. */
  weeks: Array<Array<UsageHeatmapCell | null>>
  /** Weeks actually present in the range, for the "第 N 周" label. */
  weekCount: number
  /** First cell of each week, for the month band (null for a padded week). */
  weekStarts: Array<UsageHeatmapCell | null>
}

const DAY_MS = 86_400_000
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u

/**
 * Parse a calendar key into a UTC day number, or `null` when the text is not a
 * real date. `2026-02-31` has the right shape and no such day, so the round trip
 * through `Date.UTC` is part of the check rather than a formatting detail.
 */
export function usageDayNumber(date: string): number | null {
  const match = ISO_DATE.exec(date)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const stamp = Date.UTC(year, month - 1, day)
  const parsed = new Date(stamp)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null
  }
  return Math.round(stamp / DAY_MS)
}

/** Monday = 0 … Sunday = 6, for a UTC day number. 1970-01-01 was a Thursday. */
export function usageWeekday(dayNumber: number): number {
  return (((dayNumber + 3) % 7) + 7) % 7
}

export function usageDateFromDayNumber(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10)
}

/** Local calendar keys from `from` to `to` inclusive, both `YYYY-MM-DD`. */
export function usageLocalDateRange(from: string, to: string): string[] {
  const start = usageDayNumber(from)
  const end = usageDayNumber(to)
  if (start === null || end === null || end < start) return []
  const dates: string[] = []
  for (let day = start; day <= end; day += 1) dates.push(usageDateFromDayNumber(day))
  return dates
}

/**
 * How many calendar days `from`…`to` covers; 0 when either end is unparseable
 * or inverted. This is the count an API bound has to be checked against, so it
 * is computed the same way the request range is, not from the response.
 */
export function usageRangeDays(from: string, to: string): number {
  return usageLocalDateRange(from, to).length
}

export function usageCalendarYear(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/**
 * The request window for one calendar year, narrowed to the API's day bound.
 * The narrowing is arithmetic on this side so an over-long request is never sent
 * in the first place; a response that still exceeds the bound is refused by
 * `usageSeriesMismatch` rather than drawn.
 */
export function usageYearWindow(year: number, maxRangeDays: number): { from: string; to: string } {
  const window = usageCalendarYear(year)
  if (usageRangeDays(window.from, window.to) <= maxRangeDays) return window
  const end = new Date(Date.UTC(year, 0, 1) + (maxRangeDays - 1) * DAY_MS)
  return { from: window.from, to: end.toISOString().slice(0, 10) }
}

export function usageYear(date: string): number | null {
  const match = ISO_DATE.exec(date)
  return match ? Number(match[1]) : null
}

/**
 * Lay the requested range out as Monday-based weeks, padding the first and last
 * week with `null` so that every weekday column keeps its own row.
 */
export function usageHeatmapWeeks(from: string, to: string): UsageHeatmapWeeks {
  const dates = usageLocalDateRange(from, to)
  const first = dates.length > 0 ? usageDayNumber(dates[0]!) : null
  if (first === null) return { weeks: [], weekCount: 0, weekStarts: [] }
  const leading = usageWeekday(first)
  const slots: Array<UsageHeatmapCell | null> = new Array(leading).fill(null)
  for (const date of dates) {
    const dayNumber = usageDayNumber(date)!
    slots.push({
      date,
      weekday: usageWeekday(dayNumber),
      week: Math.floor((leading + (dayNumber - first)) / 7),
      month: Number(date.slice(5, 7)),
      dayOfMonth: Number(date.slice(8, 10)),
    })
  }
  while (slots.length % 7 !== 0) slots.push(null)
  const weeks: Array<Array<UsageHeatmapCell | null>> = []
  for (let index = 0; index < slots.length; index += 7) weeks.push(slots.slice(index, index + 7))
  return {
    weeks,
    weekCount: weeks.length,
    weekStarts: weeks.map((week) => week.find((cell) => cell !== null) ?? null),
  }
}
