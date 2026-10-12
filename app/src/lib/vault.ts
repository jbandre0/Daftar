/**
 * The Vault: export and restore (spec §4 and §5).
 *
 * Export: export_journal() returns one consistent snapshot; this wraps it with the readme and header and
 * overlays any drafts on this device the server hasn't confirmed yet, so even those can leave with you.
 *
 * Restore: parse and validate the file → restore_meta + restore_batch with p_dry_run = true (the preview)
 * → the user confirms → the same calls with p_dry_run = false. The server applies the conflict rules; this
 * file only batches, remaps and reports. Re-running a restore is always safe.
 */
import type { Draft } from './draftStore'

export const FORMAT = 'daftar.journal'
export const SCHEMA_VERSION = 1
export const APP_VERSION = '1.0.0'
export const BATCH_SIZE = 100

export const README =
  "This is your complete Daftar journal. Each item in 'entries' is one journal entry. 'body_text' is the plain text " +
  "you wrote; 'body_rich' is the same text with formatting, in ProseMirror JSON. Tracks, tags, and chapters are listed " +
  "separately and referenced by id; an entry belongs to a chapter when its entry_date falls between the chapter's " +
  "start_date and end_date (no end_date means ongoing). Dates use ISO 8601 (YYYY-MM-DD); timestamps are UTC. Sealed " +
  "letters are included in full with sealed: true and their unlock_at date; the seal was a promise in the app, not " +
  "encryption. 'entry_versions' holds earlier versions of entries that were kept when a newer copy replaced them. " +
  "Photos are listed under each entry; in a .zip export they are in the /media folder, and in a text-only export the " +
  "'file' paths point to files that are not included. Entries marked \"unsynced\": true were still waiting to reach " +
  'the server from this device when you exported. You can read this file in any text editor. It belongs to you.'

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<unknown>

// ---- file shape -----------------------------------------------------------------------------------------------

export type FileTrack = {
  id: string; name: string; slug: string; color_token: string; sort_order: number; hidden: boolean
  default_template_id: string | null; updated_at: string
}
export type FileTag = { id: string; name: string; updated_at: string }
export type FileChapter = {
  id: string; name: string; description: string; start_date: string; end_date: string | null; color_token: string; updated_at: string
}
export type FileLetter = { to: string | null; sealed: boolean; unlock_at: string | null } | null
export type FileMedia = { id: string; mime: string; width: number; height: number; bytes: number; sha256: string; file: string; unsynced?: true }
export type FileEntry = {
  id: string; entry_date: string; title: string | null; track_id: string | null; tag_ids: string[]; language: string
  body_text: string; body_rich: unknown; word_count: number; fields: Record<string, unknown>; letter: FileLetter
  media: FileMedia[]; created_at: string; updated_at: string; unsynced?: true
}
export type FileVersion = { id: string; entry_id: string; reason: string; created_at: string; snapshot: unknown }

export type JournalFile = {
  _readme: string
  format: typeof FORMAT
  schema_version: number
  exported_at: string
  app_version: string
  export_type: 'full_json' | 'full_zip'
  account: { display_name: string | null; timezone: string; default_language: string }
  tracks: FileTrack[]
  tags: FileTag[]
  chapters: FileChapter[]
  entries: FileEntry[]
  entry_versions: FileVersion[]
}

type ServerExport = Omit<JournalFile, '_readme' | 'format' | 'schema_version' | 'exported_at' | 'app_version' | 'export_type'>

// ---- export ---------------------------------------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z')

