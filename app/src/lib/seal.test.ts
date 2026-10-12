import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./supabase', () => ({ supabase: {} }))
vi.mock('./syncDeps', () => ({ syncDeps: { store: { all: async () => [] } } }))
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
const {
  daysFromNow, earliestSealDay, isKnownSealed, isSealedNow, markKnownSealed, maskIfSealed, monthsFromNow, unlockDay, unlockInstant, unlockLabel, validSealDay,
} = await import('./seal')
const { letterState, sortLetters } = await import('./letters')
const { matchesFilters, NO_FILTERS, rowFromContent, overlayDrafts } = await import('./browse')
const { summaryFromContent } = await import('./entries')
import type { EntryContent } from './entries'
import type { Draft } from './draftStore'

beforeEach(() => store.clear())

const NOON = new Date(2026, 9, 12, 12, 0, 0) // 12 Oct 2026, local
const content = (o: Partial<EntryContent> = {}): EntryContent => ({
  id: 'e1', entry_date: '2026-10-01', title: 'To me, at graduation', body_rich: {}, body_text: 'the lighthouse password is marmalade', language: 'en',
  word_count: 6, track_id: null, fields: {}, tag_ids: [], is_letter: true, letter_to: 'Future me', sealed: true, unlock_at: '2099-04-20T00:00:00.000Z', ...o,
})

describe('sealed right now', () => {
  it('sealed with a date still ahead', () => {
    expect(isSealedNow({ sealed: true, unlock_at: '2099-01-01T00:00:00Z' })).toBe(true)
  })
  it('not sealed, no date, or the date has come', () => {
    expect(isSealedNow({ sealed: false, unlock_at: '2099-01-01T00:00:00Z' })).toBe(false)
    expect(isSealedNow({ sealed: true, unlock_at: null })).toBe(false)
    expect(isSealedNow({ sealed: true, unlock_at: '2020-01-01T00:00:00Z' })).toBe(false)
  })
  it('opens at the exact moment, not a day later', () => {
    const t = Date.parse('2030-05-01T00:00:00Z')
    expect(isSealedNow({ sealed: true, unlock_at: '2030-05-01T00:00:00Z' }, t - 1)).toBe(true)
    expect(isSealedNow({ sealed: true, unlock_at: '2030-05-01T00:00:00Z' }, t)).toBe(false)
  })
})

describe('masking: a list shows nothing of a sealed letter but who it is for and when it opens', () => {
  it('hides title and words, keeps recipient and date', () => {
    const m = maskIfSealed(content())
    expect(m).toMatchObject({ title: null, body_text: '', letter_to: 'Future me', sealed_until: '2099-04-20T00:00:00.000Z' })
  })
  it('an ordinary entry, and an opened letter, are untouched', () => {
    expect(maskIfSealed(content({ sealed: false, is_letter: false }))).toMatchObject({ title: 'To me, at graduation', body_text: 'the lighthouse password is marmalade', sealed_until: null, letter_to: null })
    expect(maskIfSealed(content({ unlock_at: '2020-01-01T00:00:00Z' })).body_text).toContain('marmalade')
  })
  it('a letter this device learned is sealed stays hidden even if a stale draft says otherwise', () => {
    markKnownSealed('e1')
    expect(isKnownSealed('e1')).toBe(true)
    expect(maskIfSealed(content({ sealed: false })).body_text).toBe('')
    expect(summaryFromContent(content({ sealed: false }), Date.now())).toBeNull()
  })
})

describe('lists built from this device never leak a sealed letter', () => {
  const draft = (c: EntryContent): Draft => ({ id: c.id, userId: 'u', seq: 3, savedSeq: 1, baseRevision: 1, displaced: [], updatedAt: Date.now(), content: c })

  it('search never finds a sealed letter by its words, its title or part of them', () => {
    for (const q of ['marmalade', 'lighthouse', 'graduation', 'To me', 'marmal']) {
      expect(matchesFilters(content(), { ...NO_FILTERS, q }), q).toBe(false)
    }
    expect(matchesFilters(content(), NO_FILTERS)).toBe(true) // it can still be listed, as a seal
    expect(matchesFilters(content({ unlock_at: '2020-01-01T00:00:00Z' }), { ...NO_FILTERS, q: 'marmalade' })).toBe(true) // once opened
  })
  it('a browse row for a sealed draft has no title or snippet, but says who and when', () => {
    const r = rowFromContent(content(), Date.now(), 'marmalade', true)
    expect(r).toMatchObject({ title: null, snippet: null, letter_to: 'Future me', sealed_until: '2099-04-20T00:00:00.000Z' })
  })
  it('the overlay drops a stale draft of a letter that is sealed elsewhere', () => {
    markKnownSealed('e1')
    const { rows } = overlayDrafts([], [draft(content({ sealed: false, unlock_at: null }))], NO_FILTERS)
    expect(rows).toEqual([])
  })
  it('a summary for the Desk hides a sealed draft', () => {
    expect(summaryFromContent(content(), Date.now())).toMatchObject({ title: null, body_text: '', sealed_until: '2099-04-20T00:00:00.000Z', letter_to: 'Future me' })
  })
})

