/**
 * Phase 9 "done when", server side, on real Postgres (PGlite) with the real migrations:
 * buy -> unlock, refund -> read-only, replaying a webhook does nothing, and nobody but the service role can touch a licence.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const P = 'lemonsqueezy'
let db: PGlite

beforeEach(async () => {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@t'), ('${B}', 'b@t')`)
})

const asRole = (role: string, uid: string | null, sql: string, params: unknown[] = []) =>
  db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role })])
    await tx.query(`set local role ${role}`)
    return (await tx.query<any>(sql, params)).rows
  })
const event = async (kind: string, order: string, uid: string | null = A) =>
  (await asRole('service_role', null, `select apply_license_event($1, $2, $3, $4) as r`, [P, kind, order, uid]))[0].r as string
const lic = async (uid = A) => (await db.query<any>(`select status, provider, provider_order_id, unlocked_at from licenses where user_id = $1`, [uid])).rows[0]
const canWrite = async (uid = A) => (await asRole('authenticated', uid, `select can_write() w, can_edit() e`))[0]
const expire = (uid = A, days = 10) => db.query(`update licenses set trial_ends_at = now() - make_interval(days => $2) where user_id = $1`, [uid, days])

describe('buying', () => {
  it('a paid order unlocks, records the order, and writing keeps working after the trial would have ended', async () => {
    expect((await lic()).status).toBe('trial')
    expect(await event('paid', '1001')).toBe('unlocked')
    expect(await lic()).toMatchObject({ status: 'unlocked', provider: P, provider_order_id: '1001' })
    expect((await lic()).unlocked_at).not.toBeNull()
    await expire()
    expect(await canWrite()).toEqual({ w: true, e: true })
  })
  it('replaying the same webhook does nothing', async () => {
    await event('paid', '1001')
    const before = await lic()
    expect(await event('paid', '1001')).toBe('duplicate')
    expect(await lic()).toEqual(before)
    expect(Number((await db.query<any>('select count(*) n from license_events')).rows[0].n)).toBe(1)
  })
  it('a second, different order keeps the first and says so', async () => {
    await event('paid', '1001')
    expect(await event('paid', '1002')).toBe('already_unlocked')
    expect((await lic()).provider_order_id).toBe('1001')
  })
  it('an unknown user, or no user id at all, unlocks nobody', async () => {
    expect(await event('paid', '2001', '00000000-0000-4000-8000-00000000ffff')).toBe('unknown_user')
    expect(await event('paid', '2002', null)).toBe('unknown_user')
    expect((await lic()).status).toBe('trial')
    expect((await lic(B)).status).toBe('trial')
  })
  it("one person's purchase never unlocks another", async () => {
    await event('paid', '1001', A)
    expect((await lic(B)).status).toBe('trial')
  })
  it('rubbish input is ignored', async () => {
    expect(await event('paid', '')).toBe('ignored')
    expect(await event('chargeback', '5')).toBe('ignored')
    expect((await asRole('service_role', null, `select apply_license_event('', 'paid', '5', $1) as r`, [A]))[0].r).toBe('ignored')
  })
})

describe('refunds', () => {
  it('a refund makes the account read-only and touches no writing', async () => {
    await db.query(`insert into entries (id, user_id, entry_date, title, body_text) values (gen_random_uuid(), $1, '2026-10-01', 'Kept', 'my words')`, [A])
    await event('paid', '1001')
    expect(await event('refunded', '1001', null)).toBe('refunded')
    expect((await lic()).status).toBe('refunded')
    expect(await canWrite()).toEqual({ w: false, e: false })
    expect((await asRole('authenticated', A, `select body_text from entries`))[0].body_text).toBe('my words')
    expect((await asRole('authenticated', A, `select export_journal() as j`))[0].j).toBeTruthy()
  })
  it('refunded stays read-only even with trial days left', async () => {
    await event('paid', '1001')
    await event('refunded', '1001', null)
    await db.query(`update licenses set trial_ends_at = now() + interval '10 days' where user_id = $1`, [A])
    expect(await canWrite()).toEqual({ w: false, e: false })
  })
  it('replaying a refund does nothing', async () => {
    await event('paid', '1001')
    await event('refunded', '1001', null)
    expect(await event('refunded', '1001', null)).toBe('duplicate')
    expect((await lic()).status).toBe('refunded')
  })
  it('a refund for an order we never saw changes nothing', async () => {
    await event('paid', '1001')
    expect(await event('refunded', '9999', null)).toBe('unknown_order')
    expect((await lic()).status).toBe('unlocked')
  })
  it('refunding an OLD order never touches a newer unlock', async () => {
    await event('paid', '1001')
    await event('refunded', '1001', null)
    await event('paid', '1002') // bought again
    expect((await lic()).status).toBe('unlocked')
    expect(await event('refunded', '1001', null)).toBe('duplicate')
    expect((await lic()).status).toBe('unlocked')
    expect((await lic()).provider_order_id).toBe('1002')
  })
  it('buying again after a refund unlocks again', async () => {
    await event('paid', '1001')
    await event('refunded', '1001', null)
    expect(await event('paid', '1002')).toBe('unlocked')
    expect(await canWrite()).toEqual({ w: true, e: true })
  })
  it('webhooks out of order: a refund that arrives before its order never lets the order unlock', async () => {
    expect(await event('refunded', '1001', null)).toBe('unknown_order')
    expect(await event('paid', '1001')).toBe('refunded_before_paid')
    expect((await lic()).status).toBe('trial')
  })
})

describe('trial states (section 9)', () => {
  it('trial: write and edit. 24h past: grace (edit only). 3 days past: read-only', async () => {
    expect(await canWrite()).toEqual({ w: true, e: true })
    await db.query(`update licenses set trial_ends_at = now() - interval '24 hours' where user_id = $1`, [A])
    expect(await canWrite()).toEqual({ w: false, e: true })
    await expire(A, 3)
    expect(await canWrite()).toEqual({ w: false, e: false })
  })
})

describe('who can touch licences', () => {
  it('signed-in users read only their own licence', async () => {
    const rows = await asRole('authenticated', A, `select user_id from licenses`)
    expect(rows).toEqual([{ user_id: A }])
  })
  for (const sql of [
    `update licenses set status = 'unlocked'`,
    `update licenses set trial_ends_at = now() + interval '999 days'`,
    `insert into licenses (user_id) values ('${B}')`,
    `delete from licenses`,
    `select * from license_events`,
    `select apply_license_event('lemonsqueezy', 'paid', 'x', '${A}')`,
  ]) {
    it(`a user cannot: ${sql.slice(0, 48)}`, async () => {
      await expect(asRole('authenticated', A, sql)).rejects.toThrow()
      await expect(asRole('anon', null, sql)).rejects.toThrow()
    })
  }
})
