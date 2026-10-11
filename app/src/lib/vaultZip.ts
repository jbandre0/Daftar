/**
 * Photos in the Vault (spec §4 and §6): the .zip export and restore.
 *
 *   daftar-journal-YYYY-MM-DD.zip
 *     daftar-journal-YYYY-MM-DD.json   the same file as the text-only export, with each entry's photos listed
 *     README.txt                       the same plain-English note as the JSON's _readme
 *     media/<first 8 of entry id>/<media id>.webp
 *
 * Every photo is checked against its SHA-256 as it is collected, so a damaged download fails the export loudly
 * instead of producing a backup with a bad photo in it. Restore never re-compresses a photo: it checks the hash,
 * makes a thumbnail, and hands it to the same upload queue as a new photo (so the server enforces the 2 GB cap).
 */
import { strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { Draft } from './draftStore'
import type { MediaApi } from './photoRuntime'
import type { PhotoRecord } from './photoQueue'
import { PHOTOS_PER_ENTRY, sha256Hex, STORAGE_CAP_BYTES, THUMB_ESTIMATE_BYTES } from './photos'
import { buildExport, README, serialize, type EntryResult, type FileEntry, type FileMedia, type JournalFile, type Rpc } from './vault'

export const mediaFileName = (entryId: string, mediaId: string) => `media/${entryId.slice(0, 8)}/${mediaId}.webp`

export class ZipExportError extends Error {}

const dateStamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
export const zipFilename = (d = new Date()) => `daftar-journal-${dateStamp(d)}.zip`

const defaultFetchBlob = async (url: string) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.blob()
}

export type ZipExportOptions = {
  now?: Date
  onProgress?: (done: number, total: number) => void
  fetchBlob?: (url: string) => Promise<Blob>
  concurrency?: number
}

export async function buildZipExport(
  rpc: Rpc, drafts: Draft[], pending: PhotoRecord[], api: MediaApi, opts: ZipExportOptions = {},
): Promise<{ blob: Blob; name: string; json: JournalFile; photos: number }> {
  const now = opts.now ?? new Date()
  const file = await buildExport(rpc, drafts, now)
  file.export_type = 'full_zip'

  // photos still waiting on this device belong in the backup too
  const waiting = new Map<string, PhotoRecord>()
  for (const r of pending) {
    const entry = file.entries.find((e) => e.id === r.entryId)
    if (!entry || entry.media.some((m) => m.id === r.id)) continue
    entry.media.push({ id: r.id, mime: 'image/webp', width: r.width, height: r.height, bytes: r.full.size, sha256: r.sha256, file: mediaFileName(entry.id, r.id), unsynced: true })
    waiting.set(r.id, r)
  }

  const items: { entry: FileEntry; media: FileMedia }[] = file.entries.flatMap((entry) => entry.media.map((media) => ({ entry, media })))
  const remote = items.filter((i) => !waiting.has(i.media.id))
  const entryIds = [...new Set(remote.map((i) => i.entry.id))]
  const rows = entryIds.length ? await api.listMediaMany(entryIds) : []
  const pathOf = new Map(rows.map((r) => [r.id, r.storage_path]))
  const paths = remote.map((i) => pathOf.get(i.media.id)).filter((p): p is string => !!p)
  const urls: Record<string, string> = {}
  for (let i = 0; i < paths.length; i += 100) Object.assign(urls, await api.signedUrls(paths.slice(i, i + 100)))

  // gather, verifying each photo against its checksum
  const fetchBlob = opts.fetchBlob ?? defaultFetchBlob
  const bytes = new Map<string, Uint8Array>()
  let done = 0
  const failed: string[] = []
  const queue = [...items]
  opts.onProgress?.(0, items.length)
  const worker = async () => {
    for (let it = queue.shift(); it; it = queue.shift()) {
      try {
        const local = waiting.get(it.media.id)
        let blob: Blob
        if (local) blob = local.full
        else {
          const path = pathOf.get(it.media.id)
          const url = path ? urls[path] : undefined
          if (!url) throw new Error('no address')
          blob = await fetchBlob(url)
        }
        if ((await sha256Hex(blob)) !== it.media.sha256) throw new Error('checksum mismatch')
        bytes.set(it.media.id, new Uint8Array(await blob.arrayBuffer()))
      } catch {
        failed.push(it.media.id)
      }
      opts.onProgress?.(++done, items.length)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))
  if (failed.length) {
    throw new ZipExportError(`${failed.length} ${failed.length === 1 ? 'photo' : 'photos'} couldn't be downloaded intact. Nothing was saved; try again.`)
  }

  // write the archive (photos are already compressed: stored, not deflated)
  const chunks: Uint8Array[] = []
  await new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, chunk, final) => {
      if (err) return reject(err)
      chunks.push(chunk)
      if (final) resolve()
    })
    const jsonName = `daftar-journal-${dateStamp(now)}.json`
    const j = new ZipDeflate(jsonName, { level: 6 })
    zip.add(j)
    j.push(strToU8(serialize(file)), true)
    const r = new ZipDeflate('README.txt', { level: 6 })
    zip.add(r)
    r.push(strToU8(README + '\n'), true)
    for (const it of items) {
      const f = new ZipPassThrough(it.media.file)
      zip.add(f)
      f.push(bytes.get(it.media.id)!, true)
      bytes.delete(it.media.id) // let go as we go
    }
    zip.end()
  })
  return { blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }), name: zipFilename(now), json: file, photos: items.length }
}

