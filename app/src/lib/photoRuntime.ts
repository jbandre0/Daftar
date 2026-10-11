import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { preview } from './preview'
import {
  idbPhotoStore, PhotoBlocked, PhotoQueue, PhotoRejected, PhotoRetry,
  type PhotoBackend, type RegisterArgs, type RegisterResult,
} from './photoQueue'

export type MediaRow = { id: string; entry_id: string; storage_path: string; thumb_path: string | null; width: number | null; height: number | null; bytes: number; sha256: string }

/** Reading and removing photos that are already on the server. */
export interface MediaApi {
  listMedia(entryId: string): Promise<MediaRow[]>
  listMediaMany(entryIds: string[]): Promise<MediaRow[]>
  signedUrls(paths: string[]): Promise<Record<string, string>>
  softDelete(id: string): Promise<void>
}

const statusOf = (e: unknown) => Number((e as { statusCode?: string | number; status?: number })?.statusCode ?? (e as { status?: number })?.status ?? 0)

const supabaseBackend: PhotoBackend & MediaApi = {
  async upload(path, blob) {
    let res
    try {
      res = await supabase.storage.from('media').upload(path, blob, { contentType: 'image/webp', upsert: false, cacheControl: '31536000' })
    } catch (e) {
      throw new PhotoRetry(String(e))
    }
    const err = res.error
    if (!err) return
    const status = statusOf(err)
    if (status === 409 || /already exists|duplicate/i.test(err.message)) return // a retry of an upload that landed
    if (status === 403 || status === 401 || /row-level security|unauthorized|not allowed/i.test(err.message)) {
      throw new PhotoBlocked('refused', err.message)
    }
    throw new PhotoRetry(err.message)
  },

  async register(a: RegisterArgs): Promise<RegisterResult> {
    const { data, error } = await supabase.rpc('register_media', {
      p_id: a.id, p_entry_id: a.entryId, p_mime: a.mime, p_width: a.width, p_height: a.height, p_sha256: a.sha256,
    })
    if (!error) return data as RegisterResult
    const m = error.message ?? ''
    if (/storage_cap/.test(m)) throw new PhotoBlocked('cap', m)
    if (/photo_limit/.test(m)) throw new PhotoRejected('limit', m)
    if (/unsupported_type|bad_hash/.test(m)) throw new PhotoRejected('unsupported', m)
    if (error.code === '42501') throw new PhotoBlocked('paused', m)
    throw new PhotoRetry(m) // entry_not_found / upload_missing / network: the text or the file isn't there yet
  },

  async listMedia(entryId) {
    const { data, error } = await supabase
      .from('media')
      .select('id, entry_id, storage_path, thumb_path, width, height, bytes, sha256')
      .eq('entry_id', entryId)
      .is('deleted_at', null)
      .order('created_at')
    if (error) throw error
    return (data as MediaRow[]) ?? []
  },

  async listMediaMany(entryIds) {
    const out: MediaRow[] = []
    for (let i = 0; i < entryIds.length; i += 100) {
      const { data, error } = await supabase
        .from('media')
        .select('id, entry_id, storage_path, thumb_path, width, height, bytes, sha256')
        .in('entry_id', entryIds.slice(i, i + 100))
        .is('deleted_at', null)
      if (error) throw error
      out.push(...((data as MediaRow[]) ?? []))
    }
    return out
  },

  async signedUrls(paths) {
    if (!paths.length) return {}
    const { data, error } = await supabase.storage.from('media').createSignedUrls(paths, 3600) // spec: 1 hour
    if (error) throw error
    const out: Record<string, string> = {}
    for (const d of data ?? []) if (d.path && d.signedUrl) out[d.path] = d.signedUrl
    return out
  },

  async softDelete(id) {
    const { error } = await supabase.from('media').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) throw error
  },
}

/** Real server, or the sample backend in dev preview mode. */
export const backend = (): PhotoBackend & MediaApi => preview.photos ?? supabaseBackend

export const photoQueue = new PhotoQueue({
  store: idbPhotoStore(),
  backend: {
    upload: (p, b) => backend().upload(p, b),
    register: (a) => backend().register(a),
  },
  isOnline: () => navigator.onLine,
})

// ---- what the page shows ---------------------------------------------------------------------------------------

const mediaCache = new Map<string, { at: number; rows: Promise<MediaRow[]> }>()
const urlCache = new Map<string, { at: number; url: string }>()
const URL_TTL = 50 * 60_000 // signed for an hour; renewed before that

export function invalidateMedia(entryId: string) {
  mediaCache.delete(entryId)
}

function mediaFor(entryId: string): Promise<MediaRow[]> {
  const hit = mediaCache.get(entryId)
  if (hit && Date.now() - hit.at < 60_000) return hit.rows
  const rows = backend().listMedia(entryId)
  mediaCache.set(entryId, { at: Date.now(), rows })
  rows.catch(() => mediaCache.delete(entryId))
  return rows
}

export async function signedUrl(path: string): Promise<string | null> {
  const hit = urlCache.get(path)
  if (hit && Date.now() - hit.at < URL_TTL) return hit.url
  const urls = await backend().signedUrls([path])
  const url = urls[path]
  if (url) urlCache.set(path, { at: Date.now(), url })
  return url ?? null
}

export type PhotoView = {
  src: string | null
  /** 'local' = still on this device, 'ready' = from the server, 'loading', 'missing' = removed or unavailable */
  state: 'local' | 'loading' | 'ready' | 'missing'
  width?: number
  height?: number
  blocked?: 'cap' | 'paused' | 'refused'
}

/** A photo's address for an <img>: the device copy while it is waiting to upload, then the server's signed URL. */
export function usePhoto(entryId: string, mediaId: string, size: 'full' | 'thumb' = 'full'): PhotoView {
  const [tick, setTick] = useState(0)
  const [remote, setRemote] = useState<PhotoView>({ src: null, state: 'loading' })

  useEffect(() => photoQueue.subscribe((e) => {
    if (e.type === 'registered' && (e.record.id === mediaId || e.result.id === mediaId)) {
      invalidateMedia(entryId)
      setTick((t) => t + 1)
    } else if (e.type === 'changed') setTick((t) => t + 1)
  }), [entryId, mediaId])

  const queued = photoQueue.has(mediaId)
  const rec = queued ? photoQueue.pending(entryId).find((r) => r.id === mediaId) : undefined

  useEffect(() => {
    if (queued) return
    let live = true
    ;(async () => {
      try {
        const rows = await mediaFor(entryId)
        const row = rows.find((r) => r.id === mediaId)
        if (!row) return live && setRemote({ src: null, state: 'missing' })
        const path = size === 'thumb' && row.thumb_path ? row.thumb_path : row.storage_path
        const url = await signedUrl(path)
        if (live) setRemote(url ? { src: url, state: 'ready', width: row.width ?? undefined, height: row.height ?? undefined } : { src: null, state: 'missing' })
      } catch {
        if (live) setRemote({ src: null, state: 'loading' }) // offline: try again when the queue or network changes
      }
    })()
    return () => {
      live = false
    }
  }, [entryId, mediaId, queued, size, tick])

  if (rec) return { src: photoQueue.localUrl(mediaId, size), state: 'local', width: rec.width, height: rec.height, blocked: rec.blocked }
  return remote
}
