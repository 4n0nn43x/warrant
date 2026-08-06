#!/usr/bin/env bash
#
# Replays a Warrant verdict from a `warrantId` alone.
#
# ─────────────────────────────────────────────────────────────────────────────
# What this script is
# ─────────────────────────────────────────────────────────────────────────────
#
# The executable counterpart of the sentence "we do not ask for trust, we make
# the verdict reproducible". It reads no `.env`, knows none of our keys, talks to
# none of our servers: a public RPC, a public git repository, `cast` and `jq`.
# This is the manual for a jury that wants to verify instead of believe.
#
# Six checks, in the order they chain together:
#
#   1. The warrant exists onchain, and its `status` says what the protocol did.
#   2. The verdict document is retrievable at the URI derived from `warrantId`.
#   3. `keccak256` of the retrieved bytes = the committed `feedbackHash` (ERC-8004).
#      A slash is committed on its own; an honored warrant is committed inside a
#      **batch**, so its individual document — published so that every warrant has
#      a page — is the preimage of no onchain hash. The step then follows
#      `index.json` to the batch that carries it and checks that hash instead,
#      naming which form held the proof. Without that indirection, 47 of the 57
#      published verdicts would report a divergence against a registry that holds
#      their commitment perfectly.
#   4. Onchain `conditionHash` and `actionHash` = keccak of the document's specs:
#      the document really does describe the warrant we read, not another one.
#   5. Onchain `fundingRef` = `termsHash(...)` recomputed by the contract itself
#      over the warrant's fields — the signed terms have not moved.
#   6. The `checks[]` are replayed against the chain, at the published pinned
#      block, and the verdict is recomputed. It must equal the document's, and the
#      document must equal what the onchain `status` says.
#
# ─────────────────────────────────────────────────────────────────────────────
# Two assumptions, stated because they are refutable
# ─────────────────────────────────────────────────────────────────────────────
#
# a) `jq -cS` is used as a JCS serialiser to rehash the document's sub-objects
#    (`conditionSpec`, `actionSpec`). That is exact here — ASCII keys, byte-wise
#    sorting, compact output, and every number is a short integer, outside the
#    range where jq loses precision. It is not exact in general: a float or an
#    integer beyond 2^53 would require the real implementation
#    (`packages/core/src/canonical.ts`). If step 4 fails while everything else
#    passes, that is the first thing to suspect.
# b) The document is already canonical — it is so by construction, that is what
#    `verdicts.ts` writes. Step 3 verifies this as a side effect: a reformatted
#    document no longer produces the committed `feedbackHash`.
#
# `kh` (the KeeperHub CLI) is used when present, to cross-check the execution.
# Its absence takes nothing away: the document's transaction hash is verified
# against the chain, which is the authority. The script says so and carries on.
#
# Usage:
#   scripts/replay-verdict.sh <warrantId> [options]
#
#   --rpc URL         public, archive-capable RPC (default: sepolia.base.org)
#   --escrow ADDR     WarrantEscrow (default: the Base Sepolia deployment)
#   --source SRC      base URI, directory or file of the verdict document
#   --registry ADDR   ERC-8004 ReputationRegistry, used to find the
#                     `feedbackHash` in a `NewFeedback` event
#   --span N          width of the block window scanned with --registry (200).
#                     `sepolia.base.org` refuses ranges wider than 2,000 blocks:
#                     beyond that, `eth_getLogs` fails and step 3 reports "silent".
#                     A batch is looked for over six such windows, walked one at a
#                     time: it is flushed once its last member has settled, which
#                     lands its event 400 to 800 blocks later on Base Sepolia.
#
# Exit: 0 the verdict reproduces, 1 divergence, 2 usage error.

set -euo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────────
# Public, without exception: this script must run on a machine that has never
# seen this repository.
RPC="https://sepolia.base.org"
ESCROW="0x3ae9ad53686383c80889F550065e810f72c2ff4e"
BASE_URI="https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/"
REGISTRY=""
SPAN=200
SOURCE=""
# Same name as `VERDICT_INDEX_FILE` on the server side: this is the entry point
# for a third party who has only a `warrantId` and not our journal.
VERDICT_INDEX="index.json"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${SCRIPT_DIR}/../verdicts"

# ─── Rendering ───────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; Z=$'\033[0m'
else
  B=""; DIM=""; GREEN=""; RED=""; YELLOW=""; Z=""
fi

FAILURES=0
SKIPPED=0

section() { printf '\n%s── %s%s\n' "$B" "$1" "$Z"; }

# Manual alignment: `printf '%-22s'` counts bytes, so any non-ASCII label would
# be padded short. `${#s}` counts characters in a UTF-8 locale.
field() {
  local pad=$((23 - ${#1}))
  [ "$pad" -lt 1 ] && pad=1
  printf '  %s%*s%s\n' "$1" "$pad" "" "$2"
}
ok()      { printf '  %s[ok]%s %s\n' "$GREEN" "$Z" "$1"; }
bad()     { printf '  %s[!!]%s %s\n' "$RED" "$Z" "$1"; FAILURES=$((FAILURES + 1)); }
skip()    { printf '  %s[--]%s %s\n' "$YELLOW" "$Z" "$1"; SKIPPED=$((SKIPPED + 1)); }
note()    { printf '  %s%s%s\n' "$DIM" "$1" "$Z"; }
die()     { printf '%serror:%s %s\n' "$RED" "$Z" "$1" >&2; exit 2; }

# `ok`/`bad` on the equality of two values, with the discrepancy shown when there
# is one. Every comparison in the script goes through here: a replay that said
# "ok" without showing what it compared would be worth no more than a promise.
expect_eq() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    ok "${label} = ${got}"
  else
    bad "${label}: expected ${want}, got ${got}"
  fi
}

# ─── Arguments ───────────────────────────────────────────────────────────────
WARRANT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '/^# Usage:/,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --rpc)      RPC="${2:?--rpc expects a URL}"; shift 2 ;;
    --escrow)   ESCROW="${2:?--escrow expects an address}"; shift 2 ;;
    --source)   SOURCE="${2:?--source expects a URI, a directory or a file}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry expects an address}"; shift 2 ;;
    --span)     SPAN="${2:?--span expects a number of blocks}"; shift 2 ;;
    -*) die "unknown option: $1" ;;
    *)  [ -z "$WARRANT_ID" ] || die "one warrantId at a time"; WARRANT_ID="$1"; shift ;;
  esac
