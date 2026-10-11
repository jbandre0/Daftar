/**
 * The physics and light of a page turn. Pure functions, no DOM: PageStage uses them to draw each frame, and the
 * tests pin them down.
 *
 * Model: a rigid sheet hinged on its left edge (the spine), seen from above the book. θ is the turn angle:
 * 0° = lying flat on the right (the page you're reading), 90° = standing on its edge, 180° = lying flat on the
 * left (turned). The free edge rises toward the reader as it turns, so perspective enlarges it.
 */

export const DEG = Math.PI / 180

/** Standard cubic-bezier timing (same curves as CSS), solved with Newton steps + bisection fallback. */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const sx = (u: number) => ((ax * u + bx) * u + cx) * u
  const sy = (u: number) => ((ay * u + by) * u + cy) * u
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    let u = t
    for (let i = 0; i < 8; i++) {
      const err = sx(u) - t
      if (Math.abs(err) < 1e-6) return sy(u)
      const d = dx(u)
      if (Math.abs(d) < 1e-6) break
      u -= err / d
    }
    let lo = 0, hi = 1
    u = t
    for (let i = 0; i < 30; i++) {
      const x = sx(u)
      if (Math.abs(x - t) < 1e-6) break
      if (x < t) lo = u
      else hi = u
      u = (lo + hi) / 2
    }
    return sy(u)
  }
}

/** A page lifts slowly, swings through the middle, and settles softly. */
export const turnEase = bezier(0.42, 0.04, 0.16, 1)
/** Riffled pages (a jump) snap over faster and more evenly. */
export const riffleEase = bezier(0.33, 0, 0.2, 1)
/** Letting go of a dragged page: it carries on from where your finger left it. */
export const settleEase = bezier(0.2, 0.75, 0.25, 1)

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Perspective distance for a page of width W: deep enough that the rising edge grows by ~15-25%, like a book seen from reading distance. */
export const perspectiveFor = (W: number) => Math.max(2600, W * 4.2)

/**
 * Where the free edge of the sheet lands on screen, measured from the spine, at angle θ.
 * W at 0°, 0 at 90°, −W at 180°; in between it is pushed outward by perspective because it is nearer the reader.
 */
export function edgeX(thetaDeg: number, W: number, P = perspectiveFor(W)): number {
  const t = thetaDeg * DEG
  return (W * Math.cos(t) * P) / (P - W * Math.sin(t))
}

/** Inverse of edgeX ignoring perspective: the angle that puts the free edge under a finger at x (from the spine). */
export function thetaForEdge(x: number, W: number): number {
  return Math.acos(clamp(x / W, -1, 1)) / DEG
}

// ---- light ---------------------------------------------------------------------------------------------------
// The lamp is up and to the left, in front of the book (the same lamp that lights the desk). Brightness is
// Lambert's cosine law against the sheet's normal, relative to how bright the page is lying flat.

const LAMP = (() => {
  const v = [-0.55, 0, 0.83]
  const n = Math.hypot(...v)
  return v.map((c) => c / n) as [number, number, number]
})()
const FLAT = LAMP[2]

/** Brightness of the side of the sheet facing the reader, relative to lying flat (1 = unchanged). */
export function relativeLight(thetaDeg: number): number {
  const t = thetaDeg * DEG
  // front normal after turning: (−sin θ, 0, cos θ); past 90° we see the back, whose normal is the opposite
  const n = thetaDeg <= 90 ? [-Math.sin(t), 0, Math.cos(t)] : [Math.sin(t), 0, -Math.cos(t)]
  return Math.max(0, n[0] * LAMP[0] + n[2] * LAMP[2]) / FLAT
}

export type Shade = {
  /** darkening across the whole visible face (0..1 alpha of warm black) */
  dark: number
  /** extra darkening at the spine: the sheet curving down into the gutter */
  spine: number
  /** warm highlight toward the free edge as the sheet catches the lamp */
  light: number
}

export function faceShade(thetaDeg: number): Shade {
  const rel = relativeLight(thetaDeg)
  const lift = Math.sin(thetaDeg * DEG)
  return {
    dark: clamp((1 - rel) * 0.62, 0, 0.7),
    spine: 0.22 * lift,
    light: clamp((rel - 1) * 0.6, 0, 0.14),
  }
}

/** The page beneath sits in the leaf's shadow at first and comes into the light as the leaf goes over. */
export function underDim(thetaDeg: number): number {
  return 0.36 * (1 - smoothstep(12, 118, thetaDeg))
}

/**
 * The shadow the sheet casts on the page beneath, as a band starting at its edge.
 * Returns where the band starts (from the spine), how wide it is, and how dark.
 */
export function castShadow(thetaDeg: number, W: number, P = perspectiveFor(W)): { x: number; width: number; alpha: number } {
  const lift = Math.sin(thetaDeg * DEG)
  if (thetaDeg <= 90) {
    return { x: Math.max(0, edgeX(thetaDeg, W, P)), width: W * (0.05 + 0.4 * lift), alpha: 0.46 * smoothstep(0, 14, thetaDeg) }
  }
  // standing past vertical and leaning left: its shadow pools at the spine and fades as it lies down
  return { x: 0, width: W * 0.42 * lift, alpha: 0.46 * lift * (1 - smoothstep(150, 180, thetaDeg)) }
}

// ---- a jump: riffle a few pages, then land ---------------------------------------------------------------------

/** How many blank pages riffle past for a jump of `distance` spreads (none for a neighbour). */
export function riffleCount(distance: number): number {
  const d = Math.abs(distance)
  if (d <= 1) return 0
  return clamp(Math.round(Math.log2(d) + 1), 2, 6)
}

export type Track = { start: number; duration: number; from: number; to: number; ease: (t: number) => number }

/**
 * Timing for a turn. `leaf` is the real page (going over, or coming back), `ghosts` are the riffled blanks
 * in the order they move. Forward: the page lifts first and the blanks follow it over. Back: the blanks fall
 * back one after another and the page you're going to lands last, on top.
 */
export function schedule(dir: 'next' | 'prev', ghosts: number, base: number): { leaf: Track; ghosts: Track[]; total: number } {
  const from = dir === 'next' ? 0 : 180
  const to = dir === 'next' ? 180 : 0
  if (ghosts === 0) {
    const leaf = { start: 0, duration: base, from, to, ease: turnEase }
    return { leaf, ghosts: [], total: base }
  }
  const leafDur = base * 0.62
  const ghostDur = base * 0.5
  const gap = base * 0.085
  if (dir === 'next') {
    const leaf = { start: 0, duration: leafDur, from, to, ease: turnEase }
    const g = Array.from({ length: ghosts }, (_, i) => ({ start: base * 0.14 + i * gap, duration: ghostDur, from, to, ease: riffleEase }))
    return { leaf, ghosts: g, total: Math.max(leafDur, ...g.map((x) => x.start + x.duration)) }
  }
  const g = Array.from({ length: ghosts }, (_, i) => ({ start: i * gap, duration: ghostDur, from, to, ease: riffleEase }))
  const leaf = { start: ghosts * gap + base * 0.04, duration: leafDur, from, to, ease: turnEase }
  return { leaf, ghosts: g, total: Math.max(leaf.start + leaf.duration, ...g.map((x) => x.start + x.duration)) }
}

export function angleAt(track: Track, ms: number): number {
  const p = clamp((ms - track.start) / track.duration, 0, 1)
  return track.from + (track.to - track.from) * track.ease(p)
}

/** Durations: a considered turn, and a brisk one when the reader is flicking through. */
export const TURN_MS = 860
export const BRISK_MS = 430
export const JUMP_MS = 1000
