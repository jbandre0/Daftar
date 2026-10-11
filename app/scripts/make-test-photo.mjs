// Makes a ~15 MB, 4032x3024 "phone photo" for testing the photo pipeline by hand: landscape pixels with EXIF
// Orientation 6 (held upright) and a GPS block. Output goes in public/__fixtures__/ (delete it before you ship!).
// Usage: node scripts/make-test-photo.mjs <any detailed source image>
import sharp from 'sharp'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
const src = process.argv[2]
if (!src) throw new Error('usage: node scripts/make-test-photo.mjs <source image>')
mkdirSync('public/__fixtures__', { recursive: true })
const W = 4032, H = 3024
const base = await sharp(src).resize(W, H, { fit: 'cover' }).modulate({ saturation: 1.3 }).toBuffer()
const noise = await sharp({ create: { width: W, height: H, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 38 } } }).png().toBuffer()
const out = 'public/__fixtures__/phone-12mp.jpg'
await sharp(base).composite([{ input: noise, blend: 'soft-light', opacity: 0.55 }])
  .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
  .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'TestPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 45/1 30/1', GPSLongitudeRef: 'W', GPSLongitude: '111/1 53/1 48/1' } } })
  .toFile(out)
const buf = readFileSync(out)
const t = buf.indexOf(Buffer.from('Exif\0\0')) + 6
const le = buf.toString('latin1', t, t + 2) === 'II'
const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
const ifd = t + u32(t + 4)
const tags = {}
for (let i = 0; i < u16(ifd); i++) tags[u16(ifd + 2 + i * 12).toString(16)] = u16(ifd + 2 + i * 12 + 8)
console.log(`${(statSync(out).size / 1048576).toFixed(1)} MB, EXIF orientation ${tags['112']}, GPS block ${'8825' in tags ? 'present' : 'missing'}`)
