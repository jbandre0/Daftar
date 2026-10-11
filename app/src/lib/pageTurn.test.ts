import { describe, expect, it } from 'vitest'
import {
  angleAt, bezier, castShadow, edgeX, faceShade, perspectiveFor, relativeLight, riffleCount, schedule, thetaForEdge,
  turnEase, underDim,
} from './pageTurn'

describe('timing curves', () => {
  it('a bezier matches its endpoints and the CSS ease curve', () => {
    const ease = bezier(0.25, 0.1, 0.25, 1) // CSS "ease"
    expect(ease(0)).toBe(0)
    expect(ease(1)).toBe(1)
    expect(ease(0.5)).toBeCloseTo(0.8024, 3) // published value for ease at t = 0.5
  })
  it('the turn curve is monotonic: a page never swings backwards', () => {
    let last = -1
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = turnEase(Math.min(1, t))
      expect(v).toBeGreaterThanOrEqual(last - 1e-9)
      last = v
    }
  })
})

describe('geometry', () => {
  const W = 700
  const P = perspectiveFor(W)
  it('the free edge: W lying flat, 0 standing, −W turned over', () => {
    expect(edgeX(0, W, P)).toBeCloseTo(W)
    expect(edgeX(90, W, P)).toBeCloseTo(0)
    expect(edgeX(180, W, P)).toBeCloseTo(-W)
  })
  it('perspective pushes the rising edge outward, but only modestly', () => {
    const flat = W * Math.cos(Math.PI / 4)
    const seen = edgeX(45, W, P)
    expect(seen).toBeGreaterThan(flat)
    expect(seen / flat).toBeLessThan(1.25)
  })
  it('a finger at the edge maps back to the right angle', () => {
    expect(thetaForEdge(W, W)).toBeCloseTo(0)
    expect(thetaForEdge(0, W)).toBeCloseTo(90)
    expect(thetaForEdge(-W, W)).toBeCloseTo(180)
    expect(thetaForEdge(-5 * W, W)).toBeCloseTo(180) // clamped
  })
})

describe('light', () => {
  it('a page lying flat is lit exactly as at rest (no jump when a turn starts or ends)', () => {
    expect(relativeLight(0)).toBeCloseTo(1)
    expect(relativeLight(180)).toBeCloseTo(1)
    const s = faceShade(0)
    expect(s.dark).toBeCloseTo(0)
    expect(s.spine).toBeCloseTo(0)
    expect(s.light).toBeCloseTo(0)
    expect(underDim(180)).toBe(0)
    expect(castShadow(0, 700).alpha).toBe(0)
    expect(castShadow(180, 700).alpha).toBeCloseTo(0)
  })
  it('lifting toward the lamp brightens the page, then it darkens as it turns away', () => {
    expect(faceShade(30).light).toBeGreaterThan(0)
    expect(faceShade(85).dark).toBeGreaterThan(faceShade(30).dark)
    expect(faceShade(120).dark).toBeGreaterThan(0.3) // the back, facing away from the lamp
  })
  it('the page beneath starts in shade and comes into the light', () => {
    expect(underDim(0)).toBeGreaterThan(0.3)
    expect(underDim(60)).toBeLessThan(underDim(10))
    expect(underDim(130)).toBe(0)
  })
  it('the cast shadow starts at the sheet’s edge and widens as it rises', () => {
    const lo = castShadow(20, 700)
    const hi = castShadow(70, 700)
    expect(lo.x).toBeGreaterThan(hi.x)
    expect(hi.width).toBeGreaterThan(lo.width)
  })
})

describe('jumps', () => {
  it('a neighbour is a turn, a leap riffles more pages the further it goes (2 to 6)', () => {
    expect(riffleCount(1)).toBe(0)
    expect(riffleCount(-1)).toBe(0)
    expect(riffleCount(2)).toBe(2)
    expect(riffleCount(8)).toBe(4)
    expect(riffleCount(-500)).toBe(6)
  })
  it('forward: the page lifts first and the blanks follow; back: the blanks fall first and the page lands last', () => {
    const f = schedule('next', 4, 1000)
    expect(f.leaf.start).toBe(0)
    expect(Math.min(...f.ghosts.map((g) => g.start))).toBeGreaterThan(0)
    const b = schedule('prev', 4, 1000)
    expect(b.leaf.start).toBeGreaterThan(Math.max(...b.ghosts.map((g) => g.start)))
    for (const s of [f, b]) {
      const ends = [s.leaf, ...s.ghosts].map((t) => t.start + t.duration)
      expect(s.total).toBeCloseTo(Math.max(...ends))
      expect(s.total).toBeLessThanOrEqual(1100)
    }
  })
  it('every track starts and ends exactly at its angles', () => {
    const s = schedule('prev', 3, 900)
    for (const t of [s.leaf, ...s.ghosts]) {
      expect(angleAt(t, -50)).toBe(t.from)
      expect(angleAt(t, t.start)).toBe(t.from)
      expect(angleAt(t, t.start + t.duration + 1)).toBe(t.to)
    }
  })
})
