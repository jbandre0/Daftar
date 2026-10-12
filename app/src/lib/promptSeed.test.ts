import { describe, expect, it } from 'vitest'
import { MAX_LEN, seedToSql, summarize, validateSeed } from './promptSeed'

const ok = { text: 'What did you notice today?', depth: 'light' }

describe('validateSeed', () => {
  it('accepts a minimal prompt and fills the optional fields with null', () => {
    const r = validateSeed([ok])
    expect(r.errors).toEqual([])
    expect(r.prompts).toEqual([{ text: 'What did you notice today?', depth: 'light', mood: null, time_of_day: null, track_hint: null }])
  })
  it('accepts { prompts: [...] } too', () => { expect(validateSeed({ prompts: [ok] }).prompts).toHaveLength(1) })
  it('rejects things that are not a list', () => {
    expect(validateSeed('hello').errors).toHaveLength(1)
    expect(validateSeed({}).errors).toHaveLength(1)
  })
  it('names the prompt and the problem', () => {
    const r = validateSeed([ok, { text: 'A fine long enough prompt', depth: 'shallow' }, { text: 'x', depth: 'light' }, { depth: 'light' }])
    expect(r.errors.join('\n')).toMatch(/#2: "depth" is "shallow"/)
    expect(r.errors.join('\n')).toMatch(/#3 .*too short/)
    expect(r.errors.join('\n')).toMatch(/#4: "text" is missing/)
    expect(r.prompts).toHaveLength(1)
  })
  it('requires depth, checks mood / time / track vocabularies', () => {
    expect(validateSeed([{ text: ok.text }]).errors[0]).toMatch(/"depth" is required/)
    expect(validateSeed([{ ...ok, mood: 'happy' }]).errors[0]).toMatch(/mood.*happy/)
    expect(validateSeed([{ ...ok, time_of_day: 'noon' }]).errors[0]).toMatch(/time_of_day/)
    expect(validateSeed([{ ...ok, track_hint: 'work' }]).errors[0]).toMatch(/track_hint/)
  })
  it('catches typos in field names', () => { expect(validateSeed([{ ...ok, moood: 'calm' }]).errors[0]).toMatch(/unknown field "moood"/) })
  it('English only', () => {
    expect(validateSeed([{ ...ok, language: 'ar' }]).errors[0]).toMatch(/English only/)
    expect(validateSeed([{ ...ok, language: 'en' }]).errors).toEqual([])
  })
  it('no emoji, no duplicates (ignoring case and spacing), length limits', () => {
    expect(validateSeed([{ text: 'What made you smile today? 😊', depth: 'light' }]).errors[0]).toMatch(/emoji/)
    expect(validateSeed([ok, { ...ok, text: '  what did   you notice TODAY?' }]).errors[0]).toMatch(/same text as #1/)
    expect(validateSeed([{ text: 'a'.repeat(MAX_LEN + 1), depth: 'light' }]).errors[0]).toMatch(/too long/)
    expect(validateSeed([{ text: 'word '.repeat(40).trim(), depth: 'light' }]).warnings[0]).toMatch(/long for a prompt/)
  })
})

describe('seedToSql', () => {
  it("doubles quotes so an apostrophe can't break out of the string", () => {
    const sql = seedToSql(validateSeed([{ text: "What's the thing you'd say; '); drop table prompts; --", depth: 'deep' }]).prompts)
    expect(sql).toContain("'What''s the thing you''d say; ''); drop table prompts; --'")
  })
  it('is an upsert keyed on the text', () => {
    expect(seedToSql(validateSeed([ok]).prompts)).toMatch(/on conflict \(language, \(md5\(text\)\)\) do update/)
  })
  it('an empty list is a harmless comment', () => { expect(seedToSql([])).not.toMatch(/insert/) })
  it('summarize counts', () => {
    expect(summarize(validateSeed([ok, { ...ok, text: 'Another prompt for you', depth: 'deep', mood: 'calm' }]).prompts)[1]).toBe('depth:  light 1, medium 0, deep 1, any 0')
  })
})