done

[ -n "$WARRANT_ID" ] || die "usage: $(basename "$0") <warrantId> [--rpc URL] [--source SRC]"
command -v cast >/dev/null || die "cast (Foundry) is required: https://getfoundry.sh"
command -v jq >/dev/null || die "jq is required"
# python3 is used purely for arithmetic: the amounts are uint256, which both the
# shell (64-bit) and jq (double float) would truncate. A rounded comparison would
# turn a verdict into a lottery — the same reason `bigint` is mandatory throughout
# checks/compare.ts.
command -v python3 >/dev/null || die "python3 is required (uint256 arithmetic)"

# Lowercase throughout: this is the project's canonical form for addresses and
# hashes (docs/07 § 4 rule 2), and the form of the filename and the URI.
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

WARRANT_ID="$(lc "$WARRANT_ID")"
[[ "$WARRANT_ID" =~ ^0x[0-9a-f]{64}$ ]] || die "malformed warrantId: $WARRANT_ID"

printf '%swarrant replay%s  %s\n' "$B" "$Z" "$WARRANT_ID"
note "rpc    ${RPC}"
note "escrow ${ESCROW}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. The warrant, read onchain
# ─────────────────────────────────────────────────────────────────────────────
section "1. onchain warrant"

# The flattened public getter returns ten values, one per line. `feeBpsAtOpen` is
# in ninth position, BEFORE `status`: reading `status` as the eighth would give
# 250, which is no known status (see escrow-abi.ts).
WARRANT_RAW="$(cast call "$ESCROW" \
  'warrants(bytes32)(address,address,uint256,bytes32,bytes32,bytes32,uint64,uint64,uint16,uint8)' \
  "$WARRANT_ID" --rpc-url "$RPC")" || die "cannot read the warrant on ${RPC}"

# `cast` annotates integers (`200000 [2e5]`): keep only the first field.
# `while read` rather than `mapfile`, which does not exist in the bash 3.2 shipped
# by macOS — a verification script that only runs on our machines would miss its
# target.
W=()
while IFS= read -r line; do W+=("$line"); done < <(printf '%s\n' "$WARRANT_RAW" | awk 'NF {print $1}')
[ "${#W[@]}" -eq 10 ] || die "unexpected response from the warrants() getter: $WARRANT_RAW"

AGENT="${W[0]}" BENEFICIARY="${W[1]}" BOND="${W[2]}"
CONDITION_HASH="$(lc "${W[3]}")"
ACTION_HASH="$(lc "${W[4]}")"
FUNDING_REF="$(lc "${W[5]}")"
EXPIRY="${W[6]}" OPENED_AT="${W[7]}" FEE_BPS="${W[8]}" STATUS="${W[9]}"

case "$STATUS" in
  0) die "no warrant under that id at that address (status=None)" ;;
  1) STATUS_NAME="Open"      ; ONCHAIN_VERDICT="" ;;
  2) STATUS_NAME="Honored"   ; ONCHAIN_VERDICT="honored" ;;
  3) STATUS_NAME="Slashed"   ; ONCHAIN_VERDICT="slashed" ;;
  4) STATUS_NAME="Reclaimed" ; ONCHAIN_VERDICT="" ;;
  *) die "unknown status: ${STATUS}" ;;
esac

field "agent"         "$AGENT"
field "beneficiary"   "$BENEFICIARY"
field "bond"          "${BOND} (atomic unit of the token)"
field "conditionHash" "$CONDITION_HASH"
field "actionHash"    "$ACTION_HASH"
field "fundingRef"    "$FUNDING_REF"
field "feeBpsAtOpen"  "$FEE_BPS"
field "status"        "${STATUS} (${STATUS_NAME})"

# `fundingRef` is the EIP-3009 nonce, and that nonce IS the hash of the terms:
# signing the payment authorization amounts to signing the warrant. We have the
# contract recompute it, over the fields we have just read.
DURATION=$((EXPIRY - OPENED_AT))
TERMS_HASH="$(lc "$(cast call "$ESCROW" \
  'termsHash(bytes32,address,uint256,bytes32,bytes32,uint64)(bytes32)' \
  "$WARRANT_ID" "$BENEFICIARY" "$BOND" "$CONDITION_HASH" "$ACTION_HASH" "$DURATION" \
  --rpc-url "$RPC")")"
expect_eq "fundingRef = termsHash(warrant)" "$FUNDING_REF" "$TERMS_HASH"

# ─────────────────────────────────────────────────────────────────────────────
# 2. The verdict document
# ─────────────────────────────────────────────────────────────────────────────
section "2. verdict document"

