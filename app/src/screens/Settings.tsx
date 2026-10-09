import { Screen } from '../components/Screen'
import { useTheme } from '../theme'

const TOKENS = [
  'desk', 'desk-raised', 'desk-line', 'page', 'page-line', 'ink', 'ink-soft', 'ash', 'ash-soft', 'flame', 'olive', 'seal',
]

export function Settings() {
  const { theme, setTheme } = useTheme()
  return (
    <Screen title="Settings" sub="Account and preferences." phase={10}>
      <div className="stack">
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
    </Screen>
  )
}
