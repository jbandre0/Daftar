/**
 * Browse and Read data (spec §7). Server first (browse_entries / entry_dates), with this device's
 * unsynced drafts folded in so text written offline is findable, and with the drafts alone as the
 * fallback when the server can't be reached.
 */
import { supabase } from './supabase'
import { preview } from './preview'
import { syncDeps } from './syncDeps'
import type { Draft } from './draftStore'
import type { EntryContent } from './entries'

export type BrowseFilters = {
  q: string
  track: string | null
  tags: string[]
  language: string | null
  from: string | null
  to: string | null
}
export const NO_FILTERS: BrowseFilters = { q: '', track: null, tags: [], language: null, from: null, to: null }

export type BrowseRow = {
  id: string
  entry_date: string
  title: string | null
  /** null = a sealed letter whose date hasn't come: its words are never shown */
  snippet: string | null
  word_count: number
  updated_at: string
  track_id: string | null
  language: string
  tag_ids: string[]
  unsynced?: boolean
}
export type BrowsePage = { rows: BrowseRow[]; total: number; offline: boolean }

export const PAGE_SIZE = 40

export const activeFilterCount = (f: BrowseFilters) =>
  (f.track ? 1 : 0) + f.tags.length + (f.language ? 1 : 0) + (f.from || f.to ? 1 : 0)

// ---- pure helpers (also used by preview mode and tests) --------------------------------------------------

const norm = (s: string) => s.toLocaleLowerCase()

/** Does this local copy match? Same spirit as the server: every word of the query, anywhere in title or text. */
export function matchesFilters(c: EntryContent, f: BrowseFilters): boolean {
  if (f.track && (c.track_id ?? null) !== f.track) return false
  if (f.language && c.language !== f.language) return false
  if (f.from && c.entry_date < f.from) return false
  if (f.to && c.entry_date > f.to) return false
  if (f.tags.length && !f.tags.every((t) => (c.tag_ids ?? []).includes(t))) return false
  const q = f.q.trim()
  if (q) {
    const hay = norm((c.title ?? '') + ' ' + c.body_text)
    const words = norm(q).split(/\s+/).filter(Boolean)
    if (!hay.includes(norm(q)) && !words.every((w) => hay.includes(w))) return false
  }
  return true
}

/** ~160 characters around the first match (or the start). */
export function makeSnippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const needle = norm(q.trim())
  const at = needle ? norm(flat).indexOf(needle) : -1
  if (at < 0) return flat.slice(0, 160)
  return flat.slice(Math.max(0, at - 50), Math.max(0, at - 50) + 160)
}

export function rowFromContent(c: EntryContent, updatedAt: number, q: string, unsynced: boolean): BrowseRow {
  return {
    id: c.id, entry_date: c.entry_date, title: c.title || null, snippet: makeSnippet(c.body_text, q), word_count: c.word_count,
    updated_at: new Date(updatedAt).toISOString(), track_id: c.track_id ?? null, language: c.language, tag_ids: c.tag_ids ?? [], unsynced,
  }
}

const byNewest = (a: BrowseRow, b: BrowseRow) => (b.entry_date + b.updated_at).localeCompare(a.entry_date + a.updated_at)

/** Fold unsynced local drafts into a page of server rows: they replace their server copy, or are added. */
export function overlayDrafts(rows: BrowseRow[], drafts: Draft[], f: BrowseFilters): { rows: BrowseRow[]; added: number } {
  const byId = new Map(rows.map((r) => [r.id, r]))
  let added = 0
  const front: BrowseRow[] = []
  for (const d of drafts) {
    if (d.seq <= d.savedSeq) continue
    const had = byId.has(d.id)
    if (!matchesFilters(d.content, f)) {
      if (had) byId.delete(d.id) // the unsynced edit no longer matches the filters
      continue
    }
    if (!d.content.body_text.trim() && !d.content.title) continue
    const row = rowFromContent(d.content, d.updatedAt, f.q, true)
    if (had) byId.set(d.id, row)
    else {
      front.push(row)
      added++
    }
  }
  const merged = [...front, ...byId.values()]
  return { rows: f.q.trim() ? [...front, ...rows.filter((r) => byId.has(r.id)).map((r) => byId.get(r.id)!)] : merged.sort(byNewest), added }
}

// ---- server calls ----------------------------------------------------------------------------------------

async function localDrafts(): Promise<Draft[]> {
  try {
    return await syncDeps.store.all()
  } catch {
    return []
  }
}

