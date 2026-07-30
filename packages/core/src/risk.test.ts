/**
 * Tests du pricer et de la génération de post-condition.
 *
 * `bond = clamp(minBond, riskBps × notionalUSD, maxBond)`, en `bigint`, sur
 * unités atomiques USDC. Le premier test rejoue la thèse du projet côté prix :
 * une catégorie déclarée n'achète pas un tarif.
 */

import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { classify } from './classifier.js'
import {
  DEFAULT_MIN_HEALTH_FACTOR,
  PolicyError,
  buildConditionSpec,
} from './policy.js'
import { validateConditionSpec } from './dsl.js'
import { loadRegistry, mainnetRegistryRef } from './registry.js'
import { RiskError, bondFor, clamp, priceRisk } from './risk.js'
import {
  MAX_CHECKS,
  type ActionSpec,
  type Address,
  type Check,
  type Classification,
  type Hex,
  type Policy,
} from './types.js'

const REGISTRY = loadRegistry()
const REF = mainnetRegistryRef()

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address
const TREASURY = '0x1111111111111111111111111111111111111111' as Address
const PAYROLL = '0x2222222222222222222222222222222222222222' as Address
const EXECUTOR = '0x3333333333333333333333333333333333333333' as Address
const ATTACKER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address
const SHITCOIN = '0x9999999999999999999999999999999999999999' as Address

const POLICY: Policy = {
  beneficiary: TREASURY,
  treasury: TREASURY,
  minBond: '5000000', //     5 USDC
  maxBond: '500000000', // 500 USDC
  duration: 3600,
  categories: {
    'erc20.transfer': {
      riskBps: 200,
      allowedDest: [PAYROLL],
      maxOutflow: '250000000',
    },
    'erc20.approve': { riskBps: 5, allowedDest: [PAYROLL], maxOutflow: '0' },
    'aavev3.repay': { riskBps: 25 },
    'aavev3.supply': { riskBps: 25 },
    'aavev3.withdraw': { riskBps: 50, allowedDest: [TREASURY] },
    'aavev3.borrow': { riskBps: 100, allowedDest: [TREASURY] },
  },
}

function transferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    args: [to, amount],
  })
}

function approveCalldata(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'approve',
        inputs: [{ type: 'address' }, { type: 'uint256' }],
        outputs: [{ type: 'bool' }],
        stateMutability: 'nonpayable',
      },
    ],
    args: [spender, amount],
  })
}

function aaveCalldata(
  name: 'supply' | 'withdraw' | 'borrow' | 'repay',
  args: readonly unknown[],
): Hex {
  const inputs = {
    supply: ['address', 'uint256', 'address', 'uint16'],
    withdraw: ['address', 'uint256', 'address'],
    borrow: ['address', 'uint256', 'uint256', 'uint16', 'address'],
    repay: ['address', 'uint256', 'uint256', 'address'],
  }[name]
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name,
        inputs: inputs.map((type) => ({ type })),
        outputs: [],
        stateMutability: 'nonpayable',
      },
    ],
    args: args as never,
  })
}

function action(over: Partial<ActionSpec> = {}): ActionSpec {
  return {
    version: 1,
    chainId: 1,
    target: USDC_ETH,
    value: '0',
    calldata: transferCalldata(PAYROLL, 100_000_000n),
    registryRef: REF,
    ...over,
  }
}

/** Classification fabriquée à la main, pour tester le pricer isolément. */
function fake(
  category: Classification['category'],
  notionalUSD: string,
  params: Record<string, string> = {},
): Classification {
  return {
    category,
    notionalUSD,
    registryRef: REF,
    params: {
      chainId: '1',
      // `target` est toujours présent dans une classification `unknown` réelle
      // (classifier.ts) : c'est le contrat appelé, et la post-condition de
      // repli s'en sert comme surveillance minimale.
      target: USDC_ETH,
      token: USDC_ETH,
      to: PAYROLL,
      amount: '1000000',
      ...params,
    },
  }
}

function kinds(checks: Check[]): string[] {
  return checks.map((c) => c.kind)
}