describe('the Letters list', () => {
  const l = (id: string, sealed: boolean, unlock_at: string | null, updated_at = '2026-10-01T00:00:00Z') => ({
    id, entry_date: '2026-10-01', title: null, snippet: null, word_count: 1, updated_at, letter_to: null, sealed, unlock_at,
  })
  it('three states: sealed, opened (the day has come), still writing', () => {
    expect(letterState(l('a', true, '2099-01-01T00:00:00Z'))).toBe('sealed')
    expect(letterState(l('b', true, '2020-01-01T00:00:00Z'))).toBe('opened')
    expect(letterState(l('c', false, null))).toBe('draft')
  })
  it('sealed first, the soonest to open first; the rest newest first', () => {
    const rows = [
      l('draft-old', false, null, '2026-01-01T00:00:00Z'), l('far', true, '2099-01-01T00:00:00Z'), l('draft-new', false, null, '2026-09-01T00:00:00Z'),
      l('soon', true, '2098-01-01T00:00:00Z'), l('opened', true, '2020-01-01T00:00:00Z', '2026-05-01T00:00:00Z'),
    ]
    expect(sortLetters(rows).map((r) => r.id)).toEqual(['soon', 'far', 'draft-new', 'opened', 'draft-old'])
  })
  it('a card flips to opened by itself when its moment passes', () => {
    const row = l('a', true, '2030-05-01T00:00:00Z')
    expect(letterState(row, Date.parse('2030-04-30T23:59:59Z'))).toBe('sealed')
    expect(letterState(row, Date.parse('2030-05-01T00:00:00Z'))).toBe('opened')
  })
})

describe('seal dates (a seal opens at the start of a day, in the writer\'s own time zone)', () => {
  it('the earliest day is tomorrow', () => {
    expect(earliestSealDay(NOON)).toBe('2026-10-13')
    expect(earliestSealDay(new Date(2026, 11, 31, 23, 59))).toBe('2027-01-01')
  })
  it('only a real day, tomorrow or later, is valid', () => {
    expect(validSealDay('2026-10-13', NOON)).toBe(true)
    expect(validSealDay('2029-04-20', NOON)).toBe(true)
    expect(validSealDay('2026-10-12', NOON)).toBe(false) // today
    expect(validSealDay('2020-01-01', NOON)).toBe(false)
    expect(validSealDay('2027-02-30', NOON)).toBe(false) // not a real date
    expect(validSealDay('', NOON)).toBe(false)
    expect(validSealDay('next year', NOON)).toBe(false)
  })
  it('a chosen day becomes the instant that day begins here, and reads back as the same day', () => {
    for (const day of ['2029-04-20', '2027-03-14', '2026-11-01', '2030-12-31']) {
      expect(unlockDay(unlockInstant(day))).toBe(day)
      expect(new Date(unlockInstant(day)).getHours()).toBe(0)
    }
  })
  it('reads as the voice table says: "20 April 2029"', () => {
    expect(unlockLabel(unlockInstant('2029-04-20'))).toBe('20 April 2029')
    expect(unlockLabel(unlockInstant('2027-01-05'))).toBe('5 January 2027')
  })
  it('the quick choices are real days in the future', () => {
    expect(daysFromNow(1, NOON)).toBe('2026-10-13')
    expect(monthsFromNow(1, NOON)).toBe('2026-11-12')
    expect(monthsFromNow(12, NOON)).toBe('2027-10-12')
    expect(monthsFromNow(60, NOON)).toBe('2031-10-12')
    for (const d of [daysFromNow(1, NOON), monthsFromNow(1, NOON), monthsFromNow(12, NOON), monthsFromNow(60, NOON)]) expect(validSealDay(d, NOON)).toBe(true)
  })
})
