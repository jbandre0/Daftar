import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth'
import { EntryList } from '../components/EntryList'
import { localDate, recentEntries, type EntrySummary } from '../lib/entries'
import { syncDeps } from '../lib/syncDeps'
import { dismissNudge, shouldNudge, sinceText } from '../lib/vaultRemote'

function greeting(d = new Date()) {
  const h = d.getHours()
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const todayLong = () =>
  new Intl.DateTimeFormat('en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())

export function Desk() {
  const { session, profile } = useAuth()
  const userId = session!.user.id
  const [entries, setEntries] = useState<EntrySummary[] | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const nudge = !dismissed && shouldNudge(profile?.last_export_at ?? null, profile?.created_at ?? null)

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

      <div className="card hero">
        <p className="hero-date">{todayLong()}</p>
        <p style={{ fontSize: 'var(--fs-19)', fontFamily: 'var(--font-serif)' }}>
          {entries && entries.length === 0 ? "The page is blank. That's allowed." : hasToday ? "Today's page is open." : 'A fresh page, whenever you are.'}
        </p>
        <div className="row">
          <Link className="btn btn-primary" to="/write">
            {hasToday ? 'Keep going' : 'Write today'}
          </Link>
          <Link className="btn btn-tint" to="/chapters">
            Chapters
          </Link>
        </div>
      </div>

      {entries && entries.length > 0 && (
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="section-label">
            Recently
          </h2>
          <EntryList entries={entries} />
        </section>
      )}

      {nudge ? (
        <p className="nudge">
          <span>Last backup: {sinceText(profile?.last_export_at ?? null)}. A fresh copy takes one tap.</span>
          <Link className="btn btn-tint" to="/vault">
            Export
          </Link>
          <button
            className="btn btn-quiet"
            onClick={() => {
              dismissNudge()
              setDismissed(true)
            }}
          >
            Not now
          </button>
        </p>
      ) : (
        <p className="quiet-line">Last backup: {sinceText(profile?.last_export_at ?? null)}</p>
      )}
    </div>
  )
}