DOC=""
DOC_ORIGIN=""
# The source the document was finally read from. Step 3 needs it to look for the
# batch in the same place, rather than guessing a second time.
RESOLVED_SRC=""
BATCH_BODY=""
BATCH_ORIGIN=""

# Silent on HTTP error: a 404 on the public URI is an expected case (the verdict
# has not been pushed yet), not an incident to dump raw.
fetch_http() {
  command -v curl >/dev/null || return 1
  curl -fsL --max-time 20 "$1"
}

# A source is either an HTTP base or a directory: both expose the same relative
# tree (`<id>`, `index.json`, `batch/<hash>`), which is the whole point of having
# aligned the local server with git-raw.
fetch_rel() {
  local src="${1%/}" rel="$2"
  case "$src" in
    http://*|https://*) fetch_http "${src}/${rel}" ;;
    *) [ -f "${src}/${rel}" ] && cat "${src}/${rel}" ;;
  esac
}

try_source() {
  local src="$1" body=""
  case "$src" in
    http://*|https://*)
      # A base ends with `/`; otherwise it is the document's full URL.
      case "$src" in */) src="${src}${WARRANT_ID}" ;; esac
      body="$(fetch_http "$src")" || return 1
      ;;
    *)
      [ -d "$src" ] && src="${src%/}/${WARRANT_ID}"
      [ -f "$src" ] || return 1
      body="$(cat "$src")" || return 1
      ;;
  esac
  [ -n "$body" ] || return 1
  DOC="$body"
  DOC_ORIGIN="$src"
}

# An honored warrant does not necessarily have a document of its own: beyond
# `ERC8004_BATCH_SIZE`, the Settler aggregates N verdicts into a batch document,
# committed under a single `feedbackHash`. The warrant is then inside `warrants[]`
# of a `batch/<hash>` file, and the index is the only way to find it — without it,
# a batch-settled `warrantId` would be unverifiable by a third party.
# Locates the batch that carries `$WARRANT_ID` and publishes it through the
# globals `BATCH_BODY` / `BATCH_ORIGIN`. Deliberately **not** a function that
# echoes its result: a command substitution runs in a subshell, so the origin
# would be lost on the way out and the report would name no file.
#
# Two callers need it, for two different reasons:
#
#   - resolving a warrant that has no document of its own;
#   - finding the form that actually carries the ERC-8004 commitment, now that
#     the individual documents of batch-settled warrants are published too.
#
# The index is the only way in: a batch is addressed by its own hash, which
# nothing in the warrant's identifier predicts.
find_batch() {
  local src="$1" index="" hash="" body=""
  BATCH_BODY=""
  BATCH_ORIGIN=""
  index="$(fetch_rel "$src" "$VERDICT_INDEX")" || return 1
  [ -n "$index" ] || return 1
  for hash in $(printf '%s' "$index" | jq -r '.batches[]?.uri' | awk -F/ '{print $NF}'); do
    body="$(fetch_rel "$src" "batch/${hash}")" || continue
    [ -n "$body" ] || continue
    if printf '%s' "$body" \
      | jq -e --arg id "$WARRANT_ID" '[.warrants[]? | select((.warrantId | ascii_downcase) == $id)] | length > 0' \
        >/dev/null 2>&1; then
      BATCH_BODY="$body"
      BATCH_ORIGIN="${src%/}/batch/${hash}"
      return 0
    fi
  done
  return 1
}

try_batch() {
  find_batch "$1" || return 1
  DOC="$BATCH_BODY"
  DOC_ORIGIN="$BATCH_ORIGIN"
}

resolve_from() { RESOLVED_SRC="$1"; try_source "$1" || try_batch "$1"; }

if [ -n "$SOURCE" ]; then
  resolve_from "$SOURCE" || die "no document found at ${SOURCE} (neither a warrant document nor an indexed batch)"
else
  # The public URI first — it is the one recorded onchain, hence the only one
  # whose availability proves anything. The local copy second, so the script is
  # also useful before the push: a verdict is written at settlement and committed
  # afterwards; the window exists and must be named.
  if resolve_from "$BASE_URI"; then
    :
  elif resolve_from "$LOCAL_DIR"; then
    note "the public URI does not answer yet: reading the repository's local copy."
    note "a third party can only verify after verdicts/ is committed and pushed."
  else
    die "no document found, neither at ${BASE_URI}${WARRANT_ID} nor in ${LOCAL_DIR}"
  fi
fi

field "origin" "$DOC_ORIGIN"
printf '%s' "$DOC" | jq -e . >/dev/null 2>&1 || die "the retrieved document is not JSON"

# Three document shapes, a single projection to replay:
#   - raw `VerdictDocument`     → the fields are at the root;
#   - `SingleFeedbackDocument`  → under `warrant`;
#   - `BatchFeedbackDocument`   → inside `warrants[]`, to be found by id.
# What gets hashed remains the whole document; what gets replayed is the
# projection. The two are distinct and stay that way.
DOC_SHAPE="$(printf '%s' "$DOC" | jq -r '
  if has("warrants") then "batch" elif has("warrant") then "feedback" else "verdict" end')"
REC="$(printf '%s' "$DOC" | jq -c --arg id "$WARRANT_ID" '
  if has("warrants") then (.warrants[] | select((.warrantId | ascii_downcase) == $id))
  elif has("warrant") then .warrant
  else . end')"
[ -n "$REC" ] || die "the retrieved document does not contain warrant ${WARRANT_ID}"
r() { printf '%s' "$REC" | jq -r "$1"; }

