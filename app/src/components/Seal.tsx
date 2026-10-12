import { Link } from 'react-router-dom'
import { unlockLabel } from '../lib/seal'

/**
 * A wax seal: a lump of wax (an irregular, slightly lopsided circle with a soft highlight and a pressed rim) stamped
 * with the monogram د (the first letter of دفتر, "daftar"). `open` is the same seal once the date has come: cracked
 * and a little faded. It is an object, not a button; the card around it is what you tap.
 */
export function WaxSeal({ open = false, size = 88 }: { open?: boolean; size?: number }) {
  return (
    <span className="wax" data-open={open || undefined} style={{ ['--size' as string]: `${size}px` }} aria-hidden="true">
      <i className="wax-ring" />
      <i className="wax-mark">د</i>
      {open && <i className="wax-crack" />}
    </span>
  )
}

/** A sealed letter, as a card: who it is for and when it opens, and nothing of what it says. */
export function SealedCard({
  to, until, to_href, size = 88, big = false, note,
}: {
  to: string | null
  until: string
  to_href?: string
  size?: number
  big?: boolean
  note?: string
}) {
  const inner = (
    <>
      <WaxSeal size={size} />
      <span className="sealed-text">
        <span className="sealed-to" dir="auto">{to ? `To ${to}` : 'A sealed letter'}</span>
        <span className="sealed-until">Sealed until {unlockLabel(until)}.</span>
        {note && <span className="sealed-note-line">{note}</span>}
      </span>
    </>
  )
  return to_href ? (
    <Link className={`sealed-card${big ? ' big' : ''}`} to={to_href}>{inner}</Link>
  ) : (
    <div className={`sealed-card${big ? ' big' : ''}`}>{inner}</div>
  )
}