/** Overlay unsynced drafts from this device: the newest words are the user's, even if the server hasn't them yet. */
export function overlayDrafts(data: ServerExport, drafts: Draft[]): ServerExport {
  const pending = drafts.filter((d) => d.seq > d.savedSeq)
  if (pending.length === 0) return data
  const entries = [...data.entries]
  for (const d of pending) {
    const c = d.content
    const patch = {
      entry_date: c.entry_date, title: c.title, track_id: c.track_id ?? null, tag_ids: [...(c.tag_ids ?? [])].sort(),
      language: c.language, body_text: c.body_text, body_rich: c.body_rich, word_count: c.word_count,
      fields: c.fields ?? {}, updated_at: iso(d.updatedAt), unsynced: true as const,
      ...(c.is_letter !== undefined || c.sealed !== undefined
        ? { letter: c.is_letter || c.sealed ? { to: c.letter_to ?? null, sealed: !!c.sealed, unlock_at: c.unlock_at ?? null } : null }
        : {}),
    }
    const i = entries.findIndex((e) => e.id === d.id)
    if (i >= 0) entries[i] = { ...entries[i], ...patch }
    else if (c.body_text.trim() || c.title) {
      entries.push({ id: d.id, ...patch, letter: null, media: [], created_at: iso(d.updatedAt) })
    }
  }
  entries.sort((a, b) => (a.entry_date + a.created_at + a.id).localeCompare(b.entry_date + b.created_at + b.id))
  return { ...data, entries }
}

export async function buildExport(rpc: Rpc, drafts: Draft[], now = new Date()): Promise<JournalFile> {
  const data = overlayDrafts((await rpc('export_journal')) as ServerExport, drafts)
  // Key order matches the spec's example, so the file reads top to bottom.
  return {
    _readme: README,
    format: FORMAT,
    schema_version: SCHEMA_VERSION,
    exported_at: now.toISOString(),
    app_version: APP_VERSION,
    export_type: 'full_json',
    account: data.account,
    tracks: data.tracks,
    tags: data.tags,
    chapters: data.chapters,
    entries: data.entries,
    entry_versions: data.entry_versions,
  }
}

export function exportFilename(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, '0')
  return `daftar-journal-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`
}

export const serialize = (f: JournalFile) => JSON.stringify(f, null, 2) + '\n'

// ---- parse and validate ------------------------------------------------------------------------------------

const SHA = /^[0-9a-f]{64}$/
function cleanMedia(raw: unknown, entryId: string, unreadable: Unreadable[]): FileMedia[] {
  if (!Array.isArray(raw)) return []
  const out: FileMedia[] = []
  raw.forEach((m, i) => {
    const ok = isObj(m) && isUuid(m.id) && typeof m.file === 'string' && m.file.length > 0 && typeof m.sha256 === 'string' && SHA.test(m.sha256) && typeof m.bytes === 'number' && m.bytes > 0
    if (!ok) {
      unreadable.push({ what: 'photo', index: i, label: entryId.slice(0, 8), reason: 'missing id, file or checksum' })
      return
    }
    const mm = m as Record<string, unknown>
    out.push({
      id: mm.id as string, mime: typeof mm.mime === 'string' ? mm.mime : 'image/webp', width: Number(mm.width) || 0, height: Number(mm.height) || 0,
      bytes: mm.bytes as number, sha256: mm.sha256 as string, file: mm.file as string,
    })
  })
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v)
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'))
const isTs = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v))
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export type Unreadable = { what: 'entry' | 'track' | 'tag' | 'chapter' | 'version' | 'photo'; index: number; label: string; reason: string }

export type ParseResult =
  | { ok: true; file: JournalFile; unreadable: Unreadable[]; duplicates: number }
  | { ok: false; error: string }

/** Older schema versions are upgraded in memory, one step at a time. (There are none before 1 yet.) */
function upgrade(raw: Record<string, unknown>): Record<string, unknown> {
  const v = raw.schema_version as number
  if (v === SCHEMA_VERSION) return raw
  throw new Error(`No upgrade path from schema ${v}`)
}

