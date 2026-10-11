/**
 * Read mode: "read like a book". One day per spread. Runs of days with nothing written collapse into a single
 * "3 quiet days" spread, so the book never has blank pages and never counts what was missed.
 */
export type Spread =
  | { kind: 'day'; date: string }
  | { kind: 'quiet'; from: string; to: string; days: number }

const MS = 86_400_000
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const addDays = (iso: string, n: number) => new Date(toUtc(iso) + n * MS).toISOString().slice(0, 10)
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / MS)

/** `dates` must be ascending and unique (as entry_dates() returns them). Oldest spread first. */
export function buildSpreads(dates: string[]): Spread[] {
  const out: Spread[] = []
  dates.forEach((d, i) => {
    if (i > 0) {
      const gap = daysBetween(dates[i - 1], d) - 1
      if (gap > 0) out.push({ kind: 'quiet', from: addDays(dates[i - 1], 1), to: addDays(d, -1), days: gap })
    }
    out.push({ kind: 'day', date: d })
  })
  return out
}

export const spreadKey = (s: Spread) => (s.kind === 'day' ? s.date : `quiet:${s.from}`)

/** The spread a date belongs to: its day, or the quiet run around it, or the nearest end of the book. */
export function spreadIndexFor(spreads: Spread[], date: string): number {
  if (!spreads.length) return -1
  const first = spreads[0]
  const last = spreads[spreads.length - 1]
  if (date <= (first.kind === 'day' ? first.date : first.from)) return 0
  if (date >= (last.kind === 'day' ? last.date : last.to)) return spreads.length - 1
  const i = spreads.findIndex((s) => (s.kind === 'day' ? s.date === date : date >= s.from && date <= s.to))
  return i >= 0 ? i : spreads.length - 1
}

export const quietLabel = (s: Extract<Spread, { kind: 'quiet' }>) => `${s.days} quiet ${s.days === 1 ? 'day' : 'days'}`
