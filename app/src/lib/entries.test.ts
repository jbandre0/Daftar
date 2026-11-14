import { describe, expect, it } from 'vitest'
import { isFavorite, parseEntryDate, withFavorite } from './entries'

describe('parseEntryDate: the date a page may be filed under', () => {
  const today = '2026-10-13'
  it('accepts a real past date and today', () => {
    expect(parseEntryDate('2019-02-28', today)).toBe('2019-02-28')
    expect(parseEntryDate('2026-10-13', today)).toBe('2026-10-13')
    expect(parseEntryDate('2024-02-29', today)).toBe('2024-02-29')
  })
  it('refuses the future, impossible days, and anything that is not YYYY-MM-DD', () => {
    expect(parseEntryDate('2026-10-14', today)).toBeNull()
    expect(parseEntryDate('2027-01-01', today)).toBeNull()
    expect(parseEntryDate('2023-02-29', today)).toBeNull()
    expect(parseEntryDate('2023-13-01', today)).toBeNull()
    expect(parseEntryDate('13/10/2020', today)).toBeNull()
    expect(parseEntryDate('2020-1-5', today)).toBeNull()
    expect(parseEntryDate('', today)).toBeNull()
    expect(parseEntryDate(null, today)).toBeNull()
    expect(parseEntryDate(undefined, today)).toBeNull()
  })
})

describe('favorite helpers', () => {
  it('isFavorite is true only for a real true', () => {
    expect(isFavorite({ fields: { favorite: true } })).toBe(true)
    expect(isFavorite({ fields: { favorite: false } })).toBe(false)
    expect(isFavorite({ fields: { favorite: 'true' } })).toBe(false)
    expect(isFavorite({ fields: {} })).toBe(false)
    expect(isFavorite({})).toBe(false)
  })
  it('withFavorite adds the star and keeps every other field', () => {
    expect(withFavorite({ scripture: 'Alma 32', answered_later: true }, true)).toEqual({ scripture: 'Alma 32', answered_later: true, favorite: true })
    expect(withFavorite(undefined, true)).toEqual({ favorite: true })
  })
  it('removing the star removes the key, so an un-starred entry exports as it always did', () => {
    expect(withFavorite({ scripture: 'Alma 32', favorite: true }, false)).toEqual({ scripture: 'Alma 32' })
    expect('favorite' in withFavorite({ favorite: true }, false)).toBe(false)
    expect(withFavorite(undefined, false)).toEqual({})
  })
  it('does not change the object it was given', () => {
    const f = { favorite: true, a: 1 }
    withFavorite(f, false)
    expect(f).toEqual({ favorite: true, a: 1 })
  })
})
