/**
 * The upload queue (spec §6, steps 6-7): "Insert a placeholder node in the editor immediately, upload in the
 * background, and swap in the real image when done. If the upload fails, keep the image in IndexedDB and retry."
 *
 * A photo is processed in the browser, written to IndexedDB, and only then is the editor told it exists. The queue
 * uploads both files, then asks the server to register them (register_media: the server reads the real sizes and
 * enforces the cap). The IndexedDB copy goes only after the server confirms. Offline, or before the entry's text has
 * reached the server, it simply waits and retries with backoff. It never blocks writing, and a photo that is
 * refused never costs a word of text.
 */
import { createStore, promisifyRequest, type UseStore } from 'idb-keyval'

export type RegisterArgs = { id: string; entryId: string; mime: 'image/webp'; width: number; height: number; sha256: string }
export type RegisterResult = { id: string; duplicate: boolean; remapped: boolean }

/** The server accepted nothing right now, but will later (offline, entry not saved yet, file not visible yet). */
export class PhotoRetry extends Error {}
/** The server refused: waiting won't help until something changes. */
export class PhotoBlocked extends Error {
  constructor(readonly reason: 'cap' | 'paused' | 'refused', message: string) {
    super(message)
  }
}
/** This photo can never be added (the entry already holds 12). */
export class PhotoRejected extends Error {
  constructor(readonly reason: 'limit' | 'unsupported', message: string) {
    super(message)
  }
}

export interface PhotoBackend {
  /** Idempotent: uploading a file that is already there succeeds. */
  upload(path: string, blob: Blob): Promise<void>
  register(a: RegisterArgs): Promise<RegisterResult>
}

export type PhotoRecord = {
  id: string
  userId: string
  entryId: string
  full: Blob
  thumb: Blob
  width: number
  height: number
  sha256: string
  attempts: number
  addedAt: number
  blocked?: 'cap' | 'paused' | 'refused'
}

export interface PhotoStore {
  put(r: PhotoRecord): Promise<void>
  del(id: string): Promise<void>
  all(): Promise<PhotoRecord[]>
}

export function idbPhotoStore(dbName = 'daftar-photos', storeName = 'queue'): PhotoStore {
  let store: UseStore | null = null
  const s = () => (store ??= createStore(dbName, storeName))
  return {
    put: (r) => s()('readwrite', (st) => { st.put(r, r.id); return promisifyRequest(st.transaction) }),
    del: (id) => s()('readwrite', (st) => { st.delete(id); return promisifyRequest(st.transaction) }),
    all: () => s()('readonly', (st) => promisifyRequest(st.getAll() as IDBRequest<PhotoRecord[]>)),
  }
}

export const photoPath = (userId: string, entryId: string, mediaId: string) => `${userId}/${entryId}/${mediaId}.webp`
export const thumbPath = (userId: string, entryId: string, mediaId: string) => `${userId}/${entryId}/${mediaId}.thumb.webp`

export type QueueEvent =
  | { type: 'registered'; record: PhotoRecord; result: RegisterResult }
  | { type: 'rejected'; record: PhotoRecord; reason: PhotoRejected['reason'] }
  | { type: 'changed' }

export type QueueDeps = {
  store: PhotoStore
  backend: PhotoBackend
  isOnline: () => boolean
  /** Backoff: retry n after min(maxMs, baseMs * 2^n). */
  timing?: { baseMs: number; maxMs: number }
}

export class PhotoQueue {
  private records = new Map<string, PhotoRecord>()
  private listeners = new Set<(e: QueueEvent) => void>()
  private running = false
  private again = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private urls = new Map<string, string>()
  private timing: { baseMs: number; maxMs: number }

  constructor(private deps: QueueDeps) {
    this.timing = deps.timing ?? { baseMs: 3000, maxMs: 60_000 }
  }

