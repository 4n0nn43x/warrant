/**
 * @warrant/core — Warrant's agnostic kernel.
 *
 * No I/O, no network, no keys. Everything here is pure and replayable by a third
 * party: that is the condition for a verdict to be verifiable without trusting
 * us.
 */

export * from './types.js'
export * from './constants.js'

// Canonicalization and commitment — one implementation, never two.
// A divergence between client and server would make every warrant unevaluable
// (risk R1 of docs/13-risques.md).
export {
  canonicalize,
  CanonicalizationError,
} from './canonical.js'
export {
  NormalizationError,
  defaultConfirmations,
  normalize,
  normalizeConditionSpec,
  normalizeActionSpec,
  hashCanonical,
  canonicalConditionSpec,
  canonicalActionSpec,
  conditionHash,
  actionHash,
} from './hash.js'

// Post-condition DSL.
export {
  type DslIssue,
  DslError,
  CHECK_KINDS,
  OPS,
  DECODE_AS,
  COMMITMENT_KIND,
  MAX_WATCHED_TOKENS,
  isAddress,
  isHexBytes,
  isHexData,
  isCanonicalDecimal,
  type ValidateOptions,
  type ValidationResult,
  safeValidateConditionSpec,
  validateConditionSpec,
  validateGatewayConditionSpec,
  validateActionSpec,
  injectCommitmentCheck,
} from './dsl.js'

// Classification — the category is derived from the calldata, never declared.
export {
  type ClassificationErrorCode,
  ClassificationError,
  USD_DECIMALS,
  classify,
} from './classifier.js'
export {
  type RegistryFile,
  type RegistryFileEntry,
  type RegistryAsset,
  type RegistryRouter,
  RegistryError,
  canonicalizeRegistry,
  registryRefOf,
  entryKey,
  assetKey,
  assertRegistryConsistent,
  parseRegistry,
  loadRegistry,
  mainnetRegistryRef,
} from './registry.js'

// Policy and pricing.
export {
  type CategoryPolicyExtras,
  type PolicyExtras,
  type BuildConditionOptions,
  DEFAULT_MIN_HEALTH_FACTOR,
  PolicyError,
  buildConditionSpec,
} from './policy.js'
export { RiskError, priceRisk, clamp, bondFor } from './risk.js'
