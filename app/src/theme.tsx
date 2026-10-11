import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'lamplight' | 'daylight'
/** 'book' = Newsreader (default); 'hand' = Windsong, for short, personal entries. */
export type WritingStyle = 'book' | 'hand'
const KEY = 'daftar.theme'
const WRITE_KEY = 'daftar.writing'

const ThemeCtx = createContext<{
  theme: Theme
  setTheme: (t: Theme) => void
  writing: WritingStyle
  setWriting: (w: WritingStyle) => void
} | null>(null)

function readWriting(): WritingStyle {
  try {
    return localStorage.getItem(WRITE_KEY) === 'hand' ? 'hand' : 'book'
  } catch {
    return 'book'
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'daylight' ? 'daylight' : 'lamplight'
  } catch {
    return 'lamplight'
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(readTheme)
  const [writing, setWritingState] = useState<WritingStyle>(readWriting)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', theme === 'daylight' ? '#DCC79D' : '#1F150F')
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.write = writing
  }, [writing])

  const setWriting = useCallback((w: WritingStyle) => {
    setWritingState(w)
    try {
      localStorage.setItem(WRITE_KEY, w)
    } catch {
      /* private mode */
    }
  }, [])

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t)
    try {
      localStorage.setItem(KEY, t)
    } catch {
      /* private mode: theme just won't persist */
    }
  }, [])

  const value = useMemo(() => ({ theme, setTheme, writing, setWriting }), [theme, setTheme, writing, setWriting])
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeCtx)
  if (!ctx) throw new Error('useTheme outside ThemeProvider')
  return ctx
}
