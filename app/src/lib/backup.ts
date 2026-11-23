/**
 * The nightly backup (runs on the owner's Mac, not in the browser): see `scripts/backup/cli.ts` for the Mac side
 * (sign-in, Keychain, launchd, notifications). This file is the part that decides things, kept free of Node so the
 * tests run it with fakes.
 *
 * One run:
 *   1. buildZipExport(): the SAME .zip the Vault's "Export everything" makes (JSON + README + photos, each photo
 *      checked against its SHA-256). A backup is therefore restorable by the app's own Restore.
 *   2. If nothing in the journal changed since the last saved backup (same content hash, ignoring exported_at), no
 *      new file is written. Quiet days cost nothing.
 *   3. Otherwise the file is written (the caller writes to a temp name and renames, so a half-written file never
 *      carries a backup's name), then READ BACK from disk and checked: opens, parses, same entry count, every photo
 *      present with the right checksum. A backup that fails the check is deleted and the run fails loudly.
 *   4. A sharp drop in entries since the last backup is reported (and the run skips rotation, so nothing old is
 *      thrown away that day). Words are never deleted by a backup; this only makes a mistake visible in time.
 *   5. Rotation: every backup from the last 30 days, plus the earliest one of every older month, forever. Only files
 *      named exactly like a Daftar export are ever considered; nothing else in the folder is touched.
 */
import type { MediaApi } from './photoRuntime'
import { parseJournal, serialize, type JournalFile, type Rpc } from './vault'
import { buildZipExport, openJournalFile, zipFilename } from './vaultZip'

export const KEEP_DAYS = 30

export type BackupState = {
  lastSuccessAt: string | null
  lastFile: string | null
  lastEntries: number | null
  lastPhotos: number | null
  lastContentHash: string | null
  lastError: string | null
  lastErrorAt: string | null
}

export const emptyState = (): BackupState => ({
  lastSuccessAt: null, lastFile: null, lastEntries: null, lastPhotos: null, lastContentHash: null, lastError: null, lastErrorAt: null,
})

export type BackupDeps = {
  rpc: Rpc
  media: Pick<MediaApi, 'listMediaMany' | 'signedUrls'>
  fetchBlob?: (url: string) => Promise<Blob>
  now?: Date
  state: BackupState
  /** names of the files already in the backup folder */
  list(): Promise<string[]>
  /** must be atomic: write elsewhere, then rename into place */
  write(name: string, bytes: Uint8Array): Promise<void>
  read(name: string): Promise<Uint8Array>
  remove(name: string): Promise<void>
}

export type BackupResult = {
  outcome: 'saved' | 'unchanged'
  file: string
  entries: number
  photos: number
  /** a plain sentence when something looks wrong but the backup itself is fine */
  warning: string | null
  removed: string[]
  state: BackupState
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** The journal's content, ignoring when it was exported. Equal hash = nothing worth a new file. */
export async function contentHash(file: JournalFile): Promise<string> {
  const text = serialize({ ...file, exported_at: '' })
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

const NAME = /^daftar-journal-(\d{4})-(\d{2})-(\d{2})\.zip$/

/** Which backup files to delete: keep the last 30 days, and the earliest file of each older month. */
export function toPrune(names: string[], now: Date): string[] {
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - KEEP_DAYS)
  const old = names
    .map((n) => ({ n, m: NAME.exec(n) }))
    .filter((x): x is { n: string; m: RegExpExecArray } => !!x.m)
    .map(({ n, m }) => ({ n, day: new Date(+m[1], +m[2] - 1, +m[3]), month: `${m[1]}-${m[2]}` }))
    .filter((x) => x.day < cutoff)
    .sort((a, b) => a.n.localeCompare(b.n))
  const keptMonth = new Set<string>()
  const out: string[] = []
  for (const x of old) {
    if (keptMonth.has(x.month)) out.push(x.n)
    else keptMonth.add(x.month)
  }
  return out
}

/** A drop worth a look: any loss when there were few, otherwise more than 3 entries and more than 5%. */
export function dropWarning(before: number | null, after: number): string | null {
  if (before == null || after >= before) return null
  const lost = before - after
  if (before >= 20 && (lost <= 3 || lost / before <= 0.05)) return null
  return (
    `Your journal has ${lost} fewer ${lost === 1 ? 'entry' : 'entries'} than the last backup (${before} then, ${after} now). ` +
    `If you didn't delete ${lost === 1 ? 'it' : 'them'}, the earlier backups still have every word; old backups were kept.`
  )
}

export class BackupCheckError extends Error {}

/** Read a written backup back and make sure it is whole. */
export async function verifyBackup(bytes: Uint8Array, expected: JournalFile): Promise<void> {
  const opened = await openJournalFile(new Blob([bytes as BlobPart]))
  const parsed = parseJournal(opened.text)
  if (!parsed.ok) throw new BackupCheckError(`The saved backup doesn't read back: ${parsed.error}`)
  if (parsed.file.entries.length !== expected.entries.length || parsed.unreadable.length > 0) {
    throw new BackupCheckError('The saved backup reads back with a different number of entries.')
  }
  for (const e of expected.entries) {
    for (const m of e.media) {
      const photo = opened.photo(m.file)
      if (!photo) throw new BackupCheckError(`A photo is missing from the saved backup (${m.file}).`)
      const sum = hex(await crypto.subtle.digest('SHA-256', photo as BufferSource))
      if (sum !== m.sha256) throw new BackupCheckError(`A photo in the saved backup doesn't match its checksum (${m.file}).`)
    }
  }
}

export async function runBackup(d: BackupDeps): Promise<BackupResult> {
  const now = d.now ?? new Date()
  const { blob, json, photos } = await buildZipExport(d.rpc, [], [], d.media as MediaApi, { now, fetchBlob: d.fetchBlob })
  const hash = await contentHash(json)
  const entries = json.entries.length
  const warning = dropWarning(d.state.lastEntries, entries)
  const existing = await d.list()

  if (hash === d.state.lastContentHash && d.state.lastFile && existing.includes(d.state.lastFile)) {
    const state = { ...d.state, lastSuccessAt: now.toISOString(), lastError: null, lastErrorAt: null }
    return { outcome: 'unchanged', file: d.state.lastFile, entries, photos, warning, removed: [], state }
  }

  const name = zipFilename(now)
  await d.write(name, new Uint8Array(await blob.arrayBuffer()))
  try {
    await verifyBackup(await d.read(name), json)
  } catch (e) {
    await d.remove(name).catch(() => {})
    throw e
  }

  const removed: string[] = []
  if (!warning) {
    for (const old of toPrune([...existing.filter((n) => n !== name), name], now)) {
      await d.remove(old)
      removed.push(old)
    }
  }
  const state: BackupState = {
    lastSuccessAt: now.toISOString(), lastFile: name, lastEntries: entries, lastPhotos: photos, lastContentHash: hash,
    lastError: null, lastErrorAt: null,
  }
  return { outcome: 'saved', file: name, entries, photos, warning, removed, state }
}
