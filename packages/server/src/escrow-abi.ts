/**
 * ABI of `WarrantEscrow`.
 *
 * Hand-written from contracts/src/WarrantEscrow.sol so that the server is typed
 * without depending on a compilation artefact. An integration test compares it
 * against `contracts/out/WarrantEscrow.sol/WarrantEscrow.json` and fails if the
 * two diverge.
 */

/**
 * Components of the `Authorization` struct — **in Solidity declaration order**,
 * which is also the ABI encoding order.
 *
 * Pulled out into a constant because three places depend on it and any ordering
 * divergence between them would be silent: a tuple is encoded by position, not
 * by name. `validAfter` and `validBefore` are two adjacent `uint256` fields —
 * swapping them would produce no type error at all, only an authorization the
 * token would report as not yet valid.
 */
export const authorizationComponents = [
  { name: 'from', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'v', type: 'uint8' },
  { name: 'r', type: 'bytes32' },
  { name: 's', type: 'bytes32' },
] as const

/**
 * Members of the `Warrant` struct, in storage order.
 *
 * `feeBpsAtOpen` is the ninth member, **before** `status`: the public getter
 * `warrants(bytes32)` therefore returns ten values. This is the most dangerous
 * off-by-one in this ABI — reading `status` at index 8 would return
 * `feeBpsAtOpen`, that is 250 on the current deployment, a value that is no known
 * `Status` and that `WarrantStatus[250]` would translate to `undefined` without
 * throwing.
 */
export const warrantComponents = [
  { name: 'agent', type: 'address' },
  { name: 'beneficiary', type: 'address' },
  { name: 'bond', type: 'uint256' },
  { name: 'conditionHash', type: 'bytes32' },
  { name: 'actionHash', type: 'bytes32' },
  { name: 'fundingRef', type: 'bytes32' },
  { name: 'expiry', type: 'uint64' },
  { name: 'openedAt', type: 'uint64' },
  { name: 'feeBpsAtOpen', type: 'uint16' },
  { name: 'status', type: 'uint8' },
] as const

export const warrantEscrowAbi = [
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      // `agent` is no longer a parameter: it is `auth.from`, proven by the
      // EIP-3009 signature the token verifies. An opener can therefore no longer
      // freely designate who gets the refund.
      { name: 'beneficiary', type: 'address' },
      { name: 'bond', type: 'uint256' },
      { name: 'conditionHash', type: 'bytes32' },
      { name: 'actionHash', type: 'bytes32' },
      // `fundingRef` is no longer a parameter either: it is `auth.nonce`.
      { name: 'duration', type: 'uint64' },
      { name: 'auth', type: 'tuple', components: authorizationComponents },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'honor',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'execRef', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'slash',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'execRef', type: 'bytes32' },
      { name: 'reason', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'reclaim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'warrants',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    // Ten values, not nine: see `warrantComponents`. The generated getter
    // flattens the struct, it does not return a nested tuple.
    outputs: warrantComponents,
  },
  {
    type: 'function',
    name: 'getWarrant',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    // A struct, hence **one** ten-member tuple — not ten flattened values. The
    // difference matters when decoding: viem returns a named object here.
    outputs: [{ name: '', type: 'tuple', components: warrantComponents }],
  },
  {
    type: 'function',
    name: 'termsHash',
    stateMutability: 'pure',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'beneficiary', type: 'address' },
      { name: 'bond', type: 'uint256' },
      { name: 'conditionHash', type: 'bytes32' },
      { name: 'actionHash', type: 'bytes32' },
      { name: 'duration', type: 'uint64' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'treasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'token',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'totalLocked',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'feeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint16' }],
  },
  {
    type: 'function',
    name: 'opener',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function',
    name: 'settler',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
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
  },
  {
    type: 'event',
    name: 'WarrantHonored',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'execRef', type: 'bytes32', indexed: false },
      { name: 'refunded', type: 'uint256', indexed: false },
      { name: 'fee', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WarrantSlashed',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'execRef', type: 'bytes32', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'reason', type: 'string', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'WarrantReclaimed',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'refunded', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'NotOpener', inputs: [] },
  { type: 'error', name: 'NotSettler', inputs: [] },
  { type: 'error', name: 'NotOwner', inputs: [] },
  { type: 'error', name: 'AlreadyExists', inputs: [] },
  { type: 'error', name: 'NotOpen', inputs: [] },
  { type: 'error', name: 'NotExpired', inputs: [] },
  { type: 'error', name: 'Expired', inputs: [] },
  { type: 'error', name: 'BadDuration', inputs: [] },
  { type: 'error', name: 'BadFee', inputs: [] },
  { type: 'error', name: 'ZeroBond', inputs: [] },
  { type: 'error', name: 'Underfunded', inputs: [] },
  // Added by the audit fix. Decoding them is what separates a bare "open failed"
  // from an actionable diagnosis: `ValueMismatch` says the recomputed bond no
  // longer equals the signed amount, while `BeneficiaryIsTreasury` and
  // `BadBeneficiary` point at a policy to fix, not at an outage.
  { type: 'error', name: 'RolesMustDiffer', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'BeneficiaryIsTreasury', inputs: [] },
  { type: 'error', name: 'BadBeneficiary', inputs: [] },
  { type: 'error', name: 'ValueMismatch', inputs: [] },
  { type: 'error', name: 'TermsMismatch', inputs: [] },
] as const
