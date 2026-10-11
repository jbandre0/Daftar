import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))
vi.mock('./syncDeps', () => ({ syncDeps: { store: { all: async () => [] } } }))
const { buildZipExport, openJournalFile, planPhotos, mediaFileName, planSummary, PHOTO_LINES, ZipExportError, OpenFileError } = await import('./vaultZip')
const { parseJournal, README } = await import('./vault')
const { sha256Hex, STORAGE_CAP_BYTES, THUMB_ESTIMATE_BYTES } = await import('./photos')
import type { MediaApi, MediaRow } from './photoRuntime'
import type { PhotoRecord } from './photoQueue'
import type { EntryResult, JournalFile, Rpc } from './vault'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const bytes = (seed: number, n = 400) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255)
const sha = async (b: Uint8Array) => sha256Hex(new Blob([b as BlobPart]))

async function fixture() {
  const photos = [bytes(1), bytes(2), bytes(3)]
  const shas = await Promise.all(photos.map(sha))
  const entries = [
    { id: id(1), media: [{ id: id(101), sha: shas[0], b: photos[0] }, { id: id(102), sha: shas[1], b: photos[1] }] },
    { id: id(2), media: [{ id: id(103), sha: shas[2], b: photos[2] }] },
    { id: id(3), media: [] as { id: string; sha: string; b: Uint8Array }[] },
  ]
  const exportJson = {
    account: { display_name: 'A', timezone: 'UTC', default_language: 'en' },
    tracks: [], tags: [], chapters: [], entry_versions: [],
    entries: entries.map((e) => ({
      id: e.id, entry_date: '2026-10-01', title: 't', track_id: null, tag_ids: [], language: 'en', body_text: 'x', body_rich: { type: 'doc' },
      word_count: 1, fields: {}, letter: null, created_at: '2026-10-01T00:00:00.000000Z', updated_at: '2026-10-01T00:00:00.000000Z',
      media: e.media.map((m) => ({ id: m.id, mime: 'image/webp', width: 1600, height: 1200, bytes: m.b.length, sha256: m.sha, file: mediaFileName(e.id, m.id) })),
    })),
  }
  const rpc: Rpc = async () => structuredClone(exportJson)
  const store = new Map<string, Uint8Array>()
  const rows: MediaRow[] = []
  for (const e of entries) for (const m of e.media) {
    store.set(`u/${e.id}/${m.id}.webp`, m.b)
    rows.push({ id: m.id, entry_id: e.id, storage_path: `u/${e.id}/${m.id}.webp`, thumb_path: null, width: 1600, height: 1200, bytes: m.b.length, sha256: m.sha })
  }
  const api: MediaApi = {
    listMedia: async (eid) => rows.filter((r) => r.entry_id === eid),
    listMediaMany: async (ids) => rows.filter((r) => ids.includes(r.entry_id)),
    signedUrls: async (paths) => Object.fromEntries(paths.map((p) => [p, `https://signed/${p}`])),
    softDelete: async () => {},
  }
  const fetchBlob = async (url: string) => new Blob([store.get(url.replace('https://signed/', ''))! as BlobPart])
  return { entries, rpc, api, fetchBlob, store, photos, shas }
}

