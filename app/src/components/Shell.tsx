import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Parchment } from './Parchment'
import { useAuth } from '../auth'
import { Lamp, MagnifyingGlass, PencilSimple, Envelope, Vault as VaultIcon } from '@phosphor-icons/react'

const ICON = { size: 20, weight: 'light' as const }

export function Shell() {
  const { profile, session } = useAuth()
  const { pathname } = useLocation()
  const paper = /^(\/dev)?\/(write|read)(\/|$)/.test(pathname)
  const initial = (profile?.display_name || session?.user.email || '·').trim().charAt(0).toUpperCase()
  return (
    <div className="shell" data-surface={paper ? 'paper' : 'desk'}>
      <Parchment />
      <nav className="nav" aria-label="Main">
        <NavLink to="/" end>
          <Lamp {...ICON} aria-hidden />
          <span>Desk</span>
        </NavLink>
        <NavLink to="/browse">
          <MagnifyingGlass {...ICON} aria-hidden />
          <span>Browse</span>
        </NavLink>
        <NavLink to="/write" className="write">
          <span className="write-glow">
            <span className="write-diamond">
              <PencilSimple size={24} weight="light" aria-hidden />
            </span>
          </span>
          <span className="lbl">Write</span>
        </NavLink>
        <NavLink to="/letters">
          <Envelope {...ICON} aria-hidden />
          <span>Letters</span>
        </NavLink>
        <NavLink to="/vault">
          <VaultIcon {...ICON} aria-hidden />
          <span>Vault</span>
        </NavLink>
        <div className="rail-spacer" />
        <div className="account-wrap">
          <NavLink to="/settings" aria-label="Settings and account">
            <span className="account-initial">{initial}</span>
          </NavLink>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}
