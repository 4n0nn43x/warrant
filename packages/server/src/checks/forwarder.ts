/**
 * Décapsulation des transactions sponsorisées.
 *
 * Quand KeeperHub sponsorise le gas, la transaction onchain **n'est pas** celle
 * qu'on croit avoir demandée :
 *
 *   tx.from  = un relayer, pas le wallet de l'organisation
 *   tx.to    = un forwarder, pas le contrat cible
 *   tx.input = execute(address wallet, address target, uint256 value, bytes data)
 *
 * et le calldata réellement exécuté est encapsulé dans `data`, précédé d'une
 * signature de 65 octets et de métadonnées.
 *
 * Vérifié en direct le 28/07/2026 sur Base Sepolia, transaction
 * `0xaf65a4e68a3a567729c95c3b2fef324612d70544aae930f2f7ae09a43cb4d315` :
 * forwarder `0x5aF5194B4b0909eB978e3Cf1e25333852277f07D`, relayer
 * `0x6331eb4571DE9284f7E9eAD98ac7b0661a091E99`.
 *
 * Sans cette décapsulation, `calldata_matches_commitment` échouerait sur
 * **chaque** mandat dès que le gas est sponsorisé — c'est-à-dire une saisie
 * injuste systématique.
 */

import { decodeFunctionData, type Hex } from 'viem'

/** `execute(address,address,uint256,bytes)` — sélecteur `0x9aefaff8`. */
export const FORWARDER_EXECUTE_SELECTOR = '0x9aefaff8' as const

export const FORWARDER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'wallet', type: 'address' },
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/** L'appel effectif, une fois l'enveloppe de sponsoring retirée. */
export interface EffectiveCall {
  target: Hex
  value: bigint
  calldata: Hex
  /** Wallet pour le compte duquel le forwarder agit. */
  wallet?: Hex
  /** `true` si l'appel a dû être extrait d'une enveloppe de forwarder. */
  viaForwarder: boolean
}

/**
 * Retire l'enveloppe de sponsoring si elle est présente.
 *
 * Conservateur par construction : si le motif n'est pas reconnu **exactement**,
 * on rend la transaction telle quelle plutôt que de deviner. Un faux positif
 * ici validerait un mandat qui ne devrait pas l'être.
 */
export function unwrapForwarder(tx: {
  to: string | null
  value: bigint
  input: Hex
}): EffectiveCall {
  const direct: EffectiveCall = {
    target: (tx.to ?? '0x0000000000000000000000000000000000000000') as Hex,
    value: tx.value,
    calldata: tx.input ?? '0x',
    viaForwarder: false,
  }

  if (!tx.input || !tx.input.toLowerCase().startsWith(FORWARDER_EXECUTE_SELECTOR)) {
    return direct
  }

  let decoded: readonly unknown[]
  try {
    const res = decodeFunctionData({ abi: FORWARDER_ABI, data: tx.input })
    decoded = res.args as readonly unknown[]
  } catch {
    // Le sélecteur coïncide mais la forme ne suit pas : on ne suppose rien.
    return direct
  }

  const [wallet, target, value, data] = decoded as [Hex, Hex, bigint, Hex]
  if (typeof target !== 'string' || typeof data !== 'string') return direct

  const inner = extractInnerCalldata(data)
  if (!inner) return direct

  return {
    target,
    value,
    calldata: inner,
    wallet,
    viaForwarder: true,
  }
}

/**
 * Extrait le calldata cible du payload signé du forwarder.
 *
 * Le payload est `signature(65) ‖ métadonnées ‖ calldata`. La longueur des
 * métadonnées n'est pas documentée et pourrait changer, donc on ne la code pas
 * en dur : on cherche la **dernière** frontière plausible à partir de laquelle
 * le reste forme un calldata ABI valide, c'est-à-dire `4 + 32·n` octets.
 *
 * Rend `undefined` si aucune découpe ne convient — auquel cas l'appelant
 * retombe sur la transaction brute et le check échouera, ce qui est le bon
 * comportement : mieux vaut un verdict conservateur qu'une extraction inventée.
 */
export function extractInnerCalldata(payload: Hex): Hex | undefined {
  const hex = payload.slice(2)
  const bytes = hex.length / 2
  // 65 octets de signature au minimum, plus 4 octets de sélecteur.
  if (bytes < 69) return undefined

  for (let offset = 65; offset + 4 <= bytes; offset++) {
    const rest = bytes - offset
    if (rest < 4) break
    if ((rest - 4) % 32 !== 0) continue
    return `0x${hex.slice(offset * 2)}` as Hex
  }
  return undefined
}
