import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/components.css'
import './styles/shell.css'
import { ThemeProvider } from './theme'
import { AuthProvider } from './auth'
import { App } from './App'
import { preview } from './lib/preview'

registerSW({ immediate: true })

async function boot() {
  // Dev server only: `/?preview=1` runs the whole app on sample data, no sign-in. Compiled out of production builds.
  if (import.meta.env.DEV) {
    const { maybeInstallPreview } = await import('./dev/previewBackend')
    await maybeInstallPreview()
  }
  const Badge = preview.Badge
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <AuthProvider>
          <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </ThemeProvider>
      {Badge && <Badge />}
    </StrictMode>,
  )
}

void boot()