describe('the .zip export', () => {
  it('holds the journal, a README, and every photo at the path the journal names', async () => {
    const f = await fixture()
    const progress: string[] = []
    const z = await buildZipExport(f.rpc, [], [], f.api, { now: new Date('2026-10-12T09:00:00'), fetchBlob: f.fetchBlob, onProgress: (d, t) => progress.push(`${d}/${t}`) })
    expect(z.name).toBe('daftar-journal-2026-10-12.zip')
    expect(z.photos).toBe(3)
    expect(progress.at(-1)).toBe('3/3')

    const opened = await openJournalFile(z.blob)
    expect(opened.kind).toBe('zip')
    const parsed = parseJournal(opened.text)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.export_type).toBe('full_zip')
    expect(parsed.unreadable).toEqual([])
    const all = parsed.file.entries.flatMap((e) => e.media)
    expect(all).toHaveLength(3)
    for (const m of all) {
      const got = opened.photo(m.file)
      expect(got, m.file).not.toBeNull()
      expect(await sha(got!)).toBe(m.sha256) // the very bytes, intact
    }
    expect(parsed.file.entries.find((e) => e.id === id(3))!.media).toEqual([])
  })

  it('a damaged photo fails the whole export instead of backing up a bad copy', async () => {
    const f = await fixture()
    const bad = async (url: string) => (url.includes(id(102)) ? new Blob([bytes(99)]) : f.fetchBlob(url))
    await expect(buildZipExport(f.rpc, [], [], f.api, { fetchBlob: bad })).rejects.toThrow(ZipExportError)
    await expect(buildZipExport(f.rpc, [], [], f.api, { fetchBlob: bad })).rejects.toThrow(/1 photo couldn't be downloaded intact/)
  })

  it('a photo that can\'t be downloaded fails it too', async () => {
    const f = await fixture()
    const down = async () => { throw new Error('offline') }
    await expect(buildZipExport(f.rpc, [], [], f.api, { fetchBlob: down })).rejects.toThrow(/3 photos couldn't be downloaded intact/)
  })

  it('photos still waiting on this device are in the backup, marked unsynced', async () => {
    const f = await fixture()
    const full = new Blob([bytes(7)])
    const pending: PhotoRecord = {
      id: id(150), userId: 'u', entryId: id(3), full, thumb: new Blob([bytes(8, 50)]), width: 1000, height: 800, sha256: await sha256Hex(full), attempts: 0, addedAt: 1,
    }
    const z = await buildZipExport(f.rpc, [], [pending], f.api, { fetchBlob: f.fetchBlob })
    expect(z.photos).toBe(4)
    const m = z.json.entries.find((e) => e.id === id(3))!.media[0]
    expect(m).toMatchObject({ id: id(150), unsynced: true })
    const opened = await openJournalFile(z.blob)
    expect(opened.photo(m.file)).not.toBeNull()
  })

  it('an export with no photos is still a valid .zip', async () => {
    const f = await fixture()
    const rpc: Rpc = async () => ({ ...(await f.rpc('export_journal')) as object, entries: [] })
    const z = await buildZipExport(rpc, [], [], f.api, { fetchBlob: f.fetchBlob })
    expect(z.photos).toBe(0)
    expect((await openJournalFile(z.blob)).kind).toBe('zip')
  })

  it('the README inside is the journal\'s own', async () => {
    const f = await fixture()
    const z = await buildZipExport(f.rpc, [], [], f.api, { fetchBlob: f.fetchBlob })
    expect(z.json._readme).toBe(README)
  })
})

describe('opening a file', () => {
  it('a plain .json opens as text and carries no photos', async () => {
    const o = await openJournalFile(new Blob(['{"format":"daftar.journal"}']))
    expect(o.kind).toBe('json')
    expect(o.hasPhoto('media/x/y.webp')).toBe(false)
    expect(o.photo('media/x/y.webp')).toBeNull()
  })
  it('a damaged .zip gets a plain message', async () => {
    await expect(openJournalFile(new Blob([new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4, 5, 6])]))).rejects.toThrow(OpenFileError)
  })
  it('a .zip with no journal inside is refused', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const z = new Blob([zipSync({ 'notes.txt': strToU8('hi') }) as BlobPart])
    await expect(openJournalFile(z)).rejects.toThrow(/no journal file/i)
  })
  it('ignores a .json nested in media/ and finds the real one', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const z = new Blob([zipSync({ 'media/x/evil.json': strToU8('{}'), 'daftar-journal-2026-01-01.json': strToU8('{"ok":1}') }) as BlobPart])
    expect((await openJournalFile(z)).text).toBe('{"ok":1}')
  })
})

