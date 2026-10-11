/**
 * Phase 6 "done when", server side, against real Postgres (PGlite) with the real migrations:
 *   the cap blocks cleanly, and counts what is really stored, never what the browser says.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const E = (n: number) => `00000000-0000-4000-8000-0000000e${String(n).padStart(4, '0')}`
const M = (n: number) => `00000000-0000-4000-8000-00000c${String(n).padStart(6, '0')}`
const SHA = (n: number) => n.toString(16).padStart(64, '0')
const CAP = 2147483648

let db: PGlite

async function fresh() {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t'), ('${B}', 'b@t')`)
  await db.exec(`insert into storage.buckets (id, name) values ('media', 'media') on conflict do nothing`)
  for (const [n, u] of [[1, A], [2, A], [3, B]] as const) {
    await db.query(`insert into entries (id, user_id, entry_date, body_text, body_rich) values ($1, $2, '2026-10-01', 'x', '{}')`, [E(n), u])
  }
}

async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = [], role = 'authenticated'): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await tx.query(`set local role ${role}`)
    return (await tx.query<T>(sql, params)).rows
  })
}

const path = (uid: string, entry: string, media: string, thumb = false) => `${uid}/${entry}/${media}${thumb ? '.thumb' : ''}.webp`

/** What the Storage API does after an upload: an object row whose metadata carries the real size. */
async function put(uid: string, entry: string, media: string, bytes: number, thumbBytes = 20_000, createdAt?: string) {
  for (const [thumb, size] of [[false, bytes], [true, thumbBytes]] as const) {
    await db.query(`insert into storage.objects (bucket_id, name, metadata, created_at) values ('media', $1, $2, coalesce($3::timestamptz, now()))`,
      [path(uid, entry, media, thumb), JSON.stringify({ size }), createdAt ?? null])
  }
}

const register = (uid: string, entry: string, media: string, sha = 1, extra: { mime?: string } = {}) =>
  as<{ r: { id: string; bytes?: number; thumb_bytes?: number; duplicate: boolean; remapped: boolean } }>(
    uid, `select register_media($1, $2, $3, 1600, 1200, $4) as r`, [media, entry, extra.mime ?? 'image/webp', SHA(sha)],
  ).then((r) => r[0].r)
const used = async (uid: string) => Number((await db.query<{ n: string }>(`select storage_bytes_used as n from profiles where id = $1`, [uid])).rows[0].n)

beforeEach(fresh)

