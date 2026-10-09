import { Navigate, Route, Routes } from 'react-router-dom'
import { Shell } from './components/Shell'
import { Onboarding } from './screens/Onboarding'
import { Desk } from './screens/Desk'
import { Write } from './screens/Write'
import { Browse } from './screens/Browse'
import { Read } from './screens/Read'
import { Chapters } from './screens/Chapters'
import { Letters } from './screens/Letters'
import { Vault } from './screens/Vault'
import { Settings } from './screens/Settings'

export function App() {
  return (
    <Routes>
      <Route path="/welcome" element={<Onboarding />} />
      <Route element={<Shell />}>
        <Route index element={<Desk />} />
        <Route path="write" element={<Write />} />
        <Route path="browse" element={<Browse />} />
        <Route path="read" element={<Read />} />
        <Route path="chapters" element={<Chapters />} />
        <Route path="letters" element={<Letters />} />
        <Route path="vault" element={<Vault />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
