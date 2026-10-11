/**
 * Phase 4 "done when", against real Postgres (PGlite) with the real migrations:
 *   export → wipe → restore → export again: the two files match apart from timestamps.
 *   restoring the same file twice changes nothing.
 * Plus every conflict rule in spec §5.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildExport, parseJournal, runRestore, serialize, type JournalFile, type Rpc } from './vault'
import type { Draft } from './draftStore'

const ROOT = join(__dirname, '..', '..', '..', 'supabase')
const A = '00000000-0000-4000-8000-0000000000a1'
const B = '00000000-0000-4000-8000-0000000000b2'
const FIXED = new Date('2026-10-12T09:00:00Z')

let db: PGlite

async function freshDb() {
  db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(readFileSync(join(ROOT, 'tests/shim.sql'), 'utf8'))
  for (const f of readdirSync(join(ROOT, 'migrations')).sort()) await db.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@test'), ('${B}', 'b@test')`)
}

/** Run one statement as a signed-in user, the way PostgREST would. */
async function asUser<T = unknown>(uid: string, sql: string, params: unknown[] = []): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: uid, role: 'authenticated' })])
    await tx.query('set local role authenticated')
    const r = await tx.query<{ r: T }>(sql, params)
    return r.rows[0]?.r as T
  })
}

function rpcFor(uid: string): Rpc {
  return async (fn, args = {}) => {
    switch (fn) {
      case 'export_journal':
        return asUser(uid, 'select export_journal() as r')
      case 'restore_meta':
        return asUser(uid, 'select restore_meta($1::jsonb, $2::boolean) as r', [JSON.stringify(args.p), args.p_dry_run])
      case 'restore_batch':
        return asUser(uid, 'select restore_batch($1::jsonb, $2::jsonb, $3::boolean) as r', [
          JSON.stringify(args.p), JSON.stringify(args.p_remap), args.p_dry_run,
        ])
      default:
        throw new Error('unknown rpc ' + fn)
    }
  }
}

const save = (uid: string, entry: Record<string, unknown>, base = 0) =>
  asUser<{ revision: number }>(uid, 'select save_entry($1::jsonb, $2) as r', [JSON.stringify(entry), base])

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

async function trackId(uid: string, slug: string) {
  return (await db.query<{ id: string }>(`select id from tracks where user_id = $1 and slug = $2`, [uid, slug])).rows[0].id
}

/** A journal with every kind of thing in it. */
async function seedA() {
  const daily = await trackId(A, 'daily')
  const spirit = await trackId(A, 'spiritual')
  const dreams = await trackId(A, 'dreams')
  await asUser(A, `update tracks set name = 'Every day' where id = $1`, [daily])
  await asUser(A, `insert into tracks (id, user_id, name, slug, color_token, sort_order) values ($1, $2, 'Poems', 'poems', 'seal', 5)`, [id(901), A])
  await asUser(A, `insert into tags (id, user_id, name) values ($1, $4, 'family'), ($2, $4, 'مسجد'), ($3, $4, 'travel')`, [id(801), id(802), id(803), A])
  await asUser(A, `insert into chapters (id, user_id, name, start_date, end_date) values ($1, $3, 'Summer', '2026-06-01', '2026-08-31'), ($2, $3, 'Junior year', '2026-09-01', null)`, [id(701), id(702), A])

  await save(A, { id: id(1), entry_date: '2026-07-04', title: 'Fireworks', body_text: 'Loud and bright.', body_rich: doc('Loud and bright.'), word_count: 3, track_id: daily, tag_ids: [id(801), id(803)] })
  await save(A, { id: id(2), entry_date: '2026-10-07', title: 'Morning by the window', body_text: 'Read Alma 32. الحمد لله على كل حال', body_rich: doc('Read Alma 32. الحمد لله على كل حال'), word_count: 9, language: 'en', track_id: spirit, tag_ids: [id(802)], fields: { scripture: 'Alma 32', answered_later: false } })
  await save(A, { id: id(3), entry_date: '2026-10-08', title: null, body_text: 'A dream about a lighthouse.', body_rich: doc('A dream about a lighthouse.'), word_count: 5, track_id: dreams })
  await save(A, { id: id(4), entry_date: '2026-10-08', title: 'To me, at graduation', body_text: 'Open this when you walk.', body_rich: doc('Open this when you walk.'), word_count: 5, is_letter: true, letter_to: 'Future me', sealed: true, unlock_at: '2029-04-20T15:00:00Z' })
  await save(A, { id: id(5), entry_date: '2026-10-09', title: 'Deleted later', body_text: 'gone', body_rich: doc('gone') })
  await asUser(A, `update entries set deleted_at = now() where id = $1`, [id(5)])
  // An entry with history: a conflict leaves a saved version behind.
  await save(A, { id: id(6), entry_date: '2026-10-10', title: 'Drafted twice', body_text: 'first', body_rich: doc('first'), word_count: 1 })
  await save(A, { id: id(6), body_text: 'second', body_rich: doc('second') }, 1)
  await save(A, { id: id(6), body_text: 'from the phone', body_rich: doc('from the phone') }, 1) // stale base → version kept
  await asUser(A, `update tracks set deleted_at = now() where id = $1`, [dreams]) // hidden, still used by entry 3
  await asUser(A, `update tags set deleted_at = now() where id = $1`, [id(803)]) // deleted tag: off every entry
}