function find<K extends Check['kind']>(
  checks: Check[],
  kind: K,
): Extract<Check, { kind: K }>[] {
  return checks.filter((c) => c.kind === kind) as Extract<Check, { kind: K }>[]
}

// ─────────────────────────────────────────────────────────────────────────────
// LE test, côté tarif
// ─────────────────────────────────────────────────────────────────────────────

describe('une catégorie déclarée n\'achète pas un tarif', () => {
  it("déclarer 'allowance_revoke' en exécutant un transfer donne la caution ET la post-condition du transfert", () => {
    const requete = {
      ...action({ calldata: transferCalldata(ATTACKER, 10_000_000_000n) }),
      category: 'allowance_revoke', // ce que l'agent prétend
      riskBps: 5, // le tarif qu'il espère
      bond: '5000000',
    } as unknown as ActionSpec

    const quote = priceRisk(classify(requete, REGISTRY), POLICY)

    // Tarif du transfert : 200 bps × 10 000 $ = 200 $ — pas les 5 $ demandés.
    expect(quote.category).toBe('erc20.transfer')
    expect(quote.riskBps).toBe(200)
    expect(quote.notionalUSD).toBe('10000000000')
    expect(quote.bond).toBe('200000000')

    // Post-condition du transfert, destination issue de l'allowlist.
    expect(kinds(quote.conditionSpec.checks)).toEqual([
      'erc20_balance_delta',
      'erc20_balance_delta',
      'no_new_approvals',
    ])
    expect(
      find(quote.conditionSpec.checks, 'erc20_balance_delta')[1]!.account,
    ).toBe(PAYROLL)
    // Et surtout : rien de la politique de révocation d'allowance.
    expect(kinds(quote.conditionSpec.checks)).not.toContain('erc20_allowance')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// clamp
// ─────────────────────────────────────────────────────────────────────────────

describe('bond = clamp(minBond, riskBps × notionalUSD, maxBond)', () => {
  it('valeur intermédiaire : le produit brut', () => {
    // 200 bps × 1 000 $ = 20 $, entre 5 $ et 500 $.
    const q = priceRisk(fake('erc20.transfer', '1000000000'), POLICY)
    expect(q.bond).toBe('20000000')
    expect(q.rationale).toContain('200 bps')
  })

  it('borne basse : le plancher minBond s\'applique', () => {
    // 200 bps × 1 $ = 0,02 $ → plancher 5 $.
    const q = priceRisk(fake('erc20.transfer', '1000000'), POLICY)
    expect(q.bond).toBe(POLICY.minBond)
    expect(q.rationale).toContain('plancher')
  })

  it('borne haute : le plafond maxBond s\'applique', () => {
    // 200 bps × 1 000 000 $ = 20 000 $ → plafond 500 $.
    const q = priceRisk(fake('erc20.transfer', '1000000000000'), POLICY)
    expect(q.bond).toBe(POLICY.maxBond)
    expect(q.rationale).toContain('plafond')
  })

  it('notionnel nul : plancher, jamais zéro', () => {
    expect(priceRisk(fake('erc20.transfer', '0'), POLICY).bond).toBe(
      POLICY.minBond,
    )
  })

  it('exactement aux bornes', () => {
    // 200 bps × 250 $ = 5 $ = minBond.
    expect(bondFor(fake('erc20.transfer', '250000000'), POLICY)).toBe(5_000_000n)
    // 200 bps × 25 000 $ = 500 $ = maxBond.
    expect(bondFor(fake('erc20.transfer', '25000000000'), POLICY)).toBe(
      500_000_000n,
    )
  })

  it('clamp est un clamp', () => {
    expect(clamp(5n, 1n, 10n)).toBe(5n)
    expect(clamp(5n, 7n, 10n)).toBe(7n)
    expect(clamp(5n, 99n, 10n)).toBe(10n)
  })

  it('minBond > maxBond est une erreur, pas un silence', () => {
    const casse: Policy = { ...POLICY, minBond: '10', maxBond: '1' }
    expect(() => priceRisk(fake('erc20.transfer', '0'), casse)).toThrowError(
      RiskError,
    )
  })

  it('riskBps invalide est une erreur', () => {
    const casse: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: -1, maxOutflow: '1' },
      },
    }
    expect(() => priceRisk(fake('erc20.transfer', '1000'), casse)).toThrowError(
      RiskError,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Arithmétique entière
// ─────────────────────────────────────────────────────────────────────────────

describe('arithmétique en bigint, jamais en flottant', () => {
  it('un notionnel au-delà de Number.MAX_SAFE_INTEGER reste exact', () => {
    const enorme = (2n ** 200n).toString(10)
    const q = priceRisk(fake('erc20.transfer', enorme), POLICY)
    expect(q.notionalUSD).toBe(enorme)
    expect(q.bond).toBe(POLICY.maxBond)
    expect(q.bond).not.toContain('e')
  })

  it('la caution est toujours une chaîne décimale entière', () => {
    for (const notional of ['1', '333333333', '1000000007']) {
      const bond = priceRisk(fake('erc20.transfer', notional), POLICY).bond
      expect(bond).toMatch(/^[0-9]+$/)
    }
  })

  it('la division en bps tronque vers le bas, de façon déterministe', () => {
    // 5 bps × 1,999999 $ = 0,00099... → 999 unités atomiques avant clamp.
    const politique: Policy = { ...POLICY, minBond: '0' }
    expect(bondFor(fake('erc20.approve', '1999999'), politique)).toBe(999n)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le repli du pricer
// ─────────────────────────────────────────────────────────────────────────────

describe('unknown coûte le maximum', () => {
  it('catégorie unknown → maxBond, quel que soit le notionnel', () => {
    for (const notional of ['0', '1', '999999999999']) {
      const q = priceRisk(fake('unknown', notional), POLICY)
      expect(q.bond).toBe(POLICY.maxBond)
      expect(q.rationale).toContain('unknown')
    }
  })

  it('un couple absent du registre est facturé maxBond de bout en bout', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    expect(c.category).toBe('unknown')
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('une catégorie connue mais absente de la politique → maxBond, pas minBond', () => {
    const partielle: Policy = {
      ...POLICY,
      categories: { 'erc20.transfer': POLICY.categories['erc20.transfer']! },
    }
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(c.category).toBe('aavev3.repay')
    expect(() => priceRisk(c, partielle)).toThrowError(PolicyError)
    expect(bondFor(c, partielle)).toBe(BigInt(POLICY.maxBond))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Post-conditions générées
// ─────────────────────────────────────────────────────────────────────────────

describe('la politique génère la post-condition', () => {
  it('erc20.transfer : les trois checks normatifs de docs/13 § 5, plus le delta de destination', () => {
    const c = classify(action(), REGISTRY)
    const spec = buildConditionSpec(c, POLICY)

    expect(spec.version).toBe(1)
    expect(spec.chainId).toBe(1)
    expect(spec.evaluateAt).toBe('tx')
    expect(spec.confirmations).toBe(12) // L1

    const [borne] = find(spec.checks, 'erc20_balance_delta')
    expect(borne).toMatchObject({
      token: USDC_ETH,
      account: TREASURY,
      op: 'gte',
      value: '-250000000', // la borne de la POLITIQUE, pas le montant du calldata
    })

    // Le montant arrive sur la destination de l'allowlist — en delta, dérivé
    // des logs `Transfer`, jamais en solde absolu (voir B1 plus bas).
    expect(find(spec.checks, 'erc20_balance_delta')[1]).toMatchObject({
      token: USDC_ETH,
      account: PAYROLL,
      op: 'gte',
      value: '100000000',
    })

    expect(find(spec.checks, 'no_new_approvals')[0]).toMatchObject({
      owner: TREASURY,
      tokens: [USDC_ETH],
    })
  })

  it("la borne de sortie ne peut pas être gonflée par le calldata", () => {
    const petit = buildConditionSpec(
      classify(action({ calldata: transferCalldata(PAYROLL, 1n) }), REGISTRY),
      POLICY,
    )
    const gros = buildConditionSpec(
      classify(
        action({ calldata: transferCalldata(PAYROLL, 10n ** 12n) }),
        REGISTRY,
      ),
      POLICY,
    )
    const borneDe = (s: typeof petit) =>
      find(s.checks, 'erc20_balance_delta')[0]!.value
    expect(borneDe(petit)).toBe('-250000000')
    expect(borneDe(gros)).toBe('-250000000')
  })

  it('une destination hors allowlist est remplacée par celle de la politique', () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 1_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const comptes = spec.checks.map((chk) => (chk as { account?: string }).account)
    expect(comptes).toContain(PAYROLL)
    expect(comptes).not.toContain(ATTACKER)
  })

  it('une destination listée est engagée telle quelle', () => {
    const AUTRE = '0x4444444444444444444444444444444444444444' as Address
    const politique: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [PAYROLL, AUTRE],
          maxOutflow: '250000000',
        },
      },
    }
    const c = classify(
      action({ calldata: transferCalldata(AUTRE, 1_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, politique)
    expect(find(spec.checks, 'erc20_balance_delta')[1]!.account).toBe(AUTRE)
  })

  it("maxOutflow '0' engage `0` et non `-0`, qui n'est pas un décimal canonique", () => {
    // « Aucune sortie tolérée » est la politique la plus stricte, et c'est le
    // défaut du Gateway. `-0` faisait échouer la validation de la ConditionSpec
    // qu'on venait de construire : toute quotation d'un erc20.transfer
    // classifié répondait 400. RFC 8785 impose de toute façon la même
    // sérialisation pour `0` et `-0`, donc `-0` n'aurait pas survécu au hachage.
    const stricte: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: 200, allowedDest: [PAYROLL], maxOutflow: '0' },
      },
    }
    const spec = buildConditionSpec(classify(action(), REGISTRY), stricte)
    const delta = find(spec.checks, 'erc20_balance_delta')[0]!
    expect(delta.value).toBe('0')
    expect(delta.value).not.toBe('-0')
    // Et la spec produite se valide elle-même.
    expect(() => validateConditionSpec(spec)).not.toThrow()
  })

  it('erc20.transfer sans maxOutflow est refusé : la borne doit venir de la politique', () => {
    const sansBorne: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': { riskBps: 200, allowedDest: [PAYROLL] },
      },
    }
    expect(() =>
      buildConditionSpec(classify(action(), REGISTRY), sansBorne),
    ).toThrowError(PolicyError)
  })

  it('erc20.approve : plafond d\'allowance, et zéro pour un spender hors allowlist', () => {
    const horsListe = classify(
      action({ calldata: approveCalldata(ATTACKER, 10n ** 30n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(horsListe, POLICY)
    expect(find(spec.checks, 'erc20_allowance')[0]).toMatchObject({
      token: USDC_ETH,
      owner: TREASURY,
      spender: ATTACKER,
      op: 'lte',
      value: '0',
    })
    // Une approbation ne déplace pas de fonds.
    expect(find(spec.checks, 'erc20_balance_delta')[0]).toMatchObject({
      account: TREASURY,
      op: 'gte',
      value: '0',
    })

    const listee = classify(
      action({ calldata: approveCalldata(PAYROLL, 1_000_000n) }),
      REGISTRY,
    )
    const politique: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.approve': {
          riskBps: 5,
          allowedDest: [PAYROLL],
          maxOutflow: '2000000',
        },
      },
    }
    expect(
      find(buildConditionSpec(listee, politique).checks, 'erc20_allowance')[0]!
        .value,
    ).toBe('2000000')
  })

  it('aavev3.* : health factor, et aucun nonce_advanced par défaut', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY, { executor: EXECUTOR })
    expect(kinds(spec.checks)).toEqual(['aave_health_factor'])
    expect(find(spec.checks, 'aave_health_factor')[0]).toMatchObject({
      pool: AAVE_POOL,
      user: TREASURY,
      op: 'gte',
      value: DEFAULT_MIN_HEALTH_FACTOR,
    })
  })

  it('aavev3.* : le seuil de health factor peut être durci par la politique', () => {
    const politique: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'aavev3.borrow': {
          riskBps: 100,
          allowedDest: [TREASURY],
          // Extension de politique, lue de façon défensive.
          minHealthFactor: '2000000000000000000',
        } as Policy['categories'][string],
      },
    }
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('borrow', [
          USDC_ETH,
          1_000_000n,
          2n,
          0,
          TREASURY,
        ]),
      }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(c, politique).checks, 'aave_health_factor')[0]!
        .value,
    ).toBe('2000000000000000000')
  })

  it("aavev3.withdraw : la destination du retrait vient aussi de l'allowlist", () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, ATTACKER]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const delta = find(spec.checks, 'erc20_balance_delta')[0]!
    expect(delta.account).toBe(TREASURY)
    expect(delta.value).toBe('5000000')
    expect(JSON.stringify(spec)).not.toContain(ATTACKER.slice(2))
  })

  it('unknown : post-condition générique, stricte, et décidable sur le seul receipt', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    const spec = buildConditionSpec(c, POLICY, { executor: EXECUTOR })

    // La cible de l'action non classifiée est surveillée d'office : c'est le
    // seul fait connu d'une action `unknown`.
    expect(kinds(spec.checks)).toEqual([
      'no_new_approvals',
      'erc20_balance_delta',
    ])
    expect(find(spec.checks, 'no_new_approvals')[0]).toMatchObject({
      owner: TREASURY,
      tokens: [SHITCOIN],
    })
    expect(find(spec.checks, 'erc20_balance_delta')[0]).toMatchObject({
      token: SHITCOIN,
      account: TREASURY,
      op: 'gte',
      value: '0', // aucune tolérance de sortie sur une action qu'on ne sait pas classer
    })

    // Les tokens surveillés de la politique s'ajoutent à la cible.
    const surveille = {
      ...POLICY,
      watchedTokens: [USDC_ETH],
    } as Policy
    const large = buildConditionSpec(c, surveille, { executor: EXECUTOR })
    expect(find(large.checks, 'no_new_approvals')[0]!.tokens).toEqual([
      SHITCOIN,
      USDC_ETH,
    ])
    expect(
      find(large.checks, 'erc20_balance_delta').map((d) => d.token),
    ).toEqual([SHITCOIN, USDC_ETH])
  })

  it('MAX_CHECKS est respecté, et calldata_matches_commitment est hors quota', () => {
    const actionHash =
      '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hex
    const cas: Classification[] = [
      classify(action(), REGISTRY),
      classify(
        action({ calldata: approveCalldata(PAYROLL, 1n) }),
        REGISTRY,
      ),
      classify(
        action({
          target: AAVE_POOL,
          calldata: aaveCalldata('withdraw', [USDC_ETH, 1n, TREASURY]),
        }),
        REGISTRY,
      ),
      classify(action({ target: SHITCOIN }), REGISTRY),
    ]
    for (const c of cas) {
      const nu = buildConditionSpec(c, POLICY)
      expect(nu.checks.length).toBeLessThanOrEqual(MAX_CHECKS)
      expect(nu.checks.length).toBeGreaterThan(0)

      const engage = buildConditionSpec(c, POLICY, { actionHash })
      expect(engage.checks.length).toBe(nu.checks.length + 1)
      expect(engage.checks.at(-1)).toEqual({
        kind: 'calldata_matches_commitment',
        actionHash,
      })
    }
  })

  it('confirmations par défaut : 12 sur L1, 3 sur L2', () => {
    const l1 = buildConditionSpec(classify(action(), REGISTRY), POLICY)
    expect(l1.confirmations).toBe(12)

    const l2 = buildConditionSpec(
      classify(action({ chainId: 8453, target: USDC_BASE }), REGISTRY),
      POLICY,
    )
    expect(l2.chainId).toBe(8453)
    expect(l2.confirmations).toBe(3)

    const force = buildConditionSpec(classify(action(), REGISTRY), POLICY, {
      confirmations: 1,
      evaluateAt: 'tx+1',
    })
    expect(force.confirmations).toBe(1)
    expect(force.evaluateAt).toBe('tx+1')
  })

  it('une classification sans chainId exploitable est refusée', () => {
    const orphelin: Classification = {
      category: 'erc20.transfer',
      params: { token: USDC_ETH, to: PAYROLL, amount: '1' },
      notionalUSD: '1',
      registryRef: REF,
    }
    expect(() => buildConditionSpec(orphelin, POLICY)).toThrowError(PolicyError)
    expect(() =>
      buildConditionSpec(orphelin, POLICY, { chainId: 1 }),
    ).not.toThrow()
  })

  it('le devis est reproductible', () => {
    const c = classify(action(), REGISTRY)
    expect(JSON.stringify(priceRisk(c, POLICY))).toBe(
      JSON.stringify(priceRisk(c, POLICY)),
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Un trou de politique est un refus d'ouvrir, jamais une post-condition
// permissive. La branche « politique sans allowedDest » est celle que prenait
// le binaire en production : elle n'était couverte par aucun test.
// ─────────────────────────────────────────────────────────────────────────────

/** La politique de référence, privée d'`allowedDest` sur une catégorie. */
function sansAllowlist(category: string, extra: object = {}): Policy {
  const cat = { ...POLICY.categories[category], ...extra } as Record<
    string,
    unknown
  >
  delete cat['allowedDest']
  return {
    ...POLICY,
    categories: {
      ...POLICY.categories,
      [category]: cat as Policy['categories'][string],
    },
  }
}

describe("allowedDest absent est un refus, pas un silence", () => {
  it("erc20.transfer sans allowedDest est refusé — le transfert détourné passait les trois checks restants", () => {
    // Adversaire 1 de docs/13 § 6 : 500 USDC vers une adresse arbitraire, sous
    // maxOutflow = 1000 USDC. Sans allowlist, les deux checks de destination
    // disparaissaient *silencieusement* ; il ne restait que « le trésor n'a pas
    // perdu plus de maxOutflow » et `no_new_approvals`, que ce transfert passe.
    // Verdict `honored`, caution rendue, réputation améliorée, fonds partis.
    const politique = sansAllowlist('erc20.transfer', {
      maxOutflow: '1000000000',
    })
    const detourne = classify(
      action({ calldata: transferCalldata(ATTACKER, 500_000_000n) }),
      REGISTRY,
    )
    expect(() => buildConditionSpec(detourne, politique)).toThrowError(
      PolicyError,
    )
    expect(() => buildConditionSpec(detourne, politique)).toThrowError(
      /allowedDest/,
    )
    // Et le refus remonte jusqu'au devis : pas de mandat ouvrable du tout.
    expect(() => priceRisk(detourne, politique)).toThrowError(PolicyError)
  })

  it('une allowlist vide vaut une allowlist absente', () => {
    const vide: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [],
          maxOutflow: '250000000',
        },
      },
    }
    expect(() =>
      buildConditionSpec(classify(action(), REGISTRY), vide),
    ).toThrowError(PolicyError)
  })

  it("erc20.approve sans allowedDest est refusé — sinon tout spender est allowlisté", () => {
    // `!cat.allowedDest` rendait `allowlisted` vrai pour n'importe qui :
    // l'attaquant héritait du plafond d'allowance de la politique au lieu de
    // zéro.
    const politique = sansAllowlist('erc20.approve', { maxOutflow: '1000000' })
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, 10n ** 30n) }),
      REGISTRY,
    )
    expect(() => buildConditionSpec(c, politique)).toThrowError(PolicyError)

    // Avec une allowlist, le spender hors liste est bien plafonné à zéro.
    expect(
      find(buildConditionSpec(c, POLICY).checks, 'erc20_allowance')[0]!.value,
    ).toBe('0')
  })

  for (const [nom, calldata] of [
    ['aavev3.withdraw', aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, ATTACKER])],
    ['aavev3.borrow', aaveCalldata('borrow', [USDC_ETH, 5_000_000n, 2n, 0, ATTACKER])],
  ] as const) {
    it(`${nom} sans allowedDest est refusé : un retrait est une sortie`, () => {
      const politique = sansAllowlist(nom)
      const c = classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
      expect(c.category).toBe(nom)
      expect(() => buildConditionSpec(c, politique)).toThrowError(PolicyError)
    })
  }

  it("aavev3.repay et supply ne sortent rien : elles n'exigent pas d'allowlist", () => {
    for (const [nom, calldata] of [
      ['aavev3.repay', aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY])],
      ['aavev3.supply', aaveCalldata('supply', [USDC_ETH, 1_000_000n, TREASURY, 0])],
    ] as const) {
      const c = classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
      expect(c.category).toBe(nom)
      // POLICY ne déclare pas d'allowedDest pour ces deux catégories.
      expect(() => buildConditionSpec(c, POLICY)).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Un check qui lève toujours n'est pas une garantie, c'est un remboursement
// automatique déguisé.
// ─────────────────────────────────────────────────────────────────────────────

/** Toutes les catégories, avec une classification réelle pour chacune. */
function toutesLesClassifications(): Classification[] {
  return [
    classify(action(), REGISTRY),
    classify(action({ calldata: approveCalldata(PAYROLL, 1n) }), REGISTRY),
    ...(
      [
        aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
        aaveCalldata('supply', [USDC_ETH, 1_000_000n, TREASURY, 0]),
        aaveCalldata('withdraw', [USDC_ETH, 1_000_000n, TREASURY]),
        aaveCalldata('borrow', [USDC_ETH, 1_000_000n, 2n, 0, TREASURY]),
      ] as const
    ).map((calldata) => classify(action({ target: AAVE_POOL, calldata }), REGISTRY)),
    classify(action({ target: SHITCOIN }), REGISTRY),
  ]
}

describe('une post-condition par défaut ne contient que des vérificateurs décidables', () => {
  it("aucune catégorie n'engage nonce_advanced ni native_balance_delta par défaut", () => {
    // `nonce_advanced` : sous sponsoring, `tx.from` est le relayer KeeperHub et
    // `checks/nonce.ts` lève `UnsupportedCheckError` (son docstring le dit :
    // « ne doit pas figurer dans les post-conditions par défaut »).
    // `native_balance_delta` : `checks/native.ts` refuse de deviner sans tracer,
    // et aucun tracer n'est câblé.
    // Les deux faisaient expirer le mandat vers `reclaim` : `unknown`, facturé
    // maxBond, était la catégorie dont la caution ne pouvait jamais être saisie.
    for (const c of toutesLesClassifications()) {
      const kindsVus = kinds(
        buildConditionSpec(c, POLICY, { executor: EXECUTOR }).checks,
      )
      expect(kindsVus).not.toContain('nonce_advanced')
      expect(kindsVus).not.toContain('native_balance_delta')
      expect(kindsVus.length).toBeGreaterThan(0)
    }
  })

  it('unknown : tous les checks engagés sont dérivés du receipt', () => {
    const DECIDABLES = ['no_new_approvals', 'erc20_balance_delta']
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    const spec = buildConditionSpec(c, {
      ...POLICY,
      watchedTokens: [USDC_ETH],
    } as Policy)
    for (const kind of kinds(spec.checks)) {
      expect(DECIDABLES).toContain(kind)
    }
    // La caution maximale est désormais adossée à quelque chose de saisissable.
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('unknown sans cible ni watchedTokens est refusé plutôt que vidé', () => {
    const orphelin: Classification = {
      category: 'unknown',
      params: { chainId: '1' },
      notionalUSD: '0',
      registryRef: REF,
    }
    expect(() => buildConditionSpec(orphelin, POLICY)).toThrowError(PolicyError)
  })

  it('unknown : trop de tokens surveillés est un refus explicite, pas une spec invalide', () => {
    const trop = {
      ...POLICY,
      watchedTokens: Array.from(
        { length: 8 },
        (_, i) => (`0x${String(i + 1).repeat(40)}` as Address),
      ),
    } as Policy
    expect(() =>
      buildConditionSpec(classify(action({ target: SHITCOIN }), REGISTRY), trop),
    ).toThrowError(/MAX_CHECKS|maximum/)
  })

  it("nonce_advanced n'apparaît que sur une politique non sponsorisée, et jamais en `gte 1`", () => {
    // `count(evalBlock) − count(txBlock − 1) >= 1` est vrai dès que le compte a
    // émis la transaction évaluée : une tautologie, donc zéro contrainte. La
    // forme normative de docs/07 § 2.8 est « exactement une transaction ».
    const nonSponsorise = { ...POLICY, unsponsoredExecution: true } as Policy
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 1_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, nonSponsorise, { executor: EXECUTOR })
    expect(find(spec.checks, 'nonce_advanced')[0]).toMatchObject({
      account: EXECUTOR,
      op: 'eq',
      value: '1',
    })
    // À défaut d'exécuteur connu, c'est le trésor qui est engagé.
    expect(
      find(buildConditionSpec(c, nonSponsorise).checks, 'nonce_advanced')[0]!
        .account,
    ).toBe(TREASURY)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// N'engager que ce qui est attribuable à la transaction de l'agent.
// ─────────────────────────────────────────────────────────────────────────────

describe('aucun solde absolu partagé dans une post-condition', () => {
  it("erc20.transfer n'engage plus erc20_balance(dest) : le bénéficiaire pouvait fabriquer la saisie", () => {
    // `balanceOf(dest)` est lu en fin de bloc. Si `dest` — adresse de
    // l'allowlist, donc du propriétaire du capital, ou hot wallet qui balaie
    // vers du cold storage — dépense après l'action et dans le même bloc, le
    // solde retombe sous `amount` et la caution est saisie, alors que le delta
    // jumeau prouve dans le même verdict que l'agent a fait ce qui était engagé.
    for (const c of [
      classify(action(), REGISTRY),
      classify(
        action({ calldata: transferCalldata(ATTACKER, 1_000_000n) }),
        REGISTRY,
      ),
    ]) {
      const spec = buildConditionSpec(c, POLICY)
      expect(kinds(spec.checks)).not.toContain('erc20_balance')
      // Le delta, lui, reste : il ne passe que si les fonds sont arrivés.
      expect(find(spec.checks, 'erc20_balance_delta')[1]).toMatchObject({
        account: PAYROLL,
        op: 'gte',
      })
    }
  })

  it('un auto-transfert vers le trésor allowlisté n\'est pas une saisie', () => {
    // `dest === treasury` : les fonds ne bougent pas, le delta s'annule dans les
    // logs (`from === to`). Exiger `>= amount` saisissait un transfert légitime.
    const versSoi: Policy = {
      ...POLICY,
      categories: {
        ...POLICY.categories,
        'erc20.transfer': {
          riskBps: 200,
          allowedDest: [TREASURY],
          maxOutflow: '250000000',
        },
      },
    }
    const c = classify(
      action({ calldata: transferCalldata(TREASURY, 100_000_000n) }),
      REGISTRY,
    )
    const deltas = find(buildConditionSpec(c, versSoi).checks, 'erc20_balance_delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[1]).toMatchObject({ account: TREASURY, op: 'gte', value: '0' })

    // Et le détournement reste bloqué : la destination engagée reste le trésor,
    // dont le delta vaudrait alors `-amount`, sous la borne `0`.
    const detourne = classify(
      action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(detourne, versSoi).checks, 'erc20_balance_delta')[1],
    ).toMatchObject({ account: TREASURY, value: '0' })
  })

  it("aavev3.withdraw vers le trésor engage bien `>= amount` : là, les fonds entrent", () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 5_000_000n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(
      find(buildConditionSpec(c, POLICY).checks, 'erc20_balance_delta')[0],
    ).toMatchObject({ account: TREASURY, op: 'gte', value: '5000000' })
  })

  it('toute post-condition produite se valide contre le DSL', () => {
    const politique = {
      ...POLICY,
      watchedTokens: [USDC_ETH],
      unsponsoredExecution: true,
    } as Policy
    for (const c of toutesLesClassifications()) {
      for (const p of [POLICY, politique]) {
        expect(() =>
          validateConditionSpec(buildConditionSpec(c, p, { executor: EXECUTOR })),
        ).not.toThrow()
      }
    }
  })
})