// ---- reading a journal file (.json or .zip) ------------------------------------------------------------------

export type OpenedFile = {
  text: string
  /** the photo for a `file` path in the journal, or null when this file doesn't carry it */
  photo(path: string): Uint8Array | null
  hasPhoto(path: string): boolean
  kind: 'json' | 'zip'
}

const MAX_PHOTO_BYTES = 30 * 1024 * 1024
const MAX_JSON_BYTES = 600 * 1024 * 1024

export class OpenFileError extends Error {}

export async function openJournalFile(file: Blob): Promise<OpenedFile> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  const isZip = head[0] === 0x50 && head[1] === 0x4b
  if (!isZip) return { text: await file.text(), kind: 'json', photo: () => null, hasPhoto: () => false }

  let data: Uint8Array
  try {
    data = new Uint8Array(await file.arrayBuffer())
  } catch {
    throw new OpenFileError("This .zip is too large to open in the browser. Restore the .json inside it instead; photos can be added again later.")
  }
  const names: string[] = []
  try {
    unzipSync(data, { filter: (f) => (names.push(f.name), false) })
  } catch {
    throw new OpenFileError("This .zip couldn't be read. It may be damaged. Nothing was changed.")
  }
  const jsonName = names.filter((n) => /\.json$/i.test(n) && !n.startsWith('media/') && !n.includes('/')).sort()[0]
  if (!jsonName) throw new OpenFileError("There's no journal file inside this .zip. Nothing was changed.")
  const extract = (name: string, limit: number): Uint8Array | null => {
    const got = unzipSync(data, { filter: (f) => f.name === name && f.originalSize <= limit })
    return got[name] ?? null
  }
  const json = extract(jsonName, MAX_JSON_BYTES)
  if (!json) throw new OpenFileError("The journal file inside this .zip is too large or damaged. Nothing was changed.")
  const have = new Set(names)
  return {
    kind: 'zip',
    text: new TextDecoder().decode(json),
    hasPhoto: (p) => have.has(p),
    photo: (p) => (have.has(p) ? extract(p, MAX_PHOTO_BYTES) : null),
  }
}

// ---- restoring photos --------------------------------------------------------------------------------------------

