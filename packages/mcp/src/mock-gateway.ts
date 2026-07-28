/**
 * Un Gateway en mémoire.
 *
 * Deux usages, et le second compte autant que le premier :
 *
 * - il sert de double aux tests du serveur MCP, qui n'ont ainsi besoin ni de
 *   réseau ni du paquet `@warrant/server` ;
 * - il permet à un builder de lancer le serveur MCP et de voir les quatre
 *   outils fonctionner **avant** d'avoir un Gateway, un wallet ou un RPC. La
 *   checklist DX vise « zéro à une transaction en moins de cinq minutes »
 *   (docs/09 § 8) ; l'essentiel des cinq minutes se perd d'ordinaire à câbler
 *   un backend pour découvrir que l'outil n'était pas celui qu'on croyait.
 *
 * Il ne simule **pas** la vérification de paiement : il l'accepte sur parole.
 * Aucun code de production ne doit en dépendre.
 */

import { actionHash, conditionHash, WarrantStatus, type ActionSpec, type Hex } from '@warrant/core'
import type {
  GatewayClient,
  ListWarrantsQuery,
  ListWarrantsResult,
  PaymentPayload,
  PaymentRequired,
  QuoteRequest,
  QuoteResult,
  RequestWarrantResult,
  WarrantRequest,
  WarrantView,
} from '@warrant/sdk'

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

/** Sélecteur → catégorie. Le même principe que le registre, en miniature. */
const CATEGORIES: Record<string, { category: QuoteResult['category']; riskBps: number }> = {
  '0xa9059cbb': { category: 'erc20.transfer', riskBps: 50 },
  '0x095ea7b3': { category: 'erc20.approve', riskBps: 150 },
  '0x573ade81': { category: 'aavev3.repay', riskBps: 25 },
  '0x617ba037': { category: 'aavev3.supply', riskBps: 25 },
  '0x69328dec': { category: 'aavev3.withdraw', riskBps: 100 },
  '0xa415bcad': { category: 'aavev3.borrow', riskBps: 200 },
}

/**
 * Notionnel dérivé du calldata — jamais déclaré.
 *
 * Approximation assumée : on lit le dernier mot de 32 octets et on suppose six
 * décimales. Le vrai Classifieur décode l'ABI (`@warrant/core`), mais le point
 * démontré est le même — la valeur vient du calldata, pas de la requête.
 */
function notionalFromCalldata(calldata: string): bigint {
  const body = calldata.slice(10)
  if (body.length < 64) return 0n
  return BigInt(`0x${body.slice(-64)}`) / 1_000_000n
}

function clamp(value: bigint, min: bigint, max: bigint): bigint {
  return value < min ? min : value > max ? max : value
}

export interface MockGatewayOptions {
  /** Bornes de caution, en unités atomiques USDC. */
  minBond?: bigint
  maxBond?: bigint
  /** Ressource annoncée dans le `PaymentRequired`. */
  resourceUrl?: string
  payTo?: string
  /** Durée du mandat, en secondes. */
  duration?: number
  /** `false` pour observer le chemin sans paiement de bout en bout. */
  requirePayment?: boolean
}

export interface MockGateway extends GatewayClient {
  /** Ce que le Gateway a réellement reçu — sert à prouver le nettoyage des entrées. */
  readonly seen: { actionSpecs: ActionSpec[]; payments: (PaymentPayload | undefined)[] }
  readonly warrants: Map<Hex, WarrantView>
}

