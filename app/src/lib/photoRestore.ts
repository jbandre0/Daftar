import { thumbnailFor, PhotoError, sha256Hex, isWebp } from './photos'
import { photoQueue } from './photoRuntime'
import { fetchEntry, saveEntryRemote } from './entries'
import type { OpenedFile, PhotoPlan } from './vaultZip'

export type ApplyResult = { queued: number; damaged: number }

/**
 * Hand a restore's photos to the upload queue. Each photo is checked against its checksum and is WebP, a thumbnail is
 * made from it (the photo itself is never re-compressed), and the queue takes it from there: it uploads in the
 * background, survives closing the tab, and the server enforces the cap as for any photo.
 */
export async function applyPhotoPlan(
  plan: PhotoPlan, opened: OpenedFile, userId: string, onProgress?: (done: number, total: number) => void,
): Promise<ApplyResult> {
  let queued = 0
  let damaged = 0
  let done = 0
  onProgress?.(0, plan.upload.length)
  for (const { entryId, media } of plan.upload) {
    try {
      const bytes = opened.photo(media.file)
      if (!bytes || !isWebp(bytes)) throw new PhotoError('decode', 'not a WebP')
      const blob = new Blob([bytes as BlobPart], { type: 'image/webp' })
      if ((await sha256Hex(blob)) !== media.sha256) throw new PhotoError('decode', 'checksum mismatch')
      const { thumb, width, height } = await thumbnailFor(blob)
      await photoQueue.enqueue({
        id: media.id, userId, entryId, full: blob, thumb, width: media.width || width, height: media.height || height, sha256: media.sha256,
      })
      queued++
    } catch {
      damaged++
    }
    onProgress?.(++done, plan.upload.length)
  }
  return { queued, damaged }
}

/**
 * A photo that registered under a different id than the file gave it (restored from another account, or the same
 * photo was already on the entry) needs the entry's page to point at the id it has HERE.
 */
/** Point every photo node that used media id `from` at `to` (ids are UUIDs: a plain swap can't touch anything else). */
export function swapMediaId(doc: unknown, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(doc).split(from).join(to))
}

export async function patchEntryMediaId(entryId: string, from: string, to: string): Promise<void> {
  const row = await fetchEntry(entryId)
  if (!row) return
  if (!JSON.stringify(row.body_rich).includes(from)) return
  const body_rich = swapMediaId(row.body_rich, from, to)
  const { revision, updated_at: _u, created_at: _c, deleted_at: _d, ...content } = row
  await saveEntryRemote({ ...content, body_rich }, revision, [])
}
