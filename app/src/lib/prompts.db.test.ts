/**
 * Phase 8 "done when", server side, on real Postgres (PGlite) with the real migrations:
 * loading the prompt JSON populates the table (and loading it again changes nothing), anyone can read it, nobody can write it.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { seedToSql, validateSeed } from './promptSeed'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
let db: PGlite
const report = validateSeed(JSON.parse(readFileSync(join(ROOT, 'seed', 'prompts.json'), 'utf8')))
const seed = report.prompts
const count = async () => Number((await db.query<{ n: string }>('select count(*) n from prompts')).rows[0].n)
async function as(role: string, sql: string, uid?: string) {
  return db.transaction(async (tx) => {
    if (uid) await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await tx.query(`set local role ${role}`)
    return (await tx.query(sql)).rows
  })
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t')`)
})

describe('loading the prompt file', () => {
  it('the file in the repo passes every check', () => {
    expect(report.errors).toEqual([])
    expect(seed.length).toBeGreaterThan(20)
  })
  it('populates the table', async () => {
    await db.exec(seedToSql(seed))
    expect(await count()).toBe(seed.length)
    const r = await db.query<{ depth: string; mood: string | null; time_of_day: string | null; language: string }>(`select * from prompts where text like 'What did you eat today%'`)
    expect(r.rows[0]).toMatchObject({ depth: 'light', mood: null, time_of_day: 'evening', language: 'en' })
  })
  it('loading it again adds nothing; changed tags are updated in place', async () => {
    await db.exec(seedToSql(seed))
    expect(await count()).toBe(seed.length)
    const changed = seed.map((p, i) => (i === 0 ? { ...p, depth: 'deep' as const } : p))
    await db.exec(seedToSql(changed))
    expect(await count()).toBe(seed.length)
    expect((await db.query<{ depth: string }>('select depth from prompts where text = $1', [seed[0].text])).rows[0].depth).toBe('deep')
  })
  it('the same words in the same language cannot be stored twice', async () => {
    await expect(db.exec(`insert into prompts (text, depth) values ('${seed[1].text.replace(/'/g, "''")}', 'light')`)).rejects.toThrow()
  })
  it('refuses a made-up depth or time of day', async () => {
    await expect(db.exec(`insert into prompts (text, depth) values ('A fresh prompt one', 'shallow')`)).rejects.toThrow()
    await expect(db.exec(`insert into prompts (text, depth, time_of_day) values ('A fresh prompt two', 'light', 'noon')`)).rejects.toThrow()
  })
})

describe('who can touch the table', () => {
  it('anyone, signed in or not, can read it', async () => {
    expect((await as('anon', 'select count(*)::int n from prompts'))[0]).toMatchObject({ n: seed.length })
    expect((await as('authenticated', 'select count(*)::int n from prompts', A))[0]).toMatchObject({ n: seed.length })
  })
  for (const sql of [
    `insert into prompts (text, depth) values ('Sneaky prompt from a client', 'light')`,
    `update prompts set text = 'changed by a client'`,
    `delete from prompts`,
  ]) {
    it(`nobody from the app can: ${sql.split(' ').slice(0, 3).join(' ')}`, async () => {
      await expect(as('authenticated', sql, A)).rejects.toThrow()
      await expect(as('anon', sql)).rejects.toThrow()
    })
  }
})
