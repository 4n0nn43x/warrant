/**
 * Generator of the shared test vectors `fixtures/condition-hashes.json`.
 *
 * These vectors are the only proof that TypeScript, Python and Go compute the
 * same `conditionHash`. A canonicalisation divergence between client and server
 * would make every warrant unevaluable — the costliest possible bug on this
 * project (docs/07 § 4).
 *
 * Each vector carries a `type`:
 *   - `raw`           : `spec` is an arbitrary JSON value, canonicalised as-is
 *                       (pure RFC 8785, no domain normalisation).
 *   - `conditionSpec` : `spec` goes through `normalizeConditionSpec` before JCS.
 *   - `actionSpec`    : `spec` goes through `normalizeActionSpec` before JCS.
 *
 * In all three cases: `hash = keccak256(utf8(canonical))`.
 *
 * Regeneration:
 *   node node_modules/.pnpm/node_modules/.bin/vite-node \
 *     packages/core/scripts/gen-fixtures.ts
 *
 * The test `canonical.test.ts` recomputes these vectors and fails if the file is
 * stale: it is never possible to commit a desynchronised fixture.
 *
 * ⚠ The vector VALUES are hashed content, French strings included — see
 * `conditionSpec/unicode-and-accents`. Translating one changes a hash and
 * detaches warrants already committed to it. Only the comments are in English.
 */

import { canonicalize } from '../src/canonical.js'
import {
  actionHash,
  canonicalActionSpec,
  canonicalConditionSpec,
  conditionHash,
  hashCanonical,
  normalizeConditionSpec,
} from '../src/hash.js'
import { validateConditionSpec } from '../src/dsl.js'

export type FixtureType = 'raw' | 'conditionSpec' | 'actionSpec'

export interface FixtureInput {
  name: string
  type: FixtureType
  spec: unknown
}

export interface Fixture extends FixtureInput {
  canonical: string
  hash: `0x${string}`
}

// Scenario addresses. The mixed casing is deliberate: normalisation must bring
// them back to lowercase (docs/07 § 4, rule 2).
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const AAVE_POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2'
const TREASURY = '0x1111111111111111111111111111111111111111'
const SUSPICIOUS = '0x2222222222222222222222222222222222222222'
const AGENT_EXEC = '0x3333333333333333333333333333333333333333'
const ALLOWED_DEST = '0x4444444444444444444444444444444444444444'

const TOPIC_APPROVAL =
  '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'
const ACTION_HASH =
  '0x9d8f2c1e4b6a0537d1c9e2a4f60b8d3c5a7e91f24b6d8036c1e5a9f7b3d20c48'
const REGISTRY_REF =
  '0x5c1f7a93e0b46d28f3a5c7091e6b4d82a0f39c5d71b8e2460a93f5c7d1e08b36'

/** `2^256 - 1`, tres au-dela de `Number.MAX_SAFE_INTEGER`. */
const UINT256_MAX_STR =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935'