async function wipe(uid: string) {
  await db.exec(`
    delete from entry_versions where user_id = '${uid}';
    delete from entry_tags where user_id = '${uid}';
    delete from entries where user_id = '${uid}';
    delete from tags where user_id = '${uid}';
    delete from chapters where user_id = '${uid}';
    delete from tracks where user_id = '${uid}';`)
}

/** Everything about an account that a restore could change. */
async function state(uid: string) {
  const q = async (sql: string) => (await db.query(sql, [uid])).rows
  return JSON.stringify({
    entries: await q(`select id, revision, updated_at, deleted_at, body_text, title, track_id, sealed, unlock_at from entries where user_id = $1 order by id`),
    tags: await q(`select id, name, updated_at, deleted_at from tags where user_id = $1 order by id`),
    entry_tags: await q(`select entry_id, tag_id, deleted_at, updated_at from entry_tags where user_id = $1 order by entry_id, tag_id`),
    tracks: await q(`select id, name, updated_at, deleted_at from tracks where user_id = $1 order by id`),
    chapters: await q(`select id, name, updated_at from chapters where user_id = $1 order by id`),
    versions: await q(`select id, entry_id, reason from entry_versions where user_id = $1 order by id`),
  })
}

/** Timestamps the round trip is allowed to change. */
function normalise(f: JournalFile) {
  const strip = (o: Record<string, unknown>) => {
    const { updated_at: _u, ...rest } = o
    return rest
  }
  return {
    ...f,
    exported_at: '',
    tracks: f.tracks.map(strip),
    tags: f.tags.map(strip),
    chapters: f.chapters.map(strip),
    entries: f.entries.map(strip),
  }
}

async function exportFile(uid: string) {
  return buildExport(rpcFor(uid), [], FIXED)
}

async function restore(uid: string, file: JournalFile, dryRun = false, batchSize?: number) {
  const parsed = parseJournal(serialize(file))
  if (!parsed.ok) throw new Error(parsed.error)
  return runRestore(rpcFor(uid), parsed, { dryRun, batchSize })
}

beforeEach(async () => {
  await freshDb()
  await seedA()
})

// ---------------------------------------------------------------------------------------------------------------

