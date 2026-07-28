/**
 * Tests du classifieur.
 *
 * Le premier test de ce fichier est le test qui porte la thèse du projet : un
 * agent ne choisit pas sa catégorie de risque. Tout le reste vérifie que le
 * repli n'est jamais permissif.
 */

import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { canonicalize } from './canonical.js'
import { hashCanonical } from './hash.js'
import { ClassificationError, classify } from './classifier.js'
import { buildConditionSpec } from './policy.js'
import {
  RegistryError,
  assertRegistryConsistent,
  canonicalizeRegistry,
  loadRegistry,
  mainnetRegistryRef,
  registryRefOf,
  type RegistryFile,
} from './registry.js'
import { priceRisk } from './risk.js'
import type { ActionSpec, Address, Hex, Policy } from './types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REGISTRY = loadRegistry()
const REF = mainnetRegistryRef()

const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' as Address
const AAVE_POOL = '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2' as Address
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11' as Address

const TREASURY = '0x1111111111111111111111111111111111111111' as Address
const PAYROLL = '0x2222222222222222222222222222222222222222' as Address
const ATTACKER = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address
/** Token inconnu du registre : même sélecteur, autre cible. */
const SHITCOIN = '0x9999999999999999999999999999999999999999' as Address

const ERC20_ABI = [
  'function transfer(address,uint256)',
  'function approve(address,uint256)',
] as const

