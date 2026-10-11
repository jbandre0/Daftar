import { describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))
vi.mock('./syncDeps', () => ({ syncDeps: { store: { all: async () => [] } } }))
const { matchesFilters, makeSnippet, overlayDrafts, NO_FILTERS, activeFilterCount } = await import('./browse')
const { buildSpreads, spreadIndexFor, quietLabel, addDays, daysBetween } = await import('./readModel')
import type { Draft } from './draftStore'
import type { EntryContent } from './entries'

const c = (o: Partial<EntryContent> = {}): EntryContent => ({
  id: 'e1', entry_date: '2026-10-05', title: 'Morning', body_rich: {}, body_text: 'Read Alma 32 and sat by the window', language: 'en', word_count: 8,
  track_id: 't1', tag_ids: ['a', 'b'], fields: {}, ...o,
})
const f = (o = {}) => ({ ...NO_FILTERS, ...o })

describe('matchesFilters (the offline mirror of browse_entries)', () => {
  it('matches words and parts of words, in any case, in title or text', () => {
    expect(matchesFilters(c(), f({ q: 'ALMA' }))).toBe(true)
    expect(matchesFilters(c(), f({ q: 'wind' }))).toBe(true)
    expect(matchesFilters(c(), f({ q: 'morn' }))).toBe(true)
    expect(matchesFilters(c(), f({ q: 'alma window' }))).toBe(true)
    expect(matchesFilters(c(), f({ q: 'alma lighthouse' }))).toBe(false)
  })
  it('matches Arabic parts of words', () => {
    const ar = c({ body_text: 'الحمد لله على كل حال، والصبر مفتاح الفرج', title: 'عن الصبر' })
    expect(matchesFilters(ar, f({ q: 'الصب' }))).toBe(true)
    expect(matchesFilters(ar, f({ q: 'فرج' }))).toBe(true)
    expect(matchesFilters(ar, f({ q: 'سفر' }))).toBe(false)
  })
  it('track, language, tags (all of them), and an inclusive date range', () => {
    expect(matchesFilters(c(), f({ track: 't1' }))).toBe(true)
    expect(matchesFilters(c(), f({ track: 't2' }))).toBe(false)
    expect(matchesFilters(c(), f({ language: 'ar' }))).toBe(false)
    expect(matchesFilters(c(), f({ tags: ['a'] }))).toBe(true)
    expect(matchesFilters(c(), f({ tags: ['a', 'b'] }))).toBe(true)
    expect(matchesFilters(c(), f({ tags: ['a', 'z'] }))).toBe(false)
    expect(matchesFilters(c(), f({ from: '2026-10-05', to: '2026-10-05' }))).toBe(true)
    expect(matchesFilters(c(), f({ from: '2026-10-06' }))).toBe(false)
    expect(matchesFilters(c(), f({ to: '2026-10-04' }))).toBe(false)
  })
  it('counts active filters (the search box is not a filter)', () => {
    expect(activeFilterCount(f({ q: 'x' }))).toBe(0)
    expect(activeFilterCount(f({ track: 't', tags: ['a', 'b'], language: 'en', from: '2026-01-01' }))).toBe(5)
  })
})

describe('makeSnippet', () => {
  it('centres on the match and flattens whitespace', () => {
    const long = 'word '.repeat(40) + 'needle in the middle\n\nof a long entry ' + 'word '.repeat(40)
    const s = makeSnippet(long, 'needle')
    expect(s).toContain('needle in the middle of a long entry')
    expect(s.length).toBeLessThanOrEqual(160)
  })
  it('starts at the start when there is no query', () => {
    expect(makeSnippet('Hello   world', '')).toBe('Hello world')
  })
})

describe('overlayDrafts', () => {
  const row = (id: string, date: string) => ({ id, entry_date: date, title: 't', snippet: 's', word_count: 1, updated_at: `${date}T00:00:00Z`, track_id: null, language: 'en', tag_ids: [] })
  const d = (id: string, content: Partial<EntryContent>, dirty = true): Draft => ({
    id, userId: 'u', seq: dirty ? 3 : 1, savedSeq: 1, baseRevision: 1, displaced: [], updatedAt: Date.parse('2026-10-20T00:00:00Z'),
    content: c({ id, ...content }),
  })
  it('an unsynced draft replaces its server copy and a brand-new one is added', () => {
    const { rows, added } = overlayDrafts([row('a', '2026-10-01')], [d('a', { body_text: 'edited offline', entry_date: '2026-10-01' }), d('n', { body_text: 'new offline', entry_date: '2026-10-09' })], f())
    expect(added).toBe(1)
    expect(rows.map((r) => r.id)).toEqual(['n', 'a'])
    expect(rows.find((r) => r.id === 'a')!.snippet).toBe('edited offline')
    expect(rows.find((r) => r.id === 'a')!.unsynced).toBe(true)
  })
  it('synced drafts and blank drafts are ignored', () => {
    expect(overlayDrafts([row('a', '2026-10-01')], [d('a', {}, false), d('b', { body_text: '', title: '' })], f()).rows).toHaveLength(1)
  })
  it('an unsynced edit that no longer matches the filters drops out', () => {
    const { rows } = overlayDrafts([row('a', '2026-10-01')], [d('a', { body_text: 'nothing here' })], f({ q: 'alma' }))
    expect(rows).toEqual([])
  })
})

describe('Read mode: spreads', () => {
  const dates = ['2026-10-01', '2026-10-02', '2026-10-06', '2026-10-07', '2026-12-25']
  it('days in order, with each run of empty days collapsed to one quiet spread', () => {
    const s = buildSpreads(dates)
    expect(s.map((x) => (x.kind === 'day' ? x.date : `quiet ${x.days}`))).toEqual([
      '2026-10-01', '2026-10-02', 'quiet 3', '2026-10-06', '2026-10-07', 'quiet 78', '2026-12-25',
    ])
    const q = s[2] as Extract<(typeof s)[number], { kind: 'quiet' }>
    expect([q.from, q.to]).toEqual(['2026-10-03', '2026-10-05'])
    expect(quietLabel(q)).toBe('3 quiet days')
  })
  it('one quiet day is singular', () => {
    const s = buildSpreads(['2026-10-01', '2026-10-03'])
    expect(quietLabel(s[1] as never)).toBe('1 quiet day')
  })
  it('consecutive days have no quiet spread; empty and single journals work', () => {
    expect(buildSpreads(['2026-10-01', '2026-10-02']).length).toBe(2)
    expect(buildSpreads([])).toEqual([])
    expect(buildSpreads(['2026-10-01'])).toHaveLength(1)
  })
  it('jump to a date: its day, or the quiet run around it, or the nearest end', () => {
    const s = buildSpreads(dates)
    expect(s[spreadIndexFor(s, '2026-10-06')]).toEqual({ kind: 'day', date: '2026-10-06' })
    expect(s[spreadIndexFor(s, '2026-10-04')].kind).toBe('quiet')
    expect(s[spreadIndexFor(s, '2026-11-15')].kind).toBe('quiet')
    expect(spreadIndexFor(s, '2000-01-01')).toBe(0)
    expect(spreadIndexFor(s, '2030-01-01')).toBe(s.length - 1)
    expect(spreadIndexFor([], '2026-10-04')).toBe(-1)
  })
  it('date arithmetic ignores time zones and daylight saving', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08')
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
  })
})
