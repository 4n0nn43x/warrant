/**
 * ABI de `WarrantEscrow`.
 *
 * Écrite à la main d'après contracts/src/WarrantEscrow.sol pour que le serveur
 * soit typé sans dépendre d'un artefact de compilation. Un test d'intégration
 * la compare à `contracts/out/WarrantEscrow.sol/WarrantEscrow.json` et échoue
 * si les deux divergent.
 */

export const warrantEscrowAbi = [
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'agent', type: 'address' },
      { name: 'beneficiary', type: 'address' },
      { name: 'bond', type: 'uint256' },
      { name: 'conditionHash', type: 'bytes32' },
      { name: 'actionHash', type: 'bytes32' },
      { name: 'fundingRef', type: 'bytes32' },
      { name: 'duration', type: 'uint64' },
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
    outputs: [
      { name: 'agent', type: 'address' },
      { name: 'beneficiary', type: 'address' },
      { name: 'bond', type: 'uint256' },
      { name: 'conditionHash', type: 'bytes32' },
      { name: 'actionHash', type: 'bytes32' },
      { name: 'fundingRef', type: 'bytes32' },
      { name: 'expiry', type: 'uint64' },
      { name: 'openedAt', type: 'uint64' },
      { name: 'status', type: 'uint8' },
    ],
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
] as const
