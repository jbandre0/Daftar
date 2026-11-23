import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))
const { runBackup, toPrune, dropWarning, emptyState, verifyBackup, BackupCheckError } = await import('./backup')
const { mediaFileName, buildZipExport } = await import('./vaultZip')
const { sha256Hex } = await import('./photos')
import type { BackupDeps, BackupState } from './backup'
import type { MediaApi, MediaRow } from './photoRuntime'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const bytes = (seed: number, n = 300) => Uint8Array.from({ length: n }, (_, i) => (i * 17 + seed) & 255)

async function journal(count = 3, withPhoto = true) {
  const photo = bytes(7)
  const sha = await sha256Hex(new Blob([photo as BlobPart]))
  const exportJson = {
    account: { display_name: 'A', timezone: 'UTC', default_language: 'en' },
    tracks: [], tags: [], chapters: [], entry_versions: [],
    entries: Array.from({ length: count }, (_, i) => ({
      id: id(i + 1), entry_date: '2026-10-01', title: `t${i}`, track_id: null, tag_ids: [], language: 'en', body_text: `words ${i}`,
      body_rich: { type: 'doc' }, word_count: 2, fields: {}, letter: null,
      created_at: '2026-10-01T00:00:00.000000Z', updated_at: '2026-10-01T00:00:00.000000Z',
      media: i === 0 && withPhoto
        ? [{ id: id(100), mime: 'image/webp', width: 10, height: 10, bytes: photo.length, sha256: sha, file: mediaFileName(id(1), id(100)) }]
        : [],
    })),
  }
  const rows: MediaRow[] = withPhoto ? [{ id: id(100), entry_id: id(1), storage_path: 'u/p.webp', thumb_path: null, width: 10, height: 10, bytes: photo.length, sha256: sha }] : []
  const media: Pick<MediaApi, 'listMediaMany' | 'signedUrls'> = {
    listMediaMany: async (ids) => rows.filter((r) => ids.includes(r.entry_id)),
    signedUrls: async (paths) => Object.fromEntries(paths.map((p) => [p, `https://signed/${p}`])),
  }
  return { exportJson, media, photo, fetchBlob: async () => new Blob([photo as BlobPart]) }
}

function folder(initial: string[] = []) {
  const files = new Map<string, Uint8Array>(initial.map((n) => [n, new Uint8Array([1])]))
  return {
    files,
    list: async () => [...files.keys()],
    write: async (n: string, b: Uint8Array) => void files.set(n, b),
    read: async (n: string) => files.get(n)!,
    remove: async (n: string) => void files.delete(n),
  }
}

async function deps(over: Partial<BackupDeps> & { count?: number; state?: BackupState; dir?: ReturnType<typeof folder> } = {}) {
  const j = await journal(over.count ?? 3)
  const dir = over.dir ?? folder()
  return {
    j, dir,
    d: { rpc: async () => structuredClone(j.exportJson), media: j.media, fetchBlob: j.fetchBlob, now: new Date('2026-11-23T03:30:00'), state: over.state ?? emptyState(), ...dir, ...over } as BackupDeps,
  }
}

