import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { SealedCard, WaxSeal } from '../components/Seal'
import { fetchLetters, letterState, type LetterRow } from '../lib/letters'
import { unlockLabel } from '../lib/seal'

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  if (y !== new Date().getFullYear()) o.year = 'numeric'
  return new Intl.DateTimeFormat('en', o).format(new Date(y, m - 1, d))
}

function LetterItem({ l }: { l: LetterRow }) {
  const opened = letterState(l) === 'opened'
  return (
    <li>
      <Link to={`/write/${l.id}`}>
        <span className="entry-date">{shortDate(l.entry_date)}</span>
        <span className="entry-main">
          <span className="entry-title" dir="auto">
            {l.letter_to ? `To ${l.letter_to}` : l.title || 'A letter'}
            {l.title && l.letter_to && ![l.letter_to, `To ${l.letter_to}`, `For ${l.letter_to}`].includes(l.title) ? (
              <span className="letter-subject"> · {l.title}</span>
            ) : null}
          </span>
          <span className="entry-snippet" dir="auto">
            {opened && l.unlock_at ? `Opened ${unlockLabel(l.unlock_at)}. ` : ''}
            {l.snippet || (opened ? '' : 'Not sealed yet.')}
          </span>
          {l.unsynced && <span className="entry-meta">on this device</span>}
        </span>
      </Link>
    </li>
  )
}

export function Letters() {
  const { session } = useAuth()
  const userId = session!.user.id
  const [rows, setRows] = useState<LetterRow[] | null>(null)
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    let live = true
    const load = () => fetchLetters(userId).then((r) => live && (setRows(r.rows), setOffline(r.offline)))
    void load()
    window.addEventListener('online', load)
    return () => {
      live = false
      window.removeEventListener('online', load)
    }
  }, [userId])

  const sealed = rows?.filter((l) => letterState(l) === 'sealed') ?? []
  const opened = rows?.filter((l) => letterState(l) === 'opened') ?? []
  const drafts = rows?.filter((l) => letterState(l) === 'draft') ?? []

  return (
    <div className="screen letters">
      <h1 className="screen-title">Letters</h1>
      <p className="screen-sub">Write to someone, or to later. A sealed letter stays closed until the day you choose.</p>

      <div className="row" style={{ marginBlockEnd: 'var(--sp-6)' }}>
        <Link className="btn btn-primary" to="/write/new?letter=1">Write a letter</Link>
      </div>

      {offline && <p className="empty">You're offline, so this is what this device last saw.</p>}

      {rows && rows.length === 0 && (
        <div className="card letters-empty">
          <WaxSeal size={72} />
          <p>No letters yet. Write one to your future self, or to someone you love, and seal it until the day it should be read.</p>
        </div>
      )}

      {sealed.length > 0 && (
        <section aria-labelledby="sealed-h">
          <h2 id="sealed-h" className="section-label">Sealed</h2>
          <ul className="sealed-list">
            {sealed.map((l) => (
              <li key={l.id}>
                <SealedCard to={l.letter_to} until={l.unlock_at!} to_href={`/write/${l.id}`} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {drafts.length > 0 && (
        <section aria-labelledby="drafts-h">
          <h2 id="drafts-h" className="section-label">Still writing</h2>
          <ul className="entry-list">{drafts.map((l) => <LetterItem key={l.id} l={l} />)}</ul>
        </section>
      )}

      {opened.length > 0 && (
        <section aria-labelledby="opened-h">
          <h2 id="opened-h" className="section-label">Opened</h2>
          <ul className="entry-list">{opened.map((l) => <LetterItem key={l.id} l={l} />)}</ul>
        </section>
      )}
    </div>
  )
}
