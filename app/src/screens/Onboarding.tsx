import { Link } from 'react-router-dom'
import { Screen } from '../components/Screen'

export function Onboarding() {
  return (
    <Screen
      title="Welcome to Daftar"
      sub="The journal you actually own. Sign in with a magic link, name yourself, pick your tracks, and start writing."
      phase={1}
    >
      <Link className="btn btn-primary" to="/write">
        Start writing
      </Link>
    </Screen>
  )
}
