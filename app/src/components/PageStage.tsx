import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  angleAt, BRISK_MS, castShadow, clamp, edgeX, faceShade, JUMP_MS, perspectiveFor, riffleCount, schedule, settleEase,
  smoothstep, thetaForEdge, TURN_MS, underDim, type Shade,
} from '../lib/pageTurn'

/** Which way the reader just moved. 'jump' = a leap to a date; 'none' = first paint. */
export type TurnDirection = 'next' | 'prev' | 'jump' | 'none'
export type Side = 'next' | 'prev'
export type StageSpread = { key: string; node: ReactNode }

/**
 * Read mode's book. Every spread renders inside <PageStage>; when `spreadKey` changes the page turns.
 *
 *  next  the page you were reading lifts at its free edge, catches the lamp, swings up over the spine showing its
 *        back (with your writing faintly through the paper, mirrored) and lies down on the left. The next page is
 *        beneath it, starting in its shadow.
 *  prev  the previous page swings back over from the left and lands on top.
 *  jump  blank pages riffle past (more for a longer leap), then the page you asked for.
 *  drag  on touch (anywhere) or with a mouse from the page's outer edge, the page follows your finger and either
 *        completes or springs back; a flick completes it too.
 *
 * The page is frosted glass over the parchment. Two glass panels stacked would show blurred text through each
 * other, so the page beneath is clipped, every frame, to exactly the area the turning page has uncovered
 * (from the perspective projection of its edge). Nothing animates opacity or filters on an ancestor of the glass,
 * which would break the blur. prefers-reduced-motion: no motion at all, an immediate swap.
 */
type Props = {
  spreadKey: string
  direction: TurnDirection
  /** Signed number of spreads moved (later > 0). Used for jumps: a longer leap riffles more pages. */
  distance?: number
  children: ReactNode
  /** The neighbouring spread, for dragging a page before the move is decided. */
  neighbour?: (side: Side) => StageSpread | null
  /** A drag completed a turn: move the book there. */
  onGestureTurn?: (side: Side) => void
  /** Any turn finished (useful for scrolling to the top of the new page after a drag). */
  onSettled?: () => void
}

type Slot = { key: string; node: ReactNode; peek?: Side }
type Turn = { id: number; side: Side; from: Slot; to: Slot; mode: 'auto' | 'drag'; ghosts: number; base: number }
type Engine = { frame: (leaf: number, ghosts?: number[]) => void; theta: () => number }

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Dev only: ?slowmo=8 slows every turn 8x; ?turnfreeze=60 stops an automatic turn at 60° (for screenshots).
const DEV_PARAMS = import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search) : null
const SLOW = Math.max(1, Number(DEV_PARAMS?.get('slowmo') ?? 1) || 1)
const FREEZE = DEV_PARAMS?.has('turnfreeze') ? Number(DEV_PARAMS.get('turnfreeze')) : null

let turnSeq = 0

// ---- the per-frame renderer ------------------------------------------------------------------------------------

const INK = '28, 16, 6'
const LAMP = '255, 232, 188'

function shadeGradient(s: Shade): string {
  const a = (v: number) => v.toFixed(3)
  return (
    `linear-gradient(90deg, rgba(${INK}, ${a(s.dark + s.spine)}) 0%, rgba(${INK}, ${a(s.dark + s.spine * 0.35)}) 22%, ` +
    `rgba(${INK}, ${a(s.dark)}) 55%, rgba(${LAMP}, ${a(s.light)}) 100%)`
  )
}

function box(el: HTMLElement, l: number, t: number, w: number, h: number) {
  el.style.left = `${l}px`
  el.style.top = `${t}px`
  el.style.width = `${w}px`
  el.style.height = `${h}px`
}