export type PhotoPlanItem = { entryId: string; media: FileMedia }
export type PhotoPlan = {
  /** to bring back, oldest entries first */
  upload: PhotoPlanItem[]
  /** already on that entry (same checksum): skipped, as spec §5 says */
  alreadyHere: number
  /** wouldn't fit under the 2 GB cap */
  skippedByCap: PhotoPlanItem[]
  /** the entry already holds 12 */
  overLimit: PhotoPlanItem[]
  /** listed in the journal but not carried by this file (a text-only export) */
  missing: PhotoPlanItem[]
}

const SKIPPED: EntryResult['outcome'][] = ['skipped_local_newer', 'stays_deleted']

/**
 * Decide which photos a restore will bring back. Pure: takes what the merge did, what's already stored, and how full
 * the account is. A photo goes with its entry only where the entry's text was actually taken (never into an entry the
 * merge left alone), lands on the entry's id HERE (which differs from the file's when the file came from another
 * account), is skipped if that entry already has the same photo, and stops at the 2 GB cap and the 12-per-entry limit.
 */
export function planPhotos(
  file: JournalFile,
  results: EntryResult[],
  localShas: Map<string, Set<string>>,
  localCounts: Map<string, number>,
  usedBytes: number,
  hasFile: (path: string) => boolean,
): PhotoPlan {
  const plan: PhotoPlan = { upload: [], alreadyHere: 0, skippedByCap: [], overLimit: [], missing: [] }
  const byId = new Map(results.map((r) => [r.id, r]))
  let running = usedBytes
  const added = new Map<string, number>()
  for (const entry of file.entries) {
    const r = byId.get(entry.id)
    if (!r || SKIPPED.includes(r.outcome)) continue
    const target = r.stored_as
    const have = localShas.get(target) ?? new Set<string>()
    const seen = new Set<string>()
    for (const media of entry.media) {
      const item = { entryId: target, media }
      if (have.has(media.sha256) || seen.has(media.sha256)) {
        plan.alreadyHere++
        continue
      }
      if (!hasFile(media.file)) {
        plan.missing.push(item)
        continue
      }
      if ((localCounts.get(target) ?? 0) + (added.get(target) ?? 0) >= PHOTOS_PER_ENTRY) {
        plan.overLimit.push(item)
        continue
      }
      const need = media.bytes + THUMB_ESTIMATE_BYTES
      if (running + need > STORAGE_CAP_BYTES) {
        plan.skippedByCap.push(item)
        continue
      }
      running += need
      seen.add(media.sha256)
      added.set(target, (added.get(target) ?? 0) + 1)
      plan.upload.push(item)
    }
  }
  return plan
}

export function planSummary(p: PhotoPlan) {
  return { toUpload: p.upload.length, alreadyHere: p.alreadyHere, skippedByCap: p.skippedByCap.length, overLimit: p.overLimit.length, missing: p.missing.length }
}
export type PhotoSummary = ReturnType<typeof planSummary> & { damaged?: number }

export const hasPhotoActivity = (s: PhotoSummary) => s.toUpload + s.alreadyHere + s.skippedByCap + s.overLimit + s.missing > 0

export const PHOTO_LINES = (s: PhotoSummary): string[] => [
  ...(s.toUpload ? [`Photos brought back: ${s.toUpload}`] : []),
  ...(s.alreadyHere ? [`Photos already here: ${s.alreadyHere}`] : []),
  ...(s.skippedByCap ? [`Photos skipped, your 2 GB is full: ${s.skippedByCap}. Keep the .zip so you can add them later.`] : []),
  ...(s.overLimit ? [`Photos skipped, an entry holds up to 12: ${s.overLimit}`] : []),
  ...(s.missing ? [`Photos listed but not in this file: ${s.missing}. A text-only export doesn't carry photos; use the .zip.`] : []),
  ...(s.damaged ? [`Photos that didn't match their checksum and were left out: ${s.damaged}`] : []),
]