field "shape" "$DOC_SHAPE"
if [ "$DOC_SHAPE" = "batch" ]; then
  note "batch document: $(printf '%s' "$DOC" | jq -r '.warrants | length') warrant(s) under a single feedbackHash."
fi

DOC_WARRANT_ID="$(r '.warrantId // ""')"
TX_HASH="$(r '.txHash // ""')"
BLOCK_NUMBER="$(r '.blockNumber // ""')"
EVAL_BLOCK="$(r '.evaluatedAtBlock // ""')"
DOC_VERDICT="$(r '.verdict // ""')"
DOC_RPC="$(r '.rpcUrl // ""')"
EXECUTION_ID="$(r '.executionId // ""')"
SETTLEMENT_TX="$(r '.settlementTx // ""')"
CHECK_COUNT="$(r '.checks | length')"

field "warrantId"        "$DOC_WARRANT_ID"
field "verdict"          "$DOC_VERDICT"
field "txHash (action)"  "$TX_HASH"
field "blockNumber"      "$BLOCK_NUMBER"
field "evaluatedAtBlock" "$EVAL_BLOCK"
field "rpcUrl published"  "$DOC_RPC"
field "settlementTx"     "${SETTLEMENT_TX:-null}"
field "checks"           "$CHECK_COUNT"

expect_eq "the document really is about this warrant" "$WARRANT_ID" "$DOC_WARRANT_ID"

# ─────────────────────────────────────────────────────────────────────────────
# 3. The commitment: keccak256 of the served bytes
# ─────────────────────────────────────────────────────────────────────────────
section "3. document commitment"

# Hash of the EXACT bytes received, not of a re-serialisation. `printf '%s'` adds
# no newline: an `echo` here would invalidate the hash of every valid document,
# which is the nastiest kind of false positive.
FEEDBACK_HASH="$(printf '%s' "$DOC" | cast keccak | tr 'A-F' 'a-f')"
field "keccak256(document)" "$FEEDBACK_HASH"
note "this is the value committed in NewFeedback.feedbackHash (ERC-8004)."

if [ -n "$REGISTRY" ]; then
  # The window starts at **settlement**, not at the action: the feedback is
  # written in the same daemon pass, a few blocks after `honor`/`slash`. Starting
  # from the action's block would pointlessly scan the warrant's whole lifetime.
  FROM_BLOCK="$BLOCK_NUMBER"
  if [ -n "$SETTLEMENT_TX" ] && [ "$SETTLEMENT_TX" != "null" ]; then
    FROM_BLOCK="$(cast receipt "$SETTLEMENT_TX" --rpc-url "$RPC" --json 2>/dev/null \
      | jq -r '.blockNumber' | while IFS= read -r h; do cast to-dec "$h"; done)" || FROM_BLOCK="$BLOCK_NUMBER"
  fi
  TO_BLOCK=$((FROM_BLOCK + SPAN))
  note "searching NewFeedback over [${FROM_BLOCK}, ${TO_BLOCK}]…"

  # `feedbackHash` is not indexed: it cannot be filtered by topic, so we look for
  # it in the data of the registry's logs. An unfiltered `eth_getLogs` is slow on a
  # public endpoint, hence the narrow window and the timeout guard: a verification
  # script that looks hung will not be re-run by a jury.
  # `if/elif` rather than a loop: under `set -e`, a loop whose last iteration fails
  # exits the script — here, on a machine without `timeout`, that is to say a macOS
  # without coreutils.
  #
  # ⚠ The signature has **five** `string`s, not four: `indexedTag1` is a
  # `string indexed`, and an indexed parameter still counts in the canonical
  # signature whose topic0 we hash. Omitting it yields 0x8f29270f… instead of
  # 0x6a4a6174…, a topic0 no log carries — and the script then concluded "silent
  # registry" about a registry that was answering perfectly. The worst kind of
  # false negative: it looks like an RPC limitation.
  TIMEOUT_BIN=""
  if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
  fi
  FEEDBACK_SIG='NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'

  # Echoes the registry's logs over [$1, $2]. Never fails the script: an RPC that
  # refuses a range is a limitation to report, not a divergence to declare.
  feedback_logs() {
    $TIMEOUT_BIN ${TIMEOUT_BIN:+90} cast logs --rpc-url "$RPC" --address "$REGISTRY" \
      "$FEEDBACK_SIG" --from-block "$1" --to-block "$2" 2>/dev/null || true
  }

  LOGS="$(feedback_logs "$FROM_BLOCK" "$TO_BLOCK")"

  if [ -z "$LOGS" ]; then
    skip "no readable NewFeedback over the window (silent registry, or an RPC that refuses the scan)"
    note "reduce --span, or aim at an RPC that serves eth_getLogs over ranges."
  elif printf '%s' "$LOGS" | tr 'A-F' 'a-f' | grep -q "${FEEDBACK_HASH#0x}"; then
    ok "feedbackHash found in a NewFeedback event of the registry"
  elif ! printf '%s' "$DOC" | jq -e 'has("agentId")' >/dev/null 2>&1; then
    # No ERC-8004 identity in the document: the warrant was settled by an agent
    # that had none, so there is no feedback to find — by construction, not by
    # accident. Calling that a divergence would flag an honest gap as a lie.
    skip "this document carries no ERC-8004 commitment (no agentId): nothing to find in the registry"
    note "the other steps still bind it to the onchain warrant — they do not involve ERC-8004."
  elif [ "$DOC_SHAPE" != "batch" ] && find_batch "$RESOLVED_SRC"; then
    # Honored warrants are committed **by batch**: one ERC-8004 feedback for N
    # verdicts. The individual document is genuine Settler output, published so
    # that each warrant has a readable page — but it is the preimage of no
    # onchain hash. The commitment is the batch's, and the index is what links
    # the two.
    BATCH_HASH="$(printf '%s' "$BATCH_BODY" | cast keccak | tr 'A-F' 'a-f')"
    note "the individual document is not the ERC-8004 preimage: this warrant was committed in a batch."
    field "batch document"  "$BATCH_ORIGIN"
    field "keccak256(batch)" "$BATCH_HASH"

    # The window has to be recomputed, not reused. A batch is flushed once its
    # LAST member has settled, and the flush is periodic: measured on Base
    # Sepolia, the event lands 400 to 800 blocks after the batch's earliest
    # member. Anchoring on *this* warrant's settlement — what the single-document
    # path does — therefore looks past the event whenever the warrant is not the
    # last of its batch, and reports a divergence about a registry that holds the
    # commitment perfectly.
    #
    # We restart from the batch's latest member and walk forward in SPAN-sized
    # chunks rather than issuing one wide range: an unfiltered `eth_getLogs` over
    # a thousand blocks is exactly what public endpoints refuse.
    BATCH_FROM="$(printf '%s' "$BATCH_BODY" | jq -r '[.warrants[].blockNumber | tonumber] | max')"
    BATCH_TO=$((BATCH_FROM + SPAN * 6))
    note "the batch is written after its last member: searching over [${BATCH_FROM}, ${BATCH_TO}]…"

    BATCH_FOUND=0
    CHUNK_FROM="$BATCH_FROM"
    while [ "$CHUNK_FROM" -lt "$BATCH_TO" ]; do
      CHUNK_TO=$((CHUNK_FROM + SPAN))
      [ "$CHUNK_TO" -gt "$BATCH_TO" ] && CHUNK_TO="$BATCH_TO"
      if feedback_logs "$CHUNK_FROM" "$CHUNK_TO" | tr 'A-F' 'a-f' | grep -q "${BATCH_HASH#0x}"; then
        BATCH_FOUND=1
        note "found in [${CHUNK_FROM}, ${CHUNK_TO}]"
        break
      fi
      CHUNK_FROM="$CHUNK_TO"
    done

    if [ "$BATCH_FOUND" -eq 1 ]; then
      ok "the batch's feedbackHash is carried by a NewFeedback event of the registry"
    else
      bad "neither the document nor its batch ${BATCH_HASH} appears over [${BATCH_FROM}, ${BATCH_TO}]"
    fi
  else
    bad "no NewFeedback in the window carries ${FEEDBACK_HASH}"
  fi