/** Measure the two pages and wire up a function that draws the whole scene for a given angle. */
function createEngine(root: HTMLElement, turn: Turn): Engine | null {
  const leafLayer = root.querySelector<HTMLElement>(':scope > [data-role="leaf"]')
  const underLayer = root.querySelector<HTMLElement>(':scope > [data-role="under"]')
  if (!leafLayer || !underLayer) return null
  const leaf = leafLayer.querySelector<HTMLElement>(':scope > .leaf')!
  const under = underLayer.querySelector<HTMLElement>(':scope > .leaf')!
  const front = leaf.querySelector<HTMLElement>(':scope > .leaf-front')!
  const leafPage = front.querySelector<HTMLElement>('.page')
  const underPage = under.querySelector<HTMLElement>(':scope > .leaf-front .page')
  if (!leafPage || !underPage) return null

  const q = <T extends HTMLElement>(el: HTMLElement, sel: string) => el.querySelector<T>(sel)!
  const shade = q(leaf, ':scope > .fx-shade')
  const edge = q(leaf, ':scope > .fx-edge')
  const back = q(leaf, ':scope > .leaf-back')
  const backShade = q(back, ':scope > .fx-back-shade')
  const dim = q(under, ':scope > .fx-dim')
  const cast = q(under, ':scope > .fx-cast')
  const ghosts = [...under.querySelectorAll<HTMLElement>(':scope > .fx-ghost')]

  // geometry (offsets are relative to each .leaf, which is the positioned wrapper)
  const L = leafPage.offsetLeft
  const T = leafPage.offsetTop
  const W = leafPage.offsetWidth
  const HL = leafPage.offsetHeight
  const UL = underPage.offsetLeft
  const UT = underPage.offsetTop
  const UW = underPage.offsetWidth
  const HU = underPage.offsetHeight
  const P = perspectiveFor(W)
  const dx = L - UL // both pages share the spine; measured anyway in case they don't
  const dy = T - UT

  // perspective centred on what the reader can see, not on the middle of a very long page
  const lr = leaf.getBoundingClientRect()
  const oy = clamp(innerHeight / 2 - lr.top, T + Math.min(160, HL / 2), T + HL - Math.min(160, HL / 2))
  const ur = under.getBoundingClientRect()
  const oyU = clamp(innerHeight / 2 - ur.top, UT + Math.min(160, HU / 2), UT + HU - Math.min(160, HU / 2))

  leaf.style.transformOrigin = `${L}px ${oy}px`
  leaf.style.willChange = 'transform'
  for (const el of [shade, back]) box(el, L, T, W, HL)
  box(edge, L + W - 2, T + 26, 2, Math.max(0, HL - 52))
  box(dim, UL, UT, UW, HU)
  box(cast, UL, UT, UW, HU)
  ghosts.forEach((g) => {
    box(g, UL, UT, UW, HU)
    g.style.transformOrigin = `0px ${oyU - UT}px`
  })

  const m = 90 // keep the page's own drop shadow when clipping
  let current = turn.side === 'next' ? 0 : 180

  const frame = (theta: number, ghostAngles: number[] = []) => {
    current = theta
    // the turning page
    leaf.style.transform = `perspective(${P}px) rotateY(${-theta}deg)`
    const showingBack = theta > 90
    front.style.visibility = showingBack ? 'hidden' : ''
    back.style.visibility = showingBack ? 'visible' : 'hidden'
    back.style.opacity = (1 - smoothstep(128, 178, theta)).toFixed(3)
    edge.style.opacity = (Math.sin(theta * 2 * (Math.PI / 180)) * 0.55 * (showingBack ? 0 : 1)).toFixed(3)
    const s = faceShade(theta)
    if (showingBack) {
      backShade.style.background = shadeGradient(s)
      shade.style.background = 'none'
    } else {
      shade.style.background = shadeGradient(s)
    }

    // riffled pages (jumps). Forward: they lie on the destination and appear as the page lifts off them;
    // back: they land on the current page and melt away under the page arriving on top.
    // A blank lying flat under the turning glass page is clipped away where the glass covers it, so the glass
    // always has the parchment behind it (exactly as at rest) and never brightens or shows paper through.
    const leafEdge = theta < 90 ? edgeX(theta, W, P) + dx : -Infinity
    ghosts.forEach((g, i) => {
      const a = ghostAngles[i] ?? (turn.side === 'next' ? 0 : 180)
      g.style.transform = `perspective(${P}px) rotateY(${-a}deg)`
      g.dataset.side = a > 90 ? 'back' : 'front'
      g.style.opacity = (1 - smoothstep(128, 178, a)).toFixed(3)
      g.style.clipPath = a < 0.5 && leafEdge > -Infinity ? `inset(-2px -2px -2px ${Math.max(0, leafEdge - 1).toFixed(1)}px)` : ''
      ;(g.firstElementChild as HTMLElement).style.background = shadeGradient(faceShade(a))
    })

    // what is lying on the page beneath, and how far it reaches
    // (positions are in the lower page's coordinates: its spine is x = 0)
    const covering: { reach: number }[] = []
    if (theta < 90) covering.push({ reach: edgeX(theta, W, P) + dx })
    for (let i = 0; i < ghosts.length; i++) {
      const a = ghostAngles[i] ?? (turn.side === 'next' ? 0 : 180)
      if (a < 90) covering.push({ reach: edgeX(a, UW, P) })
    }

    if (covering.length) {
      // Reveal (or cover) the page beneath along the sheet's edge, as one clean vertical sweep over its whole
      // height. Where the pages differ in height, the taller part is wiped in by the same edge instead of
      // popping into view at the start or vanishing at the end.
      let reach = -Infinity
      for (const c of covering) reach = Math.max(reach, c.reach)
      const xs = Math.min(UW + m, reach - 1)
      const poly = `polygon(${xs}px ${-m}px, ${UW + m}px ${-m}px, ${UW + m}px ${HU + m}px, ${xs}px ${HU + m}px)`
      underPage.style.clipPath = poly
      dim.style.clipPath = poly
    } else {
      underPage.style.clipPath = ''
      dim.style.clipPath = ''
    }

    // Light on the page beneath: it sits in the shade of whatever lies nearest it. The moving shadow is cast by
    // that same sheet going forward, and by the page arriving on top coming back.
    const nearest = Math.min(theta, ...ghostAngles)
    dim.style.opacity = underDim(nearest).toFixed(3)
    const castBy = turn.side === 'next' ? nearest : theta
    const c = castShadow(castBy, W, P)
    // a shadow only falls where the sheet casting it is: no further down than its own foot
    const byLeaf = castBy === theta && ghosts.length === 0
    cast.style.height = `${Math.max(0, byLeaf ? Math.min(HU, HL + dy) : HU)}px`
    cast.style.opacity = c.alpha.toFixed(3)
    cast.style.transform = `translateX(${(c.x + dx).toFixed(1)}px) scaleX(${(c.width / UW).toFixed(4)})`
  }

  return { frame, theta: () => current }
}