export const VECTORS: FixtureInput[] = [
  // ───────────────────────────────────────────────────────────────────────
  // RFC 8785 — canonicalisation pure
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'raw/key-sorting-utf16-code-units',
    type: 'raw',
    // Sorting example from RFC 8785 § 3.2.3: the order is that of UTF-16 code
    // units, not of code points. The G clef (U+1D11E) therefore precedes the
    // emoji (U+1F602), but both come after U+2764.
    spec: {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      '\n': 'Newline',
      '1': 'One',
      '\u0080': 'Control',
      '😂': 'Smiley',
      'ö': 'Latin Small Letter O With Diaeresis',
      '': 'Empty',
      '❤️': 'Heart',
      '𝄞': 'G Clef',
    },
  },
  {
    name: 'raw/nested-structure-sorting',
    type: 'raw',
    // Structure from RFC 8785 § 3.2.3, with integers rather than floats so the
    // vector stays comparable across languages without depending on how each
    // formats doubles.
    spec: {
      '1': { f: { f: 'hi', F: 5 }, '\n': 56 },
      '10': {},
      '': 'empty',
      a: {},
      '111': [{ e: 'yes', E: 'no' }],
      A: {},
    },
  },
  {
    name: 'raw/string-escapes',
    type: 'raw',
    // Echappements courts, controle generique en \u00xx, et caracteres
    // non-ASCII laisses litteraux en UTF-8.
    spec: {
      quote: '"',
      backslash: '\\',
      slash: '/',
      backspace: '\b',
      formfeed: '\f',
      newline: '\n',
      carriage: '\r',
      tab: '\t',
      nul: '\u0000',
      unit_separator: '\u001f',
      del: '\u007f',
      accents: 'caution déposée — 1 500 €',
      cjk: '保証',
      emoji: '🛡️',
    },
  },
  {
    name: 'raw/scalars-and-empty-containers',
    type: 'raw',
    spec: {
      nullValue: null,
      trueValue: true,
      falseValue: false,
      zero: 0,
      negative: -1,
      emptyObject: {},
      emptyArray: [],
      emptyString: '',
    },
  },
  {
    name: 'raw/array-order-is-preserved',
    type: 'raw',
    // JCS sorts object keys, never the elements of an array.
    spec: {
      z: [3, 2, 1],
      a: [{ b: 1, a: 2 }, [2, 1]],
    },
  },
  {
    name: 'raw/uint256-amounts-as-decimal-strings',
    type: 'raw',
    // Rule 3 of docs/07 § 4: never a `number` for an amount. These values
    // depassent toutes Number.MAX_SAFE_INTEGER (9007199254740991).
    spec: {
      maxUint256: UINT256_MAX_STR,
      oneWeiOverSafeInteger: '9007199254740992',
      oneEther: '1000000000000000000',
      healthFactor: '1500000000000000000',
      negativeDelta: '-115792089237316195423570985008687907853269984665640564039457584007913129639935',
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // Un vecteur par `kind` du catalogue (docs/07 § 2)
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'check/erc20_allowance',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'erc20_allowance',
          token: USDC_ETH,
          owner: TREASURY,
          spender: SUSPICIOUS,
          op: 'eq',
          value: '0',
        },
      ],
    },
  },
  {
    name: 'check/erc20_balance',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 8453,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        {
          kind: 'erc20_balance',
          token: USDC_BASE,
          account: ALLOWED_DEST,
          op: 'gte',
          value: '1000000',
        },
      ],
    },
  },
  {
    name: 'check/erc20_balance_delta-negative',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 8453,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        {
          kind: 'erc20_balance_delta',
          token: USDC_BASE,
          account: TREASURY,
          op: 'gte',
          value: '-1000000000',
        },
      ],
    },
  },
  {
    name: 'check/native_balance_delta',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx+1',
      confirmations: 12,
      checks: [
        {
          kind: 'native_balance_delta',
          account: TREASURY,
          op: 'gte',
          value: '-50000000000000000',
        },
      ],
    },
  },
  {
    name: 'check/aave_health_factor',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'aave_health_factor',
          pool: AAVE_POOL,
          user: TREASURY,
          op: 'gte',
          value: '1500000000000000000',
        },
      ],
    },
  },
  {
    name: 'check/staticcall_result-uint256',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'staticcall_result',
          target: USDT,
          data: '0x70a082310000000000000000000000001111111111111111111111111111111111111111',
          decodeAs: 'uint256',
          op: 'lte',
          value: UINT256_MAX_STR,
        },
      ],
    },
  },
  {
    name: 'check/staticcall_result-bytes32',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: { block: 21000000 },
      confirmations: 12,
      checks: [
        {
          kind: 'staticcall_result',
          target: USDT,
          data: '0x06fdde03',
          decodeAs: 'bytes32',
          op: 'eq',
          value: TOPIC_APPROVAL,
        },
      ],
    },
  },
  {
    name: 'check/event_emitted',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'event_emitted',
          address: USDT,
          topic0: TOPIC_APPROVAL,
          minCount: 1,
        },
      ],
    },
  },
  {
    name: 'check/nonce_advanced',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'nonce_advanced',
          account: AGENT_EXEC,
          op: 'eq',
          value: '1',
        },
      ],
    },
  },
  {
    name: 'check/no_new_approvals',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'no_new_approvals',
          owner: TREASURY,
          tokens: [USDT, USDC_ETH],
        },
      ],
    },
  },
  {
    name: 'check/calldata_matches_commitment',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        { kind: 'nonce_advanced', account: AGENT_EXEC, op: 'eq', value: '1' },
        { kind: 'calldata_matches_commitment', actionHash: ACTION_HASH },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // Normalisation: address casing, injected defaults, coerced amounts
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'normalize/checksummed-addresses-are-lowercased',
    type: 'conditionSpec',
    // Same spec as `check/erc20_allowance` but with the addresses in mixed
    // EIP-55 partout : le hash doit etre identique a celui de ce vecteur.
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'erc20_allowance',
          token: USDC_ETH.toUpperCase().replace('0X', '0x'),
          owner: TREASURY,
          spender: SUSPICIOUS,
          op: 'eq',
          value: '0',
        },
      ],
    },
  },
  {
    name: 'normalize/defaults-are-injected',
    type: 'conditionSpec',
    // `version`, `evaluateAt` and `confirmations` are omitted: normalisation
    // injects 1, "tx" and 12 (chainId 1 = L1). `minCount` is omitted: 1.
    spec: {
      chainId: 1,
      checks: [
        {
          kind: 'event_emitted',
          address: USDT,
          topic0: TOPIC_APPROVAL,
        },
      ],
    },
  },
  {
    name: 'normalize/amounts-are-canonical-decimals',
    type: 'conditionSpec',
    // `"0000"`, `"+42"` and `"-0"` are brought back to canonical form.
    spec: {
      version: 1,
      chainId: 8453,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        {
          kind: 'erc20_allowance',
          token: USDC_BASE,
          owner: TREASURY,
          spender: SUSPICIOUS,
          op: 'eq',
          value: '0000',
        },
        {
          kind: 'erc20_balance',
          token: USDC_BASE,
          account: ALLOWED_DEST,
          op: 'gte',
          value: '+42',
        },
        {
          kind: 'native_balance_delta',
          account: TREASURY,
          op: 'gte',
          value: '-0',
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // Specs completes — docs/07 § 6
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'spec/allowance-revocation-bankr',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'erc20_allowance',
          token: USDT,
          owner: TREASURY,
          spender: SUSPICIOUS,
          op: 'eq',
          value: '0',
        },
        { kind: 'no_new_approvals', owner: TREASURY, tokens: [USDT] },
        {
          kind: 'erc20_balance_delta',
          token: USDT,
          account: TREASURY,
          op: 'gte',
          value: '0',
        },
        { kind: 'calldata_matches_commitment', actionHash: ACTION_HASH },
      ],
    },
  },
  {
    name: 'spec/aave-rebalancing',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 1,
      evaluateAt: 'tx',
      confirmations: 12,
      checks: [
        {
          kind: 'aave_health_factor',
          pool: AAVE_POOL,
          user: TREASURY,
          op: 'gte',
          value: '1500000000000000000',
        },
        { kind: 'nonce_advanced', account: AGENT_EXEC, op: 'eq', value: '1' },
        { kind: 'calldata_matches_commitment', actionHash: ACTION_HASH },
      ],
    },
  },
  {
    name: 'spec/bounded-outbound-transfer',
    type: 'conditionSpec',
    spec: {
      version: 1,
      chainId: 8453,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        {
          kind: 'erc20_balance_delta',
          token: USDC_BASE,
          account: TREASURY,
          op: 'gte',
          value: '-1000000000',
        },
        {
          kind: 'erc20_balance',
          token: USDC_BASE,
          account: ALLOWED_DEST,
          op: 'gte',
          value: '1000000000',
        },
        { kind: 'calldata_matches_commitment', actionHash: ACTION_HASH },
      ],
    },
  },
  {
    name: 'spec/full-quota-eight-declared-checks',
    type: 'conditionSpec',
    // 8 checks declares + le commitment hors quota = 9 entrees, legal.
    spec: {
      version: 1,
      chainId: 8453,
      evaluateAt: 'tx',
      confirmations: 3,
      checks: [
        { kind: 'erc20_allowance', token: USDC_BASE, owner: TREASURY, spender: SUSPICIOUS, op: 'eq', value: '0' },
        { kind: 'erc20_balance', token: USDC_BASE, account: TREASURY, op: 'gte', value: '1' },
        { kind: 'erc20_balance_delta', token: USDC_BASE, account: TREASURY, op: 'gte', value: '-1' },
        { kind: 'native_balance_delta', account: TREASURY, op: 'gte', value: '-1' },
        { kind: 'aave_health_factor', pool: AAVE_POOL, user: TREASURY, op: 'gte', value: '1000000000000000000' },
        { kind: 'staticcall_result', target: USDC_BASE, data: '0x18160ddd', decodeAs: 'uint256', op: 'lte', value: UINT256_MAX_STR },
        { kind: 'event_emitted', address: USDC_BASE, topic0: TOPIC_APPROVAL, minCount: 2 },
        { kind: 'no_new_approvals', owner: TREASURY, tokens: [USDC_BASE, USDT] },
        { kind: 'calldata_matches_commitment', actionHash: ACTION_HASH },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // ActionSpec — docs/07 § 4
  // ───────────────────────────────────────────────────────────────────────
  {
    name: 'action/erc20-transfer',
    type: 'actionSpec',
    spec: {
      version: 1,
      chainId: 1,
      target: USDC_ETH,
      value: '0',
      calldata:
        '0xa9059cbb0000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000000000000000003b9aca00',
      registryRef: REGISTRY_REF,
    },
  },
  {
    name: 'action/native-value-max-uint256',
    type: 'actionSpec',
    spec: {
      version: 1,
      chainId: 8453,
      target: ALLOWED_DEST,
      value: UINT256_MAX_STR,
      calldata: '0x',
      registryRef: REGISTRY_REF,
    },
  },
]

export function buildFixtures(inputs: FixtureInput[] = VECTORS): Fixture[] {
  const seen = new Set<string>()
  return inputs.map((input) => {
    if (seen.has(input.name)) {
      throw new Error(`duplicate fixture name: ${input.name}`)
    }
    seen.add(input.name)

    let canonical: string
    let hash: `0x${string}`
    switch (input.type) {
      case 'raw':
        canonical = canonicalize(input.spec)
        hash = hashCanonical(canonical)
        break
      case 'conditionSpec':
        // Guard: a shared vector must be a legal spec once
        // normalisee, sinon on pinerait un hash inatteignable.
        validateConditionSpec(normalizeConditionSpec(input.spec), {
          allowCommitmentCheck: true,
        })
        canonical = canonicalConditionSpec(input.spec)
        hash = conditionHash(input.spec)
        break
      case 'actionSpec':
        canonical = canonicalActionSpec(input.spec)
        hash = actionHash(input.spec)
        break
    }
    return { name: input.name, type: input.type, spec: input.spec, canonical, hash }
  })
}

export const FIXTURES_PATH = new URL(
  '../fixtures/condition-hashes.json',
  import.meta.url,
)

async function main(): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  const fixtures = buildFixtures()
  const path = fileURLToPath(FIXTURES_PATH)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(fixtures, null, 2)}\n`, 'utf8')
  // eslint-disable-next-line no-console
  console.log(`wrote ${fixtures.length} vectors to ${path}`)
}

// This module is a *script*, not a library: loading it regenerates the file.
// Nothing in `src/` may import it — `canonical.test.ts` re-reads the committed
// JSON and recomputes the hashes from the `spec`, which proves
// l'accord entre le fixture et l'implementation sans dependre de ce script.
await main()