describe('export', () => {
  it('is complete, self-contained and readable', async () => {
    const f = await exportFile(A)
    expect(f.format).toBe('daftar.journal')
    expect(f.schema_version).toBe(1)
    expect(f._readme).toMatch(/belongs to you/)
    expect(f.entries.map((e) => e.id)).toEqual([id(1), id(2), id(3), id(4), id(6)]) // ordered by date; soft-deleted excluded
    const e2 = f.entries.find((e) => e.id === id(2))!
    expect(e2.body_text).toContain('الحمد لله')
    expect(e2.fields).toEqual({ scripture: 'Alma 32', answered_later: false })
    // every reference resolves inside the file
    const trackIds = new Set(f.tracks.map((t) => t.id))
    const tagIds = new Set(f.tags.map((t) => t.id))
    for (const e of f.entries) {
      if (e.track_id) expect(trackIds.has(e.track_id)).toBe(true)
      for (const t of e.tag_ids) expect(tagIds.has(t)).toBe(true)
    }
    expect(f.tracks.find((t) => t.slug === 'dreams')?.hidden).toBe(true) // hidden but used, so included
    expect(f.entries.find((e) => e.id === id(1))!.tag_ids).toEqual([id(801)]) // deleted tag left out
    expect(f.tags.map((t) => t.name)).not.toContain('travel')
    // sealed letter exported in full
    const letter = f.entries.find((e) => e.id === id(4))!
    expect(letter.letter).toEqual({ to: 'Future me', sealed: true, unlock_at: '2029-04-20T15:00:00.000000Z' })
    expect(letter.body_text).toBe('Open this when you walk.')
    // history travels too
    expect(f.entry_versions.filter((v) => v.entry_id === id(6))).toHaveLength(1)
    expect(f.entries[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })

  it('includes text from this device that has not synced yet', async () => {
    const draft = (eid: string, text: string, entry_date = '2026-10-11'): Draft => ({
      id: eid, userId: A, seq: 3, savedSeq: 1, baseRevision: 1, displaced: [], updatedAt: FIXED.getTime(),
      content: { id: eid, entry_date, title: 'Offline', body_rich: doc(text), body_text: text, language: 'en', word_count: 2 },
    })
    const f = await buildExport(rpcFor(A), [draft(id(1), 'newer offline words', '2026-07-04'), draft(id(50), 'never synced')], FIXED)
    const e1 = f.entries.find((e) => e.id === id(1))!
    expect(e1.body_text).toBe('newer offline words')
    expect(e1.unsynced).toBe(true)
    expect(f.entries.find((e) => e.id === id(50))?.body_text).toBe('never synced')
  })
})

describe('round trip (phase 4 "done when")', () => {
  it('export → wipe → restore → export: the files match apart from timestamps', async () => {
    const before = await exportFile(A)
    await wipe(A)
    expect((await exportFile(A)).entries).toHaveLength(0)

    const preview = await restore(A, before, true)
    expect(preview.counts.new).toBe(5)
    expect((await exportFile(A)).entries).toHaveLength(0) // the preview wrote nothing

    const report = await restore(A, before)
    expect(report.counts.new).toBe(5)
    expect(report.versionsAdded).toBe(1)
    expect(report.remapped).toHaveLength(0)

    const after = await exportFile(A)
    expect(normalise(after)).toEqual(normalise(before))
    expect(JSON.stringify(normalise(after))).toBe(JSON.stringify(normalise(before))) // same bytes, same order
  })

  it('restoring the same file twice changes nothing', async () => {
    const file = await exportFile(A)
    await wipe(A)
    await restore(A, file)
    const once = await state(A)
    const again = await restore(A, file)
    expect(await state(A)).toBe(once)
    expect(again.counts.unchanged).toBe(5)
    expect(again.counts.new + again.counts.updated + again.counts.restored_from_trash).toBe(0)
    expect(again.versionsAdded).toBe(0)
  })

  it('restoring into the unchanged account it came from changes nothing either', async () => {
    const file = await exportFile(A)
    const s = await state(A)
    const r = await restore(A, file)
    expect(await state(A)).toBe(s)
    expect(r.counts.unchanged).toBe(5)
  })

  it('small batches give the same result as one big batch', async () => {
    const file = await exportFile(A)
    await wipe(A)
    await restore(A, file, false, 2)
    expect(normalise(await exportFile(A))).toEqual(normalise(file))
  })
})

describe('conflict rules (spec §5)', () => {
  it('your newer edit is kept: "skipped, yours is newer"', async () => {
    const file = await exportFile(A)
    await save(A, { id: id(1), body_text: 'edited after the backup', body_rich: doc('edited after the backup') }, 1)
    const r = await restore(A, file)
    expect(r.entries.find((e) => e.id === id(1))!.outcome).toBe('skipped_local_newer')
    expect((await db.query<{ body_text: string }>(`select body_text from entries where id = $1`, [id(1)])).rows[0].body_text).toBe('edited after the backup')
  })

  it('a newer copy in the file wins, and the replaced text is kept as a version', async () => {
    const file = await exportFile(A)
    const e = file.entries.find((x) => x.id === id(1))!
    e.body_text = 'from a newer backup'
    e.body_rich = doc('from a newer backup')
    e.updated_at = '2030-01-01T00:00:00.000000Z'
    const r = await restore(A, file)
    expect(r.entries.find((x) => x.id === id(1))!.outcome).toBe('updated')
    const row = (await db.query<{ body_text: string }>(`select body_text from entries where id = $1`, [id(1)])).rows[0]
    expect(row.body_text).toBe('from a newer backup')
    const v = (await db.query<{ t: string }>(`select snapshot->>'body_text' as t from entry_versions where entry_id = $1 and reason = 'restore_overwrite'`, [id(1)])).rows
    expect(v.map((x) => x.t)).toEqual(['Loud and bright.'])
  })

  it('trash: a deletion newer than the backup stays deleted; a newer copy comes back out', async () => {
    const file = await exportFile(A)
    await asUser(A, `update entries set deleted_at = now() where id = $1`, [id(2)])
    let r = await restore(A, file)
    expect(r.entries.find((x) => x.id === id(2))!.outcome).toBe('stays_deleted')
    expect((await db.query(`select 1 from entries where id = $1 and deleted_at is not null`, [id(2)])).rows).toHaveLength(1)

    file.entries.find((x) => x.id === id(2))!.updated_at = '2030-01-01T00:00:00.000000Z'
    r = await restore(A, file)
    expect(r.entries.find((x) => x.id === id(2))!.outcome).toBe('restored_from_trash')
    expect((await db.query(`select 1 from entries where id = $1 and deleted_at is null`, [id(2)])).rows).toHaveLength(1)
  })

  it('tags on a merged entry are the union of both sides', async () => {
    const file = await exportFile(A)
    await asUser(A, `insert into tags (id, user_id, name) values ($1, $2, 'local-only')`, [id(804), A])
    await save(A, { id: id(1), tag_ids: [id(801), id(804)] }, 1) // local: family + local-only
    const e = file.entries.find((x) => x.id === id(1))!
    e.tag_ids = [id(802)] // file: مسجد
    e.body_text = 'newer'
    e.updated_at = '2030-01-01T00:00:00.000000Z'
    await restore(A, file)
    const tags = (await db.query<{ tag_id: string }>(`select tag_id from entry_tags where entry_id = $1 and deleted_at is null order by tag_id`, [id(1)])).rows.map((x) => x.tag_id)
    expect(tags).toEqual([id(801), id(802), id(804)])
  })

  it('a track, tag or chapter with the same name is reused and its id remapped', async () => {
    const file = await exportFile(A)
    const poems = file.tracks.find((t) => t.name === 'Poems')!
    poems.id = id(950) // same name, different id (e.g. from another account)
    file.tags.find((t) => t.name === 'family')!.id = id(951)
    file.entries.find((x) => x.id === id(1))!.tag_ids = [id(951)]
    file.entries.find((x) => x.id === id(1))!.track_id = id(950)
    file.entries.find((x) => x.id === id(1))!.updated_at = '2030-01-01T00:00:00.000000Z'
    const r = await restore(A, file)
    expect(r.meta.tracks.by_name).toBe(1)
    expect(r.meta.tags.by_name).toBe(1)
    const row = (await db.query<{ track_id: string }>(`select track_id from entries where id = $1`, [id(1)])).rows[0]
    expect(row.track_id).toBe(id(901)) // the local Poems
    expect((await db.query(`select 1 from tracks where id = $1`, [id(950)])).rows).toHaveLength(0) // no duplicate created
  })

  it('a newer rename in the file wins; an older one does not', async () => {
    const file = await exportFile(A)
    const t = file.tags.find((x) => x.id === id(801))!
    t.name = 'Family (older)'
    t.updated_at = '2000-01-01T00:00:00.000000Z'
    await restore(A, file)
    expect((await db.query<{ name: string }>(`select name from tags where id = $1`, [id(801)])).rows[0].name).toBe('family')
    t.name = 'Family & friends'
    t.updated_at = '2030-01-01T00:00:00.000000Z'
    const r = await restore(A, file)
    expect(r.meta.tags.renamed).toBe(1)
    expect((await db.query<{ name: string }>(`select name from tags where id = $1`, [id(801)])).rows[0].name).toBe('Family & friends')
  })

  it('restore never breaks a seal; the text still comes in', async () => {
    const file = await exportFile(A)
    const l = file.entries.find((x) => x.id === id(4))!
    l.letter = { to: 'Future me', sealed: false, unlock_at: null }
    l.body_text = 'edited letter'
    l.updated_at = '2030-01-01T00:00:00.000000Z'
    await restore(A, file)
    const row = (await db.query<{ sealed: boolean; unlock_at: Date; body_text: string }>(`select sealed, unlock_at, body_text from entries where id = $1`, [id(4)])).rows[0]
    expect(row.sealed).toBe(true)
    expect(row.unlock_at.toISOString()).toBe('2029-04-20T15:00:00.000Z')
    expect(row.body_text).toBe('edited letter')
  })

  it('a file restored into a different account keeps every word under new ids, and leaves the original alone', async () => {
    const file = await exportFile(A)
    const aBefore = await state(A)
    const r = await restore(B, file)
    expect(r.counts.new).toBe(5)
    expect(r.remapped).toHaveLength(5) // A owns those ids
    expect(await state(A)).toBe(aBefore)
    const fb = await exportFile(B)
    expect(fb.entries.map((e) => e.body_text).sort()).toEqual(file.entries.map((e) => e.body_text).sort())
    // B's own Spiritual, Letters and Dreams are reused by name; "Every day" and "Poems" are new
    expect(r.meta.tracks).toMatchObject({ by_name: 3, new: 2, matched: 0 })
    // references in B's file still resolve
    const trackIds = new Set(fb.tracks.map((t) => t.id))
    for (const e of fb.entries) if (e.track_id) expect(trackIds.has(e.track_id)).toBe(true)
    expect(fb.entry_versions).toHaveLength(1) // history followed the remapped entry
    // and restoring it into B again changes nothing
    const sB = await state(B)
    await restore(B, file)
    expect(await state(B)).toBe(sB)
  })

  it('after a cross-account restore, renaming the copies and restoring again still makes no duplicates', async () => {
    const file = await exportFile(A)
    await restore(B, file)
    await asUser(B, `update tracks set name = 'Poetry' where name = 'Poems'`)
    await asUser(B, `update tags set name = 'kin' where name = 'family'`)
    const counts = async () => (await db.query<{ n: string }>(
      `select (select count(*) from tracks where user_id = $1) + (select count(*) from tags where user_id = $1) + (select count(*) from entries where user_id = $1) as n`, [B])).rows[0].n
    const before = await counts()
    const again = await restore(B, file)
    expect(await counts()).toBe(before)
    expect(again.counts.new).toBe(0)
    expect(again.meta.tracks.new + again.meta.tags.new).toBe(0)
  })

  it('the preview writes nothing, even when the merge would change a lot', async () => {
    const file = await exportFile(A)
    file.entries.forEach((e) => {
      e.body_text += ' (changed)'
      e.updated_at = '2030-01-01T00:00:00.000000Z'
    })
    file.tags.push({ id: id(990), name: 'brand new', updated_at: '2030-01-01T00:00:00.000000Z' })
    const s = await state(A)
    const preview = await restore(A, file, true)
    expect(await state(A)).toBe(s)
    expect(preview.counts.updated).toBe(5)
    expect(preview.meta.tags.new).toBe(1)
    const real = await restore(A, file)
    expect(real.counts).toEqual(preview.counts) // the preview predicted the merge exactly
  })

  it('restore needs an active trial or unlock (reading and export still work)', async () => {
    const file = await exportFile(A)
    await db.exec(`update licenses set trial_ends_at = now() - interval '3 days' where user_id = '${A}'`)
    await expect(restore(A, file)).rejects.toThrow(/active trial or unlock|row-level security/)
    expect((await exportFile(A)).entries).toHaveLength(5)
  })
})

describe('parseJournal', () => {
  it('refuses files that are not journals, with a plain message', () => {
    expect(parseJournal('not json')).toMatchObject({ ok: false, error: expect.stringMatching(/isn't valid JSON/) })
    expect(parseJournal('{"format":"something"}')).toMatchObject({ ok: false, error: expect.stringMatching(/doesn't look like a Daftar journal/) })
    expect(parseJournal('{"format":"daftar.journal"}')).toMatchObject({ ok: false, error: expect.stringMatching(/missing its version/) })
  })

  it('refuses a newer schema version clearly', () => {
    const r = parseJournal(JSON.stringify({ format: 'daftar.journal', schema_version: 2, entries: [] }))
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/newer version of Daftar.*format 2/) })
  })

  it('keeps every readable entry and reports the rest; duplicate ids keep the newest copy', async () => {
    const file = await exportFile(A)
    const raw = JSON.parse(serialize(file))
    raw.entries.push({ id: 'nope', entry_date: '2026-01-01', body_text: 'x', updated_at: '2026-01-01T00:00:00Z' })
    raw.entries.push({ id: id(77), entry_date: 'yesterday', body_text: 'x', updated_at: '2026-01-01T00:00:00Z' })
    raw.entries.push({ ...raw.entries[0], body_text: 'older duplicate', updated_at: '2000-01-01T00:00:00Z' })
    const r = parseJournal(JSON.stringify(raw))
    if (!r.ok) throw new Error(r.error)
    expect(r.file.entries).toHaveLength(5)
    expect(r.unreadable.map((u) => u.reason)).toEqual(['no valid id', 'no valid entry_date'])
    expect(r.duplicates).toBe(1)
    expect(r.file.entries.find((e) => e.id === raw.entries[0].id)!.body_text).toBe(raw.entries[0].body_text)
  })

  it('a byte-order mark or missing optional fields are fine', () => {
    const minimal = { format: 'daftar.journal', schema_version: 1, entries: [{ id: id(60), entry_date: '2026-01-02', body_text: 'just text', updated_at: '2026-01-02T10:00:00Z' }] }
    const r = parseJournal('﻿' + JSON.stringify(minimal))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.file.entries[0]).toMatchObject({ language: 'en', tag_ids: [], letter: null, track_id: null })
  })
})
