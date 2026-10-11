/**
 * A photo restored into a DIFFERENT account, against the real SQL: the entry is stored under a new id, the photo's id
 * collides with the original owner's and is remapped, the page is repointed, the other account is untouched, and
 * restoring again adds nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('./supabase', () => ({ supabase: {} }))
vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }))
const { buildExport, parseJournal, runRestore, serialize } = await import('./vault')
const { planPhotos } = await import('./vaultZip')
const { PhotoQueue } = await import('./photoQueue')
const { swapMediaId } = await import('./photoRestore')
import type { PhotoBackend, PhotoRecord, PhotoStore } from './photoQueue'
import type { Rpc } from './vault'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const E1 = '00000000-0000-4000-8000-0000000e0001'
const M1 = '00000000-0000-4000-8000-00000c000001'
const SHA = 'ab'.repeat(32)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function setup() {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t'), ('${B}', 'b@t'); insert into storage.buckets (id, name) values ('media', 'media') on conflict do nothing`)
  const as = <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
      await tx.query('set local role authenticated')
      return (await tx.query<T>(sql, params)).rows
    })
  const rpcFor = (uid: string): Rpc => async (fn, args = {}) => {
    const q = fn === 'export_journal' ? ['select export_journal() as r', []]
      : fn === 'restore_meta' ? ['select restore_meta($1::jsonb, $2::boolean) as r', [JSON.stringify(args.p), args.p_dry_run]]
      : ['select restore_batch($1::jsonb, $2::jsonb, $3::boolean) as r', [JSON.stringify(args.p), JSON.stringify(args.p_remap), args.p_dry_run]]
    return (await as<{ r: unknown }>(uid, q[0] as string, q[1] as unknown[]))[0].r
  }
  // A's journal: one entry with a photo on its page
  await db.query(`insert into entries (id, user_id, entry_date, title, body_text, body_rich) values ($1, $2, '2026-10-01', 'Lake', 'water', $3)`,
    [E1, A, JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'water' }] }, { type: 'photo', attrs: { mediaId: M1, width: 1600, height: 1200 } }] })])
  for (const [thumb, size] of [[false, 150_000], [true, 20_000]] as const) {
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)`, [`${A}/${E1}/${M1}${thumb ? '.thumb' : ''}.webp`, JSON.stringify({ size })])
  }
  await as(A, `select register_media($1, $2, 'image/webp', 1600, 1200, $3)`, [M1, E1, SHA])

  // the browser's upload queue, talking to the real SQL as the signed-in user
  const store = new Map<string, PhotoRecord>()
  const memStore: PhotoStore = { put: async (r) => void store.set(r.id, r), del: async (id) => void store.delete(id), all: async () => [...store.values()] }
  const backendFor = (uid: string): PhotoBackend => ({
    async upload(path, blob) {
      await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2) on conflict do nothing`, [path, JSON.stringify({ size: blob.size })])
    },
    async register(a) {
      const r = (await as<{ r: { id: string; duplicate: boolean; remapped: boolean } }>(uid, `select register_media($1, $2, $3, $4, $5, $6) as r`, [a.id, a.entryId, a.mime, a.width, a.height, a.sha256]))[0].r
      return r
    },
  })
  return { db, as, rpcFor, memStore, backendFor }
}

describe('restoring a photo into another account', () => {
  it('remaps the entry and the photo, repoints the page, leaves A alone, and a second restore adds nothing', async () => {
    const { db, as, rpcFor, memStore, backendFor } = await setup()
    // 1. A exports (as the zip would: entries with their photos listed)
    const exported = await buildExport(rpcFor(A), [], new Date('2026-10-12T09:00:00Z'))
    const parsed = parseJournal(serialize(exported))
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.entries[0].media).toHaveLength(1)
    expect(parsed.file.entries[0].media[0]).toMatchObject({ id: M1, sha256: SHA, bytes: 150_000 })

    // 2. B restores the text
    const report = await runRestore(rpcFor(B), parsed, { dryRun: false })
    const bEntry = report.entries[0]
    expect(bEntry.outcome).toBe('new')
    expect(bEntry.stored_as).not.toBe(E1) // A owns that id, so B's copy lives under a new one

    // 3. the plan lands the photo on B's entry id, and uploads it through the queue
    const plan = planPhotos(parsed.file, report.entries, new Map(), new Map(), 0, () => true)
    expect(plan.upload).toHaveLength(1)
    expect(plan.upload[0].entryId).toBe(bEntry.stored_as)
    const q = new PhotoQueue({ store: memStore, backend: backendFor(B), isOnline: () => true, timing: { baseMs: 5, maxMs: 20 } })
    const events: { id: string; newId: string }[] = []
    q.subscribe((e) => e.type === 'registered' && events.push({ id: e.record.id, newId: e.result.id }))
    const full = new Blob([new Uint8Array(150_000)])
    await q.enqueue({ id: M1, userId: B, entryId: plan.upload[0].entryId, full, thumb: new Blob([new Uint8Array(20_000)]), width: 1600, height: 1200, sha256: SHA })
    for (let i = 0; i < 100 && !events.length; i++) await sleep(10)
    expect(events).toHaveLength(1)

    // 4. the id collided with A's, so B's photo has a new id; the page must follow
    const newId = events[0].newId
    expect(newId).not.toBe(M1)
    const [bRow] = await as<{ body_rich: unknown }>(B, `select body_rich from entries where id = $1`, [bEntry.stored_as])
    expect(JSON.stringify(bRow.body_rich)).toContain(M1) // restored text still points at the file's id...
    const patched = swapMediaId(bRow.body_rich, M1, newId)
    expect(JSON.stringify(patched)).toContain(newId) // ...until it is repointed
    expect(JSON.stringify(patched)).not.toContain(M1)

    // 5. B has the photo, A's is untouched, and storage for each is counted separately
    const bMedia = await as<{ id: string; sha256: string; bytes: number }>(B, `select id, sha256, bytes from media`)
    expect(bMedia).toEqual([{ id: newId, sha256: SHA, bytes: 150_000 }])
    const aMedia = await as<{ id: string }>(A, `select id from media`)
    expect(aMedia.map((m) => m.id)).toEqual([M1])
    const used = async (u: string) => Number((await db.query<{ n: string }>(`select storage_bytes_used as n from profiles where id = $1`, [u])).rows[0].n)
    expect(await used(B)).toBe(170_000)
    expect(await used(A)).toBe(170_000)

    // 6. restoring the same file into B again: the entry is already there, so is the photo: nothing to upload
    const again = await runRestore(rpcFor(B), parsed, { dryRun: false })
    expect(again.counts.new).toBe(0)
    const shas = new Map([[bEntry.stored_as, new Set(bMedia.map((m) => m.sha256))]])
    const plan2 = planPhotos(parsed.file, again.entries, shas, new Map([[bEntry.stored_as, 1]]), await used(B), () => true)
    expect(plan2.upload).toEqual([])
    expect(plan2.alreadyHere).toBe(1)
  })

  it('restoring into the same account, where the photo already exists, uploads nothing', async () => {
    const { rpcFor } = await setup()
    const exported = await buildExport(rpcFor(A), [], new Date())
    const parsed = parseJournal(serialize(exported))
    if (!parsed.ok) throw new Error(parsed.error)
    const report = await runRestore(rpcFor(A), parsed, { dryRun: false })
    expect(report.counts.unchanged).toBe(1)
    const plan = planPhotos(parsed.file, report.entries, new Map([[E1, new Set([SHA])]]), new Map([[E1, 1]]), 170_000, () => true)
    expect(plan.upload).toEqual([])
    expect(plan.alreadyHere).toBe(1)
  })
})
