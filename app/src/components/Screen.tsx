import type { ReactNode } from 'react'

export function Screen({
  title,
  sub,
  phase,
  children,
}: {
  title: string
  sub: string
  phase?: number
  children?: ReactNode
}) {
  return (
    <div className="screen">
      <h1 className="screen-title">{title}</h1>
      <p className="screen-sub">{sub}</p>
      {children}
      {phase !== undefined && <p className="stub-note">Arrives in phase {phase}.</p>}
    </div>
  )
}
