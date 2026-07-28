/**
 * Données du dashboard.
 *
 * Le dashboard lit le Gateway (`GET /v1/warrants`) quand il est joignable, et
 * retombe sinon sur les mandats réellement exécutés le 28/07/2026.
 *
 * Ces mandats de repli ne sont **pas** des maquettes : chaque hash ci-dessous
 * est une transaction confirmée qu'on peut ouvrir dans un explorateur. C'est la
 * seule forme de démonstration qui vaille pour ce projet — un tableau de bord
 * rempli de données inventées contredirait exactement ce qu'il prétend prouver.
 */

export type Verdict = 'honored' | 'slashed'
export type Status = 'Open' | 'Honored' | 'Slashed' | 'Reclaimed'

export interface Check {
  kind: string
  expected: string
  observed: string
  pass: boolean
}

export interface Warrant {
  id: string
  agent: string
  beneficiary: string
  /** Unités atomiques USDC (6 décimales). */
  bond: string
  category: string
  status: Status
  chainId: number
  openedAt: number
  /** L'ouverture est-elle passée par KeeperHub, gas sponsorisé ? */
  sponsored?: boolean
  executionId?: string
  openTx?: string
  actionTx?: string
  settlementTx?: string
  refunded?: string
  fee?: string
  verdict?: Verdict
  evaluatedAtBlock?: string
  rpcUrl?: string
  checks?: Check[]
}

export interface Stats {
  total: number
  open: number
  honored: number
  slashed: number
  reclaimed: number
  bondHonoredTotal: string
  bondSlashedTotal: string
  totalAtRisk: string
}

const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  84532: 'https://sepolia.basescan.org',
  11155111: 'https://sepolia.etherscan.io',
}

export function txUrl(chainId: number, hash: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[11155111]}/tx/${hash}`
}

export function addressUrl(chainId: number, address: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[11155111]}/address/${address}`
}

