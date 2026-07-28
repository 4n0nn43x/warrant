import { useEffect, useState } from 'react'
import '../glass.css'
import './dashboard.css'
import {
  ESCROW,
  SEPOLIA,
  addressUrl,
  formatUsdc,
  loadWarrants,
  stakeWeightedScore,
  txUrl,
  type LoadResult,
  type Warrant,
} from './data'

export default function Dashboard({ route }: { route: string }) {
  const [data, setData] = useState<LoadResult | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    loadWarrants().then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [])

  // `#/w/<id>` déplie directement un mandat : chaque verdict a une URL propre,
  // ce qui permet de pointer un jury sur une saisie précise.
  useEffect(() => {
    if (route.startsWith('#/w/')) setOpenId(route.slice(4))
  }, [route])

  if (!data) {
    return (
      <div className="dash">
        <DashNav />
        <p className="dash-loading">Chargement des mandats…</p>
      </div>
    )
  }

  const { warrants, stats, live } = data
  const score = stakeWeightedScore(stats)

  return (
    <div className="dash">
      <DashNav />

      <header className="dash-head">
        <h1>Mandats réglés</h1>
        <p>
          Chaque verdict est une lecture onchain à bloc figé. Les liens mènent à
          la transaction, pas à une capture d’écran.
        </p>
        <div className="dash-source">
          <span className={`dot ${live ? 'dot-live' : 'dot-static'}`} />
          {live ? (
            <>Gateway en direct</>
          ) : (
            <>
              Gateway hors ligne — mandats réellement exécutés le 28/07/2026,
              vérifiables onchain
            </>
          )}
          <a
            href={addressUrl(SEPOLIA, ESCROW)}
            target="_blank"
            rel="noreferrer"
            className="dash-contract"
          >
            contrat ↗
          </a>
        </div>
      </header>

      <section className="stat-row">
        <Stat value={String(stats.honored + stats.slashed)} label="mandats réglés" />
        <Stat
          value={String(stats.slashed)}
          label="saisies réelles"
          tone={stats.slashed > 0 ? 'alert' : undefined}
        />
        <Stat value={`${formatUsdc(stats.totalAtRisk)} USDC`} label="capital mis en jeu" />
        <Stat
          value={score === null ? 'n/a' : `${(score * 100).toFixed(1)} %`}
          label="score pondéré par le capital"
        />
      </section>

      <section className="warrant-list">
        {warrants.map((w) => (
          <WarrantRow
            key={w.id}
            warrant={w}
            open={openId === w.id}
            onToggle={() => setOpenId(openId === w.id ? null : w.id)}
          />
        ))}
      </section>

      <footer className="dash-foot">
        Warrant garantit la conformité du résultat, pas la sagesse de la décision.
      </footer>
    </div>
  )
}

function DashNav() {
  return (
    <nav className="dash-nav">
      <a href="#/" className="nav-logo">
        Xero
      </a>
      <a href="#/" className="btn-login glass">
        ← Accueil
      </a>
    </nav>
  )
}

function Stat({
  value,
  label,
  tone,
}: {
  value: string
  label: string
  tone?: 'alert'
}) {
  return (
    <div className="stat glass">
      <span className={`stat-value${tone === 'alert' ? ' stat-alert' : ''}`}>
        {value}
      </span>
      <span className="stat-label">{label}</span>
    </div>
  )
}

function WarrantRow({
  warrant: w,
  open,
  onToggle,
}: {
  warrant: Warrant
  open: boolean
  onToggle: () => void
}) {
  const slashed = w.status === 'Slashed'

  return (
    <article className={`warrant glass${slashed ? ' warrant-slashed' : ''}`}>
      <button className="warrant-head" onClick={onToggle} aria-expanded={open}>
        <code className="warrant-id">{short(w.id)}</code>
        <span className="warrant-cat">{w.category}</span>
        <span className="warrant-bond">{formatUsdc(w.bond)} USDC</span>
        <span className={`badge ${slashed ? 'badge-slash' : 'badge-honor'}`}>
          {slashed ? 'saisi' : 'honoré'}
        </span>
        {w.sponsored && <span className="badge badge-sponsored">gas sponsorisé</span>}
        <span className={`chevron${open ? ' chevron-open' : ''}`}>›</span>
      </button>

      {open && (
        <div className="warrant-body">
          <div className="checks">
            {(w.checks ?? []).map((c, i) => (
              <div key={i} className={`check${c.pass ? '' : ' check-fail'}`}>
                <span className="check-mark">{c.pass ? '✓' : '✗'}</span>
                <div className="check-text">
                  <code className="check-kind">{c.kind}</code>
                  <div className="check-cmp">
                    <span className="check-label">attendu</span>
                    <code>{c.expected}</code>
                  </div>
                  <div className="check-cmp">
                    <span className="check-label">observé</span>
                    <code className={c.pass ? '' : 'check-bad'}>{c.observed}</code>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Ce bloc est l'argument central du produit : un verdict qu'un tiers
              peut refaire. Sans le bloc et le RPC, ce ne serait qu'une
              affirmation de notre part. */}
          <dl className="replay">
            <div>
              <dt>bloc d’évaluation</dt>
              <dd>
                <code>{w.evaluatedAtBlock ?? '—'}</code>
              </dd>
            </div>
            <div>
              <dt>RPC</dt>
              <dd>
                <code>{w.rpcUrl ?? '—'}</code>
              </dd>
            </div>
            {w.executionId && (
              <div>
                <dt>exécution KeeperHub</dt>
                <dd>
                  <code>{w.executionId}</code>
                </dd>
              </div>
            )}
            {w.refunded && (
              <div>
                <dt>remboursé / frais</dt>
                <dd>
                  <code>
                    {formatUsdc(w.refunded)} / {formatUsdc(w.fee ?? '0')} USDC
                  </code>
                </dd>
              </div>
            )}
          </dl>

          <div className="tx-links">
            {w.openTx && (
              <a href={txUrl(w.chainId, w.openTx)} target="_blank" rel="noreferrer">
                ouverture ↗
              </a>
            )}
            {w.settlementTx && (
              <a
                href={txUrl(w.chainId, w.settlementTx)}
                target="_blank"
                rel="noreferrer"
              >
                {slashed ? 'saisie ↗' : 'règlement ↗'}
              </a>
            )}
          </div>

          {slashed && (
            <p className="slash-note">
              La caution est partie <strong>intégralement</strong> au propriétaire
              du capital. Le protocole n’a rien prélevé — une saisie ne rapporte
              rien à Warrant.
            </p>
          )}
        </div>
      )}
    </article>
  )
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}