describe('register_media', () => {
  it('takes the sizes from storage, never from the caller, and keeps the profile total in step', async () => {
    await put(A, E(1), M(1), 180_000, 25_000)
    const r = await register(A, E(1), M(1))
    expect(r).toMatchObject({ id: M(1), bytes: 180_000, thumb_bytes: 25_000, duplicate: false, remapped: false })
    const row = (await db.query<{ bytes: number; thumb_bytes: number; storage_path: string; thumb_path: string }>(`select bytes, thumb_bytes, storage_path, thumb_path from media where id = $1`, [M(1)])).rows[0]
    expect(row).toEqual({ bytes: 180_000, thumb_bytes: 25_000, storage_path: path(A, E(1), M(1)), thumb_path: path(A, E(1), M(1), true) })
    expect(await used(A)).toBe(205_000) // thumbnails count
  })

  it('needs both files to really be there', async () => {
    await expect(register(A, E(1), M(1))).rejects.toThrow(/upload_missing/)
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 1000}')`, [path(A, E(1), M(1))])
    await expect(register(A, E(1), M(1))).rejects.toThrow(/upload_missing/) // no thumbnail
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{}')`, [path(A, E(1), M(1), true)])
    await expect(register(A, E(1), M(1))).rejects.toThrow(/upload_missing/) // a file with no recorded size
  })

  it('refuses to register on an entry that is not saved yet, someone else’s entry, or a trashed one', async () => {
    await put(A, E(9), M(1), 1000)
    await expect(register(A, E(9), M(1))).rejects.toThrow(/entry_not_found/)
    await put(A, E(3), M(2), 1000)
    await expect(register(A, E(3), M(2))).rejects.toThrow(/entry_not_found/) // B's entry
    await db.query(`update entries set deleted_at = now() where id = $1`, [E(2)])
    await put(A, E(2), M(3), 1000)
    await expect(register(A, E(2), M(3))).rejects.toThrow(/entry_not_found/)
  })

  it('is safe to retry: the same id twice is one photo', async () => {
    await put(A, E(1), M(1), 1000)
    await register(A, E(1), M(1))
    const again = await register(A, E(1), M(1))
    expect(again).toMatchObject({ id: M(1), duplicate: true, remapped: false })
    expect((await db.query(`select 1 from media`)).rows).toHaveLength(1)
  })

  it('the same bytes twice on one entry reuse the first photo (matching sha256)', async () => {
    await put(A, E(1), M(1), 1000)
    await put(A, E(1), M(2), 1000)
    await register(A, E(1), M(1), 7)
    const r = await register(A, E(1), M(2), 7)
    expect(r).toMatchObject({ id: M(1), duplicate: true, remapped: true })
    // ...but the same bytes on a different entry are a separate photo
    await put(A, E(2), M(3), 1000)
    expect((await register(A, E(2), M(3), 7)).duplicate).toBe(false)
  })

  it('at most 12 photos per entry (soft-deleted ones don’t count)', async () => {
    for (let i = 1; i <= 12; i++) {
      await put(A, E(1), M(i), 1000)
      await register(A, E(1), M(i), i)
    }
    await put(A, E(1), M(13), 1000)
    await expect(register(A, E(1), M(13), 13)).rejects.toThrow(/photo_limit/)
    await as(A, `update media set deleted_at = now() where id = $1`, [M(1)])
    expect((await register(A, E(1), M(13), 13)).duplicate).toBe(false)
  })

  it('only WebP', async () => {
    await put(A, E(1), M(1), 1000)
    await expect(register(A, E(1), M(1), 1, { mime: 'image/jpeg' })).rejects.toThrow(/unsupported_type/)
  })

  it('a malformed hash is refused', async () => {
    await put(A, E(1), M(1), 1000)
    await expect(as(A, `select register_media($1, $2, 'image/webp', 1, 1, 'nothex') as r`, [M(1), E(1)])).rejects.toThrow(/bad_hash/)
  })

  it('an id that belongs to another account gets a new id, and keeps the file name it was uploaded under', async () => {
    await put(B, E(3), M(1), 1000)
    await register(B, E(3), M(1), 1) // B owns media M(1)
    await put(A, E(1), M(1), 2000) // A uploads under the same id (restoring B's file into A)
    const r = await register(A, E(1), M(1), 2)
    expect(r.remapped).toBe(true)
    expect(r.id).not.toBe(M(1))
    const row = (await db.query<{ storage_path: string; user_id: string }>(`select storage_path, user_id from media where id = $1`, [r.id])).rows[0]
    expect(row).toEqual({ storage_path: path(A, E(1), M(1)), user_id: A })
  })
})

