import { Screen } from '../components/Screen'
import { useTheme } from '../theme'
import { useAuth } from '../auth'
import { settingsLine } from '../lib/licence'
import { writeState } from '../lib/account'
import { Link } from 'react-router-dom'
import { LanguageCard, TagsCard, TracksCard } from '../components/OrganizeSettings'

const TOKENS = [
  'desk', 'desk-raised', 'desk-line', 'page', 'page-line', 'ink', 'ink-soft', 'ash', 'ash-soft', 'flame', 'olive', 'seal',
]

export function Settings() {
  const { theme, setTheme, writing, setWriting } = useTheme()
  const { session, profile, license, signOut } = useAuth()
  const state = writeState(license)

  return (
    <Screen title="Settings" sub="Account and preferences.">
      <div className="stack">
        <div className="card">
          <h2>Account</h2>
          <p>
            {profile?.display_name ? `${profile.display_name} · ` : ''}
            {session?.user.email}
          </p>
          {license && (
            <p style={{ marginBlockStart: 'var(--sp-2)' }}>{settingsLine(license)}</p>
          )}
          <div className="row" style={{ marginBlockStart: 'var(--sp-4)' }}>
            {state !== 'unlocked' && state !== 'unknown' && <Link className="btn btn-tint" to="/unlock">Unlock Daftar</Link>}
            <button className="btn btn-quiet" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
        <TracksCard />
        <TagsCard />
        <LanguageCard />
        <div className="card">
          <h2>Writing style</h2>
          <p style={{ marginBlockEnd: 'var(--sp-4)' }}>
            Book is a warm reading serif, easy over long entries. Handwriting is a hairline script, lovely for a few lines and harder to read
            at length. Arabic always stays in Naskh.
          </p>
          <div className="seg" role="group" aria-label="Writing style">
            <button aria-pressed={writing === 'book'} onClick={() => setWriting('book')}>
              Book
            </button>
            <button aria-pressed={writing === 'hand'} onClick={() => setWriting('hand')}>
              Handwriting
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Theme</h2>
          <p style={{ marginBlockEnd: 'var(--sp-4)' }}>Lamplight is the desk at night. Daylight is the same desk by a window.</p>
          <div className="seg" role="group" aria-label="Theme">
            <button aria-pressed={theme === 'lamplight'} onClick={() => setTheme('lamplight')}>
              Lamplight
            </button>
            <button aria-pressed={theme === 'daylight'} onClick={() => setTheme('daylight')}>
              Daylight
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Colour tokens</h2>
          <div className="swatches">
            {TOKENS.map((t) => (
              <div className="swatch" key={t}>
                <i style={{ background: `var(--${t})` }} />
                <span>--{t}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <p className="stub-note">Reminders and account deletion arrive in phase 10.</p>
    </Screen>
  )
}
