import { Link } from 'react-router-dom'
import { Screen } from '../components/Screen'

export function Desk() {
  return (
    <Screen title="Good evening" sub="The page is blank. That's allowed.">
      <div className="stack">
        <div className="card">
          <h2>Today</h2>
          <p>Today's entry, a prompt die, your last five entries, and a quiet backup line will live here.</p>
        </div>
        <div className="row">
          <Link className="btn btn-primary" to="/write">
            Write today
          </Link>
          <Link className="btn btn-quiet" to="/vault">
            Last backup: never
          </Link>
        </div>
      </div>
      <p className="stub-note">Arrives in phases 2, 5 and 8.</p>
    </Screen>
  )
}
