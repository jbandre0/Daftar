import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { saveDisplayName } from '../lib/account'
import { useAuth } from '../auth'

type Step = 'email' | 'check' | 'name'

export function Onboarding() {
  const { session, profile, refresh } = useAuth()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // Signed in and named: straight to the desk.
  if (session && profile && profile.display_name) return <Navigate to="/" replace />
  // Signed in but unnamed: the name step.
  const showName = !!session && !!profile && !profile.display_name

  async function sendLink(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin + '/welcome' },
    })
    setBusy(false)
    if (error) setError("Couldn't send that. Check the address and try again.")
    else setStep('check')
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' })
    setBusy(false)
    if (error) setError("That code didn't work. It may have expired. Ask for a new one.")
  }

  async function saveName(e: FormEvent) {
    e.preventDefault()
    if (!session || !name.trim()) return
    setBusy(true)
    const { error } = await saveDisplayName(session.user.id, name)
    if (error) {
      setBusy(false)
      setError("Couldn't save that. Try again.")
      return
    }
    await refresh()
    navigate('/write', { replace: true })
  }

  return (
    <div className="screen auth">
      <h1 className="screen-title">Daftar</h1>
      <p className="screen-sub">The journal you actually own.</p>

      {showName ? (
        <form className="card stack" onSubmit={saveName}>
          <h2>What should we call you?</h2>
          <label className="field">
            <span className="sr-only">Your name</span>
            <input dir="auto" autoFocus autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !name.trim()}>
            Continue
          </button>
        </form>
      ) : step === 'email' ? (
        <form className="card stack" onSubmit={sendLink}>
          <h2>Sign in</h2>
          <p>No password. We'll email you a link and a six-digit code.</p>
          <label className="field">
            <span className="sr-only">Email address</span>
            <input type="email" required autoFocus autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !email}>
            Send my link
          </button>
          <p className="fine">Your trial runs for 21 days and starts when you sign in.</p>
        </form>
      ) : (
        <form className="card stack" onSubmit={verifyCode}>
          <h2>Check your email</h2>
          <p>
            We sent a link to <strong>{email}</strong>. Open it on this device, or type the six-digit code here. On an
            iPhone home-screen app, the code is the way in.
          </p>
          <label className="field">
            <span className="sr-only">Six-digit code</span>
            <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="row">
            <button className="btn btn-primary" disabled={busy || code.trim().length < 6}>
              Enter
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => { setStep('email'); setCode(''); setError('') }}>
              Use a different email
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
