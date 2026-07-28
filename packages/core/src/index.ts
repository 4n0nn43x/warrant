/**
 * @warrant/core — le noyau agnostique de Warrant.
 *
 * Aucune E/S, aucun réseau, aucune clé. Tout ce qui est ici est pur et
 * rejouable par un tiers : c'est la condition pour qu'un verdict soit
 * vérifiable sans nous faire confiance.
 */

export * from './types.js'
export * from './constants.js'

// Canonicalisation et engagement — une seule implémentation, jamais deux.
// Une divergence entre client et serveur rendrait tout mandat inévaluable
// (risque R1 de docs/13-risques.md).
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

// DSL de post-conditions.
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

// Classification — la catégorie est dérivée du calldata, jamais déclarée.
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

// Politique et tarification.
export {
  type CategoryPolicyExtras,
  type PolicyExtras,
  type BuildConditionOptions,
  DEFAULT_MIN_HEALTH_FACTOR,
  PolicyError,
  buildConditionSpec,
} from './policy.js'
export { RiskError, priceRisk, clamp, bondFor } from './risk.js'
