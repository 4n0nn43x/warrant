import { useEffect, useState } from 'react'
import './styles.css'
import {
  ESCROW,
  SEPOLIA,
  addressUrl,
  chainName,
  formatUsdc,
  loadWarrants,
  shortHash,
  stakeWeightedScore,
  timeAgo,
  txUrl,
  type Check,
  type LoadResult,
  type Source,
  type Warrant,
} from './data'

export default function App() {
  const [route, setRoute] = useState(() => window.location.hash)
  const [data, setData] = useState<LoadResult | null>(null)

  useEffect(() => {
    const onChange = () => setRoute(window.location.hash)
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  useEffect(() => {
    let alive = true
    loadWarrants().then((d) => alive && setData(d))
    return () => {
      alive = false
    }
  }, [])

  const detailId = route.startsWith('#/warrant/') ? route.slice(10) : null
  const warrant = detailId ? data?.warrants.find((w) => w.id === detailId) : undefined

  return (
    <>
      <TopBar />
      <main className="wrap">
        {!data ? (
          <p className="page-sub">Loading…</p>
        ) : detailId ? (
          <WarrantDetail warrant={warrant} id={detailId} source={data.source} />
        ) : (
          <Overview data={data} />
        )}
        <footer className="foot">
          Warrant guarantees outcome conformance, not decision quality. Every
          verdict is an on-chain read at a pinned block and can be replayed by
          anyone.
        </footer>
      </main>
    </>
  )
}

function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a href="#/" className="brand">
          Warrant<span>Explorer</span>
        </a>
        <nav>
          <a href="#/">Warrants</a>
          <a
            href={addressUrl(SEPOLIA, ESCROW)}
            target="_blank"
            rel="noreferrer"
          >
            Escrow contract
          </a>
        </nav>
        <span className="net-badge">{chainName(SEPOLIA)}</span>
      </div>
    </header>
  )
}

function SourceBanner({ source, error }: { source: Source; error?: string }) {
  if (source === 'gateway') return null

  if (source === 'chain') {
    return (
      <div className="banner">
        <strong>Gateway offline.</strong> These warrants were rebuilt from the
        escrow's own events, read directly from an RPC. Nothing here is cached
        or canned — the contract is the record. Action categories and full
        check details are the one thing only the Gateway can add.
      </div>
    )
  }

  return (
    <div className="banner">
      <strong>No source reachable.</strong> Neither the Gateway nor the RPC
      answered, so this page has nothing to show. It will not invent warrants to
      fill the gap.
      {error ? <div className="banner-detail">{error}</div> : null}
    </div>
  )
}

