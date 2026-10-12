/**
 * Phase 7 "done when", server side, against real Postgres (PGlite) with the real migrations:
 *   a sealed letter can't be opened (or changed) before its date, opens after it, and exports with sealed: true.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const L = (n: number) => `00000000-0000-4000-8000-000000001${String(n).padStart(3, '0')}`
const FUTURE = '2099-04-20T00:00:00Z'
const PAST = '2020-01-01T00:00:00Z'

let db: PGlite
async function fresh() {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t'), ('${B}', 'b@t')`)
}
async function as<T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = [], role = 'authenticated'): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await tx.query(`set local role ${role}`)
    return (await tx.query<T>(sql, params)).rows
  })
}
const doc = (t: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })
const save = (uid: string, entry: Record<string, unknown>, base = 0) =>
  as<{ r: { revision: number } }>(uid, `select save_entry($1::jsonb, $2) as r`, [JSON.stringify(entry), base]).then((r) => r[0].r)
const body = async (id: string) => (await db.query<{ body_text: string; sealed: boolean }>(`select body_text, sealed from entries where id = $1`, [id])).rows[0]

/** Time passing: the letter's date arrives. (Only a test can do this; the guard exists to stop everyone else.) */
async function dateArrives(id: string) {
  await db.exec('alter table entries disable trigger entries_guard_seal')
  await db.query(`update entries set unlock_at = $2 where id = $1`, [id, PAST])
  await db.exec('alter table entries enable trigger entries_guard_seal')
}

/** A letter written, then sealed, the way the app does it: save the text, then a second save that seals. */
async function sealedLetter(n = 1, unlock = FUTURE) {
  const v1 = await save(A, { id: L(n), entry_date: '2026-10-01', title: 'To me, at graduation', body_text: 'the lighthouse password is marmalade', body_rich: doc('the lighthouse password is marmalade'), word_count: 5, is_letter: true, letter_to: 'Future me' })
  const v2 = await save(A, { id: L(n), sealed: true, unlock_at: unlock }, v1.revision)
  return v2.revision
}

beforeEach(fresh)

describe('sealing', () => {
  it('seals a letter for a future date', async () => {
    await sealedLetter()
    expect(await body(L(1))).toMatchObject({ sealed: true })
  })
  it('refuses a past, present or missing date', async () => {
    const v1 = await save(A, { id: L(1), entry_date: '2026-10-01', body_text: 'x', is_letter: true })
    await expect(save(A, { id: L(1), sealed: true, unlock_at: PAST }, v1.revision)).rejects.toThrow(/seal_needs_future_date/)
    await expect(save(A, { id: L(1), sealed: true, unlock_at: new Date().toISOString() }, v1.revision)).rejects.toThrow(/seal_needs_future_date/)
    await expect(as(A, `update entries set sealed = true where id = $1`, [L(1)])).rejects.toThrow() // no date at all (also the table's own check)
    expect((await body(L(1))).sealed).toBe(false)
  })
})

describe('while sealed, nothing about the letter can change', () => {
  it('text, title, recipient, date and the seal itself are frozen', async () => {
    const rev = await sealedLetter()
    for (const patch of [
      { body_text: 'rewritten', body_rich: doc('rewritten') },
      { title: 'new title' },
      { letter_to: 'someone else' },
      { sealed: false },
      { unlock_at: '2030-01-01T00:00:00Z' }, // earlier
      { unlock_at: '2100-01-01T00:00:00Z' }, // even later: the seal is not editable
      { is_letter: false },
      { language: 'ar' },
    ]) {
      await expect(save(A, { id: L(1), ...patch }, rev), JSON.stringify(patch)).rejects.toThrow(/letter_is_sealed/)
    }
    expect((await body(L(1))).body_text).toBe('the lighthouse password is marmalade')
  })

  it('a second tab that still shows the old draft cannot overwrite the sealed letter', async () => {
    const v1 = await save(A, { id: L(1), entry_date: '2026-10-01', body_text: 'draft', body_rich: doc('draft'), is_letter: true })
    await save(A, { id: L(1), sealed: true, unlock_at: FUTURE }, v1.revision) // tab 1 seals it
    await expect(save(A, { id: L(1), body_text: 'draft, edited late in tab 2', body_rich: doc('draft, edited late in tab 2') }, v1.revision)).rejects.toThrow(/letter_is_sealed/)
    expect((await body(L(1))).body_text).toBe('draft')
  })

  it('saving it again unchanged (a retry whose first response was lost) is harmless', async () => {
    const rev = await sealedLetter()
    const same = await save(A, { id: L(1), body_text: 'the lighthouse password is marmalade', sealed: true, unlock_at: FUTURE }, rev)
    expect(same.revision).toBe(rev)
  })

  it('the restore flag is cleared the moment a restore ends, even within one transaction', async () => {
    await sealedLetter()
    await expect(
      db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: A, role: 'authenticated' })])
        await tx.query('set local role authenticated')
        await tx.query(`select restore_batch('{"entries":[]}'::jsonb, '{}'::jsonb, false)`)
        await tx.query(`update entries set body_text = 'sneaky, straight after a restore' where id = $1`, [L(1)])
      }),
    ).rejects.toThrow(/letter_is_sealed/)
    expect((await body(L(1))).body_text).toBe('the lighthouse password is marmalade')
  })

  it('it can still be moved to the trash and back', async () => {
    await sealedLetter()
    expect(await as(A, `update entries set deleted_at = now() where id = $1 returning id`, [L(1)])).toHaveLength(1)
    expect(await as(A, `update entries set deleted_at = null where id = $1 returning id`, [L(1)])).toHaveLength(1)
  })

  it('a restore can import text but a later ordinary save is guarded again (the restore flag does not leak)', async () => {
    const rev = await sealedLetter()
    await as(A, `select restore_batch($1::jsonb, '{}'::jsonb, false)`, [JSON.stringify({ entries: [{ id: L(1), entry_date: '2026-10-01', title: 'To me, at graduation', body_text: 'imported', body_rich: doc('imported'), updated_at: '2099-01-01T00:00:00Z', letter: { to: 'Future me', sealed: true, unlock_at: FUTURE } }] })])
    expect((await body(L(1))).body_text).toBe('imported')
    expect((await body(L(1))).sealed).toBe(true) // the seal survived the restore
    await expect(save(A, { id: L(1), body_text: 'sneaky' }, rev + 1)).rejects.toThrow(/letter_is_sealed/)
  })
})

