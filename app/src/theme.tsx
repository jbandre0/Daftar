import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'lamplight' | 'daylight'
const KEY = 'daftar.theme'

const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null)

function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'daylight' ? 'daylight' : 'lamplight'
  } catch {
    return 'lamplight'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', theme === 'daylight' ? '#E9DFCB' : '#17110C')
  }, [theme])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      /* private mode: theme just won't persist */
    }
  }, [])

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme])
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}
