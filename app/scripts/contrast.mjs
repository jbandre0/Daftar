// Verifies WCAG AA (4.5:1 text, 3:1 large text) for every text pair, in both themes:
//  1. solid pairs from the tokens (text on the desk and on desk cards)
//  2. text on GLASS over the real parchment image, composited pixel by pixel, in the worst case
//     (the darkest 1% of pixels, with the heaviest edge veil applied)
import sharp from 'sharp'

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const lin = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const cr = (a, b) => { const [x, y] = [L(a), L(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const over = (fg, a, bg) => fg.map((v, i) => v * a + bg[i] * (1 - a))

const themes = {
  lamplight: {
    desk: '#1F150F', raised: '#2E2019', ash: '#F1E6CF', ashSoft: '#BBA586', flame: '#F0A743', onFlame: '#2A1A0C',
    olive: '#B9A77A', onSeal: '#F1E6CF', seal: '#8C2F22', ink: '#2A1F16', inkSoft: '#54422F', flameText: '#F0A743',
    glass: [247, 238, 218, 0.72], veil: [24, 12, 4, 0.62], glassIsCard: false,
  },
  daylight: {
    desk: '#DCC79D', raised: null, ash: '#2E2216', ashSoft: '#5A4A36', flame: '#8F5311', onFlame: '#FBF6EA',
    olive: '#56613A', onSeal: '#FBF6EA', seal: '#8C2F22', ink: '#2B241C', inkSoft: '#54422F', flameText: '#6B3A08',
    glass: [252, 247, 236, 0.66], veil: [250, 238, 210, 0.4], glassIsCard: true,
  },
}

let bad = 0
const report = (name, label, r, min) => {
  const ok = r >= min
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name.padEnd(9)} ${label.padEnd(44)} ${r.toFixed(2)} (needs ${min})`)
}

// parchment pixels (portrait asset, downsampled)
const { data, info } = await sharp('public/img/parchment-portrait.webp').resize(100, 130).raw().toBuffer({ resolveWithObject: true })
const pixels = []
for (let i = 0; i < data.length; i += info.channels) pixels.push([data[i], data[i + 1], data[i + 2]])
pixels.sort((a, b) => L(a) - L(b))
const worst = pixels.slice(0, Math.ceil(pixels.length * 0.01)) // the darkest 1%

for (const [name, t] of Object.entries(themes)) {
  // 1. solid pairs
  const solid = [['onFlame', 'flame'], ['onSeal', 'seal']]
  if (!t.glassIsCard) solid.push(['ash', 'desk'], ['ashSoft', 'desk'], ['flame', 'desk'], ['olive', 'desk'], ['ash', 'raised'], ['ashSoft', 'raised'], ['flameText', 'raised'], ['olive', 'raised'])
  for (const [f, b] of solid) report(name, `${f} on ${b}`, cr(hex(t[f]), hex(t[b])), 4.5)

  // 2. glass over parchment, worst case
  const [gr, gg, gb, ga] = t.glass
  const [vr, vg, vb, va] = t.veil
  let minInk = Infinity, minSoft = Infinity, minAsh = Infinity, minAshSoft = Infinity, minFlame = Infinity
  for (const px of worst) {
    const veiled = over([vr, vg, vb], va, px)
    const surface = over([gr, gg, gb], ga, veiled)
    minInk = Math.min(minInk, cr(hex(t.ink), surface))
    minSoft = Math.min(minSoft, cr(hex(t.inkSoft), surface))
    if (t.glassIsCard) {
      minAsh = Math.min(minAsh, cr(hex(t.ash), surface))
      minAshSoft = Math.min(minAshSoft, cr(hex(t.ashSoft), surface))
      minFlame = Math.min(minFlame, cr(hex(t.flameText), surface))
    }
  }
  report(name, 'ink on glass (worst 1% of parchment)', minInk, 4.5)
  report(name, 'ink-soft on glass (worst 1%)', minSoft, 4.5)
  if (t.glassIsCard) {
    report(name, 'ash on glass card (worst 1%)', minAsh, 4.5)
    report(name, 'ash-soft on glass card (worst 1%)', minAshSoft, 4.5)
    report(name, 'flame-text on glass card (worst 1%)', minFlame, 4.5)
    // headings sit straight on the parchment (large text, 3:1): worst pixel, with the veil
    const hd = Math.min(...worst.map((px) => cr(hex(t.ash), over([vr, vg, vb], va, px))))
    report(name, 'ash screen title on bare parchment (large)', hd, 3)
    const sub = Math.min(...worst.map((px) => cr(hex(t.ash), over([vr, vg, vb], va, px))))
    report(name, 'ash subtitle/labels on bare parchment', sub, 4.5)
  }
}
process.exit(bad ? 1 : 0)