function Overview({ data }: { data: LoadResult }) {
  const { warrants, stats, source, error } = data
  const score = stakeWeightedScore(stats)

  return (
    <>
      <h1 className="page-title">Warrants</h1>
      <p className="page-sub">
        Bonded executions settled through KeeperHub, with the on-chain verdict
        that closed each one.
      </p>

      <SourceBanner source={source} error={error} />

      <div className="card">
        <div className="stats">
          <Stat label="Settled" value={String(stats.honored + stats.slashed)} />
          <Stat label="Slashed" value={String(stats.slashed)} />
          <Stat label="Capital at risk" value={`${formatUsdc(stats.totalAtRisk)} USDC`} />
          <Stat
            label="Stake-weighted score"
            value={score === null ? 'n/a' : `${(score * 100).toFixed(1)}%`}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <span>Latest warrants</span>
          <span className="card-note">{warrants.length} total</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Warrant ID</th>
              <th>Category</th>
              <th className="hide-sm">Age</th>
              <th>Bond</th>
              <th>Verdict</th>
              <th className="hide-sm">Settlement</th>
            </tr>
          </thead>
          <tbody>
            {warrants.map((w) => (
              <tr key={w.id}>
                <td>
                  <a href={`#/warrant/${w.id}`} className="mono">
                    {shortHash(w.id)}
                  </a>
                </td>
                <td className="mono">{w.category}</td>
                <td className="hide-sm num">{timeAgo(w.openedAt)}</td>
                <td className="num">{formatUsdc(w.bond)} USDC</td>
                <td>
                  <StatusBadge status={w.status} />
                  {w.sponsored && (
                    <>
                      {' '}
                      <span className="badge badge-plain">sponsored</span>
                    </>
                  )}
                </td>
                <td className="hide-sm">
                  {w.settlementTx ? (
                    <a
                      href={txUrl(w.chainId, w.settlementTx)}
                      target="_blank"
                      rel="noreferrer"
                      className="mono"
                    >
                      {shortHash(w.settlementTx, 8, 6)}
                    </a>
                  ) : (
                    <span className="mono">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: Warrant['status'] }) {
  const cls =
    status === 'Slashed'
      ? 'badge-fail'
      : status === 'Honored'
        ? 'badge-ok'
        : status === 'Open'
          ? 'badge-warn'
          : 'badge-plain'
  return <span className={`badge ${cls}`}>{status}</span>
}

function WarrantDetail({
  warrant: w,
  id,
  source,
}: {
  warrant: Warrant | undefined
  id: string
  source: Source
}) {
  if (!w) {
    return (
      <>
        <a href="#/" className="back">
          ← Back to warrants
        </a>
        <h1 className="page-title">Warrant not found</h1>
        <p className="page-sub mono">{id}</p>
      </>
    )
  }

  const slashed = w.status === 'Slashed'

  return (
    <>
      <a href="#/" className="back">
        ← Back to warrants
      </a>
      <h1 className="page-title">Warrant</h1>
      <p className="page-sub mono">{w.id}</p>

      <SourceBanner source={source} />

      <div className="card">
        <div className="card-head">Overview</div>
        <dl>
          <Row label="Status">
            <StatusBadge status={w.status} />
            {w.sponsored && (
              <>
                {' '}
                <span className="badge badge-plain">gas sponsored by KeeperHub</span>
              </>
            )}
          </Row>
          <Row label="Action category">
            <span className="mono">{w.category}</span>
            <div className="hint">
              Derived from the calldata, never declared by the agent.
            </div>
          </Row>
          <Row label="Bond">
            {formatUsdc(w.bond)} USDC
            {w.refunded && (
              <div className="hint">
                Refunded {formatUsdc(w.refunded)} · fee {formatUsdc(w.fee ?? '0')}
              </div>
            )}
            {slashed && (
              <div className="hint">
                Transferred in full to the beneficiary. No fee is taken on a
                slash — slashing earns Warrant nothing.
              </div>
            )}
          </Row>
          <Row label="Agent">
            <a
              href={addressUrl(w.chainId, w.agent)}
              target="_blank"
              rel="noreferrer"
              className="mono"
            >
              {w.agent}
            </a>
          </Row>
          <Row label="Beneficiary">
            <a
              href={addressUrl(w.chainId, w.beneficiary)}
              target="_blank"
              rel="noreferrer"
              className="mono"
            >
              {w.beneficiary}
            </a>
          </Row>
          <Row label="Network">{chainName(w.chainId)}</Row>
        </dl>
      </div>

      <div className="card">
        <div className="card-head">
          <span>Post-condition checks</span>
          <span className="card-note">
            {(w.checks ?? []).filter((c) => !c.pass).length} failed of{' '}
            {(w.checks ?? []).length}
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th />
              <th>Check</th>
              <th>Expected vs observed</th>
            </tr>
          </thead>
          <tbody>
            {(w.checks ?? []).map((c, i) => (
              <CheckRow key={i} check={c} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Without the pinned block and the RPC, a verdict is only our word for
          it. With them, anyone can redo the read and get the same answer. */}
      <div className="card">
        <div className="card-head">
          <span>Replay</span>
          <span className="card-note">deterministic, reproducible by anyone</span>
        </div>
        <dl>
          <Row label="Evaluated at block">
            <span className="mono">{w.evaluatedAtBlock ?? '—'}</span>
          </Row>
          <Row label="RPC endpoint">
            <span className="mono">{w.rpcUrl ?? '—'}</span>
            <div className="hint">
              Independent of KeeperHub. Using the same provider to execute and
              to judge would make the verdict circular.
            </div>
          </Row>
          {w.executionId && (
            <Row label="KeeperHub execution">
              <span className="mono">{w.executionId}</span>
            </Row>
          )}
          {w.conditionHash && (
            <Row label="conditionHash">
              <span className="mono">{w.conditionHash}</span>
            </Row>
          )}
          {w.actionHash && (
            <Row label="actionHash">
              <span className="mono">{w.actionHash}</span>
            </Row>
          )}
          {w.fundingRef && (
            <Row label="fundingRef">
              <a
                href={txUrl(w.chainId, w.fundingRef)}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {w.fundingRef}
              </a>
              <div className="hint">Settlement tx that funded the bond.</div>
            </Row>
          )}
        </dl>
      </div>

      <div className="card">
        <div className="card-head">Transactions</div>
        <dl>
          {w.openTx && (
            <Row label="Open">
              <a
                href={txUrl(w.chainId, w.openTx)}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {w.openTx}
              </a>
            </Row>
          )}
          {w.settlementTx && (
            <Row label={slashed ? 'Slash' : 'Honor'}>
              <a
                href={txUrl(w.chainId, w.settlementTx)}
                target="_blank"
                rel="noreferrer"
                className="mono"
              >
                {w.settlementTx}
              </a>
            </Row>
          )}
        </dl>
      </div>
    </>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function CheckRow({ check: c }: { check: Check }) {
  return (
    <tr className={`check-row${c.pass ? '' : ' check-fail-bg'}`}>
      <td className={c.pass ? 'mark-ok' : 'mark-fail'}>{c.pass ? '✓' : '✗'}</td>
      <td className="mono">{c.kind}</td>
      <td>
        <div className="cmp">
          <span className="cmp-label">Expected</span>
          <span className="mono">{c.expected}</span>
          <span className="cmp-label">Observed</span>
          <span className={`mono${c.pass ? '' : ' val-bad'}`}>{c.observed}</span>
        </div>
      </td>
    </tr>
  )
}
