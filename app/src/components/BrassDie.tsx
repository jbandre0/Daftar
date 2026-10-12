/**
 * The brass die: a small isometric cube in flame line art (pips are rings, nothing filled).
 * `rolls` changes on every roll; the 150 ms tilt replays because the element is keyed by it.
 * Reduced motion turns the tilt off (base.css). Decorative: the button that holds it carries the label.
 */
export function BrassDie({ size = 56, rolls = 0 }: { size?: number; rolls?: number }) {
  return (
    <svg
      key={rolls}
      className={`brass-die${rolls > 0 ? ' rolled' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden
      focusable="false"
    >
      <path d="M32 4 56 18v28L32 60 8 46V18Z" />
      <path d="M8 18 32 32 56 18M32 32v28" />
      <circle cx="32" cy="18" r="2.4" />
      <circle cx="15.2" cy="30.6" r="2.2" />
      <circle cx="24.8" cy="47.4" r="2.2" />
      <circle cx="51.2" cy="26.4" r="2.2" />
      <circle cx="44" cy="39" r="2.2" />
      <circle cx="36.8" cy="51.6" r="2.2" />
    </svg>
  )
}