describe('when the date comes', () => {
  it('the letter opens and is an ordinary entry again', async () => {
    const rev = await sealedLetter(1, FUTURE)
    await dateArrives(L(1))
    const edited = await save(A, { id: L(1), body_text: 'a note added after opening' }, rev)
    expect(edited.revision).toBe(rev + 1)
    expect((await body(L(1))).body_text).toBe('a note added after opening')
  })
})

describe('lists and search never reveal a sealed letter', () => {
  const browse = (uid: string, q: string | null = null) =>
    as<{ id: string; title: string | null; snippet: string | null; letter_to: string | null; sealed_until: string | null }>(uid, `select * from browse_entries($1)`, [q])

  it('browse: no title, no snippet, but who it is for and when it opens', async () => {
    await sealedLetter()
    const [row] = await browse(A)
    expect(row).toMatchObject({ id: L(1), title: null, snippet: null, letter_to: 'Future me' })
    expect(new Date(row.sealed_until!).toISOString()).toBe('2099-04-20T00:00:00.000Z')
  })
  it('search by its title, its words, or a part of them finds nothing', async () => {
    await sealedLetter()
    for (const q of ['graduation', 'marmalade', 'lighthou', 'To me, at']) expect(await browse(A, q), q).toEqual([])
  })
  it('once opened, title and words are findable', async () => {
    await sealedLetter()
    await dateArrives(L(1))
    expect((await browse(A, 'marmalade')).map((r) => r.id)).toEqual([L(1)])
    expect((await browse(A))[0]).toMatchObject({ title: 'To me, at graduation', letter_to: null, sealed_until: null })
  })
  it('list_letters: sealed first (soonest to open first), then opened and drafts; sealed ones masked', async () => {
    await sealedLetter(1, '2099-04-20T00:00:00Z')
    await sealedLetter(2, '2098-01-01T00:00:00Z')
    await save(A, { id: L(3), entry_date: '2026-10-02', title: 'Unfinished', body_text: 'dear you', is_letter: true, letter_to: 'You' })
    await sealedLetter(4, FUTURE)
    await dateArrives(L(4)) // already opened
    const rows = await as<{ id: string; title: string | null; snippet: string | null; is_sealed_now: boolean }>(A, `select * from list_letters()`)
    expect(rows.slice(0, 2).map((r) => r.id)).toEqual([L(2), L(1)]) // sealed first, the soonest to open first
    expect(rows.slice(0, 2).every((r) => r.is_sealed_now && r.title === null && r.snippet === null)).toBe(true)
    expect(rows.slice(2).map((r) => r.id).sort()).toEqual([L(3), L(4)].sort())
    expect(rows.find((r) => r.id === L(3))).toMatchObject({ title: 'Unfinished', snippet: 'dear you', is_sealed_now: false })
    expect(rows.find((r) => r.id === L(4))!.snippet).toContain('marmalade')
  })
  it('a letter that is not a letter at all is not listed', async () => {
    await save(A, { id: L(9), entry_date: '2026-10-02', body_text: 'an ordinary day' })
    expect(await as(A, `select * from list_letters()`)).toEqual([])
  })
})

describe('whose letters', () => {
  it('B sees none of A\'s, and signed-out visitors cannot ask', async () => {
    await sealedLetter()
    expect(await as(B, `select * from list_letters()`)).toEqual([])
    expect(await browse(B)).toEqual([])
    await expect(as(A, `select * from list_letters()`, [], 'anon')).rejects.toThrow()
  })
  function browse(uid: string) { return as(uid, `select * from browse_entries()`) }
})

describe('export', () => {
  it('a sealed letter is exported in full, with sealed: true and its unlock date (the file belongs to the user)', async () => {
    await sealedLetter()
    const [{ j }] = await as<{ j: { entries: { id: string; body_text: string; letter: { to: string; sealed: boolean; unlock_at: string } }[] } }>(A, `select export_journal() as j`)
    const e = j.entries.find((x) => x.id === L(1))!
    expect(e.body_text).toBe('the lighthouse password is marmalade')
    expect(e.letter).toEqual({ to: 'Future me', sealed: true, unlock_at: '2099-04-20T00:00:00.000000Z' })
  })
})