describe('planPhotos: which photos come back', () => {
  const entry = (n: number, media: { id: number; sha: string; bytes?: number; file?: string }[]) => ({
    id: id(n), media: media.map((m) => ({ id: id(m.id), mime: 'image/webp', width: 1, height: 1, bytes: m.bytes ?? 1000, sha256: m.sha, file: m.file ?? `media/${n}/${m.id}.webp` })),
  })
  const file = (entries: ReturnType<typeof entry>[]) => ({ entries } as unknown as JournalFile)
  const res = (n: number, outcome: EntryResult['outcome'] = 'new', storedAs?: number): EntryResult => ({ id: id(n), stored_as: id(storedAs ?? n), outcome, title: '', entry_date: '2026-10-01' })
  const have = () => true
  const none = new Map<string, Set<string>>()
  const zero = new Map<string, number>()
  const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64)

  it('brings back photos for new entries', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }, { id: 12, sha: B }])]), [res(1)], none, zero, 0, have)
    expect(p.upload.map((u) => u.media.sha256)).toEqual([A, B])
  })
  it('skips a photo the entry already has (same checksum), and counts it', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }, { id: 12, sha: B }])]), [res(1, 'unchanged')], new Map([[id(1), new Set([A])]]), new Map([[id(1), 1]]), 0, have)
    expect(p.upload.map((u) => u.media.sha256)).toEqual([B])
    expect(p.alreadyHere).toBe(1)
  })
  it('the same bytes twice in one file are one photo', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }, { id: 12, sha: A }])]), [res(1)], none, zero, 0, have)
    expect(p.upload).toHaveLength(1)
    expect(p.alreadyHere).toBe(1)
  })
  it('never adds photos to an entry the merge left alone', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }]), entry(2, [{ id: 12, sha: B }])]), [res(1, 'skipped_local_newer'), res(2, 'stays_deleted')], none, zero, 0, have)
    expect(p.upload).toEqual([])
  })
  it('takes photos for updated entries and ones restored from the trash', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }]), entry(2, [{ id: 12, sha: B }])]), [res(1, 'updated'), res(2, 'restored_from_trash')], none, zero, 0, have)
    expect(p.upload).toHaveLength(2)
  })
  it('lands a photo on the entry\'s id HERE (a file from another account stores entries under new ids)', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }])]), [res(1, 'new', 77)], none, zero, 0, have)
    expect(p.upload[0].entryId).toBe(id(77))
  })
  it('stops at the 2 GB cap, counting thumbnails, and says which were skipped', () => {
    const room = 1000 + THUMB_ESTIMATE_BYTES
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }, { id: 12, sha: B }, { id: 13, sha: C }])]), [res(1)], none, zero, STORAGE_CAP_BYTES - room * 2 - 5, have)
    expect(p.upload).toHaveLength(2)
    expect(p.skippedByCap.map((u) => u.media.sha256)).toEqual([C])
  })
  it('at most 12 photos per entry, counting what is already there', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: 200 + i, sha: i.toString(16).padStart(64, '0') }))
    const p = planPhotos(file([entry(1, many)]), [res(1)], none, new Map([[id(1), 2]]), 0, have)
    expect(p.upload).toHaveLength(10)
    expect(p.overLimit).toHaveLength(4)
  })
  it('a text-only file lists photos it cannot supply: reported, never silently dropped', () => {
    const p = planPhotos(file([entry(1, [{ id: 11, sha: A }])]), [res(1)], none, zero, 0, () => false)
    expect(p.upload).toEqual([])
    expect(p.missing).toHaveLength(1)
    expect(PHOTO_LINES(planSummary(p)).join(' ')).toMatch(/not in this file.*use the \.zip/)
  })
  it('the summary reads plainly', () => {
    const lines = PHOTO_LINES({ toUpload: 3, alreadyHere: 1, skippedByCap: 2, overLimit: 0, missing: 0, damaged: 1 })
    expect(lines).toEqual([
      'Photos brought back: 3',
      'Photos already here: 1',
      'Photos skipped, your 2 GB is full: 2. Keep the .zip so you can add them later.',
      "Photos that didn't match their checksum and were left out: 1",
    ])
  })
})
