import { describe, expect, it } from 'vitest'
import { fitWithin, isWebp, MAX_ORIGINAL_BYTES, PhotoError, sha256Hex, validateFile, webpPersonalMetadata, wouldFit, STORAGE_CAP_BYTES } from './photos'

const file = (name: string, type: string, size = 1000) => new File([new Uint8Array(size)], name, { type })

describe('fitWithin (1600 px long edge, never enlarges)', () => {
  it('landscape, portrait and square', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 })
    expect(fitWithin(3000, 3000, 1600)).toEqual({ width: 1600, height: 1600 })
  })
  it('a small photo stays as it is', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1600, 900, 1600)).toEqual({ width: 1600, height: 900 })
  })
  it('thumbnail size, and extreme panoramas never collapse to zero', () => {
    expect(fitWithin(4032, 3024, 400)).toEqual({ width: 400, height: 300 })
    expect(fitWithin(20000, 10, 400).height).toBeGreaterThanOrEqual(1)
  })
})

describe('validateFile', () => {
  it('accepts JPEG, PNG, WebP and HEIC up to 25 MB', () => {
    for (const [n, t] of [['a.jpg', 'image/jpeg'], ['a.png', 'image/png'], ['a.webp', 'image/webp'], ['a.heic', 'image/heic'], ['IMG.HEIC', '']] as const) {
      expect(() => validateFile(file(n, t))).not.toThrow()
    }
    expect(() => validateFile(file('a.jpg', 'image/jpeg', MAX_ORIGINAL_BYTES))).not.toThrow()
  })
  it('refuses over 25 MB and non-images, with kinds the UI maps to plain messages', () => {
    expect(() => validateFile(file('a.jpg', 'image/jpeg', MAX_ORIGINAL_BYTES + 1))).toThrowError(expect.objectContaining({ kind: 'too_big' }))
    expect(() => validateFile(file('a.pdf', 'application/pdf'))).toThrowError(expect.objectContaining({ kind: 'not_image' }))
    expect(() => validateFile(file('a.txt', ''))).toThrow(PhotoError)
  })
})

describe('sha256Hex', () => {
  it('is the standard SHA-256 (hex, lower-case)', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('WebP inspection', () => {
  const chunk = (id: string, len: number) => {
    const b = new Uint8Array(8 + len + (len % 2))
    b.set([...id].map((c) => c.charCodeAt(0)), 0)
    b[4] = len & 255
    b[5] = (len >> 8) & 255
    return b
  }
  const webp = (...chunks: Uint8Array[]) => {
    const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 4))
    body.set([...'WEBP'].map((c) => c.charCodeAt(0)), 0)
    let o = 4
    for (const c of chunks) { body.set(c, o); o += c.length }
    const out = new Uint8Array(8 + body.length)
    out.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
    out[4] = body.length & 255
    out[5] = (body.length >> 8) & 255
    out.set(body, 8)
    return out
  }
  it('recognises WebP and nothing else', () => {
    expect(isWebp(webp(chunk('VP8 ', 10)))).toBe(true)
    expect(isWebp(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isWebp(new Uint8Array(4))).toBe(false)
  })
  it('finds EXIF and XMP (where location and camera details live); a colour profile is not personal', () => {
    expect(webpPersonalMetadata(webp(chunk('VP8 ', 10)))).toEqual([])
    expect(webpPersonalMetadata(webp(chunk('VP8X', 10), chunk('EXIF', 7), chunk('VP8 ', 12)))).toEqual(['EXIF'])
    expect(webpPersonalMetadata(webp(chunk('ICCP', 4), chunk('XMP ', 3)))).toEqual(['XMP'])
    expect(webpPersonalMetadata(webp(chunk('ICCP', 4), chunk('VP8 ', 12)))).toEqual([])
  })
})

describe('wouldFit', () => {
  it('is exactly at the 2 GB boundary', () => {
    expect(wouldFit(STORAGE_CAP_BYTES - 100, 100)).toBe(true)
    expect(wouldFit(STORAGE_CAP_BYTES - 100, 101)).toBe(false)
  })
})
