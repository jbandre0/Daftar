// Builds the parchment backgrounds from the source image and reports how dark the surface gets,
// so the glass panel's opacity can be chosen against real pixels. Usage: node scripts/parchment.mjs <source>
import sharp from 'sharp'

const src = process.argv[2]
const crop = { left: 130, top: 130, width: 1447 - 260, height: 1920 - 260 } // drop the torn, dark outer edge
const cropped = await sharp(src).extract(crop).png().toBuffer()
const base = sharp(cropped)
await base.clone().resize({ width: 1100 }).webp({ quality: 66, effort: 6 }).toFile('public/img/parchment-portrait.webp')
await base.clone().rotate(90).resize({ width: 1800 }).webp({ quality: 62, effort: 6 }).toFile('public/img/parchment-landscape.webp')

const { data, info } = await base.clone().resize(120, 160).raw().toBuffer({ resolveWithObject: true })
const lum = (r, g, b) => {
  const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const px = []
for (let i = 0; i < data.length; i += info.channels) px.push([data[i], data[i + 1], data[i + 2]])
const L = px.map((p) => lum(...p)).sort((a, b) => a - b)
const q = (p) => L[Math.floor(p * (L.length - 1))]
console.log('luminance  darkest %s  p5 %s  median %s  lightest %s', q(0).toFixed(3), q(0.05).toFixed(3), q(0.5).toFixed(3), q(1).toFixed(3))
const mean = px.reduce((a, p) => [a[0] + p[0], a[1] + p[1], a[2] + p[2]], [0, 0, 0]).map((v) => Math.round(v / px.length))
console.log('mean colour rgb(%s)', mean.join(','))
const darkest = px.reduce((m, p) => (lum(...p) < lum(...m) ? p : m))
console.log('darkest pixel rgb(%s)', darkest.join(','))
