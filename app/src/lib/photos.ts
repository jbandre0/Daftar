/**
 * The photo pipeline (spec §6). Everything happens in the browser, before upload:
 *   decode (applying the EXIF orientation) → draw to a canvas (which drops ALL metadata, GPS included) →
 *   resize to 1600 px on the long edge → encode WebP at 0.8 → make a 400 px thumbnail → SHA-256 of the result.
 *
 * Re-drawing through a canvas is what strips the metadata: nothing from the original file's EXIF survives, and we
 * never copy any of it across. Safari cannot encode WebP from a canvas (it quietly hands back a PNG), so when the
 * native encoder doesn't produce WebP we fall back to a small WebP encoder compiled to WebAssembly, loaded only then.
 */

export const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024
export const MAX_LONG_EDGE = 1600
export const THUMB_LONG_EDGE = 400
export const WEBP_QUALITY = 0.8
export const THUMB_QUALITY = 0.72
export const PHOTOS_PER_ENTRY = 12
export const STORAGE_CAP_BYTES = 2 * 1024 * 1024 * 1024
/** Thumbnails are ~20-40 KB; used only to estimate before a photo has been made. */
export const THUMB_ESTIMATE_BYTES = 40 * 1024

export type PhotoErrorKind = 'too_big' | 'not_image' | 'heic' | 'decode' | 'limit' | 'cap' | 'encode'

export class PhotoError extends Error {
  constructor(readonly kind: PhotoErrorKind, message: string) {
    super(message)
  }
}

/** What the writer sees. Plain, and always says the words are safe. */
export const PHOTO_MESSAGES: Record<PhotoErrorKind, string> = {
  too_big: 'That photo is over 25 MB. Try a smaller one. Your words are safe.',
  not_image: "That file isn't a photo Daftar can use.",
  heic: "This photo format isn't supported here. Try exporting it as JPEG.",
  decode: "Couldn't open that photo. Try a different one.",
  limit: 'An entry holds up to 12 photos. Your words are safe.',
  cap: "Your photo storage is full (2 GB). Your words are safe. Remove some photos, or export your journal, to make room.",
  encode: "Couldn't prepare that photo here. Try again, or try a different browser.",
}

export type ProcessedPhoto = { full: Blob; thumb: Blob; width: number; height: number; sha256: string }

/** Largest size that fits `edge` on the long side. Never enlarges. */
export function fitWithin(w: number, h: number, edge: number): { width: number; height: number } {
  const long = Math.max(w, h)
  if (long <= edge) return { width: w, height: h }
  const k = edge / long
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

export function validateFile(file: File): void {
  const name = file.name.toLowerCase()
  const isHeic = /heic|heif/.test(file.type) || /\.(heic|heif)$/.test(name)
  if (!file.type.startsWith('image/') && !isHeic) throw new PhotoError('not_image', PHOTO_MESSAGES.not_image)
  if (file.size > MAX_ORIGINAL_BYTES) throw new PhotoError('too_big', PHOTO_MESSAGES.too_big)
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---- encoding --------------------------------------------------------------------------------------------------

type Drawable = ImageBitmap

async function decode(file: Blob): Promise<Drawable> {
  // 'from-image': rotate by the EXIF orientation now, so the stored pixels are upright and need no tag.
  return createImageBitmap(file, { imageOrientation: 'from-image' })
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function draw(src: Drawable, width: number, height: number) {
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null
  if (!ctx) throw new PhotoError('encode', PHOTO_MESSAGES.encode)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, width, height)
  return { canvas, ctx }
}

async function canvasToBlob(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Set by tests and by the dev harness to exercise the WebAssembly path on a browser that could do it natively. */
export const encoderOverride: { forceWasm: boolean } = { forceWasm: false }

async function encodeWebp(src: Drawable, width: number, height: number, quality: number): Promise<Blob> {
  const { canvas, ctx } = draw(src, width, height)
  if (!encoderOverride.forceWasm) {
    const blob = await canvasToBlob(canvas, 'image/webp', quality)
    if (blob && blob.type === 'image/webp' && blob.size > 0) return blob
  }
  // The native encoder gave us something else (Safari: a PNG). Use the WebAssembly encoder.
  try {
    const { default: encode } = await import('@jsquash/webp/encode')
    const data = ctx.getImageData(0, 0, width, height)
    const bytes = await encode(data, { quality: Math.round(quality * 100) })
    return new Blob([bytes], { type: 'image/webp' })
  } catch {
    throw new PhotoError('encode', PHOTO_MESSAGES.encode)
  }
}

export async function processImage(file: File): Promise<ProcessedPhoto> {
  validateFile(file)
  let bitmap: Drawable
  try {
    bitmap = await decode(file)
  } catch {
    const heic = /heic|heif/.test(file.type) || /\.(heic|heif)$/i.test(file.name)
    throw new PhotoError(heic ? 'heic' : 'decode', heic ? PHOTO_MESSAGES.heic : PHOTO_MESSAGES.decode)
  }
  try {
    const full = fitWithin(bitmap.width, bitmap.height, MAX_LONG_EDGE)
    const thumb = fitWithin(bitmap.width, bitmap.height, THUMB_LONG_EDGE)
    const [fullBlob, thumbBlob] = [
      await encodeWebp(bitmap, full.width, full.height, WEBP_QUALITY),
      await encodeWebp(bitmap, thumb.width, thumb.height, THUMB_QUALITY),
    ]
    return { full: fullBlob, thumb: thumbBlob, width: full.width, height: full.height, sha256: await sha256Hex(fullBlob) }
  } finally {
    bitmap.close?.()
  }
}

/** A thumbnail for a photo that is already a processed WebP (restoring from a .zip): no re-compression of the photo itself. */
export async function thumbnailFor(full: Blob): Promise<{ thumb: Blob; width: number; height: number }> {
  let bitmap: Drawable
  try {
    bitmap = await decode(full)
  } catch {
    throw new PhotoError('decode', PHOTO_MESSAGES.decode)
  }
  try {
    const t = fitWithin(bitmap.width, bitmap.height, THUMB_LONG_EDGE)
    return { thumb: await encodeWebp(bitmap, t.width, t.height, THUMB_QUALITY), width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close?.()
  }
}

/** True if these bytes are a WebP file (RIFF....WEBP). */
export function isWebp(bytes: Uint8Array): boolean {
  const s = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b))
  return bytes.length > 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP'
}

/**
 * The chunks of a WebP file that can carry personal details: EXIF (camera, time, GPS) and XMP. A photo made here
 * never has either. (An ICC colour profile may be present; it is only colour information, and it keeps colours right.)
 */
export function webpPersonalMetadata(bytes: Uint8Array): string[] {
  const found: string[] = []
  const text = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b))
  let i = 12
  while (i + 8 <= bytes.length) {
    const id = text(i, i + 4)
    const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24)
    if (id === 'EXIF' || id === 'XMP ') found.push(id.trim())
    i += 8 + size + (size % 2)
  }
  return found
}

/** Will adding these bytes (and thumbnails) stay within the cap? Advisory: the server decides. */
export function wouldFit(usedBytes: number, addBytes: number): boolean {
  return usedBytes + addBytes <= STORAGE_CAP_BYTES
}
