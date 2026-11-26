import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Theme = 'lamplight' | 'daylight'
/** 'book' = Newsreader (default). print = Patrick Hand, notebook = Kalam, pen = Caveat, hand = Windsong (the most flourished). */
export type WritingStyle = 'book' | 'print' | 'notebook' | 'pen' | 'hand'
export const WRITING_STYLES: { id: WritingStyle; label: string }[] = [
  { id: 'book', label: 'Book' },
  { id: 'print', label: 'Print' },
  { id: 'notebook', label: 'Notebook' },
  { id: 'pen', label: 'Quick pen' },
  { id: 'hand', label: 'Flourish' },
]
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
    const v = localStorage.getItem(WRITE_KEY)
    return WRITING_STYLES.some((w) => w.id === v) ? (v as WritingStyle) : 'book'
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
