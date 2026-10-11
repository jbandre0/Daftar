import type { ReactNode } from 'react'

/** Which way the reader just moved. 'jump' = a leap to a date; 'none' = first paint. */
export type TurnDirection = 'next' | 'prev' | 'jump' | 'none'

/**
 * THE SEAM FOR THE PAGE-TURN ANIMATION.
 *
 * Read mode renders every spread inside <PageStage>. `spreadKey` changes whenever the reader moves to another
 * spread, and `direction` says which way. Today this simply swaps the content with no motion. The page-turn
 * (spec §8: "page turns in Read mode slide 24 px with a fade, 180 ms ease-out"; the owner wants something much
 * nicer than that, built with motion, in Opus) belongs in here, and only in here: Read.tsx already owns the
 * data, keyboard (←/→), swipe, jump-to-date and the live-region announcement, and will not need to change.
 *
 * Contract for whoever builds the motion:
 *  - children are the full spread (glass panel, scrollable content). Keep the previous child mounted while it
 *    animates out; do not block input or focus on the animation finishing.
 *  - honour prefers-reduced-motion: no transforms at all, a plain swap (CSS in base.css already zeroes
 *    transitions/animations under that media query, but check any JS-driven motion).
 *  - 'jump' should feel different from 'next'/'prev' (a leap, not a page).
 *  - the panel is frosted glass (backdrop-filter) over the parchment: animating transform/opacity on it is
 *    fine; avoid animating blur radius (expensive).
 *  - touch-action on the stage is `pan-y` so vertical scroll still works while Read.tsx handles horizontal swipes.
 */
export function PageStage({ spreadKey, direction, children }: { spreadKey: string; direction: TurnDirection; children: ReactNode }) {
  return (
    <div className="stage" data-direction={direction} data-spread={spreadKey}>
      {children}
    </div>
  )
}