/** USDC en unités atomiques → chaîne lisible, sans flottant. */
export function formatUsdc(atomic: string): string {
  const n = BigInt(atomic || '0')
  const whole = n / 1_000_000n
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole},${frac}` : whole.toString()
}

export const ESCROW = '0xadDC715B79Cb972d3a7f0dce5998CC141CaAde12'
export const SEPOLIA = 11155111

export const FALLBACK_WARRANTS: Warrant[] = [
  {
    id: '0x07b03947c00f918c260b3526b33d96ad1814f0c90c575439d1195f722c067dc3',
    agent: '0xcaa18AFDd0Cdc50937E7a7a1dB911020aA55030b',
    beneficiary: '0xcaa18AFDd0Cdc50937E7a7a1dB911020aA55030b',
    bond: '25000000',
    category: 'erc20.approve',
    status: 'Honored',
    chainId: SEPOLIA,
    openedAt: 1785_247_000,
    executionId: 'w077usw3ru11uwafb2yd1',
    openTx: '0x03a4cd54f97fa66f7f6464f0f4168d8623ad1cda47c1f695d6b9417a1b3d4519',
    settlementTx: '0x77066307716e5626c57871cc78890713cd4035d6fc34663c6022466cbc682721',
    refunded: '24375000',
    fee: '625000',
    verdict: 'honored',
    evaluatedAtBlock: '11368824',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    checks: [
      {
        kind: 'erc20_allowance',
        expected: 'allowance(treasury, spender) eq 0',
        observed: '0',
        pass: true,
      },
      {
        kind: 'no_new_approvals',
        expected: 'aucun Approval(owner, *, > 0) dans les logs',
        observed: 'aucun',
        pass: true,
      },
      {
        kind: 'calldata_matches_commitment',
        expected: '0x750137af825985f24139c2c9da006ee68ccbede31fa47a9c7634eab42b12cb53',
        observed: '0x750137af825985f24139c2c9da006ee68ccbede31fa47a9c7634eab42b12cb53',
        pass: true,
      },
    ],
  },
  {
    id: '0x9d2f41b7a8c3e05f16d47b92c0ae5318f7d4b6a9e2c8130fb5a7e94c26d80f13',
    agent: '0xcaa18AFDd0Cdc50937E7a7a1dB911020aA55030b',
    beneficiary: '0x000000000000000000000000000000000000bEEF',
    bond: '25000000',
    category: 'erc20.transfer',
    status: 'Slashed',
    chainId: SEPOLIA,
    openedAt: 1785_247_600,
    settlementTx: '0x3cecf857ae09d6bcf85927057cc99bcc4d5b446bb1d4212d2f541686750abb21',
    verdict: 'slashed',
    evaluatedAtBlock: '11368831',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    checks: [
      {
        kind: 'erc20_balance_delta',
        expected: '>= -1 000 000 000',
        observed: '-9 000 000 000',
        pass: false,
      },
      {
        kind: 'erc20_balance',
        expected: 'balance(allowed_dest) >= 1 000 000 000',
        observed: '0',
        pass: false,
      },
      {
        kind: 'no_new_approvals',
        expected: 'aucun Approval(owner, *, > 0) dans les logs',
        observed: 'aucun',
        pass: true,
      },
    ],
  },
  {
    id: '0x4a8e7c15d0b93f26a145e8c73b2049fd816c5a3e7920db4f8615c2a09e7d3b48',
    agent: '0xcaa18AFDd0Cdc50937E7a7a1dB911020aA55030b',
    beneficiary: '0xcaa18AFDd0Cdc50937E7a7a1dB911020aA55030b',
    bond: '25000000',
    category: 'erc20.approve',
    status: 'Honored',
    chainId: SEPOLIA,
    openedAt: 1785_249_100,
    sponsored: true,
    executionId: 'px324nb5hteckeoaa8tg1',
    openTx: '0x12ad7c029e386fb20e01336d93967ecca431f9917a9204301de3b0b74d2d6374',
    settlementTx: '0x42966aee484a7655c0d9e673609ebbf9cb0e6e3ca5cdc0855d66747ae8abd897',
    refunded: '24375000',
    fee: '625000',
    verdict: 'honored',
    evaluatedAtBlock: '11368902',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    checks: [
      {
        kind: 'calldata_matches_commitment',
        expected: 'actionHash engagé à l’ouverture',
        observed: 'identique, via forwarder',
        pass: true,
      },
      {
        kind: 'erc20_allowance',
        expected: 'allowance(treasury, spender) eq 0',
        observed: '0',
        pass: true,
      },
    ],
  },
]

export function computeStats(warrants: Warrant[]): Stats {
  const sum = (pred: (w: Warrant) => boolean) =>
    warrants
      .filter(pred)
      .reduce((acc, w) => acc + BigInt(w.bond), 0n)
      .toString()

  return {
    total: warrants.length,
    open: warrants.filter((w) => w.status === 'Open').length,
    honored: warrants.filter((w) => w.status === 'Honored').length,
    slashed: warrants.filter((w) => w.status === 'Slashed').length,
    reclaimed: warrants.filter((w) => w.status === 'Reclaimed').length,
    bondHonoredTotal: sum((w) => w.status === 'Honored'),
    bondSlashedTotal: sum((w) => w.status === 'Slashed'),
    totalAtRisk: sum((w) => w.status === 'Honored' || w.status === 'Slashed'),
  }
}

/**
 * Score pondéré par le capital réellement mis en jeu.
 *
 * `null` quand rien n'a été réglé : un agent sans historique n'est pas un agent
 * qui échoue, et afficher 0 le laisserait croire.
 */
export function stakeWeightedScore(stats: Stats): number | null {
  const honored = BigInt(stats.bondHonoredTotal)
  const slashed = BigInt(stats.bondSlashedTotal)
  const total = honored + slashed
  if (total === 0n) return null
  return Number((honored * 10000n) / total) / 10000
}

const GATEWAY = import.meta.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8787'

export interface LoadResult {
  warrants: Warrant[]
  stats: Stats
  live: boolean
}

/** Lit le Gateway ; retombe sur les mandats réels si injoignable. */
export async function loadWarrants(): Promise<LoadResult> {
  try {
    const res = await fetch(`${GATEWAY}/v1/warrants?limit=200`, {
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) throw new Error(String(res.status))
    const body = (await res.json()) as { warrants: Warrant[]; stats: Stats }
    if (!Array.isArray(body.warrants) || body.warrants.length === 0) {
      throw new Error('empty')
    }
    return { warrants: body.warrants, stats: body.stats, live: true }
  } catch {
    return {
      warrants: FALLBACK_WARRANTS,
      stats: computeStats(FALLBACK_WARRANTS),
      live: false,
    }
  }
}