function transferCalldata(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'transfer',
        inputs: [
          { type: 'address', name: 'to' },
          { type: 'uint256', name: 'amount' },
        ],
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
        inputs: [
          { type: 'address', name: 'spender' },
          { type: 'uint256', name: 'amount' },
        ],
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

const POLICY: Policy = {
  beneficiary: TREASURY,
  treasury: TREASURY,
  minBond: '5000000', //   5 USDC
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

// ─────────────────────────────────────────────────────────────────────────────
// LE test
// ─────────────────────────────────────────────────────────────────────────────

describe('la catégorie est dérivée du calldata, jamais déclarée', () => {
  it("une requête déclarant 'allowance_revoke' avec un calldata de transfer est classée erc20.transfer, payée au tarif du transfert, et engagée sur la post-condition du transfert", () => {
    // Ce que l'agent — compromis par prompt injection — prétend faire, et ce
    // qu'il fait réellement. `ActionSpec` n'a volontairement aucun champ de
    // catégorie : le cast montre que même si un champ parasite arrivait, il
    // n'aurait aucun chemin vers la décision.
    const menteur = {
      ...action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      category: 'allowance_revoke',
      declaredNotionalUSD: '0',
      riskBps: 5,
      bond: '5000000',
    } as unknown as ActionSpec

    const classification = classify(menteur, REGISTRY)

    // 1. La catégorie vient du couple (chainId, target, selector).
    expect(classification.category).toBe('erc20.transfer')

    // 2. Le notionnel vient des arguments décodés : 100 USDC.
    expect(classification.notionalUSD).toBe('100000000')

    // 3. La caution est celle du transfert (200 bps × 100 $ = 2 $, remonté au
    //    plancher de 5 $), pas les 5 $ « bon marché » qu'il espérait obtenir
    //    d'une révocation d'allowance — et surtout pas un tarif choisi par lui.
    const quote = priceRisk(classification, POLICY)
    expect(quote.category).toBe('erc20.transfer')
    expect(quote.riskBps).toBe(200)
    expect(quote.bond).toBe('5000000')

    // 4. La post-condition est celle de la politique de transfert, et la
    //    destination engagée est celle de l'ALLOWLIST — pas celle du calldata.
    const engagedDest = quote.conditionSpec.checks
      .filter((c) => c.kind === 'erc20_balance')
      .map((c) => (c as { account: string }).account)
    expect(engagedDest).toEqual([PAYROLL])
    expect(JSON.stringify(quote.conditionSpec)).not.toContain(
      ATTACKER.slice(2),
    )
    expect(quote.conditionSpec.checks.map((c) => c.kind)).toEqual([
      'erc20_balance_delta',
      'erc20_balance',
      'erc20_balance_delta',
      'no_new_approvals',
    ])
  })

  it('la classification est identique que la requête porte ou non des champs déclaratifs', () => {
    const honnete = action()
    const bruite = {
      ...honnete,
      category: 'erc20.approve',
      notionalUSD: '1',
      urgency: 'high',
    } as unknown as ActionSpec

    expect(classify(bruite, REGISTRY)).toEqual(classify(honnete, REGISTRY))
  })

  it("le notionnel suit le montant du calldata, pas ce que la requête raconte", () => {
    const petit = classify(
      action({ calldata: transferCalldata(PAYROLL, 1_000_000n) }),
      REGISTRY,
    )
    const gros = classify(
      {
        ...action({ calldata: transferCalldata(PAYROLL, 1_000_000_000_000n) }),
        // Champ déclaratif parasite : sans effet, par construction.
        notionalUSD: '1',
      } as unknown as ActionSpec,
      REGISTRY,
    )
    expect(petit.notionalUSD).toBe('1000000')
    expect(gros.notionalUSD).toBe('1000000000000')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// La clé est le couple, pas le sélecteur
// ─────────────────────────────────────────────────────────────────────────────

describe('la clé est (chainId, target, selector)', () => {
  it("le même sélecteur sur deux cibles donne deux catégories", () => {
    const surUsdc = classify(action({ target: USDC_ETH }), REGISTRY)
    const surShitcoin = classify(action({ target: SHITCOIN }), REGISTRY)

    expect(surUsdc.category).toBe('erc20.transfer')
    expect(surShitcoin.category).toBe('unknown')
    expect(surUsdc.category).not.toBe(surShitcoin.category)
  })

  it('deux cibles peuvent porter deux catégories nommées différentes pour un même sélecteur', () => {
    const poolB = '0x3333333333333333333333333333333333333333' as Address
    const synthetique: RegistryFile = {
      version: 1,
      assets: {
        [`1:${USDC_ETH}`]: { symbol: 'USDC', decimals: 6, priceUSD: '1000000' },
      },
      entries: [
        {
          chainId: 1,
          target: AAVE_POOL,
          selector: '0x69328dec',
          category: 'aavev3.withdraw',
          signature: 'withdraw(address,uint256,address)',
          argNames: ['asset', 'amount', 'to'],
          targetAs: 'pool',
          amountArg: 'amount',
          assetArg: 'asset',
        },
        {
          chainId: 1,
          target: poolB,
          selector: '0x69328dec',
          category: 'aavev3.supply',
          signature: 'withdraw(address,uint256,address)',
          argNames: ['asset', 'amount', 'to'],
          targetAs: 'pool',
          amountArg: 'amount',
          assetArg: 'asset',
        },
      ],
    }
    assertRegistryConsistent(synthetique)

    const calldata = aaveCalldata('withdraw', [USDC_ETH, 10_000_000n, TREASURY])
    expect(
      classify(action({ target: AAVE_POOL, calldata }), synthetique).category,
    ).toBe('aavev3.withdraw')
    expect(
      classify(action({ target: poolB, calldata }), synthetique).category,
    ).toBe('aavev3.supply')
  })

  it('le même couple (target, selector) sur deux chaînes reste distinct', () => {
    const surBase = classify(
      action({ chainId: 8453, target: USDC_BASE }),
      REGISTRY,
    )
    expect(surBase.category).toBe('erc20.transfer')

    // L'USDC Base n'existe pas sur Ethereum : couple absent → `unknown`.
    const mauvaiseChaine = classify(
      action({ chainId: 1, target: USDC_BASE }),
      REGISTRY,
    )
    expect(mauvaiseChaine.category).toBe('unknown')
  })

  it("la cible est comparée sans tenir compte de la casse", () => {
    const checksum = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as Address
    const c = classify(action({ target: checksum }), REGISTRY)
    expect(c.category).toBe('erc20.transfer')
    expect(c.params['token']).toBe(USDC_ETH)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le repli n'est jamais permissif
// ─────────────────────────────────────────────────────────────────────────────

describe('le repli n\'est jamais permissif', () => {
  it('couple inconnu → catégorie unknown, notionnel nul, caution maximale', () => {
    const c = classify(action({ target: SHITCOIN }), REGISTRY)
    expect(c.category).toBe('unknown')
    expect(c.notionalUSD).toBe('0')
    expect(c.params['target']).toBe(SHITCOIN)
    expect(c.params['selector']).toBe('0xa9059cbb')

    const quote = priceRisk(c, POLICY)
    expect(quote.bond).toBe(POLICY.maxBond)
  })

  it('sélecteur inconnu sur une cible connue → unknown', () => {
    const c = classify(
      action({ target: USDC_ETH, calldata: '0xdeadbeef' }),
      REGISTRY,
    )
    expect(c.category).toBe('unknown')
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('calldata de moins de 4 octets → refus', () => {
    for (const calldata of ['0x', '0xa9', '0xa9059c'] as Hex[]) {
      expect(() => classify(action({ calldata }), REGISTRY)).toThrowError(
        ClassificationError,
      )
      try {
        classify(action({ calldata }), REGISTRY)
      } catch (err) {
        expect((err as ClassificationError).code).toBe('CALLDATA_TOO_SHORT')
      }
    }
  })

  it('calldata non hexadécimal → refus', () => {
    expect(() =>
      classify(action({ calldata: 'a9059cbb' as Hex }), REGISTRY),
    ).toThrowError(/hexadécimal/)
    expect(() =>
      classify(action({ calldata: '0xzzzzzzzz' as Hex }), REGISTRY),
    ).toThrowError(ClassificationError)
  })

  it('décodage ABI en échec → refus, jamais un repli sur unknown', () => {
    // Bon sélecteur, arguments tronqués.
    const tronque = ('0xa9059cbb' + '00'.repeat(31)) as Hex
    let code: string | undefined
    try {
      classify(action({ calldata: tronque }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('DECODE_FAILED')

    // Bon sélecteur, arguments surnuméraires.
    const trop = (transferCalldata(PAYROLL, 1n) + '00'.repeat(32)) as Hex
    expect(() => classify(action({ calldata: trop }), REGISTRY)).toThrowError(
      ClassificationError,
    )
  })

  it('routeur générique par la cible → refus', () => {
    let code: string | undefined
    try {
      classify(action({ target: MULTICALL3 }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('GENERIC_ROUTER')
  })

  it('sélecteur enveloppant → refus, quelle que soit la cible', () => {
    const enveloppes: Hex[] = [
      '0xac9650d8', // multicall(bytes[])
      '0x5ae401dc', // multicall(uint256,bytes[])
      '0x252dba42', // aggregate((address,bytes)[])
      '0x82ad56cb', // aggregate3((address,bool,bytes)[])
      '0x3593564c', // execute(bytes,bytes[],uint256) — Universal Router
      '0x09c5eabe', // execute(bytes)
      '0xb61d27f6', // execute(address,uint256,bytes)
      '0x8d80ff0a', // multiSend(bytes)
      '0x6a761202', // execTransaction(...)
    ]
    for (const selector of enveloppes) {
      const calldata = (selector + '00'.repeat(64)) as Hex
      let code: string | undefined
      try {
        classify(action({ target: SHITCOIN, calldata }), REGISTRY)
      } catch (err) {
        code = (err as ClassificationError).code
      }
      expect(code, `sélecteur ${selector}`).toBe('GENERIC_ROUTER')
    }
  })

  it("value > 0 sur une catégorie qui ne l'attend pas → refus", () => {
    let code: string | undefined
    try {
      classify(action({ value: '1' }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNEXPECTED_VALUE')

    // Y compris quand l'action n'est même pas classifiée.
    try {
      classify(action({ target: SHITCOIN, value: '1000000000000000000' }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNEXPECTED_VALUE')

    // value = "0" reste évidemment acceptable.
    expect(classify(action({ value: '0' }), REGISTRY).category).toBe(
      'erc20.transfer',
    )
  })

  it('value négative ou non numérique → refus', () => {
    expect(() => classify(action({ value: '-1' }), REGISTRY)).toThrowError(
      ClassificationError,
    )
    expect(() => classify(action({ value: 'beaucoup' }), REGISTRY)).toThrowError(
      ClassificationError,
    )
  })

  it('actif absent de la table de prix → refus, jamais un notionnel nul', () => {
    const calldata = aaveCalldata('supply', [
      SHITCOIN,
      10n ** 24n,
      TREASURY,
      0,
    ])
    let code: string | undefined
    try {
      classify(action({ target: AAVE_POOL, calldata }), REGISTRY)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('UNPRICEABLE_ASSET')
  })

  it('entrée de registre au sélecteur incohérent → refus', () => {
    // Registre fabriqué à la main, sélecteur menteur. `classify` recalcule.
    const menteur = {
      version: 1,
      entries: [
        {
          chainId: 1,
          target: USDC_ETH,
          selector: '0xa9059cbb',
          category: 'erc20.transfer',
          signature: 'approve(address,uint256)',
          argNames: ['spender', 'amount'],
          targetAs: 'token',
          amountArg: 'amount',
          assetDecimals: 6,
          assetPriceUSD: '1000000',
        },
      ],
    } as RegistryFile

    let code: string | undefined
    try {
      classify(action(), menteur)
    } catch (err) {
      code = (err as ClassificationError).code
    }
    expect(code).toBe('REGISTRY_INCONSISTENT')
    expect(() => assertRegistryConsistent(menteur)).toThrowError(RegistryError)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Décodage et notionnel
// ─────────────────────────────────────────────────────────────────────────────

describe('décodage des arguments et dérivation du notionnel', () => {
  it('erc20.transfer : arguments nommés, adresses en minuscules', () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 42_000_000n) }),
      REGISTRY,
    )
    expect(c.category).toBe('erc20.transfer')
    expect(c.params).toEqual({
      to: ATTACKER,
      amount: '42000000',
      token: USDC_ETH,
      chainId: '1',
    })
    expect(c.notionalUSD).toBe('42000000') // 42 USDC = 42,00 $
    expect(c.registryRef).toBe(REF)
  })

  it('erc20.approve : révocation à zéro, notionnel nul', () => {
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, 0n) }),
      REGISTRY,
    )
    expect(c.category).toBe('erc20.approve')
    expect(c.params['spender']).toBe(ATTACKER)
    expect(c.params['amount']).toBe('0')
    expect(c.notionalUSD).toBe('0')
  })

  it("erc20.approve : une allowance infinie produit un notionnel énorme, donc la caution maximale", () => {
    const max = 2n ** 256n - 1n
    const c = classify(
      action({ calldata: approveCalldata(ATTACKER, max) }),
      REGISTRY,
    )
    expect(BigInt(c.notionalUSD)).toBe(max) // × 1 $ / 1e6 décimales
    expect(priceRisk(c, POLICY).bond).toBe(POLICY.maxBond)
  })

  it('aavev3.repay : signature et arguments Aave V3', () => {
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('repay', [USDC_ETH, 5_000_000n, 2n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(c.category).toBe('aavev3.repay')
    expect(c.params).toEqual({
      asset: USDC_ETH,
      amount: '5000000',
      interestRateMode: '2',
      onBehalfOf: TREASURY,
      pool: AAVE_POOL,
      chainId: '1',
    })
    expect(c.notionalUSD).toBe('5000000')
  })

  it('aavev3.supply / withdraw / borrow', () => {
    const supply = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('supply', [WETH, 10n ** 18n, TREASURY, 0]),
      }),
      REGISTRY,
    )
    expect(supply.category).toBe('aavev3.supply')
    // 1 WETH à 3 000 $, en virgule fixe 1e6.
    expect(supply.notionalUSD).toBe('3000000000')

    const withdraw = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('withdraw', [USDC_ETH, 250_000_000n, TREASURY]),
      }),
      REGISTRY,
    )
    expect(withdraw.category).toBe('aavev3.withdraw')
    expect(withdraw.params['to']).toBe(TREASURY)

    const borrow = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('borrow', [
          USDC_ETH,
          1_000_000_000n,
          2n,
          0,
          TREASURY,
        ]),
      }),
      REGISTRY,
    )
    expect(borrow.category).toBe('aavev3.borrow')
    expect(borrow.notionalUSD).toBe('1000000000')
  })

  it('le notionnel est arrondi vers le bas, en entier, jamais en flottant', () => {
    // 1 wei de WETH à 3 000 $ vaut 3e-15 $ : strictement inférieur à l'unité
    // atomique, donc 0. Aucun flottant n'apparaît.
    const c = classify(
      action({
        target: AAVE_POOL,
        calldata: aaveCalldata('supply', [WETH, 1n, TREASURY, 0]),
      }),
      REGISTRY,
    )
    expect(c.notionalUSD).toBe('0')
    expect(c.notionalUSD).not.toContain('e')
    expect(c.notionalUSD).not.toContain('.')
  })

  it('classify est déterministe', () => {
    const spec = action()
    const a = classify(spec, REGISTRY)
    const b = classify(spec, REGISTRY)
    expect(a).toEqual(b)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Le registre lui-même
// ─────────────────────────────────────────────────────────────────────────────

describe('registre de classification', () => {
  it('le fichier du dépôt est cohérent : chaque sélecteur est recalculé depuis sa signature', () => {
    expect(() => assertRegistryConsistent(REGISTRY)).not.toThrow()
  })

  it('les sélecteurs Aave V3 sont ceux du Pool onchain', () => {
    const bySignature = Object.fromEntries(
      REGISTRY.entries.map((e) => [e.signature, e.selector]),
    )
    expect(bySignature['supply(address,uint256,address,uint16)']).toBe(
      '0x617ba037',
    )
    expect(bySignature['withdraw(address,uint256,address)']).toBe('0x69328dec')
    expect(bySignature['borrow(address,uint256,uint256,uint16,address)']).toBe(
      '0xa415bcad',
    )
    expect(bySignature['repay(address,uint256,uint256,address)']).toBe(
      '0x573ade81',
    )
    expect(bySignature['transfer(address,uint256)']).toBe('0xa9059cbb')
    expect(bySignature['approve(address,uint256)']).toBe('0x095ea7b3')
  })

  it('couvre au minimum USDC (Ethereum et Base) et le Pool Aave V3 Ethereum', () => {
    const couples = REGISTRY.entries.map(
      (e) => `${e.chainId}:${e.target}:${e.category}`,
    )
    expect(couples).toContain(`1:${USDC_ETH}:erc20.transfer`)
    expect(couples).toContain(`1:${USDC_ETH}:erc20.approve`)
    expect(couples).toContain(`8453:${USDC_BASE}:erc20.transfer`)
    expect(couples).toContain(`8453:${USDC_BASE}:erc20.approve`)
    for (const cat of [
      'aavev3.repay',
      'aavev3.supply',
      'aavev3.withdraw',
      'aavev3.borrow',
    ]) {
      expect(couples).toContain(`1:${AAVE_POOL}:${cat}`)
    }
  })

  it("le registryRef est le keccak256 de la forme canonique JCS, insensible à l'ordre des clés", () => {
    expect(REF).toMatch(/^0x[0-9a-f]{64}$/)
    // Même canonicalisation que conditionHash / actionHash : une seule
    // implémentation, donc une seule occasion de diverger (docs/13 R1).
    expect(REF).toBe(hashCanonical(canonicalize(REGISTRY)))
    expect(canonicalizeRegistry(REGISTRY)).toBe(canonicalize(REGISTRY))

    // Mêmes données, clés écrites dans l'ordre inverse : même empreinte.
    const reordonne = Object.fromEntries(
      Object.entries(REGISTRY).reverse(),
    ) as unknown as RegistryFile
    expect(JSON.stringify(reordonne)).not.toBe(JSON.stringify(REGISTRY))
    expect(registryRefOf(reordonne)).toBe(REF)
  })

  it('modifier une entrée change le registryRef', () => {
    const modifie = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    modifie.entries[0]!.assetPriceUSD = '2000000'
    expect(registryRefOf(modifie)).not.toBe(REF)
  })

  it('un registre dupliqué ou mal formé est refusé au chargement', () => {
    const duplique = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    duplique.entries.push(duplique.entries[0]!)
    expect(() => assertRegistryConsistent(duplique)).toThrowError(/dupliqué/)

    const casse = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    casse.entries[0]!.target = '0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48' as Address
    expect(() => assertRegistryConsistent(casse)).toThrowError(/normalisée/)
  })

  it('les noms d\'arguments correspondent à l\'arité de la signature', () => {
    const faux = JSON.parse(JSON.stringify(REGISTRY)) as RegistryFile
    faux.entries[0]!.argNames = ['to']
    expect(() => assertRegistryConsistent(faux)).toThrowError(/argNames/)
  })

  it('ERC20_ABI de référence — les signatures du registre sont celles-là', () => {
    for (const sig of ERC20_ABI) {
      const bare = sig.replace('function ', '')
      expect(REGISTRY.entries.some((e) => e.signature === bare)).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Bouclage classifieur → politique
// ─────────────────────────────────────────────────────────────────────────────

describe('la classification alimente la politique, pas l\'inverse', () => {
  it('un transfert détourné engage la destination de la politique', () => {
    const c = classify(
      action({ calldata: transferCalldata(ATTACKER, 100_000_000n) }),
      REGISTRY,
    )
    const spec = buildConditionSpec(c, POLICY)
    const accounts = spec.checks
      .map((chk) => (chk as { account?: string }).account)
      .filter(Boolean)
    expect(accounts).toContain(PAYROLL)
    expect(accounts).not.toContain(ATTACKER)
  })
})
