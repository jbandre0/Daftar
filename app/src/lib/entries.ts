import { supabase } from './supabase'
import { preview } from './preview'

/** The parts of an entry the editor owns. Everything here round-trips through save_entry(). */
export type EntryContent = {
  id: string
  entry_date: string // YYYY-MM-DD, no time zone
  title: string
  body_rich: unknown // Tiptap / ProseMirror JSON
  body_text: string
  language: string
  word_count: number
  /** Optional so drafts written before phase 3 still load; use the helpers below to read them. */
  track_id?: string | null
  fields?: Record<string, unknown>
  tag_ids?: string[]
}

export const trackOf = (c: EntryContent) => c.track_id ?? null
export const fieldsOf = (c: EntryContent) => c.fields ?? {}
export const tagsOf = (c: EntryContent) => c.tag_ids ?? []

export type EntryRow = EntryContent & {
  revision: number
  updated_at: string
  created_at: string
  deleted_at: string | null
}

export type SaveResult = { id: string; revision: number; updated_at: string; conflict: boolean; created: boolean }

/** Thrown when the server refuses a write because of the trial (RLS / 42501). Not retried. */
export class WriteBlockedError extends Error {}
/** Network down, timeout, 5xx: retried with backoff. */
export class OfflineError extends Error {}

const ENTRY_COLUMNS =
  'id, entry_date, title, body_rich, body_text, language, word_count, track_id, fields, revision, updated_at, created_at, deleted_at'

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

export function localDate(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/u).length : 0
}

function classify(error: { code?: string; message?: string } | null, status?: number): Error {
  if (error?.code === '42501') return new WriteBlockedError(error.message)
  if (!status || status >= 500 || status === 408 || /fetch|network|Failed to fetch|Load failed/i.test(error?.message ?? '')) {
    return new OfflineError(error?.message ?? 'offline')
  }
  return new Error(error?.message ?? `save failed (${status})`)
}

export async function saveEntryRemote(content: EntryContent, baseRevision: number, displaced: unknown[]): Promise<SaveResult> {
  let res
  try {
    res = await supabase.rpc('save_entry', { p_entry: content, p_base_revision: baseRevision, p_displaced: displaced })
  } catch (e) {
    throw new OfflineError(String(e))
  }
  if (res.error) throw classify(res.error, res.status)
  return res.data as SaveResult
}

export async function fetchEntry(id: string): Promise<EntryRow | null> {
  const { data, error, status } = await supabase.from('entries').select(ENTRY_COLUMNS).eq('id', id).maybeSingle()
  if (error) throw classify(error, status)
  if (!data) return null
  const tags = await supabase.from('entry_tags').select('tag_id').eq('entry_id', id).is('deleted_at', null)
  if (tags.error) throw classify(tags.error, tags.status)
  return { ...(data as EntryRow), tag_ids: (tags.data ?? []).map((t) => t.tag_id as string) }
}

export type EntrySummary = Pick<EntryRow, 'id' | 'entry_date' | 'title' | 'body_text' | 'word_count' | 'updated_at'>

export async function entriesInRange(start: string, end: string | null): Promise<EntrySummary[]> {
  if (preview.range) return preview.range(start, end)
  let q = supabase
    .from('entries')
    .select('id, entry_date, title, body_text, word_count, updated_at')
    .is('deleted_at', null)
    .gte('entry_date', start)
  if (end) q = q.lte('entry_date', end)
  const { data, error, status } = await q.order('entry_date', { ascending: false }).limit(500)
  if (error) throw classify(error, status)
  return (data as EntrySummary[]) ?? []
}

/** Plain text of a ProseMirror doc, blocks separated by a blank line (matches the editor's getText). */
export function docToText(doc: unknown): string {
  const blocks: string[] = []
  const walk = (n: any): string => {
    if (!n) return ''
    if (n.type === 'text') return n.text ?? ''
    if (n.type === 'hardBreak') return '\n'
    return (n.content ?? []).map(walk).join('')
  }
  const top = (doc as any)?.content ?? []
  for (const n of top) {
    if (n.type === 'bulletList' || n.type === 'orderedList') {
      for (const li of n.content ?? []) blocks.push((li.content ?? []).map(walk).join('\n\n'))
    } else blocks.push(walk(n))
  }
  return blocks.join('\n\n').replace(/^\n+|\n+$/g, '')
}

export async function recentEntries(limit = 5): Promise<EntrySummary[]> {
  if (preview.recent) return preview.recent(limit)
  const { data, error, status } = await supabase
    .from('entries')
    .select('id, entry_date, title, body_text, word_count, updated_at')
    .is('deleted_at', null)
    .order('entry_date', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(limit)
  if (error) throw classify(error, status)
  return (data as EntrySummary[]) ?? []
}
