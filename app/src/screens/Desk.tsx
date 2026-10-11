import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { localDate, recentEntries, type EntrySummary } from '../lib/entries'
import { syncDeps } from '../lib/syncDeps'

function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

function shortDate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(y, m - 1, d))
}

function snippet(e: EntrySummary) {
  const t = e.body_text.replace(/\s+/g, ' ').trim()
  return t.length > 90 ? t.slice(0, 90).trimEnd() + '…' : t
}

export function Desk() {
  const { session, profile } = useAuth()
  const userId = session!.user.id
  const [entries, setEntries] = useState<EntrySummary[] | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      // Local unsynced drafts first, so offline writing still shows up here.
      const drafts = (await syncDeps.store.all()).filter((d) => d.userId === userId)
      const local: EntrySummary[] = drafts.map((d) => ({
        id: d.id, entry_date: d.content.entry_date, title: d.content.title, body_text: d.content.body_text,
        word_count: d.content.word_count, updated_at: new Date(d.updatedAt).toISOString(),
      }))
      let remote: EntrySummary[] = []
      try {
        remote = await recentEntries(5)
      } catch {
        /* offline */
      }
      const byId = new Map<string, EntrySummary>()
      for (const e of [...remote, ...local]) {
        const prev = byId.get(e.id)
        if (!prev || e.updated_at > prev.updated_at) byId.set(e.id, e)
      }
      const merged = [...byId.values()]
        .filter((e) => e.body_text.trim() || e.title)
        .sort((a, b) => (b.entry_date + b.updated_at).localeCompare(a.entry_date + a.updated_at))
        .slice(0, 5)
      if (!cancelled) setEntries(merged)
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  const today = localDate()
  const hasToday = entries?.some((e) => e.entry_date === today)
  const name = profile?.display_name ? `, ${profile.display_name}` : ''

  return (
    <div className="screen">
      <h1 className="screen-title">
        {greeting()}
        {name}
      </h1>
      <p className="screen-sub">{entries && entries.length === 0 ? "The page is blank. That's allowed." : ' '}</p>

      <div className="row" style={{ marginBlockEnd: 'var(--sp-6)' }}>
        <Link className="btn btn-primary" to="/write">
          {hasToday ? 'Keep going' : 'Write today'}
        </Link>
      </div>

      {entries && entries.length > 0 && (
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-label">
            Recently
          </h2>
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
        </section>
      )}

      <p className="quiet-line">Last backup: never. The Vault arrives in phase 4.</p>
    </div>
  )
}
