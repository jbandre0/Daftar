import { Link } from 'react-router-dom'
import type { EntrySummary } from '../lib/entries'
import { unlockLabel } from '../lib/seal'

function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
  if (y !== new Date().getFullYear()) opts.year = 'numeric' // the year only when it isn't this one
  return new Intl.DateTimeFormat('en', opts).format(new Date(y, m - 1, d))
}

export function snippet(e: Pick<EntrySummary, 'body_text'>, max = 90) {
  const t = e.body_text.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t
}

export function EntryList({ entries }: { entries: EntrySummary[] }) {
  return (
    <ul className="entry-list">
      {entries.map((e) => (
        <li key={e.id}>
          <Link to={`/write/${e.id}`}>
            <span className="entry-date">{shortDate(e.entry_date)}</span>
            <span className="entry-main">
              {e.sealed_until ? (
                <>
                  <span className="entry-title" dir="auto">{e.letter_to ? `A letter to ${e.letter_to}` : 'A sealed letter'}</span>
                  <span className="entry-snippet sealed-note">Sealed until {unlockLabel(e.sealed_until)}.</span>
                </>
              ) : (
                <>
                  <span className="entry-title" dir="auto">
                    {e.title || snippet(e) || 'Untitled'}
                  </span>
                  {e.title && (
                    <span className="entry-snippet" dir="auto">
                      {snippet(e)}
                    </span>
                  )}
                </>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
