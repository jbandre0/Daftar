/**
 * Sealed letters (spec §7, §9). "Sealed means hidden until the date, not encrypted."
 *
 * The server hides a sealed letter in searches and lists and refuses to change one (migration 0008). This file is the
 * app's half of the promise: one definition of "sealed right now", and the one place that turns an entry into the
 * placeholder every list shows instead of its words. There is deliberately NO way to open a letter early.
 */

export type SealFields = { sealed?: boolean | null; unlock_at?: string | null; letter_to?: string | null }

/** Sealed, and its date has not come. */
export function isSealedNow(e: SealFields, now = Date.now()): boolean {
  return !!e.sealed && !!e.unlock_at && Date.parse(e.unlock_at) > now
}

// A letter this device has learned is sealed (the server refused an edit to it). Stale local drafts of it must never
// show up in lists, whatever those drafts say.
const KEY = 'daftar.sealedIds'
function read(): string[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]')
  } catch {
    return []
  }
}
export function markKnownSealed(id: string) {
  try {
    const ids = read()
    if (!ids.includes(id)) localStorage.setItem(KEY, JSON.stringify([...ids, id].slice(-200)))
  } catch {
    /* private mode */
  }
}
export const isKnownSealed = (id: string) => read().includes(id)

/** What a list shows for an entry: nothing of a sealed letter but who it is for and when it opens. */
export type Masked<T> = Omit<T, 'title' | 'body_text'> & { title: string | null; body_text: string; sealed_until: string | null; letter_to: string | null }
export function maskIfSealed<T extends { id: string; title?: string | null; body_text: string } & SealFields>(e: T, now = Date.now()): Masked<T> {
  const hidden = isSealedNow(e, now) || isKnownSealed(e.id)
  return {
    ...e,
    title: hidden ? null : (e.title ?? null),
    body_text: hidden ? '' : e.body_text,
    sealed_until: hidden ? (e.unlock_at ?? null) : null,
    letter_to: hidden ? (e.letter_to ?? null) : null,
  }
}

// ---- dates (a seal opens at the start of a day, in the writer's own time zone) -------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** The earliest day a letter can be sealed until: tomorrow. */
export function earliestSealDay(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return localDay(d)
}

/** "2029-04-20" -> the instant that day begins here, as an ISO string for the server. */
export function unlockInstant(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString()
}

/** The local calendar day of an unlock instant. */
export const unlockDay = (iso: string) => localDay(new Date(iso))

/** "20 April 2029" (the voice table: "Sealed until 20 April 2029.") */
export function unlockLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso))
}

/** A day offset from today, for the quick choices when sealing. */
export function daysFromNow(n: number, now = new Date()): string {
  return localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n))
}
export function monthsFromNow(n: number, now = new Date()): string {
  return localDay(new Date(now.getFullYear(), now.getMonth() + n, now.getDate()))
}

/** Is `day` a valid seal date? (A real date, tomorrow or later.) */
export function validSealDay(day: string, now = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const [y, m, d] = day.split('-').map(Number)
  const parsed = new Date(y, m - 1, d)
  if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) return false
  return day >= earliestSealDay(now)
}
