/**
 * ABI fragments — events only, because this reader reads nothing but events.
 *
 * `endpoint`, `feedbackURI` and `feedbackHash` are **not stored** by the
 * ReputationRegistry: they are only emitted in `NewFeedback`. `readFeedback`
 * returns only `value`, `valueDecimals`, `tag1`, `tag2` and `isRevoked`. No
 * getter gives back a verdict's URI. Reading a Warrant verdict from the chain
 * therefore requires indexing the logs, and that is an architectural constraint,
 * not an implementation detail.
 *
 * The ERC-8004 fragments are taken verbatim from
 * `erc-8004/erc-8004-contracts@master:abis/ReputationRegistry.json`.
 * The `WarrantEscrow` fragments are taken from
 * `packages/server/src/escrow-abi.ts` — copied rather than imported so that this
 * package can be published on its own, with `viem` as its only dependency.
 */

/** ERC-8004 addresses, deterministic and identical across every chain of the same type. */
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
 * `NewFeedback` — the only place where `feedbackURI` and `feedbackHash` appear.
 *
 * Note `indexedTag1`, an **indexed** `string`: its topic is
 * `keccak256(bytes(tag1))`, not the string itself. That is what makes it possible
 * to filter on `tag1 = 'warrant'` node-side. The non-indexed `tag1` that follows
 * carries the readable value.
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

/** `bond = refunded + fee`: the refund is net of fees, the bond was not. */
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

/** `bond = amount`: a slash transfers the whole thing, with no fee. */
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
