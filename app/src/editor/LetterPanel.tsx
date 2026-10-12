import { useId, useState } from 'react'
import type { EntryContent } from '../lib/entries'
import { daysFromNow, earliestSealDay, isSealedNow, monthsFromNow, unlockLabel, unlockInstant, validSealDay } from '../lib/seal'

/**
 * The letter part of a page: who it is to, and the deliberate step of sealing it. Sealing asks for a day and says
 * plainly what it means; there is no way to open a sealed letter early. Once the day has come the letter is an
 * ordinary entry again and this panel just remembers when it was sealed and opened.
 */
export function LetterPanel({
  content, editable, onTo, onSeal,
}: {
  content: EntryContent
  editable: boolean
  onTo: (to: string) => void
  /** Seals the letter for the given day (YYYY-MM-DD). Returns a plain-words problem, or null when it worked. */
  onSeal: (day: string) => Promise<string | null>
}) {
  const toId = useId()
  const [confirming, setConfirming] = useState(false)
  const [day, setDay] = useState(() => monthsFromNow(12))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const opened = !!content.sealed && !isSealedNow(content)
  const hasText = content.body_text.trim().length > 0

  async function confirm() {
    if (!validSealDay(day)) {
      setProblem("Pick a day that hasn't come yet.")
      return
    }
    setBusy(true)
    setProblem(null)
    const p = await onSeal(day)
    setBusy(false)
    if (p) setProblem(p)
  }

  return (
    <div className="letter-panel">
      <label className="field-row" htmlFor={toId}>
        <span>To</span>
        <input
          id={toId}
          dir="auto"
          value={content.letter_to ?? ''}
          readOnly={!editable}
          maxLength={80}
          placeholder="Future me"
          onChange={(e) => onTo(e.target.value)}
        />
      </label>

      {opened && content.unlock_at && (
        <p className="meta letter-opened">This letter was sealed until {unlockLabel(content.unlock_at)}. That day has come, so it is open.</p>
      )}

      {!content.sealed && editable && !confirming && (
        <div className="row">
          <button type="button" className="btn btn-tint" disabled={!hasText} onClick={() => setConfirming(true)}>
            Seal this letter…
          </button>
          {!hasText && <span className="meta">Write something first.</span>}
        </div>
      )}

      {confirming && !content.sealed && (
        <div className="seal-confirm" role="group" aria-label="Seal this letter">
          <p>
            Sealed means hidden until the day you choose, not encrypted. You won't be able to open it, or change it, before then.
          </p>
          <label className="field-row">
            <span>Opens on</span>
            <input type="date" value={day} min={earliestSealDay()} onChange={(e) => setDay(e.target.value)} />
          </label>
          <div className="chip-row" aria-label="Quick choices">
            {[
              ['In a month', monthsFromNow(1)],
              ['In a year', monthsFromNow(12)],
              ['In five years', monthsFromNow(60)],
              ['Tomorrow', daysFromNow(1)],
            ].map(([label, d]) => (
              <button key={label} type="button" className="chip" aria-pressed={day === d} onClick={() => setDay(d)}>
                {label}
              </button>
            ))}
          </div>
          {problem && <p className="form-error" role="alert">{problem}</p>}
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || !validSealDay(day)} onClick={() => void confirm()}>
              {validSealDay(day) ? `Seal until ${unlockLabel(unlockInstant(day))}` : 'Pick a day'}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => { setConfirming(false); setProblem(null) }}>
              Not yet
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