  subscribe(fn: (e: QueueEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(e: QueueEvent) {
    for (const fn of this.listeners) fn(e)
  }

  /** Load what an earlier session left behind and start uploading. */
  async start(userId: string) {
    for (const r of await this.deps.store.all()) if (r.userId === userId && !this.records.has(r.id)) this.records.set(r.id, r)
    this.emit({ type: 'changed' })
    this.kick()
  }

  async enqueue(r: Omit<PhotoRecord, 'attempts' | 'addedAt'>): Promise<PhotoRecord> {
    const rec: PhotoRecord = { ...r, attempts: 0, addedAt: Date.now() }
    await this.deps.store.put(rec) // on disk first: only now is the photo "added"
    this.records.set(rec.id, rec)
    this.emit({ type: 'changed' })
    this.kick()
    return rec
  }

  /** Waiting photos, oldest first. */
  pending(entryId?: string): PhotoRecord[] {
    return [...this.records.values()].filter((r) => !entryId || r.entryId === entryId).sort((a, b) => a.addedAt - b.addedAt)
  }
  has(id: string) {
    return this.records.has(id)
  }
  /** A local URL for a photo that hasn't reached the server yet (so it shows up straight away). */
  localUrl(id: string, which: 'full' | 'thumb' = 'full'): string | null {
    const r = this.records.get(id)
    if (!r) return null
    const key = `${id}:${which}`
    let u = this.urls.get(key)
    if (!u) {
      u = URL.createObjectURL(which === 'full' ? r.full : r.thumb)
      this.urls.set(key, u)
    }
    return u
  }
  private forget(id: string) {
    this.records.delete(id)
    // keep the object URL alive a moment: an <img> may still be showing it while the signed URL loads
    for (const which of ['full', 'thumb']) {
      const key = `${id}:${which}`
      const u = this.urls.get(key)
      if (u) setTimeout(() => URL.revokeObjectURL(u), 15_000)
      this.urls.delete(key)
    }
  }

  /** Try again now: network back, trial unlocked, space freed, or the entry has just been saved. */
  retryNow() {
    for (const r of this.records.values()) delete r.blocked
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.kick()
  }

  /** Make a photo that will never be uploaded go away (the writer removed it, or it is refused for good). */
  async discard(id: string) {
    const r = this.records.get(id)
    if (!r) return
    await this.deps.store.del(id)
    this.forget(id)
    this.emit({ type: 'changed' })
  }

  kick() {
    if (this.running) {
      this.again = true
      return
    }
    void this.run()
  }

  private async run() {
    this.running = true
    try {
      do {
        this.again = false
        let retry = false
        for (const r of this.pending()) {
          if (r.blocked) continue
          if (!this.deps.isOnline()) {
            retry = true
            break
          }
          const outcome = await this.process(r)
          if (outcome === 'retry') retry = true
        }
        if (retry) this.schedule()
      } while (this.again)
    } finally {
      this.running = false
    }
  }

  private schedule() {
    if (this.timer) return
    const n = Math.max(0, ...[...this.records.values()].filter((r) => !r.blocked).map((r) => r.attempts))
    const ms = Math.min(this.timing.maxMs, this.timing.baseMs * 2 ** Math.max(0, n - 1))
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, ms)
  }

  private async process(r: PhotoRecord): Promise<'done' | 'retry' | 'blocked' | 'rejected'> {
    try {
      await this.deps.backend.upload(photoPath(r.userId, r.entryId, r.id), r.full)
      await this.deps.backend.upload(thumbPath(r.userId, r.entryId, r.id), r.thumb)
      const result = await this.deps.backend.register({ id: r.id, entryId: r.entryId, mime: 'image/webp', width: r.width, height: r.height, sha256: r.sha256 })
      await this.deps.store.del(r.id) // gone from the device only after the server has confirmed
      this.forget(r.id)
      this.emit({ type: 'registered', record: r, result })
      this.emit({ type: 'changed' })
      return 'done'
    } catch (e) {
      if (e instanceof PhotoBlocked) {
        r.blocked = e.reason
        this.emit({ type: 'changed' })
        return 'blocked'
      }
      if (e instanceof PhotoRejected) {
        await this.deps.store.del(r.id)
        this.forget(r.id)
        this.emit({ type: 'rejected', record: r, reason: e.reason })
        this.emit({ type: 'changed' })
        return 'rejected'
      }
      r.attempts++
      await this.deps.store.put(r).catch(() => {})
      this.emit({ type: 'changed' })
      return 'retry'
    }
  }
}