describe('a nightly backup', () => {
  it('saves the same .zip the app exports, read back and checked', async () => {
    const { d, dir } = await deps()
    const r = await runBackup(d)
    expect(r.outcome).toBe('saved')
    expect(r.file).toBe('daftar-journal-2026-11-23.zip')
    expect(r.entries).toBe(3)
    expect(r.photos).toBe(1)
    expect(dir.files.has(r.file)).toBe(true)
    expect(r.state.lastContentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.state.lastSuccessAt).toBe(d.now!.toISOString())
  })

  it('writes nothing new when the journal has not changed, even a day later', async () => {
    const { d, dir } = await deps()
    const first = await runBackup(d)
    const again = await runBackup({ ...d, state: first.state, now: new Date('2026-11-24T03:30:00') })
    expect(again.outcome).toBe('unchanged')
    expect(again.file).toBe(first.file)
    expect([...dir.files.keys()]).toEqual([first.file])
    expect(again.state.lastSuccessAt).toBe(new Date('2026-11-24T03:30:00').toISOString())
  })

  it('writes a new file when a word changed', async () => {
    const { d, j, dir } = await deps()
    const first = await runBackup(d)
    const changed = structuredClone(j.exportJson)
    changed.entries[1].body_text = 'words 1, and more'
    const r = await runBackup({ ...d, rpc: async () => structuredClone(changed), state: first.state, now: new Date('2026-11-24T03:30:00') })
    expect(r.outcome).toBe('saved')
    expect(dir.files.size).toBe(2)
  })

  it('writes again when the last backup file was removed from the folder', async () => {
    const { d, dir } = await deps()
    const first = await runBackup(d)
    dir.files.clear()
    const r = await runBackup({ ...d, state: first.state })
    expect(r.outcome).toBe('saved')
    expect(dir.files.has(r.file)).toBe(true)
  })

  it('deletes a backup that does not read back, and fails loudly', async () => {
    const { d, dir } = await deps()
    const broken = { ...d, read: async (n: string) => dir.files.get(n)!.slice(0, 40) }
    await expect(runBackup(broken)).rejects.toThrow()
    expect(dir.files.size).toBe(0)
  })

  it('fails (and writes nothing) when a photo cannot be downloaded intact', async () => {
    const { d, dir } = await deps()
    await expect(runBackup({ ...d, fetchBlob: async () => new Blob([bytes(99) as BlobPart]) })).rejects.toThrow(/couldn't be downloaded intact/)
    expect(dir.files.size).toBe(0)
  })

  it('warns about a sharp drop and keeps every old backup that night', async () => {
    const old = ['daftar-journal-2026-08-01.zip', 'daftar-journal-2026-08-15.zip']
    const dir = folder(old)
    const { d } = await deps({ count: 2, dir, state: { ...emptyState(), lastEntries: 9 } })
    const r = await runBackup(d)
    expect(r.warning).toMatch(/7 fewer entries/)
    expect(r.removed).toEqual([])
    expect(old.every((n) => dir.files.has(n))).toBe(true)
  })

  it('prunes old backups on a normal night, and touches nothing that is not a backup', async () => {
    const dir = folder(['daftar-journal-2026-08-01.zip', 'daftar-journal-2026-08-15.zip', 'notes.txt', 'daftar-journal-2026-08-20.json'])
    const { d } = await deps({ dir })
    const r = await runBackup(d)
    expect(r.removed).toEqual(['daftar-journal-2026-08-15.zip'])
    expect([...dir.files.keys()].sort()).toEqual(['daftar-journal-2026-08-01.zip', 'daftar-journal-2026-08-20.json', 'daftar-journal-2026-11-23.zip', 'notes.txt'])
  })
})

describe('verifyBackup', () => {
  it('catches a photo missing from the archive', async () => {
    const j = await journal()
    const z = await buildZipExport(async () => structuredClone(j.exportJson), [], [], j.media as MediaApi, { fetchBlob: j.fetchBlob })
    const zipBytes = new Uint8Array(await z.blob.arrayBuffer())
    await expect(verifyBackup(zipBytes, z.json)).resolves.toBeUndefined()
    const claimsMore = structuredClone(z.json)
    claimsMore.entries[1].media.push({ ...claimsMore.entries[0].media[0], file: 'media/x/missing.webp' })
    await expect(verifyBackup(zipBytes, claimsMore)).rejects.toBeInstanceOf(BackupCheckError)
  })
})

describe('toPrune', () => {
  const now = new Date('2026-11-23T03:30:00')
  it('keeps the last 30 days and the earliest of each older month', () => {
    const names = [
      'daftar-journal-2026-11-22.zip', 'daftar-journal-2026-10-24.zip', // within 30 days
      'daftar-journal-2026-10-23.zip', 'daftar-journal-2026-10-20.zip', 'daftar-journal-2026-10-02.zip', // October: keep the 2nd
      'daftar-journal-2026-09-30.zip', 'daftar-journal-2026-09-01.zip', // September: keep the 1st
      'daftar-journal-2025-01-05.zip', // a lone old month: kept
    ]
    expect(toPrune(names, now).sort()).toEqual(['daftar-journal-2026-09-30.zip', 'daftar-journal-2026-10-20.zip', 'daftar-journal-2026-10-23.zip'])
  })
  it('ignores anything not named like a backup', () => {
    expect(toPrune(['daftar-journal-2020-01-01.zip.partial', 'photo.zip', 'daftar-journal-2020-01-1.zip'], now)).toEqual([])
  })
})

describe('dropWarning', () => {
  it('says nothing on growth, the first run, or a small drop in a big journal', () => {
    expect(dropWarning(null, 0)).toBeNull()
    expect(dropWarning(10, 12)).toBeNull()
    expect(dropWarning(400, 397)).toBeNull()
    expect(dropWarning(400, 390)).toBeNull() // 2.5%
  })
  it('speaks up on any loss in a small journal and on a large loss in a big one', () => {
    expect(dropWarning(10, 9)).toMatch(/1 fewer entry/)
    expect(dropWarning(400, 300)).toMatch(/100 fewer entries/)
    expect(dropWarning(5, 0)).toMatch(/5 fewer entries/)
  })
})
