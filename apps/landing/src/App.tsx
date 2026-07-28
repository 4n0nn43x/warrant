import { useEffect, useState } from 'react'
import Landing from './Landing'
import Dashboard from './dashboard/Dashboard'

/**
 * Routeur minimal par fragment d'URL.
 *
 * Pas de dépendance de routage : deux vues, et le hash suffit. Il a même un
 * avantage ici — la page se sert en fichiers statiques sans configuration
 * serveur, ce qui compte pour un déploiement qu'un jury doit pouvoir ouvrir
 * sans rien installer.
 */
export default function App() {
  const [route, setRoute] = useState(() => window.location.hash)

  useEffect(() => {
    const onChange = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  if (route.startsWith('#/dashboard') || route.startsWith('#/w/')) {
    return <Dashboard route={route} />
  }
  return <Landing />
}