else
  skip "no ERC-8004 registry supplied (--registry): commitment not cross-checked onchain"
  note "steps 4 and 5 still bind the document to the onchain warrant."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. The document's specs = the ones committed at open
# ─────────────────────────────────────────────────────────────────────────────
section "4. committed specs"

# `jq -cS` as a JCS serialiser — see assumption (a) at the top of the file.
jcs_hash() { printf '%s' "$REC" | jq -cS "$1" | tr -d '\n' | cast keccak | tr 'A-F' 'a-f'; }

expect_eq "keccak(conditionSpec) = conditionHash" "$CONDITION_HASH" "$(jcs_hash '.conditionSpec')"
expect_eq "keccak(actionSpec) = actionHash"       "$ACTION_HASH"    "$(jcs_hash '.actionSpec')"

# ─────────────────────────────────────────────────────────────────────────────
# 5. The action transaction
# ─────────────────────────────────────────────────────────────────────────────
section "5. action transaction"

[[ "$TX_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "txHash missing or malformed in the document"

RECEIPT="$(cast receipt "$TX_HASH" --rpc-url "$RPC" --json)" || die "no receipt found for ${TX_HASH}"
TX="$(cast tx "$TX_HASH" --rpc-url "$RPC" --json)" || die "no transaction found for ${TX_HASH}"

RCPT_BLOCK="$(printf '%s' "$RECEIPT" | jq -r '.blockNumber' | xargs -I{} cast to-dec {})"
RCPT_STATUS="$(printf '%s' "$RECEIPT" | jq -r '.status')"
RCPT_GAS="$(printf '%s' "$RECEIPT" | jq -r '.gasUsed' | xargs -I{} cast to-dec {})"

field "inclusion block" "$RCPT_BLOCK"
field "gasUsed"         "$RCPT_GAS"

expect_eq "inclusion block = published blockNumber" "$BLOCK_NUMBER" "$RCPT_BLOCK"
if [ "$RCPT_STATUS" = "0x1" ]; then
  ok "the action transaction succeeded onchain"
else
  bad "the action transaction failed onchain (status=${RCPT_STATUS})"
fi

# `evaluateAt: "tx"` evaluates at the inclusion block, `"tx+1"` at the next one.
# The document publishes the resolved block: we check it is consistent with the
# spec rather than take it on trust.
EVALUATE_AT="$(r '.conditionSpec.evaluateAt // ""')"
case "$EVALUATE_AT" in
  tx)     expect_eq "evaluatedAtBlock (evaluateAt=tx)"   "$RCPT_BLOCK"        "$EVAL_BLOCK" ;;
  tx+1)   expect_eq "evaluatedAtBlock (evaluateAt=tx+1)" "$((RCPT_BLOCK + 1))" "$EVAL_BLOCK" ;;
  *)      skip "evaluateAt=${EVALUATE_AT}: pinned block taken as-is (${EVAL_BLOCK})" ;;
esac

