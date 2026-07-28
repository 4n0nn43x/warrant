/**
 * `@warrant/reputation-reader` — réputation ERC-8004 pondérée par le capital.
 *
 * ERC-8004 compte plus de 150 000 enregistrements de réputation, et rien n'y est
 * en jeu quand on publie un feedback : la réputation y est **déclarative**.
 * `getSummary` rend une moyenne de notes, sans jamais dire combien un agent a
 * risqué pour l'obtenir.
 *
 * Cette bibliothèque calcule, depuis les seuls **events onchain** :
 *
 *     stakeWeightedScore(agent) = Σ(bond_honored) / (Σ(bond_honored) + Σ(bond_slashed))
 *     totalAtRisk(agent)        = Σ(bond) sur tous les mandats réglés
 *
 * Un agent avec 200 petits mandats honorés et un score de 1,0 devient
 * distinguable d'un agent avec 50 000 $ cumulés de cautions honorées au même
 * score : `totalAtRisk` les sépare.
 *
 * Elle lit des **logs**, pas des vues — `feedbackURI` et `feedbackHash` ne sont
 * pas stockés par le ReputationRegistry, ils ne sont émis que dans l'event
 * `NewFeedback`. C'est une contrainte d'architecture, pas un détail.
 *
 * Elle ne dépend que de `viem`, et d'aucun autre paquet Warrant : elle se lit,
 * se publie et s'utilise sans le reste du projet.
 *
 * ```ts
 * import { createPublicClient, http } from 'viem'
 * import { base } from 'viem/chains'
 * import { readAgentReputation, ERC8004_ADDRESSES, formatScore } from '@warrant/reputation-reader'
 *
 * const client = createPublicClient({ chain: base, transport: http() })
 * const rep = await readAgentReputation(client, {
 *   reputationRegistry: ERC8004_ADDRESSES.mainnet.reputation,
 *   escrow: '0x…',
 *   agentId: 1234n,
 *   clients: ['0x…settler'],   // qui a le droit de noter cet agent pour Warrant
 * })
 * console.log(formatScore(rep.stakeWeightedScore), rep.totalAtRisk)
 * ```
 */

export * from './types.js'
export * from './abi.js'
export * from './decode.js'
export * from './score.js'
export * from './read.js'
