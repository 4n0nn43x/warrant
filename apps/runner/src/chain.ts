/**
 * Lectures onchain du runner — et seulement des lectures.
 *
 * Le runner n'écrit jamais sur la chaîne : l'ouverture part du wallet KeeperHub
 * (sponsorisée, invariant I10), le règlement part de la clé du Settler. Ce
 * fichier n'existe donc que pour **compter**, et pour refuser de démarrer quand
 * la configuration ferait dépenser dans le vide.
 *
 * Pourquoi la chaîne et non le journal pour les compteurs : le journal dit ce
 * qui a été *ouvert*, jamais ce qui a été *réglé* — c'est le Settler qui règle,
 * dans un autre processus, et il ne réécrit pas le journal. Un compteur qui
 * lirait le journal seul annoncerait donc 150 mandats « ouverts » et zéro
 * honoré, indéfiniment. `getWarrant(id)` est la seule source qui connaisse
 * `status`, et c'est celle que le jury peut rejouer.
 *
 * ⚠ L'ABI est importée depuis les **sources** de `@warrant/server`, pas depuis
 * son `dist/` : le `dist/` publié dans l'arbre est antérieur à l'ajout de
 * `getWarrant`, et un runner qui lirait `warrants()` à plat sur une ABI périmée
 * décalerait `status` d'un cran — `feeBpsAtOpen` vaut 250, qui n'est aucun
 * statut connu et que `WarrantStatus[250]` traduit en `undefined` sans lever.
 * Le prix assumé : `tsx`/`tsc` résolvent le chemin relatif, et le runner ne
 * s'exécute donc que depuis le monorepo. C'est un outil d'exploitation, pas un
 * paquet publié.
 */

import { WarrantStatus, type Address, type Hex } from '@warrant/core'
import { createPublicClient, http, type PublicClient } from 'viem'
import { base, baseSepolia, mainnet, sepolia } from 'viem/chains'
import { warrantEscrowAbi } from '../../../packages/server/src/escrow-abi.js'

/**
 * Chaînes connues, alignées sur `bin/settler.ts` et `bin/open-warrant.ts`.
 * Une chaîne absente fait échouer le démarrage plutôt que de laisser viem
 * deviner un RPC : ouvrir 150 mandats sur la mauvaise chaîne est irréversible.
 */
export const CHAINS = { 1: mainnet, 8453: base, 11155111: sepolia, 84532: baseSepolia } as const

/**
 * Chaînes sur lesquelles un runner de volume est autorisé à tourner.
 *
 * Refus par défaut, et la liste est celle des testnets et non celle des
 * mainnets — parce que la seconde est ouverte. Le runner ouvre des centaines de
 * mandats sans confirmation humaine : c'est exactement le programme qu'il ne
 * faut jamais pouvoir lancer sur un mainnet par simple héritage d'un `.env`.
 */
export const VOLUME_ALLOWED_CHAIN_IDS = new Set([11155111, 84532, 421614, 11155420])

export function chainOf(chainId: number) {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) {
    throw new Error(
      `WARRANT_ESCROW_CHAIN_ID non supportée: ${chainId} — ` +
        `valeurs acceptées : ${Object.keys(CHAINS).join(', ')}`,
    )
  }
  return chain
}

export function publicClientFor(chainId: number, rpc: string): PublicClient {
  return createPublicClient({ chain: chainOf(chainId), transport: http(rpc) }) as PublicClient
}

/** Un mandat tel que la chaîne le rend. Aucune interprétation. */
export interface OnchainWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  expiry: number
  openedAt: number
  feeBpsAtOpen: number
  status: WarrantStatus
}

export const ERC20_READ_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
] as const

/**
 * Statut de plusieurs mandats, en **un** aller-retour par lot.
 *
 * `multicall` et non N `readContract` : les compteurs sont recalculés à chaque
 * ouverture, et sur 150 mandats une boucle naïve ferait 150 requêtes par tour,
 * soit un ordre de grandeur au-dessus de ce qu'un RPC public tolère. La taille
 * de lot reste modeste — un `eth_call` d'agrégat trop gros se fait refuser sur
 * la limite de gas de l'appel, pas sur une limite de taille, et le message ne
 * le dit pas.
 */