export function parseJournal(text: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''))
  } catch {
    return { ok: false, error: "This file isn't valid JSON, so it can't be a Daftar journal. Nothing was changed." }
  }
  if (!isObj(raw) || raw.format !== FORMAT) {
    return { ok: false, error: "This doesn't look like a Daftar journal file. Nothing was changed." }
  }
  const v = raw.schema_version
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return { ok: false, error: "This journal file is missing its version number, so it can't be read safely. Nothing was changed." }
  }
  if (v > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `This file was made by a newer version of Daftar (format ${v}; this app reads up to ${SCHEMA_VERSION}). Update the app, then try again. Nothing was changed.`,
    }
  }
  let src: Record<string, unknown>
  try {
    src = upgrade(raw)
  } catch {
    return { ok: false, error: "This journal file's format can't be upgraded. Nothing was changed." }
  }

  const unreadable: Unreadable[] = []
  const arr = (k: string) => (Array.isArray(src[k]) ? (src[k] as unknown[]) : [])
  const label = (o: Record<string, unknown>) => String(o.title || o.name || o.entry_date || o.id || '').slice(0, 60)

  const tracks: FileTrack[] = []
  arr('tracks').forEach((t, i) => {
    if (!isObj(t) || !isUuid(t.id) || typeof t.name !== 'string' || !t.name.trim()) {
      unreadable.push({ what: 'track', index: i, label: isObj(t) ? label(t) : '', reason: 'missing id or name' })
      return
    }
    tracks.push({
      id: t.id, name: t.name, slug: typeof t.slug === 'string' ? t.slug : '', color_token: typeof t.color_token === 'string' ? t.color_token : 'flame',
      sort_order: typeof t.sort_order === 'number' ? t.sort_order : 0, hidden: t.hidden === true,
      default_template_id: isUuid(t.default_template_id) ? t.default_template_id : null,
      updated_at: isTs(t.updated_at) ? t.updated_at : '1970-01-01T00:00:00Z',
    })
  })

  const tags: FileTag[] = []
  arr('tags').forEach((t, i) => {
    if (!isObj(t) || !isUuid(t.id) || typeof t.name !== 'string' || !t.name.trim()) {
      unreadable.push({ what: 'tag', index: i, label: isObj(t) ? label(t) : '', reason: 'missing id or name' })
      return
    }
    tags.push({ id: t.id, name: t.name.trim(), updated_at: isTs(t.updated_at) ? t.updated_at : '1970-01-01T00:00:00Z' })
  })

  const chapters: FileChapter[] = []
  arr('chapters').forEach((c, i) => {
    const ok = isObj(c) && isUuid(c.id) && typeof c.name === 'string' && c.name.trim() && isDate(c.start_date) &&
      (c.end_date === null || c.end_date === undefined || (isDate(c.end_date) && (c.end_date as string) >= (c.start_date as string)))
    if (!ok) {
      unreadable.push({ what: 'chapter', index: i, label: isObj(c) ? label(c) : '', reason: 'missing id, name or valid dates' })
      return
    }
    const cc = c as Record<string, unknown>
    chapters.push({
      id: cc.id as string, name: cc.name as string, description: typeof cc.description === 'string' ? cc.description : '',
      start_date: cc.start_date as string, end_date: (cc.end_date as string | null) ?? null,
      color_token: typeof cc.color_token === 'string' ? cc.color_token : 'olive',
      updated_at: isTs(cc.updated_at) ? (cc.updated_at as string) : '1970-01-01T00:00:00Z',
    })
  })

  const byId = new Map<string, FileEntry>()
  let duplicates = 0
  arr('entries').forEach((e, i) => {
    if (!isObj(e)) {
      unreadable.push({ what: 'entry', index: i, label: '', reason: 'not an entry' })
      return
    }
    const problems: string[] = []
    if (!isUuid(e.id)) problems.push('no valid id')
    if (!isDate(e.entry_date)) problems.push('no valid entry_date')
    if (typeof e.body_text !== 'string') problems.push('no body_text')
    const updated = isTs(e.updated_at) ? e.updated_at : isTs(e.created_at) ? e.created_at : null
    if (!updated) problems.push('no valid updated_at')
    if (problems.length) {
      unreadable.push({ what: 'entry', index: i, label: label(e), reason: problems.join(', ') })
      return
    }
    let letter: FileLetter = null
    if (isObj(e.letter)) {
      const unlock = isTs(e.letter.unlock_at) ? (e.letter.unlock_at as string) : null
      letter = { to: typeof e.letter.to === 'string' ? e.letter.to : null, sealed: e.letter.sealed === true && !!unlock, unlock_at: unlock }
    }
    const entry: FileEntry = {
      id: e.id as string,
      entry_date: e.entry_date as string,
      title: typeof e.title === 'string' ? e.title : null,
      track_id: isUuid(e.track_id) ? e.track_id : null,
      tag_ids: Array.isArray(e.tag_ids) ? [...new Set(e.tag_ids.filter(isUuid))].sort() : [],
      language: typeof e.language === 'string' && e.language ? e.language : 'en',
      body_text: e.body_text as string,
      body_rich: isObj(e.body_rich) ? e.body_rich : {},
      word_count: typeof e.word_count === 'number' && e.word_count >= 0 ? Math.floor(e.word_count) : 0,
      fields: isObj(e.fields) ? e.fields : {},
      letter,
      media: cleanMedia(e.media, String(e.id), unreadable),
      created_at: isTs(e.created_at) ? (e.created_at as string) : (updated as string),
      updated_at: updated as string,
    }
    const prev = byId.get(entry.id)
    if (prev) {
      duplicates++
      if (Date.parse(prev.updated_at) >= Date.parse(entry.updated_at)) return
    }
    byId.set(entry.id, entry)
  })

  const versions: FileVersion[] = []
  arr('entry_versions').forEach((x, i) => {
    if (!isObj(x) || !isUuid(x.id) || !isUuid(x.entry_id) || !isObj(x.snapshot)) {
      unreadable.push({ what: 'version', index: i, label: '', reason: 'missing id, entry or snapshot' })
      return
    }
    versions.push({
      id: x.id, entry_id: x.entry_id, reason: typeof x.reason === 'string' ? x.reason : 'restore_overwrite',
      created_at: isTs(x.created_at) ? x.created_at : new Date(0).toISOString(), snapshot: x.snapshot,
    })
  })

  const acc = isObj(src.account) ? src.account : {}
  return {
    ok: true,
    duplicates,
    unreadable,
    file: {
      _readme: typeof src._readme === 'string' ? src._readme : README,
      format: FORMAT,
      schema_version: SCHEMA_VERSION,
      exported_at: isTs(src.exported_at) ? (src.exported_at as string) : '',
      app_version: typeof src.app_version === 'string' ? src.app_version : '',
      export_type: src.export_type === 'full_zip' ? 'full_zip' : 'full_json',
      account: {
        display_name: typeof acc.display_name === 'string' ? acc.display_name : null,
        timezone: typeof acc.timezone === 'string' ? acc.timezone : 'UTC',
        default_language: typeof acc.default_language === 'string' ? acc.default_language : 'en',
      },
      tracks, tags, chapters,
      entries: [...byId.values()],
      entry_versions: versions,
    },
  }
}

