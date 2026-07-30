/**
 * ABI de `WarrantEscrow`.
 *
 * Écrite à la main d'après contracts/src/WarrantEscrow.sol pour que le serveur
 * soit typé sans dépendre d'un artefact de compilation. Un test d'intégration
 * la compare à `contracts/out/WarrantEscrow.sol/WarrantEscrow.json` et échoue
 * si les deux divergent.
 */

/**
 * Composants de la struct `Authorization` — **dans l'ordre de la déclaration
 * Solidity**, qui est celui de l'encodage ABI.
 *
 * Extrait dans une constante parce que trois endroits en dépendent et qu'une
 * divergence d'ordre entre eux serait silencieuse : un tuple est encodé par
 * position, pas par nom. `validAfter` et `validBefore` sont deux `uint256`
 * adjacents — les permuter ne produirait aucune erreur de type, seulement une
 * autorisation dont le token dirait qu'elle n'est pas encore valide.
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
 * Membres de la struct `Warrant`, dans l'ordre du stockage.
 *
 * `feeBpsAtOpen` est le neuvième membre, **avant** `status` : le getter public
 * `warrants(bytes32)` rend donc dix valeurs. C'est le décalage le plus
 * dangereux de cette ABI — lire `status` à l'index 8 rendrait `feeBpsAtOpen`,
 * soit 250 sur le déploiement courant, valeur qui n'est aucun `Status` connu et
 * que `WarrantStatus[250]` traduirait en `undefined` sans lever.
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
      // `agent` n'est plus un paramètre : il est `auth.from`, prouvé par la
      // signature EIP-3009 que le token vérifie. Un opener ne peut donc plus
      // désigner librement le destinataire du remboursement.
      { name: 'beneficiary', type: 'address' },
      { name: 'bond', type: 'uint256' },
      { name: 'conditionHash', type: 'bytes32' },
      { name: 'actionHash', type: 'bytes32' },
      // `fundingRef` n'est plus un paramètre non plus : c'est `auth.nonce`.
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
    // Dix valeurs, pas neuf : voir `warrantComponents`. Le getter généré
    // aplatit la struct, il ne rend pas un tuple imbriqué.
    outputs: warrantComponents,
  },
  {
    type: 'function',
    name: 'getWarrant',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    // Une struct, donc **un** tuple à dix membres — et non dix valeurs à plat.
    // La différence compte au décodage : viem rend ici un objet nommé.
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
  // Ajoutées par le correctif d'audit. Les décoder est ce qui distingue un
  // « open a échoué » d'un diagnostic exploitable : `ValueMismatch` dit que la
  // caution recalculée ne vaut plus le montant signé, `BeneficiaryIsTreasury`
  // et `BadBeneficiary` désignent une politique à corriger, pas une panne.
  { type: 'error', name: 'RolesMustDiffer', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'BeneficiaryIsTreasury', inputs: [] },
  { type: 'error', name: 'BadBeneficiary', inputs: [] },
  { type: 'error', name: 'ValueMismatch', inputs: [] },
  { type: 'error', name: 'TermsMismatch', inputs: [] },
] as const