export async function readWarrants(
  client: PublicClient,
  escrow: Address,
  ids: readonly Hex[],
  batchSize = 50,
): Promise<Map<string, OnchainWarrant>> {
  const out = new Map<string, OnchainWarrant>()
  for (let i = 0; i < ids.length; i += batchSize) {
    const slice = ids.slice(i, i + batchSize)
    const results = (await client.multicall({
      allowFailure: true,
      contracts: slice.map((id) => ({
        address: escrow,
        abi: warrantEscrowAbi,
        functionName: 'getWarrant',
        args: [id],
      })),
    })) as unknown as { status: 'success' | 'failure'; result?: unknown }[]
    for (const [k, result] of results.entries()) {
      const id = slice[k]!
      // Un échec de lecture n'est pas un mandat absent : le distinguer importe,
      // parce qu'un mandat qu'on ne sait pas lire ne doit pas être compté comme
      // `None` — il sortirait des compteurs sans que personne ne le remarque.
      if (result.status !== 'success') continue
      const w = result.result as unknown as {
        agent: Address
        beneficiary: Address
        bond: bigint
        expiry: bigint
        openedAt: bigint
        feeBpsAtOpen: number
        status: number
      }
      out.set(id.toLowerCase(), {
        id: id.toLowerCase() as Hex,
        agent: w.agent.toLowerCase() as Address,
        beneficiary: w.beneficiary.toLowerCase() as Address,
        bond: w.bond,
        expiry: Number(w.expiry),
        openedAt: Number(w.openedAt),
        feeBpsAtOpen: Number(w.feeBpsAtOpen),
        status: Number(w.status) as WarrantStatus,
      })
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Balayage d'events — la seconde source, indépendante du journal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le bloc de déploiement de l'escrow, par dichotomie sur `eth_getCode`.
 *
 * Pourquoi ne pas le lire dans `deployments/base-sepolia.json` : ce fichier est
 * *notre* affirmation. Une vérification qui borne son balayage avec un chiffre
 * que nous avons nous-mêmes écrit peut manquer exactement ce qu'elle cherche —
 * un mandat ouvert avant le bloc annoncé. La dichotomie ne fait confiance qu'au
 * nœud : ≈ 25 `eth_getCode` pour un point de départ que personne n'a à croire.
 *
 * `low` n'est pas 0 : sur une chaîne à 44 millions de blocs, partir de la genèse
 * ajoute 26 requêtes pour rien. On part de la tête moins `maxLookback` et on
 * vérifie que le contrat n'existait **pas** à ce bloc — sinon on le dit, et
 * l'appelant est libre de descendre plus bas plutôt que de scanner une fenêtre
 * qui tronque l'histoire en silence.
 */
export async function deploymentBlock(
  client: PublicClient,
  address: Address,
  maxLookback = 2_000_000n,
): Promise<{ block: bigint; head: bigint; complete: boolean }> {
  const head = await client.getBlockNumber()
  let low = head > maxLookback ? head - maxLookback : 0n
  const codeAtLow = await client.getCode({ address, blockNumber: low })
  if (codeAtLow && codeAtLow !== '0x') {
    return { block: low, head, complete: false }
  }
  let high = head
  while (low < high) {
    const mid = (low + high) / 2n
    const code = await client.getCode({ address, blockNumber: mid })
    if (code && code !== '0x') high = mid
    else low = mid + 1n
  }
  return { block: low, head, complete: true }
}

/** Ce que les events disent d'un mandat. Aucune lecture d'état. */
export interface EventWarrant {
  id: Hex
  agent: Address
  beneficiary: Address
  bond: bigint
  openedAtBlock: bigint
  openTx: Hex
  /** Renseigné par `WarrantHonored`. `fee` et `refunded` sont **lus**, pas dérivés. */
  honored?: { refunded: bigint; fee: bigint; tx: Hex; block: bigint }
  slashed?: { amount: bigint; reason: string; tx: Hex; block: bigint }
  reclaimed?: { refunded: bigint; tx: Hex; block: bigint }
}

export interface EventScan {
  warrants: Map<string, EventWarrant>
  fromBlock: bigint
  toBlock: bigint
  /** Nombre de requêtes `eth_getLogs` émises. Le coût de la preuve, chiffré. */
  requests: number
  /** Events de règlement portant un `id` jamais vu ouvert. Doit rester vide. */
  orphanSettlements: string[]
}

/**
 * Reconstruit l'histoire complète de l'escrow à partir de ses seuls events.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Pourquoi cette fonction existe alors que `readWarrants` suffit à compter
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `readWarrants` lit `status` dans l'état courant. C'est juste, mais ce n'est
 * qu'**une** source, et elle part d'une liste d'`id` que nous fournissons — celle
 * du journal. Un compteur bâti ainsi ne peut structurellement pas détecter les
 * deux erreurs qui comptent devant un jury : un mandat ouvert onchain et **absent
 * du journal** (il n'est dans aucune liste, donc dans aucun total), et un montant
 * *dérivé* qui diverge du montant *réellement transféré* (`fee` calculée
 * `bond × feeBpsAtOpen / 10000` au lieu d'être lue dans `WarrantHonored`).
 *
 * Le balayage d'events n'a pas ces angles morts : il énumère les `id` au lieu de
 * les recevoir, et il porte les montants tels que le contrat les a émis. Croiser
 * les deux, c'est la différence entre « notre compteur est cohérent avec
 * lui-même » et « notre compteur est cohérent avec la chaîne ».
 *
 * `chunkBlocks` par défaut à 2001 : `sepolia.base.org` refuse tout `eth_getLogs`
 * dont `toBlock − fromBlock` dépasse 2000, et la borne porte bien sur l'écart —
 * mesuré, une plage de 2001 blocs passe. Les quatre events sont demandés dans une
 * **seule** requête par fenêtre (`events: [...]`), pas quatre : le facteur 4 sur
 * un RPC public est ce qui fait la différence entre une vérification qu'on relance
 * volontiers et une qu'on évite.
 */
export async function scanWarrantEvents(
  client: PublicClient,
  escrow: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkBlocks = 2001n,
): Promise<EventScan> {
  const warrants = new Map<string, EventWarrant>()
  const orphanSettlements: string[] = []
  const pendingSettlements: { id: string; apply: (w: EventWarrant) => void }[] = []
  let requests = 0

  const events = warrantEscrowAbi.filter(
    (entry): entry is Extract<(typeof warrantEscrowAbi)[number], { type: 'event' }> =>
      entry.type === 'event',
  )

  for (let cursor = fromBlock; cursor <= toBlock; cursor = cursor + chunkBlocks) {
    const to = cursor + chunkBlocks - 1n > toBlock ? toBlock : cursor + chunkBlocks - 1n
    const logs = await client.getLogs({ address: escrow, events, fromBlock: cursor, toBlock: to })
    requests += 1
    for (const log of logs) {
      const decoded = log as unknown as {
        eventName: string
        args: Record<string, unknown>
        transactionHash: Hex
        blockNumber: bigint
      }
      const id = String(decoded.args['id'] ?? '').toLowerCase()
      if (!id) continue
      switch (decoded.eventName) {
        case 'WarrantOpened':
          warrants.set(id, {
            id: id as Hex,
            agent: String(decoded.args['agent']).toLowerCase() as Address,
            beneficiary: String(decoded.args['beneficiary']).toLowerCase() as Address,
            bond: decoded.args['bond'] as bigint,
            openedAtBlock: decoded.blockNumber,
            openTx: decoded.transactionHash,
          })
          break
        case 'WarrantHonored':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.honored = {
                refunded: decoded.args['refunded'] as bigint,
                fee: decoded.args['fee'] as bigint,
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
        case 'WarrantSlashed':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.slashed = {
                amount: decoded.args['amount'] as bigint,
                reason: String(decoded.args['reason'] ?? ''),
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
        case 'WarrantReclaimed':
          pendingSettlements.push({
            id,
            apply: (w) => {
              w.reclaimed = {
                refunded: decoded.args['refunded'] as bigint,
                tx: decoded.transactionHash,
                block: decoded.blockNumber,
              }
            },
          })
          break
      }
    }
  }

  // Les règlements sont rattachés **après** le balayage complet et non au vol :
  // rien ne garantit qu'une fenêtre porte l'ouverture avant le règlement quand la
  // fenêtre est la première du balayage. Un rattachement au vol produirait des
  // « règlements orphelins » qui ne le sont pas.
  for (const s of pendingSettlements) {
    const w = warrants.get(s.id)
    if (!w) {
      orphanSettlements.push(s.id)
      continue
    }
    s.apply(w)
  }

  return { warrants, fromBlock, toBlock, requests, orphanSettlements }
}

/** Rôles et paramètres immuables de l'escrow. Lus, jamais supposés. */
export async function readEscrowRoles(
  client: PublicClient,
  escrow: Address,
): Promise<{
  opener: Address
  settler: Address
  treasury: Address
  token: Address
  feeBps: number
  totalLocked: bigint
}> {
  const [opener, settler, treasury, token, feeBps, totalLocked] = await Promise.all([
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'opener' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'settler' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'treasury' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'token' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'feeBps' }),
    client.readContract({ address: escrow, abi: warrantEscrowAbi, functionName: 'totalLocked' }),
  ])
  return {
    opener: (opener as string).toLowerCase() as Address,
    settler: (settler as string).toLowerCase() as Address,
    treasury: (treasury as string).toLowerCase() as Address,
    token: (token as string).toLowerCase() as Address,
    feeBps: Number(feeBps),
    totalLocked: totalLocked as bigint,
  }
}

/**
 * `reclaim(id)` — la seule écriture onchain du runner, et elle est
 * **permissionnée par personne**.
 *
 * `WarrantEscrow.reclaim` est volontairement sans permission (« empêche toute
 * séquestration par un settler défaillant ») et rembourse `bond` **intégralement,
 * sans frais**. Le runner l'appelle donc sur les mandats expirés, et ce n'est pas
 * une coquetterie : le Settler, quand l'action KeeperHub a échoué, s'abstient de
 * juger et laisse expirer. Sans balayage, ces 0,2 USDC restent immobilisés
 * indéfiniment — personne ne les réclame — alors qu'ils valent 40 cycles honorés.
 * C'est le seul mécanisme du système qui transforme un échec d'exécution en
 * capital de nouveau disponible.
 *
 * Le gas sort de la clé de l'agent (≈ 0,0000005 ETH), et non de celle du Settler :
 * mélanger les deux ferait passer un remboursement pour un règlement dans la
 * comptabilité de gas.
 */
export const RECLAIM_ABI = warrantEscrowAbi

export async function usdcBalance(
  client: PublicClient,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: ERC20_READ_ABI,
    functionName: 'balanceOf',
    args: [owner],
  })) as bigint
}