// ---- restore --------------------------------------------------------------------------------------------------

export type Outcome = 'new' | 'updated' | 'unchanged' | 'skipped_local_newer' | 'restored_from_trash' | 'stays_deleted'
export const OUTCOMES: Outcome[] = ['new', 'updated', 'unchanged', 'skipped_local_newer', 'restored_from_trash', 'stays_deleted']

export type EntryResult = { id: string; stored_as: string; outcome: Outcome; title: string; entry_date: string }
type MetaCounts = Record<'tracks' | 'tags' | 'chapters', { new: number; matched: number; by_name: number; renamed: number }>
type MetaResult = { remap: Record<'tracks' | 'tags' | 'chapters', Record<string, string>>; counts: MetaCounts }

export type RestoreReport = {
  dryRun: boolean
  meta: MetaCounts
  counts: Record<Outcome, number>
  entries: EntryResult[]
  remapped: EntryResult[]
  versionsAdded: number
  unreadable: Unreadable[]
  duplicates: number
}

export async function runRestore(
  rpc: Rpc,
  parsed: Extract<ParseResult, { ok: true }>,
  opts: { dryRun: boolean; batchSize?: number; onProgress?: (done: number, total: number) => void },
): Promise<RestoreReport> {
  const { file } = parsed
  const size = opts.batchSize ?? BATCH_SIZE
  const meta = (await rpc('restore_meta', {
    p: { tracks: file.tracks, tags: file.tags, chapters: file.chapters },
    p_dry_run: opts.dryRun,
  })) as MetaResult

  const versionsByEntry = new Map<string, FileVersion[]>()
  for (const v of file.entry_versions) versionsByEntry.set(v.entry_id, [...(versionsByEntry.get(v.entry_id) ?? []), v])

  const results: EntryResult[] = []
  let versionsAdded = 0
  opts.onProgress?.(0, file.entries.length)
  for (let i = 0; i < file.entries.length; i += size) {
    const batch = file.entries.slice(i, i + size).map(({ unsynced: _u, media: _m, ...e }) => e)
    const versions = batch.flatMap((e) => versionsByEntry.get(e.id) ?? [])
    const r = (await rpc('restore_batch', {
      p: { entries: batch, versions },
      p_remap: meta.remap,
      p_dry_run: opts.dryRun,
    })) as { entries: EntryResult[]; versions_added: number }
    results.push(...r.entries)
    versionsAdded += r.versions_added
    opts.onProgress?.(Math.min(i + size, file.entries.length), file.entries.length)
  }

  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>
  for (const r of results) counts[r.outcome]++
  return {
    dryRun: opts.dryRun,
    meta: meta.counts,
    counts,
    entries: results,
    remapped: results.filter((r) => r.outcome === 'new' && r.stored_as !== r.id),
    versionsAdded,
    unreadable: parsed.unreadable,
    duplicates: parsed.duplicates,
  }
}

