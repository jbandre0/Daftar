import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../auth'

export function RequireAuth() {
  const { session } = useAuth()
  if (session === undefined) return <p className="sr-only" role="status">Opening your desk…</p>
  if (!session) return <Navigate to="/welcome" replace />
  return <Outlet />
}
