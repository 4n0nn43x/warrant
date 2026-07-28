/**
 * Fragments d'ABI — uniquement les events, parce que ce lecteur ne lit que des
 * events.
 *
 * `endpoint`, `feedbackURI` et `feedbackHash` ne sont **pas stockés** par le
 * ReputationRegistry : ils ne sont émis que dans `NewFeedback`. `readFeedback`
 * ne rend que `value`, `valueDecimals`, `tag1`, `tag2` et `isRevoked`. Aucun
 * getter ne redonne l'URI d'un verdict. Lire un verdict Warrant depuis la
 * chaîne exige donc d'indexer les logs, et c'est une contrainte d'architecture,
 * pas un détail d'implémentation.
 *
 * Les fragments ERC-8004 sont repris verbatim de
 * `erc-8004/erc-8004-contracts@master:abis/ReputationRegistry.json`.
 * Les fragments `WarrantEscrow` sont repris de
 * `packages/server/src/escrow-abi.ts` — recopiés plutôt qu'importés pour que ce
 * paquet soit publiable seul, avec `viem` pour unique dépendance.
 */

/** Adresses ERC-8004, déterministes et identiques sur toutes les chaînes de même type. */
export const ERC8004_ADDRESSES = {
  mainnet: {
    identity: '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
    reputation: '0x8004baa17c55a88189ae136b182e5fda19de9b63',
  },
  testnet: {
    identity: '0x8004a818bfb912233c491871b3d84c89a494bd9e',
    reputation: '0x8004b663056a597dffe9eccc1965a193b7388713',
  },
} as const

/**
 * `NewFeedback` — le seul endroit où `feedbackURI` et `feedbackHash`
 * apparaissent.
 *
 * Noter `indexedTag1`, une `string` **indexée** : son topic est
 * `keccak256(bytes(tag1))`, pas la chaîne. C'est ce qui permet de filtrer sur
 * `tag1 = 'warrant'` côté nœud. Le `tag1` non indexé qui suit porte la valeur
 * lisible.
 */
export const newFeedbackEvent = {
  type: 'event',
  name: 'NewFeedback',
  inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'clientAddress', type: 'address', indexed: true },
    { name: 'feedbackIndex', type: 'uint64', indexed: false },
    { name: 'value', type: 'int128', indexed: false },
    { name: 'valueDecimals', type: 'uint8', indexed: false },
    { name: 'indexedTag1', type: 'string', indexed: true },
    { name: 'tag1', type: 'string', indexed: false },
    { name: 'tag2', type: 'string', indexed: false },
    { name: 'endpoint', type: 'string', indexed: false },
    { name: 'feedbackURI', type: 'string', indexed: false },
    { name: 'feedbackHash', type: 'bytes32', indexed: false },
  ],
} as const

export const feedbackRevokedEvent = {
  type: 'event',
  name: 'FeedbackRevoked',
  inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'clientAddress', type: 'address', indexed: true },
    { name: 'feedbackIndex', type: 'uint64', indexed: true },
  ],
} as const

export const warrantOpenedEvent = {
  type: 'event',
  name: 'WarrantOpened',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'agent', type: 'address', indexed: true },
    { name: 'beneficiary', type: 'address', indexed: true },
    { name: 'bond', type: 'uint256', indexed: false },
    { name: 'conditionHash', type: 'bytes32', indexed: false },
    { name: 'actionHash', type: 'bytes32', indexed: false },
    { name: 'fundingRef', type: 'bytes32', indexed: false },
    { name: 'expiry', type: 'uint64', indexed: false },
  ],
} as const

/** `bond = refunded + fee` : le remboursement est net de frais, la caution ne l'est pas. */
export const warrantHonoredEvent = {
  type: 'event',
  name: 'WarrantHonored',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'execRef', type: 'bytes32', indexed: false },
    { name: 'refunded', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
  ],
} as const

/** `bond = amount` : une saisie transfère l'intégralité, sans frais. */
export const warrantSlashedEvent = {
  type: 'event',
  name: 'WarrantSlashed',
  inputs: [
    { name: 'id', type: 'bytes32', indexed: true },
    { name: 'execRef', type: 'bytes32', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'reason', type: 'string', indexed: false },
  ],
} as const

export const reputationEventsAbi = [newFeedbackEvent, feedbackRevokedEvent] as const

export const escrowEventsAbi = [
  warrantOpenedEvent,
  warrantHonoredEvent,
  warrantSlashedEvent,
] as const
