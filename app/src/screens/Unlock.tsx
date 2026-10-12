import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth'
import { writeState } from '../lib/account'
import { PRICE, pollUntil, startCheckout } from '../lib/licence'

/**
 * /unlock. The hosted checkout sends the buyer back here (`?paid=1`), and the webhook may land a moment later,
 * so this looks for the unlock for up to 60 seconds, then says plainly that it is still on its way.
 */
export function Unlock() {
  const { session, license, refresh } = useAuth()
  const [params] = useSearchParams()
  const returning = params.get('paid') === '1'
  const state = writeState(license)
  const unlocked = state === 'unlocked'
  const [waiting, setWaiting] = useState(returning && !unlocked)
  const [gaveUp, setGaveUp] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const latest = useRef(license)
  latest.current = license
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  useEffect(() => {
    if (!waiting) return
    const signal = { cancelled: false }
    void pollUntil(async () => {
      await refreshRef.current()
      return latest.current?.status === 'unlocked'
    }, { signal }).then((found) => {
      if (signal.cancelled) return
      setWaiting(false)
      setGaveUp(!found)
    })
    return () => {
      signal.cancelled = true
    }
  }, [waiting])

  // coming back to this tab after paying in another one
  useEffect(() => {
    if (unlocked) return
    const onShow = () => document.visibilityState === 'visible' && void refreshRef.current()
    document.addEventListener('visibilitychange', onShow)
    return () => document.removeEventListener('visibilitychange', onShow)
  }, [unlocked])

  const buy = () => {
    setProblem(null)
    if (startCheckout(session!.user.id) === 'unavailable') setProblem("Checkout isn't switched on here yet.")
  }

  if (unlocked) {
    return (
      <div className="screen">
        <h1 className="screen-title">Daftar is yours.</h1>
        <p className="screen-sub">Write as long as you like.</p>
        <p className="row">
          <Link className="btn btn-primary" to="/write">Write today</Link>
          <Link className="btn btn-tint" to="/settings">Settings</Link>
        </p>
      </div>
    )
  }

  return (
    <div className="screen">
      <h1 className="screen-title">Unlock Daftar</h1>
      <p className="screen-sub">{PRICE}, once. No subscription.</p>
      <div className="card stack">
        {waiting ? (
          <p role="status">Confirming your purchase…</p>
        ) : gaveUp ? (
          <>
            <p role="status">This is taking longer than usual. Your payment is safe, and this will update on its own once it arrives.</p>
            <p className="row"><button className="btn btn-tint" onClick={() => { setGaveUp(false); setWaiting(true) }}>Check again</button></p>
          </>
        ) : (
          <>
            <p>
              {state === 'readonly'
                ? 'Your page is open to read and export. Unlocking lets you write again.'
                : 'Unlocking keeps the page open to write, with room for your photos, for as long as you have it.'}
            </p>
            <p className="fine">Reading and export never depend on this. A refund returns the account to read-only; nothing you wrote is touched.</p>
            <p className="row"><button className="btn btn-primary" onClick={buy}>Unlock for {PRICE}</button></p>
            {problem && <p className="form-error" role="alert">{problem}</p>}
          </>
        )}
      </div>
    </div>
  )
}
