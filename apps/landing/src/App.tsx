import { useEffect, useRef, useState } from 'react'

/** Durées de chaque phase, en millisecondes. Cycle total ≈ 3,4 s. */
const PHASE_MS = { p1: 800, splash: 800, p2: 800, idle: 1000 } as const

type Phase = keyof typeof PHASE_MS

/** Demi-largeur de la fenêtre lumineuse qui glisse le long du faisceau. */
const HALF_WIDTH = 5

export default function App() {
  const [menuOpen, setMenuOpen] = useState(false)

  const pipelineRef = useRef<HTMLDivElement>(null)
  const nodeStackRef = useRef<HTMLDivElement>(null)
  const nodeXRef = useRef<HTMLDivElement>(null)
  const nodeShieldRef = useRef<HTMLDivElement>(null)
  const beamGlowRef = useRef<SVGPathElement>(null)
  const beamCoreRef = useRef<SVGPathElement>(null)
  const gradientRef = useRef<SVGLinearGradientElement>(null)
  const splashRef = useRef<HTMLDivElement>(null)

  function toggleMenu() {
    setMenuOpen((open) => {
      const next = !open
      document.body.style.overflow = next ? 'hidden' : ''
      return next
    })
  }

  useEffect(() => {
    const pipeline = pipelineRef.current
    const nodeStack = nodeStackRef.current
    const nodeX = nodeXRef.current
    const nodeShield = nodeShieldRef.current
    const beamGlow = beamGlowRef.current
    const beamCore = beamCoreRef.current
    const gradient = gradientRef.current
    const splash = splashRef.current

    if (
      !pipeline ||
      !nodeStack ||
      !nodeX ||
      !nodeShield ||
      !beamGlow ||
      !beamCore ||
      !gradient ||
      !splash
    ) {
      return
    }

    /**
     * Le tracé est recalculé depuis la position réelle des nœuds plutôt que
     * codé en dur : les tailles changent aux points de rupture, et un tracé
     * figé se décalerait des icônes.
     */
    function updatePath() {
      const pRect = pipeline!.getBoundingClientRect()
      const sRect = nodeStack!.getBoundingClientRect()
      const xRect = nodeX!.getBoundingClientRect()
      const shRect = nodeShield!.getBoundingClientRect()

      const startX = sRect.left + sRect.width / 2 - pRect.left
      const startY = sRect.top + sRect.height / 2 - pRect.top
      const midX = xRect.left + xRect.width / 2 - pRect.left
      const midY = xRect.top + xRect.height / 2 - pRect.top
      const endX = shRect.left + shRect.width / 2 - pRect.left
      const endY = shRect.top + shRect.height / 2 - pRect.top

      const d = `M ${startX},${startY} L ${midX},${midY} L ${endX},${endY}`
      beamGlow!.setAttribute('d', d)
      beamCore!.setAttribute('d', d)
    }

    updatePath()
    window.addEventListener('resize', updatePath)

    let phase: Phase = 'p1'
    let lastStateChange = performance.now()
    let frame = 0

    /** Fait glisser la fenêtre lumineuse en déplaçant les bornes du gradient. */
    function setBeamCenter(percentage: number) {
      const center = percentage * 100
      gradient!.setAttribute('x1', `${center - HALF_WIDTH}%`)
      gradient!.setAttribute('x2', `${center + HALF_WIDTH}%`)
      gradient!.setAttribute('y1', '0%')
      gradient!.setAttribute('y2', '0%')
    }

    /**
     * Masque le faisceau pendant l'éclaboussure : on le coupe net plutôt que
     * de le laisser traverser l'onde, sinon les deux se superposent.
     * À la réapparition, la lueur reprend son opacité de repos définie en CSS.
     */
    function setBeamVisible(visible: boolean) {
      beamGlow!.style.opacity = visible ? '' : '0'
      beamCore!.style.opacity = visible ? '1' : '0'
    }

    function tick(now: number) {
      const elapsed = now - lastStateChange

      if (phase === 'p1') {
        const p = Math.min(elapsed / PHASE_MS.p1, 1) * 0.5
        setBeamCenter(p)
        nodeStack!.classList.toggle('active', p < 0.4)

        if (elapsed >= PHASE_MS.p1) {
          nodeStack!.classList.remove('active')
          setBeamVisible(false)
          splash!.classList.add('animate')
          phase = 'splash'
          lastStateChange = now
        }
      } else if (phase === 'splash') {
        if (elapsed >= PHASE_MS.splash) {
          splash!.classList.remove('animate')
          setBeamVisible(true)
          phase = 'p2'
          lastStateChange = now
        }
      } else if (phase === 'p2') {
        const p = 0.5 + Math.min(elapsed / PHASE_MS.p2, 1) * 0.5
        setBeamCenter(p)
        nodeShield!.classList.toggle('active', p > 0.6)

        if (elapsed >= PHASE_MS.p2) {
          nodeShield!.classList.remove('active')
          phase = 'idle'
          lastStateChange = now
        }
      } else if (elapsed >= PHASE_MS.idle) {
        phase = 'p1'
        lastStateChange = now
      }

      frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)

    return () => {
      window.removeEventListener('resize', updatePath)
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <>
      <nav>
        <span className="nav-logo">Xero</span>

        <button
          className={`menu-toggle${menuOpen ? ' active' : ''}`}
          onClick={toggleMenu}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          <span />
          <span />
        </button>

        <div className={`nav-menu${menuOpen ? ' active' : ''}`}>
          <ul className="nav-links">
            <li>
              <a href="#">Method</a>
            </li>
            <li>
              <a href="#">Pricing</a>
            </li>
            <li>
              <a href="#">Docs</a>
            </li>
          </ul>

          <div className="nav-actions">
            <a href="#" className="btn-login">
              Log in
            </a>
            <a href="#" className="btn-signup">
              Sign up
            </a>
          </div>
        </div>
      </nav>

      <section className="hero-card">
        <div className="hero-grid" />

        <div className="icon-pipeline" ref={pipelineRef}>
          <svg className="beam-svg">
            <defs>
              <filter id="glow">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
              <linearGradient
                id="beam-gradient"
                gradientUnits="userSpaceOnUse"
                ref={gradientRef}
              >
                <stop offset="0%" stopColor="#b04090" stopOpacity="0" />
                <stop offset="20%" stopColor="#b04090" stopOpacity="0.8" />
                <stop offset="50%" stopColor="#fff" stopOpacity="1" />
                <stop offset="80%" stopColor="#c8a0e0" stopOpacity="0.8" />
                <stop offset="100%" stopColor="#c8a0e0" stopOpacity="0" />
              </linearGradient>
            </defs>

            <path
              ref={beamGlowRef}
              className="beam-path-glow"
              fill="none"
              stroke="url(#beam-gradient)"
              strokeWidth="2"
              filter="url(#glow)"
            />
            <path
              ref={beamCoreRef}
              className="beam-path-core"
              fill="none"
              stroke="url(#beam-gradient)"
              strokeWidth="0.8"
            />
          </svg>

          <div
            className="icon-node node-light-right"
            id="node-stack"
            ref={nodeStackRef}
          >
            <svg viewBox="0 0 24 24">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </div>

          <div className="pipeline-line" />

          <div className="pipeline-center">
            <div className="splash" ref={splashRef} />
            <div className="icon-node-center" id="node-x" ref={nodeXRef}>
              <XeroMark />
            </div>
          </div>

          <div className="pipeline-line right" />

          <div
            className="icon-node node-light-left"
            id="node-shield"
            ref={nodeShieldRef}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <polyline points="9 12 11 14 15 10" />
            </svg>
          </div>
        </div>

        <div className="hero-content">
          <h1 className="hero-heading">
            The simple way
            <strong>encryption your data</strong>
          </h1>
          <p className="hero-sub">
            Fully managed data encrypting service and annotation
            <br />
            platform for teams of all industries.
          </p>
          <a href="#" className="btn-cta">
            Get Started
          </a>
        </div>
      </section>

      <div className="brands">
        <div className="brand-item">
          <svg viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="currentColor" />
            <path fill="var(--bg)" d="M8 9h8v2H8zm0 4h6v2H8z" />
          </svg>
          Expedia
        </div>

        <div className="brand-item">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="7" r="4" />
            <circle cx="5" cy="16" r="3.5" />
            <circle cx="19" cy="16" r="3.5" />
          </svg>
          asana
        </div>

        <div className="brand-item">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <polyline points="4 8 20 8" />
            <polyline points="4 12 12 12" />
            <polyline points="4 16 20 16" />
          </svg>
          zenefits
        </div>

        <div className="brand-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="15.5" cy="8.5" r="2.5" fill="currentColor" stroke="none" />
            <circle cx="8.5" cy="8.5" r="2" />
            <path d="M8.5 10.5v4" />
            <path d="M10.5 8.5h2.5" />
            <circle cx="8.5" cy="17" r="3" />
          </svg>
          HubSp<span className="hubspot-dot" />t
        </div>

        <div className="brand-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3v18" />
            <path d="M3 12h18" />
            <path d="M5.6 5.6l12.8 12.8" />
            <path d="M18.4 5.6L5.6 18.4" />
          </svg>
          loom
        </div>
      </div>
    </>
  )
}

/**
 * Marque « X » du centre de la pipeline — un X géométrique dont les branches
 * sont entaillées, pour qu'il reste lisible à 28 px comme à 64 px.
 */
function XeroMark() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M6 4h7.6l6.4 9.1L26.4 4H34l-10.3 14.4L34.6 36H27l-7-10.2L13 36H5.4l10.9-17.6L6 4zm5.9 3.2l8.1 11.3-8.7 14h3.3l7.4-10.9 7.5 10.9h3.3l-9.2-14 8.4-11.3h-3.2L20 16.6 12.9 7.2H11.9z" />
      <path d="M20 21.4l2.1 3-2.1 3.1-2.1-3.1 2.1-3z" />
    </svg>
  )
}
