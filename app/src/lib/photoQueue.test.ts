import { describe, expect, it, vi } from 'vitest'
import {
  photoPath, PhotoBlocked, PhotoQueue, PhotoRejected, PhotoRetry, thumbPath,
  type PhotoBackend, type PhotoRecord, type PhotoStore, type QueueEvent, type RegisterArgs,
} from './photoQueue'

vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => `blob:${Math.random()}`, revokeObjectURL: () => {} }))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return
    await sleep(4)
  }
  throw new Error('timed out')
}

class MemStore implements PhotoStore {
  rows = new Map<string, PhotoRecord>()
  async put(r: PhotoRecord) { this.rows.set(r.id, structuredClone({ ...r, full: r.full, thumb: r.thumb })) }
  async del(id: string) { this.rows.delete(id) }
  async all() { return [...this.rows.values()] }
}

class FakeBackend implements PhotoBackend {
  files = new Set<string>()
  registered: RegisterArgs[] = []
  uploads: string[] = []
  online = true
  entrySaved = true
  failUploadAt: string | null = null
  registerError: Error | null = null
  /** refuse only these photos */
  refuseIds = new Map<string, Error>()
  async upload(path: string) {
    if (!this.online) throw new PhotoRetry('offline')
    this.uploads.push(path)
    if (this.failUploadAt && path.endsWith(this.failUploadAt)) { this.failUploadAt = null; throw new PhotoRetry('flaky') }
    this.files.add(path)
  }
  async register(a: RegisterArgs) {
    if (!this.online) throw new PhotoRetry('offline')
    if (this.registerError) throw this.registerError
    const refused = this.refuseIds.get(a.id)
    if (refused) throw refused
    if (!this.entrySaved) throw new PhotoRetry('entry_not_found')
    this.registered.push(a)
    return { id: a.id, duplicate: false, remapped: false }
  }
}

const blob = (n: number) => new Blob([new Uint8Array(n)], { type: 'image/webp' })
const rec = (id: string, entryId = 'e1') => ({ id, userId: 'u', entryId, full: blob(100), thumb: blob(10), width: 1600, height: 1200, sha256: 'a'.repeat(64) })

function make(over: { timing?: { baseMs: number; maxMs: number } } = {}) {
  const store = new MemStore()
  const backend = new FakeBackend()
  const q = new PhotoQueue({ store, backend, isOnline: () => backend.online, timing: over.timing ?? { baseMs: 8, maxMs: 30 } })
  const events: QueueEvent[] = []
  q.subscribe((e) => events.push(e))
  return { store, backend, q, events }
}

