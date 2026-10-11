import { Link } from 'react-router-dom'
import type { EntrySummary } from '../lib/entries'

function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(y, m - 1, d))
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
              <span className="entry-title" dir="auto">
                {e.title || snippet(e) || 'Untitled'}
              </span>
              {e.title && (
                <span className="entry-snippet" dir="auto">
                  {snippet(e)}
                </span>
              )}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
