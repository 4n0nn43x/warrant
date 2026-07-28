/**
 * Tests bâtis sur une transaction sponsorisée **réelle**.
 *
 * Base Sepolia, bloc 44736245 :
 * `0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315`
 *
 * C'est le premier appel exécuté via KeeperHub par ce projet, et il a révélé
 * que `tx.to` désigne un forwarder et non le contrat cible dès que le gas est
 * sponsorisé. Figer ces octets ici garantit qu'une régression sur la
 * décapsulation se voit immédiatement, sans dépendre du réseau.
 */

import { describe, expect, it } from 'vitest'
import type { Hex } from 'viem'
import {
  FORWARDER_EXECUTE_SELECTOR,
  extractInnerCalldata,
  unwrapForwarder,
} from './forwarder.js'

/** Calldata top-level réel de la transaction sponsorisée. */
const REAL_FORWARDER_INPUT =
  '0x9aefaff8' +
  '0000000000000000000000001f854780eaea8ec169c6cf96597934da2573bfa1' + // wallet org
  '000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e' + // USDC cible
  '0000000000000000000000000000000000000000000000000000000000000000' + // value
  '0000000000000000000000000000000000000000000000000000000000000080' + // offset bytes
  '0000000000000000000000000000000000000000000000000000000000000099' + // longueur 153
  '5f14e21922e4e2a9f606e6ca773ac116d193af5daaf3946c547943208418014855d80bd52c66b74bcde87e62045df4c9870b8d001942b2fe310d60272c10f0141c000000000000000000000000000000006a68aad8095ea7b3000000000000000000000000000000000000000000000000000000000000dead0000000000000000000000000000000000000000000000000000000000000000' +
  '00000000000000'

const FORWARDER = '0x5aF5194B4b0909eB978e3Cf1e25333852277f07D'
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ORG_WALLET = '0x1F854780EAEA8ec169c6cF96597934Da2573bfA1'

describe('unwrapForwarder — transaction sponsorisée réelle', () => {
  const call = unwrapForwarder({
    to: FORWARDER,
    value: 0n,
    input: REAL_FORWARDER_INPUT as Hex,
  })

  it('reconnaît l’enveloppe de sponsoring', () => {
    expect(call.viaForwarder).toBe(true)
  })

  it('retrouve le contrat cible, pas le forwarder', () => {
    expect(call.target.toLowerCase()).toBe(USDC_BASE_SEPOLIA.toLowerCase())
    expect(call.target.toLowerCase()).not.toBe(FORWARDER.toLowerCase())
  })

  it('retrouve le wallet pour le compte duquel le forwarder agit', () => {
    expect(call.wallet?.toLowerCase()).toBe(ORG_WALLET.toLowerCase())
  })

  it('extrait un calldata `approve` bien formé', () => {
    // 4 octets de sélecteur + 2 mots de 32 octets.
    expect(call.calldata.slice(0, 10)).toBe('0x095ea7b3')
    expect((call.calldata.length - 2) / 2).toBe(68)
  })

  it('décode les arguments engagés — spender et montant', () => {
    const args = call.calldata.slice(10)
    expect(args.slice(0, 64).endsWith('dead')).toBe(true)
    expect(BigInt(`0x${args.slice(64, 128)}`)).toBe(0n)
  })
})

describe('unwrapForwarder — le cas direct reste intact', () => {
  it('rend la transaction telle quelle hors sponsoring', () => {
    const direct = unwrapForwarder({
      to: USDC_BASE_SEPOLIA,
      value: 0n,
      input: '0x095ea7b3' as Hex,
    })
    expect(direct.viaForwarder).toBe(false)
    expect(direct.target).toBe(USDC_BASE_SEPOLIA)
    expect(direct.calldata).toBe('0x095ea7b3')
  })

  it('traite une création de contrat sans lever', () => {
    const created = unwrapForwarder({ to: null, value: 0n, input: '0x6080' as Hex })
    expect(created.viaForwarder).toBe(false)
    expect(created.target).toBe('0x0000000000000000000000000000000000000000')
  })
})

describe('unwrapForwarder — conservateur en cas de doute', () => {
  it('ne devine rien si le sélecteur coïncide mais la forme ne suit pas', () => {
    const bogus = unwrapForwarder({
      to: FORWARDER,
      value: 0n,
      input: `${FORWARDER_EXECUTE_SELECTOR}deadbeef` as Hex,
    })
    // Retombe sur la transaction brute : le check échouera, ce qui est correct.
    expect(bogus.viaForwarder).toBe(false)
    expect(bogus.target).toBe(FORWARDER)
  })

  it('n’altère pas un calldata dont le sélecteur diffère', () => {
    const other = unwrapForwarder({
      to: USDC_BASE_SEPOLIA,
      value: 0n,
      input: '0xa9059cbb0000' as Hex,
    })
    expect(other.viaForwarder).toBe(false)
    expect(other.calldata).toBe('0xa9059cbb0000')
  })
})

describe('extractInnerCalldata', () => {
  it('refuse un payload trop court pour contenir signature + sélecteur', () => {
    expect(extractInnerCalldata(`0x${'00'.repeat(68)}` as Hex)).toBeUndefined()
  })

  it('rend un calldata de longueur ABI valide — 4 + 32·n octets', () => {
    const inner = extractInnerCalldata(
      `0x${'11'.repeat(65)}${'22'.repeat(8)}095ea7b3${'33'.repeat(64)}` as Hex,
    )
    expect(inner).toBeDefined()
    const len = (inner!.length - 2) / 2
    expect((len - 4) % 32).toBe(0)
  })
})
