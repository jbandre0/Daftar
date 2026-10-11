/**
 * Phase 5 "done when", against real Postgres (PGlite) with the real migrations:
 *   search finds partial words in English and Arabic.
 * Plus filters, near-misses, sealed letters, isolation, paging, and the date list for Read mode.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const T = (n: number) => `00000000-0000-4000-8000-00000000f${String(n).padStart(3, '0')}`
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let db: PGlite

async function asUser<T = unknown>(uid: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await tx.query('set local role authenticated')
    return (await tx.query<T>(sql, params)).rows
  })
}

type Hit = { id: string; entry_date: string; title: string | null; snippet: string | null; tag_ids: string[]; total_count: string | number; track_id: string | null }
const browse = (uid: string, args: Record<string, unknown> = {}) => {
  const a = { q: null, track: null, tags: null, language: null, from: null, to: null, limit: 40, offset: 0, ...args }
  return asUser<Hit>(uid, `select * from browse_entries($1, $2, $3::uuid[], $4, $5::date, $6::date, $7, $8)`, [a.q, a.track, a.tags, a.language, a.from, a.to, a.limit, a.offset])
}
const ids = (rows: Hit[]) => rows.map((r) => r.id)

async function entry(n: number, date: string, title: string | null, body: string, extra: Record<string, unknown> = {}) {
  await db.query(
    `insert into entries (id, user_id, entry_date, title, body_text, body_rich, language, track_id, sealed, unlock_at, is_letter)
     values ($1, $2, $3, $4, $5, '{}', $6, $7, $8, $9, $8)`,
    [id(n), extra.user ?? A, date, title, body, extra.language ?? 'en', extra.track ?? null, extra.sealed ?? false, extra.unlock ?? null],
  )
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t'), ('${B}', 'b@t')`)
  await db.query(`insert into tracks (id, user_id, name, slug) values ($1, $2, 'Walks', 'walks')`, [T(1), A])
  await db.query(`insert into tags (id, user_id, name) values ($1, $3, 'family'), ($2, $3, 'travel')`, [T(11), T(12), A])

  await entry(1, '2026-10-01', 'Grandmother visit', 'We drove to see my grandmother. She made lentil soup and told the story of the old house again.', { track: T(1) })
  await entry(2, '2026-10-03', null, 'Quiet day. Wrote a letter, walked to the river, and watched the water for a long while.')
  await entry(3, '2026-10-03', 'Same day, second entry', 'Evening notes about nothing in particular.')
  await entry(4, '2026-10-07', 'عن الصبر', 'الحمد لله على كل حال. كتبت هذه الفقرة بالعربية داخل صفحة إنجليزية. الصبر مفتاح الفرج.', { language: 'ar' })
  await entry(5, '2026-10-09', 'Mixed', 'Read Alma 32 today. الحمد لله then back to English, the seed comparison again.')
  await entry(6, '2026-10-10', 'To me, at graduation', 'Secret words: the lighthouse password is marmalade.', { sealed: true, unlock: '2099-01-01T00:00:00Z' })
  await entry(7, '2026-10-11', 'An opened letter', 'This letter was sealed once; its date has passed. Marmalade again.', { sealed: true, unlock: '2020-01-01T00:00:00Z' })
  await entry(8, '2026-10-12', "Percent_and under'score", 'Costs went up 50% this year, and the file_name had an underscore.')
  await entry(9, '2026-10-04', 'Not mine', 'grandmother secrets that belong to someone else', { user: B })
  await db.query(`insert into entry_tags (entry_id, tag_id, user_id) values ($1, $3, $5), ($1, $4, $5), ($2, $3, $5)`, [id(1), id(2), T(11), T(12), A])
  await db.query(`update entries set deleted_at = now() where id = $1`, [id(3)]) // soft-deleted entries never show
  await entry(10, '2026-09-20', 'Old', 'An older entry from September with the word grandmother in it.')
})

describe('search', () => {
  it('finds a whole word', async () => {
    expect(ids(await browse(A, { q: 'lentil' }))).toEqual([id(1)])
  })

  it('finds PART of a word, from the start, the middle and the end (English)', async () => {
    expect(ids(await browse(A, { q: 'grandm' }))).toContain(id(1))
    expect(ids(await browse(A, { q: 'randmoth' }))).toContain(id(1))
    expect(ids(await browse(A, { q: 'mother' }))).toContain(id(1))
    expect(ids(await browse(A, { q: 'lent' }))).toEqual([id(1)])
  })

  it('finds PART of a word in Arabic (partial words, via ILIKE)', async () => {
    expect(ids(await browse(A, { q: 'الصب' }))).toContain(id(4)) // prefix of الصبر
    expect(ids(await browse(A, { q: 'بالعرب' }))).toContain(id(4)) // middle of بالعربية
    expect(ids(await browse(A, { q: 'فرج' }))).toContain(id(4))
    expect(ids(await browse(A, { q: 'الحمد' }))).toEqual(expect.arrayContaining([id(4), id(5)])) // Arabic inside a mixed entry too
  })

  it('finds a whole Arabic word, and English next to Arabic', async () => {
    expect(ids(await browse(A, { q: 'الصبر' }))).toContain(id(4))
    expect(ids(await browse(A, { q: 'seed' }))).toEqual([id(5)])
  })

  it('short words and phrases are exact: no loose fuzzy matches ("seed" is not "see")', async () => {
    expect(ids(await browse(A, { q: 'seed' }))).toEqual([id(5)]) // entry 1 has "see", entry 7 "sealed"
    expect(ids(await browse(A, { q: 'see' })).sort()).toEqual([id(1), id(5)].sort()) // "see" is in entry 1 and, as part of "seed", entry 5
    expect(ids(await browse(A, { q: 'grandmother lentil' })).sort()).toEqual([id(1)])
  })

  it('searches titles as well as text', async () => {
    expect(ids(await browse(A, { q: 'Grandmother visit' }))).toEqual([id(1)])
    expect(ids(await browse(A, { q: 'عن الصبر' }))).toContain(id(4))
  })

  it('is case-insensitive', async () => {
    expect(ids(await browse(A, { q: 'LENTIL' }))).toEqual([id(1)])
  })

  it('tolerates a typo (trigram similarity)', async () => {
    expect(ids(await browse(A, { q: 'grandmohter' }))).toContain(id(1))
    expect(ids(await browse(A, { q: 'lighthuse' })).length).toBe(0) // only the sealed letter has it: still hidden
  })

  it('treats % and _ as plain characters, not wildcards', async () => {
    expect(ids(await browse(A, { q: '50%' }))).toEqual([id(8)])
    expect(ids(await browse(A, { q: 'file_name' }))).toEqual([id(8)])
    expect(ids(await browse(A, { q: '%' }))).toEqual([id(8)])
    expect(ids(await browse(A, { q: "under'score" }))).toEqual([id(8)])
    expect(ids(await browse(A, { q: '\\' }))).toEqual([])
  })

  it('returns a snippet around the match', async () => {
    const [hit] = await browse(A, { q: 'lentil' })
    expect(hit.snippet).toContain('lentil soup')
    expect(hit.snippet!.length).toBeLessThanOrEqual(160)
    const [ar] = await browse(A, { q: 'الصبر' })
    expect(ar.snippet).toContain('الصبر')
  })

  it('ranks title matches above body matches', async () => {
    // "letter": entry 2 has it in the body; entry 7 ("An opened letter") has it in the title and body
    const r = await browse(A, { q: 'letter' })
    expect(r.map((x) => x.id).slice(0, 2)).toEqual([id(7), id(2)])
  })
})

describe('sealed letters', () => {
  it('a sealed letter is never matched by its text or title, and never shows a snippet', async () => {
    expect(ids(await browse(A, { q: 'marmalade' }))).toEqual([id(7)]) // only the opened one
    expect(ids(await browse(A, { q: 'lighthouse' }))).toEqual([])
    expect(ids(await browse(A, { q: 'To me, at graduation' }))).toEqual([])
    const all = await browse(A, {})
    const sealed = all.find((r) => r.id === id(6))!
    expect(sealed).toBeTruthy() // it is listed (as a sealed card later), but...
    expect(sealed.snippet).toBeNull() // ...its words are not
  })
  it('once the date has passed it is an ordinary entry', async () => {
    const opened = (await browse(A, {})).find((r) => r.id === id(7))!
    expect(opened.snippet).toContain('sealed once')
  })
})

describe('filters', () => {
  it('lists newest first, never soft-deleted ones, never someone else’s', async () => {
    const all = await browse(A, {})
    const iso = all.map((r) => new Date(r.entry_date).toISOString().slice(0, 10))
    expect(iso).toEqual([...iso].sort().reverse())
    expect(ids(all)).not.toContain(id(3))
    expect(ids(all)).not.toContain(id(9))
    expect(Number(all[0].total_count)).toBe(all.length)
  })
  it('B only ever sees B', async () => {
    expect(ids(await browse(B, {}))).toEqual([id(9)])
    expect(ids(await browse(B, { q: 'grandmother' }))).toEqual([id(9)])
  })
  it('track', async () => {
    expect(ids(await browse(A, { track: T(1) }))).toEqual([id(1)])
  })
  it('language', async () => {
    expect(ids(await browse(A, { language: 'ar' }))).toEqual([id(4)])
  })
  it('date range, both ends inclusive (this is how a chapter filters)', async () => {
    expect(ids(await browse(A, { from: '2026-10-03', to: '2026-10-07' })).sort()).toEqual([id(2), id(4)].sort())
    expect(ids(await browse(A, { from: '2026-10-12' }))).toEqual([id(8)])
    expect(ids(await browse(A, { to: '2026-09-30' }))).toEqual([id(10)])
  })
  it('tags: one tag, and several means ALL of them', async () => {
    expect(ids(await browse(A, { tags: [T(11)] })).sort()).toEqual([id(1), id(2)].sort())
    expect(ids(await browse(A, { tags: [T(11), T(12)] }))).toEqual([id(1)])
    expect((await browse(A, { tags: [T(11)] }))[0].tag_ids.length).toBeGreaterThan(0)
  })
  it('a removed tag link no longer filters', async () => {
    await db.query(`update entry_tags set deleted_at = now() where entry_id = $1 and tag_id = $2`, [id(2), T(11)])
    expect(ids(await browse(A, { tags: [T(11)] }))).toEqual([id(1)])
    await db.query(`update entry_tags set deleted_at = null where entry_id = $1 and tag_id = $2`, [id(2), T(11)])
  })
  it('filters and search combine', async () => {
    expect(ids(await browse(A, { q: 'grandmother', from: '2026-10-01' }))).toEqual([id(1)])
    expect(ids(await browse(A, { q: 'grandmother', language: 'ar' }))).toEqual([])
  })
  it('paging: limit, offset, and a stable total', async () => {
    const first = await browse(A, { limit: 3, offset: 0 })
    const second = await browse(A, { limit: 3, offset: 3 })
    expect(first).toHaveLength(3)
    expect(ids(first).some((x) => ids(second).includes(x))).toBe(false)
    expect(Number(first[0].total_count)).toBe(Number(second[0].total_count))
    expect(await browse(A, { limit: 3, offset: 1000 })).toEqual([])
  })
  it('a blank search is just the list', async () => {
    expect(ids(await browse(A, { q: '   ' }))).toEqual(ids(await browse(A, {})))
  })
})

describe('entry_dates (Read mode)', () => {
  it('lists each date once, in order, without trashed or foreign entries', async () => {
    const [{ entry_dates }] = await asUser<{ entry_dates: string[] }>(A, 'select entry_dates()')
    const dates = entry_dates.map((d) => (typeof d === 'string' ? d : (d as unknown as Date).toISOString().slice(0, 10)))
    expect(dates).toEqual(['2026-09-20', '2026-10-01', '2026-10-03', '2026-10-07', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'])
  })
  it('is empty for an account with nothing', async () => {
    await db.exec(`insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000c3', 'c@t')`)
    const [{ entry_dates }] = await asUser<{ entry_dates: string[] }>('00000000-0000-4000-8000-0000000000c3', 'select entry_dates()')
    expect(entry_dates).toEqual([])
  })
  it('signed-out visitors can call neither function', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query('set local role anon')
      await tx.query('select entry_dates()')
    })).rejects.toThrow()
    await expect(db.transaction(async (tx) => {
      await tx.query('set local role anon')
      await tx.query('select * from browse_entries()')
    })).rejects.toThrow()
  })
})
