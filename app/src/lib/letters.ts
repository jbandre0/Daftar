import { supabase } from './supabase'
import { preview } from './preview'
import { syncDeps } from './syncDeps'
import { isKnownSealed, isSealedNow, maskIfSealed } from './seal'

export type LetterRow = {
  id: string
  entry_date: string
  /** null for a sealed letter that hasn't opened: its title is part of what it says */
  title: string | null
  snippet: string | null
  word_count: number
  updated_at: string
  letter_to: string | null
  sealed: boolean
  unlock_at: string | null
  unsynced?: boolean
}

export type LetterState = 'sealed' | 'opened' | 'draft'
export const letterState = (l: Pick<LetterRow, 'sealed' | 'unlock_at'>, now = Date.now()): LetterState =>
  isSealedNow(l, now) ? 'sealed' : l.sealed ? 'opened' : 'draft'

/** Sealed first (soonest to open first), then everything else, newest first. */
export function sortLetters(rows: LetterRow[], now = Date.now()): LetterRow[] {
  return [...rows].sort((a, b) => {
    const sa = letterState(a, now) === 'sealed'
    const sb = letterState(b, now) === 'sealed'
    if (sa !== sb) return sa ? -1 : 1
    if (sa && sb) return Date.parse(a.unlock_at!) - Date.parse(b.unlock_at!)
    return b.updated_at.localeCompare(a.updated_at)
  })
}

const CACHE = 'daftar.letters.'
const cached = (userId: string): LetterRow[] => {
  try {
    return JSON.parse(localStorage.getItem(CACHE + userId) ?? '[]')
  } catch {
    return []
  }
}

/** The Letters screen's list: the server's (already masked), plus letters only on this device, never leaking a sealed one. */
export async function fetchLetters(userId: string): Promise<{ rows: LetterRow[]; offline: boolean }> {
  let rows: LetterRow[] = []
  let offline = false
  if (preview.letters) rows = await preview.letters()
  else {
    const { data, error } = await supabase.rpc('list_letters')
    if (error) {
      offline = true
      rows = cached(userId)
    } else {
      rows = ((data as (LetterRow & { is_sealed_now?: boolean })[]) ?? []).map((r) => ({
        id: r.id, entry_date: String(r.entry_date).slice(0, 10), title: r.title, snippet: r.snippet, word_count: r.word_count,
        updated_at: r.updated_at, letter_to: r.letter_to, sealed: r.sealed, unlock_at: r.unlock_at,
      }))
      try {
        localStorage.setItem(CACHE + userId, JSON.stringify(rows))
      } catch {
        /* ignore */
      }
    }
  }
  const byId = new Map(rows.map((r) => [r.id, r]))
  let drafts: Awaited<ReturnType<typeof syncDeps.store.all>> = []
  try {
    drafts = await syncDeps.store.all()
  } catch {
    /* ignore */
  }
  for (const d of drafts) {
    const c = d.content
    if (d.userId !== userId || d.seq <= d.savedSeq || !(c.is_letter || c.sealed)) continue
    if (!c.body_text.trim() && !c.title && !c.letter_to) continue
    if (isKnownSealed(d.id) && !isSealedNow(c)) continue // a stale draft of a letter sealed elsewhere
    const m = maskIfSealed({ ...c, title: c.title ?? '' })
    byId.set(d.id, {
      id: d.id, entry_date: c.entry_date, title: m.title || null, snippet: m.sealed_until ? null : m.body_text.replace(/\s+/g, ' ').trim().slice(0, 160),
      word_count: c.word_count, updated_at: new Date(d.updatedAt).toISOString(), letter_to: c.letter_to ?? null, sealed: !!c.sealed,
      unlock_at: c.unlock_at ?? null, unsynced: true,
    })
  }
  return { rows: sortLetters([...byId.values()]), offline }
}