export function createMockGateway(options: MockGatewayOptions = {}): MockGateway {
  const minBond = options.minBond ?? 1_000_000n
  const maxBond = options.maxBond ?? 100_000_000n
  const resourceUrl = options.resourceUrl ?? 'https://api.warrant.sh/v1/warrants'
  const payTo = options.payTo ?? '0x00000000000000000000000000000000000000a1'
  const duration = options.duration ?? 3600
  const requirePayment = options.requirePayment ?? true

  const seen = { actionSpecs: [] as ActionSpec[], payments: [] as (PaymentPayload | undefined)[] }
  const warrants = new Map<Hex, WarrantView>()
  let nonce = 0

  function price(actionSpec: ActionSpec): QuoteResult {
    const selector = actionSpec.calldata.slice(0, 10).toLowerCase()
    const known = CATEGORIES[selector]
    // `unknown` déclenche le repli le plus strict : ne pas savoir coûte cher.
    const category = known?.category ?? 'unknown'
    const riskBps = known?.riskBps ?? 500
    const notional = notionalFromCalldata(actionSpec.calldata)
    const bond = clamp((notional * BigInt(riskBps)) / 10_000n, minBond, maxBond)

    return {
      category,
      bond: bond.toString(),
      riskBps,
      notionalUSD: notional.toString(),
      conditionSpec: {
        version: 1,
        chainId: actionSpec.chainId,
        evaluateAt: 'tx+1',
        confirmations: 3,
        checks: [{ kind: 'calldata_matches_commitment', actionHash: actionHash(actionSpec) }],
      },
      rationale: `${category} à ${notional} USD, ${riskBps} bps, borné à [${minBond}, ${maxBond}].`,
    }
  }

  function challenge(quote: QuoteResult, actionSpec: ActionSpec): PaymentRequired {
    return {
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: {
        url: resourceUrl,
        description: `Bond for a KeeperHub-executed ${quote.category} action`,
        mimeType: 'application/json',
      },
      accepts: [
        {
          scheme: 'exact',
          network: `eip155:${actionSpec.chainId}`,
          amount: quote.bond,
          asset: USDC_BASE,
          payTo,
          maxTimeoutSeconds: 60,
          extra: { name: 'USDC', version: '2' },
        },
      ],
      extensions: {},
    }
  }

  return {
    seen,
    warrants,

    async quote(req: QuoteRequest): Promise<QuoteResult> {
      seen.actionSpecs.push(req.actionSpec)
      return price(req.actionSpec)
    },

    async requestWarrant(
      req: WarrantRequest,
      payment?: PaymentPayload,
    ): Promise<RequestWarrantResult> {
      seen.actionSpecs.push(req.actionSpec)
      seen.payments.push(payment)

      const quote = price(req.actionSpec)
      if (requirePayment && !payment) {
        return { status: 'payment-required', paymentRequired: challenge(quote, req.actionSpec) }
      }

      nonce += 1
      const id = `0x${nonce.toString(16).padStart(64, '0')}` as Hex
      const now = Math.floor(Date.now() / 1000)
      const view: WarrantView = {
        warrantId: id,
        agent: (payment?.payload as { authorization?: { from?: string } } | undefined)?.authorization
          ?.from as WarrantView['agent'] ?? ('0x' + '11'.repeat(20)) as WarrantView['agent'],
        beneficiary: req.beneficiary,
        bond: quote.bond,
        conditionHash: conditionHash(quote.conditionSpec),
        actionHash: actionHash(req.actionSpec),
        expiry: now + duration,
        openedAt: now,
        status: WarrantStatus.Open,
        category: quote.category,
        executionId: `exec_${nonce}`,
        actionSpec: req.actionSpec,
        conditionSpec: quote.conditionSpec,
        checks: [],
      }
      warrants.set(id, view)

      const settlement = payment
        ? {
            success: true,
            transaction: `0x${'ab'.repeat(32)}`,
            network: payment.accepted.network,
            payer: view.agent,
            amount: quote.bond,
          }
        : undefined

      const warrant = {
        warrantId: view.warrantId,
        executionId: view.executionId as string,
        conditionHash: view.conditionHash,
        actionHash: view.actionHash,
        expiry: view.expiry,
        bond: view.bond,
      }
      return settlement ? { status: 'opened', warrant, settlement } : { status: 'opened', warrant }
    },

    async getWarrant(warrantId: Hex): Promise<WarrantView | null> {
      return warrants.get(warrantId) ?? null
    },

    async listWarrants(query: ListWarrantsQuery): Promise<ListWarrantsResult> {
      const all = [...warrants.values()].filter((w) => {
        if (w.agent.toLowerCase() !== query.agent.toLowerCase()) return false
        if (query.category && w.category !== query.category) return false
        if (query.since !== undefined && w.openedAt < query.since) return false
        if (query.until !== undefined && w.openedAt > query.until) return false
        return true
      })

      const count = (s: WarrantStatus) => all.filter((w) => w.status === s).length
      const honored = count(WarrantStatus.Honored)
      const slashed = count(WarrantStatus.Slashed)
      const settled = honored + slashed

      return {
        warrants: all.slice(0, query.limit ?? 20),
        stats: {
          total: all.length,
          open: count(WarrantStatus.Open),
          honored,
          slashed,
          reclaimed: count(WarrantStatus.Reclaimed),
          totalBonded: all.reduce((acc, w) => acc + BigInt(w.bond), 0n).toString(),
          totalSlashed: all
            .filter((w) => w.status === WarrantStatus.Slashed)
            .reduce((acc, w) => acc + BigInt(w.bond), 0n)
            .toString(),
          honorRateBps: settled === 0 ? 0 : Math.round((honored / settled) * 10_000),
        },
      }
    },
  }
}