describe('upload and register', () => {
  it('writes to the device first, uploads the photo and its thumbnail, registers, then clears the device copy', async () => {
    const { q, store, backend, events } = make()
    const stored = backend.register.bind(backend)
    let onDiskWhenRegistering = false
    backend.register = async (a) => { onDiskWhenRegistering = store.rows.has(a.id); return stored(a) }
    await q.enqueue(rec('m1'))
    expect(store.rows.has('m1')).toBe(true) // on disk before anything else happens
    await waitFor(() => backend.registered.length === 1)
    await waitFor(() => !store.rows.has('m1'))
    expect(onDiskWhenRegistering).toBe(true) // still on the device at the moment the server was asked
    expect(backend.uploads).toEqual([photoPath('u', 'e1', 'm1'), thumbPath('u', 'e1', 'm1')])
    expect(backend.registered[0]).toMatchObject({ id: 'm1', entryId: 'e1', mime: 'image/webp', width: 1600, height: 1200 })
    expect(events.some((e) => e.type === 'registered')).toBe(true)
    expect(q.has('m1')).toBe(false)
  })

  it('paths follow {user}/{entry}/{media}.webp and .thumb.webp', () => {
    expect(photoPath('u', 'e', 'm')).toBe('u/e/m.webp')
    expect(thumbPath('u', 'e', 'm')).toBe('u/e/m.thumb.webp')
  })

  it('photos go up in the order they were added', async () => {
    const { q, backend } = make()
    await Promise.all([q.enqueue(rec('a')), q.enqueue(rec('b')), q.enqueue(rec('c'))])
    await waitFor(() => backend.registered.length === 3)
    expect(backend.registered.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('on disk before the page is told', () => {
  it('enqueue does not return until the photo is really stored (a slow disk must not let the page get ahead of it)', async () => {
    const rows = new Map<string, PhotoRecord>()
    const slow: PhotoStore = {
      put: async (r) => { await sleep(40); rows.set(r.id, r) },
      del: async (id) => void rows.delete(id),
      all: async () => [...rows.values()],
    }
    const backend = new FakeBackend()
    backend.online = false
    const q = new PhotoQueue({ store: slow, backend, isOnline: () => backend.online })
    await q.enqueue(rec('m1'))
    expect(rows.has('m1')).toBe(true) // the moment enqueue resolves, it is safe on disk
  })
})

describe('offline and not-ready', () => {
  it('while offline the photo waits on the device, then goes up when the network returns', async () => {
    const { q, store, backend } = make()
    backend.online = false
    await q.enqueue(rec('m1'))
    await sleep(60)
    expect(backend.registered).toHaveLength(0)
    expect(store.rows.has('m1')).toBe(true)
    expect(q.pending()).toHaveLength(1)
    backend.online = true
    q.retryNow()
    await waitFor(() => backend.registered.length === 1)
    expect(store.rows.has('m1')).toBe(false)
  })

  it('waits, with backoff, for the entry\'s text to reach the server first', async () => {
    const { q, backend } = make()
    backend.entrySaved = false
    await q.enqueue(rec('m1'))
    await sleep(80)
    expect(backend.registered).toHaveLength(0)
    const attempts = backend.uploads.length
    expect(attempts).toBeGreaterThan(2) // it kept trying (uploads are idempotent)
    backend.entrySaved = true
    await waitFor(() => backend.registered.length === 1)
  })

  it('a half-finished upload (photo up, thumbnail failed) is completed on retry, never duplicated', async () => {
    const { q, backend } = make()
    backend.failUploadAt = '.thumb.webp'
    await q.enqueue(rec('m1'))
    await waitFor(() => backend.registered.length === 1)
    expect(backend.registered).toHaveLength(1)
    expect(backend.files.size).toBe(2)
  })

  it('survives a restart: a new session picks up what the last one left on the device', async () => {
    const { q, store, backend } = make()
    backend.online = false
    await q.enqueue(rec('m1'))
    await q.enqueue(rec('m2', 'e2'))
    const backend2 = new FakeBackend()
    const q2 = new PhotoQueue({ store, backend: backend2, isOnline: () => true, timing: { baseMs: 8, maxMs: 30 } })
    await q2.start('u')
    await waitFor(() => backend2.registered.length === 2)
    expect(store.rows.size).toBe(0)
  })

  it('another user\'s leftovers are not uploaded as this user', async () => {
    const { store } = make()
    await store.put({ ...rec('x'), userId: 'someone-else', attempts: 0, addedAt: 1 })
    const backend = new FakeBackend()
    const q = new PhotoQueue({ store, backend, isOnline: () => true })
    await q.start('u')
    await sleep(40)
    expect(backend.registered).toHaveLength(0)
  })
})

describe('refusals never touch the writing', () => {
  it('a full account blocks that photo (kept on the device), and others still go', async () => {
    const { q, store, backend } = make()
    backend.registerError = new PhotoBlocked('cap', 'storage_cap')
    await q.enqueue(rec('m1'))
    await waitFor(() => q.pending()[0]?.blocked === 'cap')
    expect(store.rows.has('m1')).toBe(true) // not lost: the writer can free space and retry
    backend.registerError = null
    q.retryNow()
    await waitFor(() => backend.registered.length === 1)
    expect(q.pending()).toHaveLength(0)
  })

  it('a blocked photo is not hammered: no retries until something changes', async () => {
    const { q, backend } = make()
    backend.registerError = new PhotoBlocked('paused', 'paused')
    await q.enqueue(rec('m1'))
    await waitFor(() => q.pending()[0]?.blocked === 'paused')
    const n = backend.uploads.length
    await sleep(80)
    expect(backend.uploads.length).toBe(n)
  })

  it('a refused photo is left alone when other photos are added: it is not retried every time', async () => {
    const { q, backend } = make()
    backend.refuseIds.set('m1', new PhotoBlocked('cap', 'storage_cap'))
    await q.enqueue(rec('m1'))
    await waitFor(() => q.pending()[0]?.blocked === 'cap')
    const uploadsOfM1 = () => backend.uploads.filter((p) => p.includes('/m1')).length
    const before = uploadsOfM1()
    await q.enqueue(rec('m2'))
    await waitFor(() => backend.registered.some((r) => r.id === 'm2'))
    await sleep(40)
    expect(uploadsOfM1()).toBe(before) // m1 was not touched while m2 went through
    expect(q.pending().map((r) => r.id)).toEqual(['m1']) // and it is still safe on the device
  })

  it('a 13th photo on an entry is rejected for good and dropped from the device', async () => {
    const { q, store, backend, events } = make()
    backend.registerError = new PhotoRejected('limit', 'photo_limit')
    await q.enqueue(rec('m1'))
    await waitFor(() => events.some((e) => e.type === 'rejected'))
    expect(store.rows.size).toBe(0)
    expect(q.has('m1')).toBe(false)
    expect(events.find((e) => e.type === 'rejected')).toMatchObject({ reason: 'limit' })
  })

  it('discard removes a waiting photo (the writer took it off the page)', async () => {
    const { q, store, backend } = make()
    backend.online = false
    await q.enqueue(rec('m1'))
    await q.discard('m1')
    expect(store.rows.size).toBe(0)
    expect(q.pending()).toHaveLength(0)
  })
})

describe('what the page can show while waiting', () => {
  it('has a local address for a queued photo (so it appears at once), and none after it is registered', async () => {
    const { q, backend } = make()
    backend.online = false
    await q.enqueue(rec('m1'))
    expect(q.localUrl('m1')).toMatch(/^blob:/)
    expect(q.localUrl('m1')).toBe(q.localUrl('m1')) // stable, not a new URL per render
    expect(q.localUrl('nope')).toBeNull()
  })
})