function clearStyles(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('.leaf').forEach((el) => {
    el.style.transform = ''
    el.style.transformOrigin = ''
    el.style.willChange = ''
  })
  root.querySelectorAll<HTMLElement>('.leaf-front').forEach((el) => (el.style.visibility = ''))
  root.querySelectorAll<HTMLElement>('.page').forEach((el) => (el.style.clipPath = ''))
}

// ---- the component ---------------------------------------------------------------------------------------------

export function PageStage({ spreadKey, direction, distance = 0, children, neighbour, onGestureTurn, onSettled }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const committed = useRef<StageSpread>({ key: spreadKey, node: children })
  const lastTurnAt = useRef(0)
  const briskFor = useRef<{ key: string; brisk: boolean }>({ key: spreadKey, brisk: false })
  const engine = useRef<Engine | null>(null)
  const pendingTheta = useRef<number | null>(null)
  const settleRaf = useRef(0)
  const settleSafety = useRef(0)
  const [state, setState] = useState<{ shown: string; turn: Turn | null }>({ shown: spreadKey, turn: null })

  // ---- a new spread arrived: decide how to get there (derived state, during render) -------------------------
  if (state.shown !== spreadKey) {
    const t = state.turn
    if (t && t.to.key === spreadKey) {
      setState({ shown: spreadKey, turn: t }) // a drag already took us there
    } else if (reducedMotion() || direction === 'none' || committed.current.key === spreadKey || (document.hidden && FREEZE === null)) {
      setState({ shown: spreadKey, turn: null })
    } else {
      const side: Side = direction === 'prev' || (direction === 'jump' && distance < 0) ? 'prev' : 'next'
      const ghosts = direction === 'jump' ? riffleCount(distance) : 0
      if (briskFor.current.key !== spreadKey) {
        const now = Date.now()
        briskFor.current = { key: spreadKey, brisk: now - lastTurnAt.current < 520 }
        lastTurnAt.current = now
      }
      const brisk = briskFor.current.brisk
      setState({
        shown: spreadKey,
        turn: {
          id: ++turnSeq, side, mode: 'auto', ghosts,
          base: (ghosts ? JUMP_MS : brisk ? BRISK_MS : TURN_MS) * SLOW,
          from: { key: committed.current.key, node: committed.current.node },
          to: { key: spreadKey, node: children },
        },
      })
    }
  }

  useLayoutEffect(() => {
    committed.current = { key: spreadKey, node: children }
  })

  const finish = useCallback(
    (id: number) => {
      setState((s) => (s.turn?.id === id ? { ...s, turn: null } : s))
      onSettled?.()
    },
    [onSettled],
  )

  // ---- run a turn ------------------------------------------------------------------------------------------
  const turn = state.turn
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    if (!turn) {
      clearStyles(root)
      engine.current = null
      return
    }
    clearStyles(root)
    const eng = createEngine(root, turn)
    if (!eng) {
      if (import.meta.env.DEV) console.debug('[PageStage] could not measure the pages; skipping the turn', root.innerHTML.slice(0, 300))
      finish(turn.id)
      return
    }
    engine.current = eng
    if (import.meta.env.DEV) (window as unknown as { __daftarTurn?: Engine }).__daftarTurn = eng

    // A turn nobody can see is not worth finishing slowly: if the tab is hidden, land it now.
    const onHide = () => {
      if (!document.hidden || FREEZE !== null) return
      cancelAnimationFrame(settleRaf.current)
      finish(turn.id)
    }
    document.addEventListener('visibilitychange', onHide)

    if (turn.mode === 'drag') {
      eng.frame(pendingTheta.current ?? (turn.side === 'next' ? 0 : 180))
      return () => {
        cancelAnimationFrame(settleRaf.current)
        document.removeEventListener('visibilitychange', onHide)
      }
    }

    const plan = schedule(turn.side, turn.ghosts, turn.base)
    eng.frame(plan.leaf.from, plan.ghosts.map((g) => g.from)) // first frame before paint: no flash
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const ms = now - t0
      const a = angleAt(plan.leaf, ms)
      if (FREEZE !== null && ((turn.side === 'next' && a >= FREEZE) || (turn.side === 'prev' && a <= FREEZE))) {
        eng.frame(FREEZE, plan.ghosts.map((g) => angleAt(g, ms)))
        return
      }
      eng.frame(a, plan.ghosts.map((g) => angleAt(g, ms)))
      if (ms >= plan.total) finish(turn.id)
      else raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    // and if frames stop arriving (throttled, backgrounded), never leave a page half-turned
    const safety = FREEZE === null ? setTimeout(() => finish(turn.id), plan.total + 1200) : 0
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(safety)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [turn, finish])

  // ---- dragging ----------------------------------------------------------------------------------------------
  type Drag = {
    id: number; x: number; y: number; side: Side | null; decided: boolean; mouse: boolean; W: number
    samples: { x: number; t: number }[]; animated: boolean
  }
  const drag = useRef<Drag | null>(null)
  const swallowClick = useRef(false)

  const settle = (target: number, then: () => void) => {
    const eng = engine.current
    if (!eng) return then()
    const from = eng.theta()
    const dur = clamp((Math.abs(target - from) / 180) * 640, 170, 600) * SLOW
    const t0 = performance.now()
    cancelAnimationFrame(settleRaf.current)
    const tick = (now: number) => {
      const p = clamp((now - t0) / dur, 0, 1)
      eng.frame(from + (target - from) * settleEase(p))
      if (p < 1) settleRaf.current = requestAnimationFrame(tick)
      else {
        clearTimeout(settleSafety.current)
        then()
      }
    }
    settleRaf.current = requestAnimationFrame(tick)
    clearTimeout(settleSafety.current)
    settleSafety.current = window.setTimeout(() => {
      cancelAnimationFrame(settleRaf.current)
      then()
    }, dur + 1200)
  }

  const restPage = () => rootRef.current?.querySelector<HTMLElement>(':scope > [data-role="rest"] .page')?.getBoundingClientRect() ?? null
  const edgeZone = (r: DOMRect) => Math.min(64, r.width * 0.12)
  const edgeAt = (x: number): Side | null => {
    const r = restPage()
    if (!r) return null
    const z = edgeZone(r)
    if (x > r.right - z && x < r.right + 16) return 'next'
    if (x < r.left + z && x > r.left - 16) return 'prev'
    return null
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (state.turn || !neighbour || !e.isPrimary) return
    const r = restPage()
    if (!r) return
    const mouse = e.pointerType === 'mouse'
    let side: Side | null = null
    if (mouse) {
      if (e.button !== 0) return
      side = edgeAt(e.clientX)
      if (!side || !neighbour(side)) return
      e.preventDefault() // no text selection while dragging a page by its edge
    }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, side, decided: false, mouse, W: r.width, samples: [], animated: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) {
      // affordance: a grab cursor at the page's outer edges
      const root = rootRef.current
      if (e.pointerType === 'mouse' && root && !state.turn && neighbour) {
        const side = edgeAt(e.clientX)
        root.dataset.edge = side && neighbour(side) ? side : ''
      }
      return
    }
    if (e.pointerId !== d.id) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (!d.decided) {
      if (Math.hypot(dx, dy) < 10) return
      if (!d.mouse && Math.abs(dx) < Math.abs(dy) * 1.2) {
        drag.current = null // a scroll, not a turn
        return
      }
      const side: Side = d.side ?? (dx < 0 ? 'next' : 'prev')
      const n = neighbour?.(side)
      if (!n || (side === 'next' && dx > 0) || (side === 'prev' && dx < 0)) {
        drag.current = null
        return
      }
      d.side = side
      d.decided = true
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      } catch {
        /* the pointer is already gone (or synthetic): keep going without capture */
      }
      if (!reducedMotion()) {
        d.animated = true
        pendingTheta.current = side === 'next' ? 0 : 180
        setState((s) => ({
          ...s,
          turn: {
            id: ++turnSeq, side, mode: 'drag', ghosts: 0, base: TURN_MS,
            from: { key: spreadKey, node: children },
            to: { key: n.key, node: n.node, peek: side },
          },
        }))
      }
    }
    d.samples.push({ x: e.clientX, t: performance.now() })
    if (d.samples.length > 6) d.samples.shift()
    if (!d.animated) return
    // the page's free edge follows the finger (a little faster on touch, where you rarely grab the very edge)
    const travel = (d.side === 'next' ? -dx : dx) * (d.mouse ? 1 : 1.25)
    const edgePos = d.side === 'next' ? d.W - Math.max(0, travel) : -d.W + Math.max(0, travel)
    const theta = thetaForEdge(edgePos, d.W)
    pendingTheta.current = theta
    engine.current?.frame(theta)
  }

  const onPointerEnd = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    if (!d.decided || !d.side) return
    swallowClick.current = true
    setTimeout(() => (swallowClick.current = false), 0)
    const side = d.side
    const dx = e.clientX - d.x
    const s = d.samples
    const v = s.length > 1 ? (s[s.length - 1].x - s[0].x) / Math.max(1, s[s.length - 1].t - s[0].t) : 0
    if (!d.animated) {
      // reduced motion: a plain swipe
      if ((side === 'next' && dx < -60) || (side === 'prev' && dx > 60)) onGestureTurn?.(side)
      return
    }
    const id = state.turn?.id
    const theta = engine.current?.theta() ?? pendingTheta.current ?? (side === 'next' ? 0 : 180)
    const flick = side === 'next' ? v < -0.45 && theta > 8 : v > 0.45 && theta < 172
    const far = side === 'next' ? theta > 72 : theta < 108
    const done = () => (id !== undefined ? finish(id) : undefined)
    if (e.type !== 'pointercancel' && (far || flick)) {
      onGestureTurn?.(side)
      settle(side === 'next' ? 180 : 0, done)
    } else {
      settle(side === 'next' ? 0 : 180, done)
    }
  }

  // a drag that began on a link must not also follow it
  const onClickCapture = (e: React.MouseEvent) => {
    if (swallowClick.current) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // ---- layers ------------------------------------------------------------------------------------------------
  const live = (slot: Slot): ReactNode => {
    if (slot.key === spreadKey) return children
    if (slot.peek) {
      const n = neighbour?.(slot.peek)
      if (n && n.key === slot.key) return n.node
    }
    return slot.node
  }

  type Layer = { key: string; role: 'rest' | 'under' | 'leaf'; node: ReactNode }
  const t = state.turn
  const layers: Layer[] = !t
    ? [{ key: spreadKey, role: 'rest', node: children }]
    : t.side === 'next'
      ? [{ key: t.to.key, role: 'under', node: live(t.to) }, { key: t.from.key, role: 'leaf', node: live(t.from) }]
      : [{ key: t.from.key, role: 'under', node: live(t.from) }, { key: t.to.key, role: 'leaf', node: live(t.to) }]

  return (
    <div
      ref={rootRef}
      className="stage"
      data-turning={t ? t.side : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={onClickCapture}
    >
      {layers.map((l) => {
        const away = l.key !== spreadKey
        return (
          <div key={l.key} className="layer" data-role={l.role} aria-hidden={away || undefined} inert={away || undefined}>
            <div className="leaf">
              <div className="leaf-front">{l.node}</div>
              {l.role === 'leaf' && (
                <>
                  <div className="fx fx-shade" />
                  <div className="fx fx-edge" />
                  <div className="fx leaf-back" aria-hidden="true" inert>
                    <div className="leaf-showthrough">{l.node}</div>
                    <div className="fx-back-shade" />
                  </div>
                </>
              )}
              {l.role === 'under' && (
                <>
                  <div className="fx fx-dim" />
                  {Array.from({ length: t?.ghosts ?? 0 }, (_, i) => (
                    <div key={i} className="fx fx-ghost" aria-hidden="true">
                      <div className="fx-ghost-shade" />
                    </div>
                  ))}
                  <div className="fx fx-cast" />
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