describe('the cap (2 GB, counted from stored bytes, thumbnails included)', () => {
  it('the upload policy lets files in below the cap and refuses them at it', async () => {
    const ins = (name: string) => as(A, `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 10}')`, [name])
    await expect(ins(path(A, E(1), M(1)))).resolves.toBeDefined()
    await db.query(`insert into storage.objects (bucket_id, name, metadata) values ('media', $1, $2)`, [path(A, E(1), M(50)), JSON.stringify({ size: CAP })])
    await expect(ins(path(A, E(1), M(2)))).rejects.toThrow() // at the cap: no more uploads
  })

  it('registration is refused once the real stored bytes pass the cap, however small the client says the photo is', async () => {
    await put(A, E(1), M(1), CAP - 100_000, 20_000) // fits
    await register(A, E(1), M(1), 1)
    await put(A, E(1), M(2), 90_000, 20_000) // pushes the total past the cap
    await expect(register(A, E(1), M(2), 2)).rejects.toThrow(/storage_cap/)
    expect((await db.query(`select 1 from media where id = $1`, [M(2)])).rows).toHaveLength(0)
  })

  it('thumbnails count toward the cap', async () => {
    await put(A, E(1), M(1), CAP - 10_000, 5_000) // exactly under
    await register(A, E(1), M(1), 1)
    await put(A, E(1), M(2), 1, 30_000) // a 1-byte photo with a 30 KB thumbnail tips it over
    await expect(register(A, E(1), M(2), 2)).rejects.toThrow(/storage_cap/)
  })

  it('an account’s usage is its own: B’s files never count against A', async () => {
    await put(B, E(3), M(9), CAP - 1)
    await put(A, E(1), M(1), 1000)
    await expect(register(A, E(1), M(1))).resolves.toBeDefined()
  })

  it('removing a photo keeps it counted until the purge, then frees it', async () => {
    await put(A, E(1), M(1), 500_000, 20_000)
    await register(A, E(1), M(1))
    await as(A, `update media set deleted_at = now() - interval '31 days' where id = $1`, [M(1)])
    expect(await used(A)).toBe(520_000)
    const cands = await as<{ id: string; storage_path: string }>(A, `select * from media_purge_candidates()`, [], 'service_role')
    expect(cands.map((c) => c.id)).toEqual([M(1)])
    // the job deletes the files through the Storage API, then:
    await db.exec(`delete from storage.objects where bucket_id = 'media'`)
    expect(await as<{ n: number }>(A, `select finalize_media_purge($1::uuid[]) as n`, [[M(1)]], 'service_role')).toEqual([{ n: 1 }])
    expect(await used(A)).toBe(0)
  })
})

describe('what a client can and cannot do to media', () => {
  it('cannot insert a media row directly (that would skip every check above)', async () => {
    await expect(as(A, `insert into media (user_id, entry_id, storage_path, mime, bytes, sha256) values ($1, $2, 'x', 'image/webp', 1, $3)`, [A, E(1), SHA(1)])).rejects.toThrow()
  })
  it('cannot edit the numbers on a row, only soft-delete', async () => {
    await put(A, E(1), M(1), 1000)
    await register(A, E(1), M(1))
    await expect(as(A, `update media set bytes = 1 where id = $1`, [M(1)])).rejects.toThrow()
    await expect(as(A, `update media set storage_path = 'elsewhere' where id = $1`, [M(1)])).rejects.toThrow()
    expect(await as(A, `update media set deleted_at = now() where id = $1 returning id`, [M(1)])).toHaveLength(1)
    await expect(as(A, `delete from media where id = $1`, [M(1)])).rejects.toThrow()
  })
  it('B cannot see, remove or register against A’s photos', async () => {
    await put(A, E(1), M(1), 1000)
    await register(A, E(1), M(1))
    expect(await as(B, `select * from media`)).toHaveLength(0)
    expect(await as(B, `update media set deleted_at = now() where id = $1 returning id`, [M(1)])).toHaveLength(0)
    await put(B, E(1), M(5), 1000) // B can't even upload into A's entry folder
    await expect(register(B, E(1), M(5))).rejects.toThrow(/entry_not_found/)
  })
  it('signed-out visitors can call none of it', async () => {
    await expect(as(A, `select register_media($1, $2, 'image/webp', 1, 1, $3)`, [M(1), E(1), SHA(1)], 'anon')).rejects.toThrow()
    await expect(as(A, `select storage_used_bytes()`, [], 'anon')).rejects.toThrow()
  })
  it('clean-up helpers belong to the service role alone', async () => {
    for (const fn of ['media_purge_candidates()', 'media_orphans()', 'soft_delete_unreferenced_media()']) {
      await expect(as(A, `select * from ${fn}`)).rejects.toThrow()
    }
    await expect(as(A, `select finalize_media_purge('{}'::uuid[])`)).rejects.toThrow()
    await expect(as(A, `select storage_used_bytes_for($1)`, [B])).rejects.toThrow() // A can't read B's usage
  })
})