if command -v kh >/dev/null 2>&1; then
  if KH_OUT="$(kh execution get "$EXECUTION_ID" --json 2>/dev/null)" && [ -n "$KH_OUT" ]; then
    KH_TX="$(printf '%s' "$KH_OUT" | jq -r '..|.txHash? // empty' | head -1 | tr 'A-F' 'a-f')"
    if [ -n "$KH_TX" ]; then
      expect_eq "kh: txHash of execution ${EXECUTION_ID}" "$TX_HASH" "$KH_TX"
    else
      skip "kh answered without a txHash for ${EXECUTION_ID}"
    fi
  else
    skip "kh present but without access to execution ${EXECUTION_ID} (missing key?)"
  fi
else
  skip "kh absent: KeeperHub cross-check skipped"
  note "no effect on the replay — the chain is the authority, not the execution API."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Replaying the post-conditions
# ─────────────────────────────────────────────────────────────────────────────
section "6. replaying the checks at block ${EVAL_BLOCK}"

# One result per committed check, without exception: `checks[]` is published in
# full, including the checks that passed. A document publishing fewer than the
# spec commits to would be hiding precisely the one that failed.
SPEC_COUNT="$(r '.conditionSpec.checks | length')"
expect_eq "published checks = committed checks" "$SPEC_COUNT" "$CHECK_COUNT"

# `compare` from checks/compare.ts: eq | lte | gte, exact, no tolerance. Any
# intended margin lives in the committed `value`, never here.
compare_op() {
  python3 -c '
import sys
observed, op, expected = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
if op not in ("eq", "lte", "gte"):
    sys.exit(2)
held = observed == expected if op == "eq" else observed <= expected if op == "lte" else observed >= expected
sys.exit(0 if held else 1)' "$1" "$2" "$3"
}

# `pass=true|false` from the comparison, to keep the call site readable.
compare_pass() {
  if compare_op "$1" "$2" "$3"; then printf 'true'; else printf 'false'; fi
}

