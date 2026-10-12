import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BrassDie } from './BrassDie'
import {
  NO_FILTERS, loadDieState, loadPrompts, matchesPrompt, pushHistory, rollPrompt, saveDieState,
  type DieState, type PromptFilters, type PromptRow,
} from '../lib/prompts'
import { DEPTHS, MOODS, TIMES } from '../lib/promptSeed'

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

/** A prompt handed to a new page (the page keeps it as entry.fields.prompt, so it exports with the entry). */
export type PromptHandoff = { text: string; track_hint: PromptRow['track_hint'] }

export function PromptDie() {
  const navigate = useNavigate()
  const [all, setAll] = useState<PromptRow[] | null>(null)
  const [offline, setOffline] = useState(false)
  const [state, setState] = useState<DieState>(loadDieState)
  const [rolls, setRolls] = useState(0)

  useEffect(() => {
    let live = true
    loadPrompts().then((r) => {
      if (!live) return
      setAll(r.rows)
      setOffline(r.offline)
    })
    return () => {
      live = false
    }
  }, [])

  const pool = useMemo(() => (all ?? []).filter((p) => matchesPrompt(p, state.filters)), [all, state.filters])
  const shown = all?.find((p) => p.id === state.current) ?? null

  const commit = (next: DieState) => {
    setState(next)
    saveDieState(next)
  }
  const roll = () => {
    const p = rollPrompt(pool, state.history)
    if (!p) return
    setRolls((n) => n + 1)
    commit({ ...state, history: pushHistory(state.history, p.id), current: p.id })
  }
  const setFilter = (patch: Partial<DieState['filters']>) => commit({ ...state, filters: { ...state.filters, ...patch } })
  const filtered = state.filters.depth || state.filters.mood || state.filters.time

  const writeAbout = () => {
    if (!shown) return
    const prompt: PromptHandoff = { text: shown.text, track_hint: shown.track_hint }
    navigate('/write/new', { state: { prompt } })
  }

  const empty = all !== null && all.length === 0
  const nothingFits = all !== null && all.length > 0 && pool.length === 0

  return (
    <section className="card die-card" aria-labelledby="die-h">
      <div className="die-top">
        <span className="die-mark"><BrassDie rolls={rolls} /></span>
        <div className="die-body">
          <h2 id="die-h">A prompt, if you want one</h2>
          {shown ? (
            <p className="die-prompt" dir="auto" aria-live="polite">{shown.text}</p>
          ) : (
            <p className="die-prompt die-prompt-empty">
              {empty
                ? offline ? "Prompts load once you're online." : 'No prompts yet.'
                : 'Nothing is asked of you. Roll when you would like a way in.'}
            </p>
          )}
        </div>
      </div>

      <div className="die-filters" role="group" aria-label="Narrow the prompts">
        <select className="select" aria-label="Depth" value={state.filters.depth ?? ''} onChange={(e) => setFilter({ depth: (e.target.value || null) as PromptFilters['depth'] })}>
          <option value="">Any depth</option>
          {DEPTHS.map((d) => <option key={d} value={d}>{cap(d)}</option>)}
        </select>
        <select className="select" aria-label="Mood" value={state.filters.mood ?? ''} onChange={(e) => setFilter({ mood: (e.target.value || null) as PromptFilters['mood'] })}>
          <option value="">Any mood</option>
          {MOODS.map((m) => <option key={m} value={m}>{cap(m)}</option>)}
        </select>
        <select className="select" aria-label="Time of day" value={state.filters.time ?? ''} onChange={(e) => setFilter({ time: (e.target.value || null) as PromptFilters['time'] })}>
          <option value="">Any time</option>
          {TIMES.map((t) => <option key={t} value={t}>{cap(t)}</option>)}
        </select>
        {filtered && <button type="button" className="btn btn-quiet" onClick={() => commit({ ...state, filters: NO_FILTERS })}>Clear</button>}
      </div>
      {nothingFits && <p className="die-note" role="status">Nothing fits that mix yet. Loosen one.</p>}

      <div className="row">
        <button type="button" className="btn btn-tint" onClick={roll} disabled={pool.length === 0}>
          Roll for a prompt
        </button>
        {shown && <button type="button" className="btn btn-primary" onClick={writeAbout}>Write about this</button>}
      </div>
    </section>
  )
}