describe('trial rules', () => {
  it('registering needs an active trial or unlock', async () => {
    await put(A, E(1), M(1), 1000)
    await db.exec(`update licenses set trial_ends_at = now() - interval '3 days' where user_id = '${A}'`)
    await expect(register(A, E(1), M(1))).rejects.toThrow(/paused/)
    await db.exec(`update licenses set status = 'unlocked' where user_id = '${A}'`)
    await expect(register(A, E(1), M(1))).resolves.toBeDefined()
  })
  it('an expired trial cannot upload either', async () => {
    await db.exec(`update licenses set trial_ends_at = now() - interval '3 days' where user_id = '${A}'`)
    await expect(as(A, `insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{"size": 1}')`, [path(A, E(1), M(1))])).rejects.toThrow()
  })
})

describe('export lists photos', () => {
  it('each entry carries its live photos with metadata and a relative file path', async () => {
    await put(A, E(1), M(1), 1234)
    await put(A, E(1), M(2), 5678)
    await register(A, E(1), M(1), 1)
    await register(A, E(1), M(2), 2)
    await as(A, `update media set deleted_at = now() where id = $1`, [M(2)])
    const [{ j }] = await as<{ j: { entries: { id: string; media: { id: string; file: string; bytes: number; sha256: string; width: number }[] }[] } }>(A, `select export_journal() as j`)
    const e1 = j.entries.find((e) => e.id === E(1))!
    expect(e1.media).toEqual([{ id: M(1), mime: 'image/webp', width: 1600, height: 1200, bytes: 1234, sha256: SHA(1), file: `media/${E(1).slice(0, 8)}/${M(1)}.webp` }])
    expect(j.entries.find((e) => e.id === E(2))!.media).toEqual([])
  })
})

describe('clean-up helpers', () => {
  it('orphans: files with no row, older than a day', async () => {
    await put(A, E(1), M(1), 1000, 100, '2020-01-01T00:00:00Z') // old, never registered
    await put(A, E(1), M(2), 1000, 100) // fresh: still being uploaded
    await put(A, E(1), M(3), 1000, 100, '2020-01-01T00:00:00Z')
    await register(A, E(1), M(3), 3) // old but registered
    const rows = await as<{ name: string; bytes: string }>(A, `select * from media_orphans()`, [], 'service_role')
    expect(rows.map((r) => r.name).sort()).toEqual([path(A, E(1), M(1)), path(A, E(1), M(1), true)].sort())
  })
  it('unreferenced photos (deleted from the page with the keyboard) are soft-deleted after a day', async () => {
    await db.query(`update entries set body_rich = $2 where id = $1`, [E(1), JSON.stringify({ type: 'doc', content: [{ type: 'photo', attrs: { mediaId: M(1) } }] })])
    for (const n of [1, 2]) {
      await put(A, E(1), M(n), 1000)
      await register(A, E(1), M(n), n)
    }
    await db.exec(`update media set created_at = now() - interval '2 days'`)
    const [{ n }] = await as<{ n: number }>(A, `select soft_delete_unreferenced_media() as n`, [], 'service_role')
    expect(n).toBe(1)
    const live = (await db.query<{ id: string }>(`select id from media where deleted_at is null`)).rows.map((r) => r.id)
    expect(live).toEqual([M(1)])
  })
  it('a fresh photo is never swept, even if its page has not been saved with it yet', async () => {
    await put(A, E(1), M(1), 1000)
    await register(A, E(1), M(1))
    const [{ n }] = await as<{ n: number }>(A, `select soft_delete_unreferenced_media() as n`, [], 'service_role')
    expect(n).toBe(0)
  })
})