// ---- report ---------------------------------------------------------------------------------------------------

export const OUTCOME_TEXT: Record<Outcome, string> = {
  new: 'New entries',
  updated: 'Updated (the file had a newer copy; yours was kept as a version)',
  unchanged: 'Already here, unchanged',
  skipped_local_newer: 'Skipped, yours is newer',
  restored_from_trash: 'Taken out of the trash',
  stays_deleted: 'Left in the trash (you deleted them after this backup)',
}

export function reportText(r: RestoreReport, fileName: string, when = new Date()): string {
  const lines: string[] = []
  lines.push(`Daftar restore report`, `File: ${fileName}`, `When: ${when.toISOString()}`, r.dryRun ? 'Preview only: nothing was written.' : 'Merged into the journal.', '')
  lines.push('Entries')
  for (const o of OUTCOMES) lines.push(`  ${OUTCOME_TEXT[o]}: ${r.counts[o]}`)
  lines.push(`  Saved versions added: ${r.versionsAdded}`, '')
  lines.push('Tracks, tags, chapters')
  for (const k of ['tracks', 'tags', 'chapters'] as const) {
    const c = r.meta[k]
    lines.push(`  ${k}: ${c.new} new, ${c.matched + c.by_name} already here (${c.by_name} matched by name), ${c.renamed} renamed`)
  }
  const list = (title: string, items: EntryResult[]) => {
    if (!items.length) return
    lines.push('', title)
    for (const e of items) lines.push(`  ${e.entry_date}  ${e.title || '(untitled)'}`)
  }
  list('Skipped, yours is newer', r.entries.filter((e) => e.outcome === 'skipped_local_newer'))
  list('Left in the trash', r.entries.filter((e) => e.outcome === 'stays_deleted'))
  if (r.remapped.length) {
    lines.push('', 'Saved under a new id (the original id belongs to another account)')
    for (const e of r.remapped) lines.push(`  ${e.entry_date}  ${e.title || '(untitled)'}  ${e.id} → ${e.stored_as}`)
  }
  if (r.unreadable.length) {
    lines.push('', "Couldn't be read, so they were left out")
    for (const u of r.unreadable) lines.push(`  ${u.what} #${u.index + 1}${u.label ? ` (${u.label})` : ''}: ${u.reason}`)
  }
  if (r.duplicates) lines.push('', `The file listed ${r.duplicates} entr${r.duplicates === 1 ? 'y' : 'ies'} twice; the newest copy of each was used.`)
  return lines.join('\n') + '\n'
}