export async function browseEntries(userId: string, f: BrowseFilters, offset = 0): Promise<BrowsePage> {
  const drafts = (await localDrafts()).filter((d) => d.userId === userId)
  if (preview.browse) {
    const page = await preview.browse(f, offset)
    return { ...page, offline: false }
  }
  const { data, error } = await supabase.rpc('browse_entries', {
    p_q: f.q.trim() || null,
    p_track: f.track,
    p_tags: f.tags.length ? f.tags : null,
    p_language: f.language,
    p_from: f.from,
    p_to: f.to,
    p_limit: PAGE_SIZE,
    p_offset: offset,
  })
  if (error) {
    // Offline (or the server is unreachable): search what is on this device.
    const rows = drafts
      .filter((d) => matchesFilters(d.content, f) && (d.content.body_text.trim() || d.content.title))
      .map((d) => rowFromContent(d.content, d.updatedAt, f.q, d.seq > d.savedSeq))
      .sort(byNewest)
    return { rows: rows.slice(offset, offset + PAGE_SIZE), total: rows.length, offline: true }
  }
  const server = (data as (BrowseRow & { total_count: number | string })[]) ?? []
  let rows: BrowseRow[] = server.map(({ total_count: _t, ...r }) => ({ ...r, entry_date: String(r.entry_date).slice(0, 10) }))
  let total = server.length ? Number(server[0].total_count) : 0
  if (offset === 0) {
    const o = overlayDrafts(rows, drafts, f)
    rows = o.rows
    total += o.added
  }
  return { rows, total, offline: false }
}

/** How many entries each day of a month has (for the calendar dots). */
export async function fetchMonthDays(userId: string, year: number, month0: number): Promise<Record<string, number>> {
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = `${year}-${pad(month0 + 1)}-01`
  const end = `${year}-${pad(month0 + 1)}-${pad(new Date(year, month0 + 1, 0).getDate())}`
  const counts: Record<string, number> = {}
  const add = (d: string) => (counts[d] = (counts[d] ?? 0) + 1)
  const drafts = (await localDrafts()).filter((d) => d.userId === userId)
  let serverIds = new Set<string>()
  if (preview.monthDays) {
    Object.assign(counts, await preview.monthDays(start, end))
  } else {
    const { data, error } = await supabase.from('entries').select('id, entry_date').is('deleted_at', null).gte('entry_date', start).lte('entry_date', end).limit(1000)
    if (!error) {
      serverIds = new Set((data ?? []).map((r) => r.id as string))
      for (const r of data ?? []) add(String(r.entry_date).slice(0, 10))
    }
  }
  for (const d of drafts) {
    if (serverIds.has(d.id) || (!d.content.body_text.trim() && !d.content.title)) continue
    if (preview.monthDays) continue
    if (d.content.entry_date >= start && d.content.entry_date <= end) add(d.content.entry_date)
  }
  return counts
}

/** Every date that has an entry, ascending. */
export async function fetchAllDates(userId: string): Promise<string[]> {
  const set = new Set<string>()
  if (preview.allDates) (await preview.allDates()).forEach((d) => set.add(d))
  else {
    const { data, error } = await supabase.rpc('entry_dates')
    if (!error) for (const d of (data as string[]) ?? []) set.add(String(d).slice(0, 10))
  }
  for (const d of await localDrafts()) {
    if (d.userId === userId && (d.content.body_text.trim() || d.content.title)) set.add(d.content.entry_date)
  }
  return [...set].sort()
}

export type DayEntry = {
  id: string
  entry_date: string
  title: string
  body_rich: unknown
  body_text: string
  language: string
  word_count: number
  track_id: string | null
  tag_ids: string[]
  unsynced?: boolean
}

/** The full entries for one day (Read mode). */
export async function fetchDay(userId: string, date: string): Promise<DayEntry[]> {
  const out = new Map<string, DayEntry>()
  if (preview.day) (await preview.day(date)).forEach((e) => out.set(e.id, e))
  else {
    const { data, error } = await supabase
      .from('entries')
      .select('id, entry_date, title, body_rich, body_text, language, word_count, track_id, sealed, unlock_at, created_at')
      .is('deleted_at', null)
      .eq('entry_date', date)
      .order('created_at')
    if (!error && data?.length) {
      const ids = data.map((r) => r.id as string)
      const tags = await supabase.from('entry_tags').select('entry_id, tag_id').in('entry_id', ids).is('deleted_at', null)
      for (const r of data) {
        const hidden = r.sealed && r.unlock_at && Date.parse(r.unlock_at as string) > Date.now()
        out.set(r.id as string, {
          id: r.id as string, entry_date: date, title: (r.title as string) ?? '', language: r.language as string,
          word_count: r.word_count as number, track_id: (r.track_id as string) ?? null,
          body_rich: hidden ? { type: 'doc', content: [] } : r.body_rich, body_text: hidden ? '' : (r.body_text as string),
          tag_ids: (tags.data ?? []).filter((t) => t.entry_id === r.id).map((t) => t.tag_id as string),
        })
      }
    }
  }
  for (const d of await localDrafts()) {
    if (d.userId !== userId || d.content.entry_date !== date || (!d.content.body_text.trim() && !d.content.title)) continue
    if (d.seq <= d.savedSeq && out.has(d.id)) continue // the server copy is as new
    const c = d.content
    out.set(d.id, {
      id: d.id, entry_date: date, title: c.title, body_rich: c.body_rich, body_text: c.body_text, language: c.language,
      word_count: c.word_count, track_id: c.track_id ?? null, tag_ids: c.tag_ids ?? [], unsynced: d.seq > d.savedSeq,
    })
  }
  return [...out.values()]
}