# Signed sum of the account's `Transfer` events in the receipt's logs — the same
# rule as checks/erc20.ts: the delta attributable to THIS transaction, never a
# balance difference between two blocks, which would charge the agent for what
# another transaction in the same block did.
transfer_delta() {
  local token acct
  token="$(lc "$1")"; acct="$(lc "$2")"
  printf '%s' "$RECEIPT" | jq -r --arg token "$token" --arg acct "$acct" '
    def addr($t): "0x" + ($t[26:66] | ascii_downcase);
    [ .logs[]
      | select((.address | ascii_downcase) == $token)
      | select(.topics | length == 3)
      | select(.topics[0] == "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
      | { from: addr(.topics[1]), to: addr(.topics[2]), amount: .data }
    ]
    | map((if .to == $acct then 1 else 0 end) as $in
        | (if .from == $acct then 1 else 0 end) as $out
        | { sign: ($in - $out), amount: .amount })
    | map(select(.sign != 0))
    | (map("\(.sign) \(.amount)") | join("\n"))'
}

# Sums the `<sign> <hex amount>` lines received on standard input. The code goes
# through `-c` rather than a heredoc: a heredoc would occupy stdin precisely, and
# the sum would silently be 0 — every delta would read as zero.
sum_signed() {
  python3 -c '
import sys
total = 0
for line in sys.stdin:
    parts = line.split()
    if len(parts) == 2:
        total += int(parts[0]) * int(parts[1], 16)
print(total)'
}

TOTAL=0
REPLAYED=0
AGREED=0
RECOMPUTED_VERDICT="honored"

for i in $(seq 0 $((CHECK_COUNT - 1))); do
  TOTAL=$((TOTAL + 1))
  SPEC="$(printf '%s' "$REC" | jq -c ".conditionSpec.checks[$i] // {}")"
  RESULT="$(printf '%s' "$REC" | jq -c ".checks[$i]")"
  KIND="$(printf '%s' "$RESULT" | jq -r '.kind')"
  DOC_PASS="$(printf '%s' "$RESULT" | jq -r '.pass')"
  DOC_OBSERVED="$(printf '%s' "$RESULT" | jq -r '.observed')"
  SPEC_KIND="$(printf '%s' "$SPEC" | jq -r '.kind // ""')"
  OP="$(printf '%s' "$SPEC" | jq -r '.op // ""')"
  VALUE="$(printf '%s' "$SPEC" | jq -r '.value // ""')"

  printf '  %s#%d %s%s  %s\n' "$B" "$i" "$KIND" "$Z" "${DIM}document: pass=${DOC_PASS} observed=${DOC_OBSERVED}${Z}"

  # The published result must describe the check committed at the same position:
  # this is what forbids publishing a reordered `checks[]` to hide a failure.
  if [ -n "$SPEC_KIND" ] && [ "$SPEC_KIND" != "$KIND" ]; then
    bad "  position ${i}: the conditionSpec commits ${SPEC_KIND}, the result says ${KIND}"
    continue
  fi

  REPLAY_OBSERVED=""
  REPLAY_PASS=""

  case "$KIND" in
    erc20_balance_delta)
      TOKEN="$(printf '%s' "$SPEC" | jq -r '.token')"
      ACCOUNT="$(printf '%s' "$SPEC" | jq -r '.account')"
      REPLAY_OBSERVED="$(transfer_delta "$TOKEN" "$ACCOUNT" | sum_signed)"
      REPLAY_PASS="$(compare_pass "$REPLAY_OBSERVED" "$OP" "$VALUE")"
      ;;
    erc20_balance)
      TOKEN="$(printf '%s' "$SPEC" | jq -r '.token')"
      ACCOUNT="$(printf '%s' "$SPEC" | jq -r '.account')"
      REPLAY_OBSERVED="$(cast call "$TOKEN" 'balanceOf(address)(uint256)' "$ACCOUNT" \
        --block "$EVAL_BLOCK" --rpc-url "$RPC" | awk 'NF {print $1}')"
      REPLAY_PASS="$(compare_pass "$REPLAY_OBSERVED" "$OP" "$VALUE")"
      ;;
    erc20_allowance)
      TOKEN="$(printf '%s' "$SPEC" | jq -r '.token')"
      OWNER="$(printf '%s' "$SPEC" | jq -r '.owner')"
      SPENDER="$(printf '%s' "$SPEC" | jq -r '.spender')"
      REPLAY_OBSERVED="$(cast call "$TOKEN" 'allowance(address,address)(uint256)' "$OWNER" "$SPENDER" \
        --block "$EVAL_BLOCK" --rpc-url "$RPC" | awk 'NF {print $1}')"
      REPLAY_PASS="$(compare_pass "$REPLAY_OBSERVED" "$OP" "$VALUE")"
      ;;
    aave_health_factor)
      POOL="$(printf '%s' "$SPEC" | jq -r '.pool')"
      USER="$(printf '%s' "$SPEC" | jq -r '.user')"
      # healthFactor = 6th element of the tuple, in 1e18. A position with no debt
      # returns type(uint256).max: the comparison stays correct in arbitrary
      # precision.
      REPLAY_OBSERVED="$(cast call "$POOL" \
        'getUserAccountData(address)(uint256,uint256,uint256,uint256,uint256,uint256)' "$USER" \
        --block "$EVAL_BLOCK" --rpc-url "$RPC" | awk 'NF {print $1}' | sed -n '6p')"
      REPLAY_PASS="$(compare_pass "$REPLAY_OBSERVED" "$OP" "$VALUE")"
      ;;
    event_emitted)
      ADDRESS="$(lc "$(printf '%s' "$SPEC" | jq -r '.address')")"
      TOPIC0="$(lc "$(printf '%s' "$SPEC" | jq -r '.topic0')")"
      MIN_COUNT="$(printf '%s' "$SPEC" | jq -r '.minCount')"
      REPLAY_OBSERVED="$(printf '%s' "$RECEIPT" | jq -r --arg a "$ADDRESS" --arg t "$TOPIC0" '
        [ .logs[]
          | select((.address | ascii_downcase) == $a)
          | select((.topics[0] // "" | ascii_downcase) == $t)
        ] | length')"
      REPLAY_PASS="$(compare_pass "$REPLAY_OBSERVED" gte "$MIN_COUNT")"
      ;;
    no_new_approvals)
      # An `Approval(owner, *, > 0)` in the transaction's logs. Setting an
      # allowance back to zero is allowed: that is the revocation action.
      # An empty `tokens` means "every token", never "none": a protection that
      # disarms itself is not one.
      OWNER="$(lc "$(printf '%s' "$SPEC" | jq -r '.owner')")"
      OFFENDERS="$(printf '%s' "$RECEIPT" | jq -r \
        --arg owner "$OWNER" \
        --argjson tokens "$(printf '%s' "$SPEC" | jq -c '[(.tokens // [])[] | ascii_downcase]')" '
        def addr($t): "0x" + ($t[26:66] | ascii_downcase);
        [ .logs[]
          | select(($tokens | length) == 0 or ((.address | ascii_downcase) as $a | $tokens | index($a)))
          | select(.topics | length == 3)
          | select(.topics[0] == "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925")
          | select(addr(.topics[1]) == $owner)
          | select((.data | ltrimstr("0x") | ltrimstr("0") | length) > 0)
        ] | length')"
      REPLAY_OBSERVED="${OFFENDERS} new approvals"
      [ "$OFFENDERS" = "0" ] && REPLAY_PASS=true || REPLAY_PASS=false
      ;;
    calldata_matches_commitment)
      # Reconstructs the ActionSpec from the transaction, forwarder unwrapping
      # included, then rehashes it. Without the unwrapping this check would fail on
      # every sponsored warrant — the systematic unjust slash described in
      # checks/forwarder.ts.
      TX_TO="$(lc "$(printf '%s' "$TX" | jq -r '.to // ""')")"
      TX_INPUT="$(lc "$(printf '%s' "$TX" | jq -r '.input')")"
      TX_VALUE="$(cast to-dec "$(printf '%s' "$TX" | jq -r '.value')")"
      TX_CHAIN_HEX="$(printf '%s' "$TX" | jq -r '.chainId // empty')"
      # `chainId` is absent from unprotected legacy transactions: we then fall
      # back on the chain declared in the ConditionSpec, like the evaluator.
      if [ -n "$TX_CHAIN_HEX" ]; then TX_CHAIN="$(cast to-dec "$TX_CHAIN_HEX")"
      else TX_CHAIN="$(r '.conditionSpec.chainId')"; fi

      EFF_TARGET="$TX_TO"; EFF_VALUE="$TX_VALUE"; EFF_CALLDATA="$TX_INPUT"; VIA=""

      if [ "${TX_INPUT:0:10}" = "0x9aefaff8" ]; then
        FWD=()
        while IFS= read -r line; do FWD+=("$line"); done < <(
          cast decode-calldata 'execute(address,address,uint256,bytes)' "$TX_INPUT" 2>/dev/null || true
        )
        if [ "${#FWD[@]}" -eq 4 ]; then
          PAYLOAD="${FWD[3]#0x}"
          NBYTES=$(( ${#PAYLOAD} / 2 ))
          INNER=""
          # signature(65) ‖ metadata ‖ calldata: the first boundary ≥ 65 from
          # which the remainder is 4 + 32·n bytes. Same rule as
          # extractInnerCalldata, whose metadata length is undocumented and is
          # therefore not hard-coded.
          off=65
          while [ $((off + 4)) -le "$NBYTES" ]; do
            REST=$((NBYTES - off))
            if [ $(( (REST - 4) % 32 )) -eq 0 ]; then
              INNER="0x${PAYLOAD:$((off * 2))}"
              break
            fi
            off=$((off + 1))
          done
          if [ -n "$INNER" ]; then
            EFF_TARGET="$(lc "${FWD[1]}")"
            EFF_VALUE="${FWD[2]}"
            EFF_CALLDATA="$(lc "$INNER")"
            VIA=" via forwarder"
          fi
        fi
      fi

      REGISTRY_REF="$(r '.actionSpec.registryRef')"
      RECONSTRUCTED="$(jq -cSn \
        --argjson version 1 \
        --argjson chainId "$TX_CHAIN" \
        --arg target "$EFF_TARGET" \
        --arg value "$EFF_VALUE" \
        --arg calldata "$EFF_CALLDATA" \
        --arg registryRef "$REGISTRY_REF" \
        '{version:$version, chainId:$chainId, target:$target, value:$value, calldata:$calldata, registryRef:$registryRef}')"
      RECONSTRUCTED_HASH="$(lc "$(printf '%s' "$RECONSTRUCTED" | tr -d '\n' | cast keccak)")"
      REPLAY_OBSERVED="${RECONSTRUCTED_HASH}${VIA}"
      # The commitment read onchain takes precedence over the one copied into the
      # spec: it is the only one of the two we do not control.
      if [ "$RECONSTRUCTED_HASH" = "$ACTION_HASH" ]; then REPLAY_PASS=true; else REPLAY_PASS=false; fi
      ;;
    *)
      skip "  ${KIND}: not replayed by this script"
      note "  kinds replayed: erc20_balance{,_delta}, erc20_allowance, aave_health_factor,"
      note "  no_new_approvals, calldata_matches_commitment. The others require a"
      note "  tracer or ABI decoding that cast does not do alone — use the evaluator."
      continue
      ;;
  esac

  REPLAYED=$((REPLAYED + 1))
  [ "$REPLAY_PASS" = "false" ] && RECOMPUTED_VERDICT="slashed"

  # We compare the boolean AND the observed value. The boolean alone would let a
  # doctored `observed` through — "the condition held, here is a tidied-up
  # number" — when that number is precisely what the verdict claims to make
  # auditable. The evaluator's `observed` values all start with the value, with
  # details following in parentheses: we compare the first field.
  if [ "$REPLAY_PASS" = "$DOC_PASS" ] && [ "${REPLAY_OBSERVED%% *}" = "${DOC_OBSERVED%% *}" ]; then
    AGREED=$((AGREED + 1))
    ok "  replay: pass=${REPLAY_PASS} observed=${REPLAY_OBSERVED}"
  else
    bad "  replay: pass=${REPLAY_PASS} observed=${REPLAY_OBSERVED} — the document claims pass=${DOC_PASS} observed=${DOC_OBSERVED}"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# Conclusion
# ─────────────────────────────────────────────────────────────────────────────
section "verdict"

# The verdict is a pure conjunction: every post-condition, no short-circuiting.
# Recomputed here over the replayed checks only — if one of them could not be
# replayed, we say so instead of concluding on its behalf.
field "checks replayed" "${AGREED}/${REPLAYED} agree with the document (${TOTAL} published)"

DOC_SELF="$(printf '%s' "$REC" | jq -r 'if ([.checks[].pass] | all) then "honored" else "slashed" end')"
expect_eq "verdict = conjunction of published checks" "$DOC_SELF" "$DOC_VERDICT"

if [ "$REPLAYED" -eq "$TOTAL" ]; then
  expect_eq "verdict recomputed from the chain" "$DOC_VERDICT" "$RECOMPUTED_VERDICT"
else
  skip "verdict not fully recomputable: $((TOTAL - REPLAYED)) check(s) not replayed"
fi

if [ -n "$ONCHAIN_VERDICT" ]; then
  expect_eq "onchain status (${STATUS_NAME})" "$DOC_VERDICT" "$ONCHAIN_VERDICT"
else
  skip "onchain status ${STATUS_NAME}: the protocol has not decided yet"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ] && [ "$REPLAYED" -eq "$TOTAL" ]; then
  printf '%s%sVERDICT REPRODUCED%s — %s, %d/%d checks replayed identically at block %s.\n' \
    "$B" "$GREEN" "$Z" "$DOC_VERDICT" "$AGREED" "$TOTAL" "$EVAL_BLOCK"
  exit 0
elif [ "$FAILURES" -eq 0 ]; then
  printf '%s%sVERDICT PARTIALLY REPRODUCED%s — %s, %d/%d checks replayed, no divergence. %d check(s) skipped.\n' \
    "$B" "$YELLOW" "$Z" "$DOC_VERDICT" "$REPLAYED" "$TOTAL" "$SKIPPED"
  exit 0
else
  printf '%s%sDIVERGENCE%s — %d check(s) failed. The published verdict does not reproduce.\n' \
    "$B" "$RED" "$Z" "$FAILURES"
  exit 1
fi
