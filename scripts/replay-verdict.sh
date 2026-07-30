#!/usr/bin/env bash
#
# Rejoue un verdict Warrant à partir d'un `warrantId` seul.
#
# ─────────────────────────────────────────────────────────────────────────────
# Ce que ce script est
# ─────────────────────────────────────────────────────────────────────────────
#
# La contrepartie exécutable de la phrase « on ne demande pas de confiance, on
# rend le verdict reproductible ». Il ne lit aucun `.env`, ne connaît aucune de
# nos clés, ne parle à aucun de nos serveurs : un RPC public, un dépôt git
# public, `cast` et `jq`. C'est le mode d'emploi d'un jury qui veut vérifier au
# lieu de croire.
#
# Six vérifications, dans l'ordre où elles s'enchaînent :
#
#   1. Le mandat existe onchain, et son `status` dit ce que le protocole a fait.
#   2. Le document de verdict est récupérable à l'URI dérivée du `warrantId`.
#   3. `keccak256` des octets récupérés = le `feedbackHash` engagé (ERC-8004).
#   4. `conditionHash` et `actionHash` onchain = keccak des specs du document :
#      le document décrit bien le mandat qu'on a lu, pas un autre.
#   5. `fundingRef` onchain = `termsHash(...)` recalculé par le contrat lui-même
#      sur les champs du mandat — les termes signés n'ont pas bougé.
#   6. Les `checks[]` sont rejoués contre la chaîne, au bloc figé publié, et le
#      verdict est recalculé. Il doit valoir celui du document, et le document
#      doit valoir ce que dit le `status` onchain.
#
# ─────────────────────────────────────────────────────────────────────────────
# Deux hypothèses, énoncées parce qu'elles sont réfutables
# ─────────────────────────────────────────────────────────────────────────────
#
# a) `jq -cS` est utilisé comme sérialiseur JCS pour rehacher les sous-objets du
#    document (`conditionSpec`, `actionSpec`). C'est exact ici — clés ASCII, tri
#    par octet, sortie compacte, et tous les nombres sont des entiers courts,
#    hors de la zone où jq perd de la précision. Ça ne l'est pas en général : un
#    flottant ou un entier au-delà de 2^53 exigerait la vraie implémentation
#    (`packages/core/src/canonical.ts`). Si l'étape 4 échoue alors que tout le
#    reste passe, c'est la première chose à suspecter.
# b) Le document est déjà canonique — il l'est par construction, c'est ce que
#    `verdicts.ts` écrit. L'étape 3 le vérifie de fait : un document reformaté
#    ne produit plus le `feedbackHash` engagé.
#
# `kh` (CLI KeeperHub) est utilisé s'il est présent, pour recouper l'exécution.
# Son absence ne retire rien : le hash de transaction du document est vérifié
# contre la chaîne, qui est l'autorité. Le script le dit et continue.
#
# Usage :
#   scripts/replay-verdict.sh <warrantId> [options]
#
#   --rpc URL         RPC public, capable d'archive (défaut : sepolia.base.org)
#   --escrow ADDR     WarrantEscrow (défaut : déploiement Base Sepolia)
#   --source SRC      base URI, répertoire ou fichier du document de verdict
#   --registry ADDR   ReputationRegistry ERC-8004, pour retrouver le
#                     `feedbackHash` dans un event `NewFeedback`
#   --span N          largeur de la fenêtre de blocs scannée avec --registry (200).
#                     `sepolia.base.org` refuse les plages de plus de 2 000 blocs :
#                     au-delà, `eth_getLogs` échoue et l'étape 3 se dit « muette ».
#
# Sortie : 0 le verdict se reproduit, 1 divergence, 2 erreur d'utilisation.

set -euo pipefail

# ─── Valeurs par défaut ──────────────────────────────────────────────────────
# Publiques, sans exception : ce script doit tourner sur une machine qui n'a
# jamais vu ce dépôt.
RPC="https://sepolia.base.org"
ESCROW="0x3ae9ad53686383c80889F550065e810f72c2ff4e"
BASE_URI="https://raw.githubusercontent.com/4n0nn43x/warrant/master/verdicts/"
REGISTRY=""
SPAN=200
SOURCE=""
# Même nom que `VERDICT_INDEX_FILE` côté serveur : c'est le point d'entrée d'un
# tiers qui n'a qu'un `warrantId` et pas notre journal.
VERDICT_INDEX="index.json"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${SCRIPT_DIR}/../verdicts"

# ─── Rendu ───────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; Z=$'\033[0m'
else
  B=""; DIM=""; GREEN=""; RED=""; YELLOW=""; Z=""
fi

FAILURES=0
SKIPPED=0

section() { printf '\n%s── %s%s\n' "$B" "$1" "$Z"; }

# Alignement à la main : `printf '%-22s'` compte les octets, et une étiquette
# accentuée compterait double. `${#s}` compte les caractères en locale UTF-8.
field() {
  local pad=$((23 - ${#1}))
  [ "$pad" -lt 1 ] && pad=1
  printf '  %s%*s%s\n' "$1" "$pad" "" "$2"
}
ok()      { printf '  %s[ok]%s %s\n' "$GREEN" "$Z" "$1"; }
bad()     { printf '  %s[!!]%s %s\n' "$RED" "$Z" "$1"; FAILURES=$((FAILURES + 1)); }
skip()    { printf '  %s[--]%s %s\n' "$YELLOW" "$Z" "$1"; SKIPPED=$((SKIPPED + 1)); }
note()    { printf '  %s%s%s\n' "$DIM" "$1" "$Z"; }
die()     { printf '%serreur :%s %s\n' "$RED" "$Z" "$1" >&2; exit 2; }

# `ok`/`bad` selon l'égalité de deux valeurs, avec l'écart affiché quand il y en
# a un. Toutes les comparaisons du script passent par ici : un rejeu qui dirait
# « ok » sans montrer ce qu'il a comparé ne vaudrait pas mieux qu'une promesse.
expect_eq() {
  local label="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then
    ok "${label} = ${got}"
  else
    bad "${label} : attendu ${want}, obtenu ${got}"
  fi
}

# ─── Arguments ───────────────────────────────────────────────────────────────
WARRANT_ID=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) sed -n '/^# Usage :/,/^# Sortie/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --rpc)      RPC="${2:?--rpc attend une URL}"; shift 2 ;;
    --escrow)   ESCROW="${2:?--escrow attend une adresse}"; shift 2 ;;
    --source)   SOURCE="${2:?--source attend une URI, un répertoire ou un fichier}"; shift 2 ;;
    --registry) REGISTRY="${2:?--registry attend une adresse}"; shift 2 ;;
    --span)     SPAN="${2:?--span attend un nombre de blocs}"; shift 2 ;;
    -*) die "option inconnue : $1" ;;
    *)  [ -z "$WARRANT_ID" ] || die "un seul warrantId à la fois"; WARRANT_ID="$1"; shift ;;
  esac
done

[ -n "$WARRANT_ID" ] || die "usage : $(basename "$0") <warrantId> [--rpc URL] [--source SRC]"
command -v cast >/dev/null || die "cast (Foundry) est requis : https://getfoundry.sh"
command -v jq >/dev/null || die "jq est requis"
# python3 sert uniquement d'arithmétique : les montants sont des uint256, que le
# shell (64 bits) et jq (flottant double) tronqueraient tous les deux. Une
# comparaison arrondie transformerait un verdict en loterie — même raison qui
# impose `bigint` partout dans checks/compare.ts.
command -v python3 >/dev/null || die "python3 est requis (arithmétique uint256)"

# Minuscules partout : c'est la forme canonique des adresses et des hashs du
# projet (docs/07 § 4 règle 2), et celle du nom de fichier et de l'URI.
lc() { printf '%s' "$1" | tr 'A-F' 'a-f'; }

WARRANT_ID="$(lc "$WARRANT_ID")"
[[ "$WARRANT_ID" =~ ^0x[0-9a-f]{64}$ ]] || die "warrantId malformé : $WARRANT_ID"

printf '%swarrant replay%s  %s\n' "$B" "$Z" "$WARRANT_ID"
note "rpc    ${RPC}"
note "escrow ${ESCROW}"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Le mandat, lu onchain
# ─────────────────────────────────────────────────────────────────────────────
section "1. mandat onchain"

# Le getter public aplati rend dix valeurs, une par ligne. `feeBpsAtOpen` est en
# neuvième position, AVANT `status` : lire `status` en huitième donnerait 250,
# qui n'est aucun statut connu (voir escrow-abi.ts).
WARRANT_RAW="$(cast call "$ESCROW" \
  'warrants(bytes32)(address,address,uint256,bytes32,bytes32,bytes32,uint64,uint64,uint16,uint8)' \
  "$WARRANT_ID" --rpc-url "$RPC")" || die "lecture du mandat impossible sur ${RPC}"

# `cast` annote les entiers (`200000 [2e5]`) : on ne garde que le premier champ.
# `while read` plutôt que `mapfile`, qui n'existe pas dans le bash 3.2 livré par
# macOS — un script de vérification qui ne tourne que chez nous manquerait sa
# cible.
W=()
while IFS= read -r line; do W+=("$line"); done < <(printf '%s\n' "$WARRANT_RAW" | awk 'NF {print $1}')
[ "${#W[@]}" -eq 10 ] || die "réponse inattendue du getter warrants() : $WARRANT_RAW"

AGENT="${W[0]}" BENEFICIARY="${W[1]}" BOND="${W[2]}"
CONDITION_HASH="$(lc "${W[3]}")"
ACTION_HASH="$(lc "${W[4]}")"
FUNDING_REF="$(lc "${W[5]}")"
EXPIRY="${W[6]}" OPENED_AT="${W[7]}" FEE_BPS="${W[8]}" STATUS="${W[9]}"

case "$STATUS" in
  0) die "aucun mandat sous cet identifiant à cette adresse (status=None)" ;;
  1) STATUS_NAME="Open"      ; ONCHAIN_VERDICT="" ;;
  2) STATUS_NAME="Honored"   ; ONCHAIN_VERDICT="honored" ;;
  3) STATUS_NAME="Slashed"   ; ONCHAIN_VERDICT="slashed" ;;
  4) STATUS_NAME="Reclaimed" ; ONCHAIN_VERDICT="" ;;
  *) die "status inconnu : ${STATUS}" ;;
esac

field "agent"         "$AGENT"
field "beneficiary"   "$BENEFICIARY"
field "bond"          "${BOND} (unité atomique du token)"
field "conditionHash" "$CONDITION_HASH"
field "actionHash"    "$ACTION_HASH"
field "fundingRef"    "$FUNDING_REF"
field "feeBpsAtOpen"  "$FEE_BPS"
field "status"        "${STATUS} (${STATUS_NAME})"

# `fundingRef` est le nonce EIP-3009, et ce nonce EST le hash des termes :
# signer l'autorisation de paiement revient à signer le mandat. On le fait
# recalculer par le contrat, sur les champs qu'on vient de lire.
DURATION=$((EXPIRY - OPENED_AT))
TERMS_HASH="$(lc "$(cast call "$ESCROW" \
  'termsHash(bytes32,address,uint256,bytes32,bytes32,uint64)(bytes32)' \
  "$WARRANT_ID" "$BENEFICIARY" "$BOND" "$CONDITION_HASH" "$ACTION_HASH" "$DURATION" \
  --rpc-url "$RPC")")"
expect_eq "fundingRef = termsHash(mandat)" "$FUNDING_REF" "$TERMS_HASH"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Le document de verdict
# ─────────────────────────────────────────────────────────────────────────────
section "2. document de verdict"

DOC=""
DOC_ORIGIN=""

# Silencieux sur erreur HTTP : un 404 sur l'URI publique est un cas prévu (le
# verdict n'est pas encore poussé), pas un incident à afficher en brut.
fetch_http() {
  command -v curl >/dev/null || return 1
  curl -fsL --max-time 20 "$1"
}

# Une source est soit une base HTTP, soit un répertoire : les deux exposent la
# même arborescence relative (`<id>`, `index.json`, `batch/<hash>`), c'est tout
# l'intérêt d'avoir aligné le serveur local sur git-raw.
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
      # Une base se termine par `/` ; sinon c'est l'URL complète du document.
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

# Un mandat honoré n'a pas forcément de document à lui : au-delà de
# `ERC8004_BATCH_SIZE`, le Settler agrège N verdicts dans un document de lot,
# engagé par un seul `feedbackHash`. Le mandat est alors dans `warrants[]` d'un
# fichier `batch/<hash>`, et l'index est le seul moyen de le trouver — sans lui,
# un `warrantId` réglé en lot serait invérifiable par un tiers.
try_batch() {
  local src="$1" index="" hash="" body=""
  index="$(fetch_rel "$src" "$VERDICT_INDEX")" || return 1
  [ -n "$index" ] || return 1
  for hash in $(printf '%s' "$index" | jq -r '.batches[]?.uri' | awk -F/ '{print $NF}'); do
    body="$(fetch_rel "$src" "batch/${hash}")" || continue
    [ -n "$body" ] || continue
    if printf '%s' "$body" \
      | jq -e --arg id "$WARRANT_ID" '[.warrants[]? | select((.warrantId | ascii_downcase) == $id)] | length > 0' \
        >/dev/null 2>&1; then
      DOC="$body"
      DOC_ORIGIN="${src%/}/batch/${hash}"
      return 0
    fi
  done
  return 1
}

resolve_from() { try_source "$1" || try_batch "$1"; }

if [ -n "$SOURCE" ]; then
  resolve_from "$SOURCE" || die "document introuvable à ${SOURCE} (ni document de mandat, ni lot indexé)"
else
  # L'URI publique d'abord — c'est celle qui est inscrite onchain, donc la seule
  # dont la disponibilité prouve quelque chose. La copie locale ensuite, pour
  # que le script serve aussi avant la poussée : un verdict est écrit au
  # règlement et commité après, la fenêtre existe et il faut la nommer.
  if resolve_from "$BASE_URI"; then
    :
  elif resolve_from "$LOCAL_DIR"; then
    note "l'URI publique ne répond pas encore : lecture de la copie locale du dépôt."
    note "un tiers ne pourra vérifier qu'après le commit et la poussée de verdicts/."
  else
    die "document introuvable, ni à ${BASE_URI}${WARRANT_ID} ni dans ${LOCAL_DIR}"
  fi
fi

field "origine" "$DOC_ORIGIN"
printf '%s' "$DOC" | jq -e . >/dev/null 2>&1 || die "le document récupéré n'est pas du JSON"

# Trois formes de document, une seule projection à rejouer :
#   - `VerdictDocument` brut          → les champs sont à la racine ;
#   - `SingleFeedbackDocument`        → sous `warrant` ;
#   - `BatchFeedbackDocument`         → dans `warrants[]`, à retrouver par id.
# Ce qui est haché reste le document entier ; ce qui est rejoué est la
# projection. Les deux sont distincts et le restent.
DOC_SHAPE="$(printf '%s' "$DOC" | jq -r '
  if has("warrants") then "lot" elif has("warrant") then "feedback" else "verdict" end')"
REC="$(printf '%s' "$DOC" | jq -c --arg id "$WARRANT_ID" '
  if has("warrants") then (.warrants[] | select((.warrantId | ascii_downcase) == $id))
  elif has("warrant") then .warrant
  else . end')"
[ -n "$REC" ] || die "le document récupéré ne contient pas le mandat ${WARRANT_ID}"
r() { printf '%s' "$REC" | jq -r "$1"; }

field "forme" "$DOC_SHAPE"
if [ "$DOC_SHAPE" = "lot" ]; then
  note "document de lot : $(printf '%s' "$DOC" | jq -r '.warrants | length') mandat(s) sous un seul feedbackHash."
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
field "rpcUrl publié"    "$DOC_RPC"
field "settlementTx"     "${SETTLEMENT_TX:-null}"
field "checks"           "$CHECK_COUNT"

expect_eq "le document parle bien de ce mandat" "$WARRANT_ID" "$DOC_WARRANT_ID"

# ─────────────────────────────────────────────────────────────────────────────
# 3. L'engagement : keccak256 des octets servis
# ─────────────────────────────────────────────────────────────────────────────
section "3. engagement du document"

# Hash des octets EXACTS reçus, pas d'une re-sérialisation. `printf '%s'` n'ajoute
# pas de saut de ligne : un `echo` ici invaliderait le hash de tout document
# valide, ce qui est le plus vicieux des faux positifs.
FEEDBACK_HASH="$(printf '%s' "$DOC" | cast keccak | tr 'A-F' 'a-f')"
field "keccak256(document)" "$FEEDBACK_HASH"
note "c'est la valeur engagée dans NewFeedback.feedbackHash (ERC-8004)."

if [ -n "$REGISTRY" ]; then
  # La fenêtre part du **règlement**, pas de l'action : le feedback est écrit dans
  # la même passe du daemon, quelques blocs après `honor`/`slash`. Partir du bloc
  # de l'action ferait scanner pour rien la durée de vie du mandat.
  FROM_BLOCK="$BLOCK_NUMBER"
  if [ -n "$SETTLEMENT_TX" ] && [ "$SETTLEMENT_TX" != "null" ]; then
    FROM_BLOCK="$(cast receipt "$SETTLEMENT_TX" --rpc-url "$RPC" --json 2>/dev/null \
      | jq -r '.blockNumber' | while IFS= read -r h; do cast to-dec "$h"; done)" || FROM_BLOCK="$BLOCK_NUMBER"
  fi
  TO_BLOCK=$((FROM_BLOCK + SPAN))
  note "recherche dans NewFeedback sur [${FROM_BLOCK}, ${TO_BLOCK}]…"

  # `feedbackHash` n'est pas indexé : impossible de le filtrer par topic, on le
  # cherche dans les données des logs du registre. Un `eth_getLogs` non filtré est
  # lent sur un endpoint public, d'où la fenêtre étroite et le garde-temps : un
  # script de vérification qui a l'air planté ne sera pas relancé par un jury.
  # `if/elif` et non une boucle : sous `set -e`, une boucle dont la dernière
  # itération échoue fait sortir le script — ici, sur une machine sans `timeout`,
  # c'est-à-dire un macOS sans coreutils.
  #
  # ⚠ La signature compte **cinq** `string`, pas quatre : `indexedTag1` est un
  # `string indexed`, et un paramètre indexé compte quand même dans la signature
  # canonique dont on hache le topic0. L'omettre donne
  # 0x8f29270f… au lieu de 0x6a4a6174…, un topic0 qu'aucun log ne porte — et le
  # script concluait alors « registre muet » sur un registre qui répondait
  # parfaitement. Le pire des faux négatifs : il ressemble à une limite du RPC.
  TIMEOUT_BIN=""
  if command -v timeout >/dev/null 2>&1; then TIMEOUT_BIN="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then TIMEOUT_BIN="gtimeout"
  fi
  LOGS="$($TIMEOUT_BIN ${TIMEOUT_BIN:+90} cast logs --rpc-url "$RPC" --address "$REGISTRY" \
    'NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)' \
    --from-block "$FROM_BLOCK" --to-block "$TO_BLOCK" 2>/dev/null || true)"

  if [ -z "$LOGS" ]; then
    skip "aucun NewFeedback lisible sur la fenêtre (registre muet, ou RPC qui refuse le scan)"
    note "réduire --span, ou viser un RPC qui sert eth_getLogs sur des plages."
  elif printf '%s' "$LOGS" | tr 'A-F' 'a-f' | grep -q "${FEEDBACK_HASH#0x}"; then
    ok "feedbackHash retrouvé dans un event NewFeedback du registre"
  else
    bad "aucun NewFeedback de la fenêtre ne porte ${FEEDBACK_HASH}"
  fi
else
  skip "aucun registre ERC-8004 fourni (--registry) : engagement non recoupé onchain"
  note "les étapes 4 et 5 lient malgré tout le document au mandat onchain."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Les specs du document = celles engagées à l'ouverture
# ─────────────────────────────────────────────────────────────────────────────
section "4. specs engagées"

# `jq -cS` comme sérialiseur JCS — voir l'hypothèse (a) en tête de fichier.
jcs_hash() { printf '%s' "$REC" | jq -cS "$1" | tr -d '\n' | cast keccak | tr 'A-F' 'a-f'; }

expect_eq "keccak(conditionSpec) = conditionHash" "$CONDITION_HASH" "$(jcs_hash '.conditionSpec')"
expect_eq "keccak(actionSpec) = actionHash"       "$ACTION_HASH"    "$(jcs_hash '.actionSpec')"

# ─────────────────────────────────────────────────────────────────────────────
# 5. La transaction d'action
# ─────────────────────────────────────────────────────────────────────────────
section "5. transaction d'action"

[[ "$TX_HASH" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "txHash absent ou malformé dans le document"

RECEIPT="$(cast receipt "$TX_HASH" --rpc-url "$RPC" --json)" || die "receipt introuvable pour ${TX_HASH}"
TX="$(cast tx "$TX_HASH" --rpc-url "$RPC" --json)" || die "transaction introuvable pour ${TX_HASH}"

RCPT_BLOCK="$(printf '%s' "$RECEIPT" | jq -r '.blockNumber' | xargs -I{} cast to-dec {})"
RCPT_STATUS="$(printf '%s' "$RECEIPT" | jq -r '.status')"
RCPT_GAS="$(printf '%s' "$RECEIPT" | jq -r '.gasUsed' | xargs -I{} cast to-dec {})"

field "bloc d'inclusion" "$RCPT_BLOCK"
field "gasUsed"          "$RCPT_GAS"

expect_eq "bloc d'inclusion = blockNumber publié" "$BLOCK_NUMBER" "$RCPT_BLOCK"
if [ "$RCPT_STATUS" = "0x1" ]; then
  ok "la transaction d'action a réussi onchain"
else
  bad "la transaction d'action a échoué onchain (status=${RCPT_STATUS})"
fi

# `evaluateAt: "tx"` évalue au bloc d'inclusion, `"tx+1"` au suivant. Le
# document publie le bloc résolu : on vérifie qu'il est cohérent avec la spec
# plutôt que de le croire.
EVALUATE_AT="$(r '.conditionSpec.evaluateAt // ""')"
case "$EVALUATE_AT" in
  tx)     expect_eq "evaluatedAtBlock (evaluateAt=tx)"   "$RCPT_BLOCK"        "$EVAL_BLOCK" ;;
  tx+1)   expect_eq "evaluatedAtBlock (evaluateAt=tx+1)" "$((RCPT_BLOCK + 1))" "$EVAL_BLOCK" ;;
  *)      skip "evaluateAt=${EVALUATE_AT} : bloc figé pris tel quel (${EVAL_BLOCK})" ;;
esac

if command -v kh >/dev/null 2>&1; then
  if KH_OUT="$(kh execution get "$EXECUTION_ID" --json 2>/dev/null)" && [ -n "$KH_OUT" ]; then
    KH_TX="$(printf '%s' "$KH_OUT" | jq -r '..|.txHash? // empty' | head -1 | tr 'A-F' 'a-f')"
    if [ -n "$KH_TX" ]; then
      expect_eq "kh: txHash de l'exécution ${EXECUTION_ID}" "$TX_HASH" "$KH_TX"
    else
      skip "kh a répondu sans txHash pour ${EXECUTION_ID}"
    fi
  else
    skip "kh présent mais sans accès à l'exécution ${EXECUTION_ID} (clé absente ?)"
  fi
else
  skip "kh absent : recoupement KeeperHub sauté"
  note "sans effet sur le rejeu — la chaîne est l'autorité, pas l'API d'exécution."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 6. Rejeu des post-conditions
# ─────────────────────────────────────────────────────────────────────────────
section "6. rejeu des checks au bloc ${EVAL_BLOCK}"

# Un résultat par check engagé, sans exception : `checks[]` est publié intégral,
# y compris les vérifications passées. Un document qui en publierait moins que la
# spec n'en engage cacherait exactement celle qui a échoué.
SPEC_COUNT="$(r '.conditionSpec.checks | length')"
expect_eq "checks publiés = checks engagés" "$SPEC_COUNT" "$CHECK_COUNT"

# `compare` de checks/compare.ts : eq | lte | gte, exact, sans tolérance. Toute
# marge voulue est dans la `value` engagée, jamais ici.
compare_op() {
  python3 -c '
import sys
observed, op, expected = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
if op not in ("eq", "lte", "gte"):
    sys.exit(2)
held = observed == expected if op == "eq" else observed <= expected if op == "lte" else observed >= expected
sys.exit(0 if held else 1)' "$1" "$2" "$3"
}

# `pass=true|false` de la comparaison, pour rester lisible à l'appel.
compare_pass() {
  if compare_op "$1" "$2" "$3"; then printf 'true'; else printf 'false'; fi
}

# Somme signée des `Transfer` du compte dans les logs du receipt — la même règle
# que checks/erc20.ts : le delta imputable à CETTE transaction, jamais une
# différence de soldes entre deux blocs, qui imputerait à l'agent ce qu'une
# autre transaction du même bloc a fait.
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

# Somme des `<signe> <montant hexadécimal>` reçus sur l'entrée standard. Le code
# passe par `-c` et non par un heredoc : un heredoc occuperait justement stdin,
# et la somme vaudrait silencieusement 0 — tous les deltas passeraient pour nuls.
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

  # Le résultat publié doit décrire le check engagé à la même position : c'est ce
  # qui interdit de publier un `checks[]` réordonné pour cacher un échec.
  if [ -n "$SPEC_KIND" ] && [ "$SPEC_KIND" != "$KIND" ]; then
    bad "  position ${i} : la conditionSpec engage ${SPEC_KIND}, le résultat dit ${KIND}"
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
      # healthFactor = 6e élément du tuple, en 1e18. Une position sans dette rend
      # type(uint256).max : la comparaison reste correcte en précision arbitraire.
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
      # Un `Approval(owner, *, > 0)` dans les logs de la transaction. Remettre
      # une allowance à zéro est autorisé : c'est l'action de révocation.
      # `tokens` vide signifie « tous les tokens », jamais « aucun » : une
      # protection qui se désarme toute seule n'en est pas une.
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
      # Reconstruction de l'ActionSpec depuis la transaction, décapsulation du
      # forwarder comprise, puis rehachage. Sans la décapsulation ce check
      # échouerait sur tout mandat sponsorisé — la saisie injuste systématique
      # décrite dans checks/forwarder.ts.
      TX_TO="$(lc "$(printf '%s' "$TX" | jq -r '.to // ""')")"
      TX_INPUT="$(lc "$(printf '%s' "$TX" | jq -r '.input')")"
      TX_VALUE="$(cast to-dec "$(printf '%s' "$TX" | jq -r '.value')")"
      TX_CHAIN_HEX="$(printf '%s' "$TX" | jq -r '.chainId // empty')"
      # `chainId` est absent des transactions legacy non protégées : on retombe
      # alors sur la chaîne déclarée dans la ConditionSpec, comme l'évaluateur.
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
          # signature(65) ‖ métadonnées ‖ calldata : première frontière ≥ 65 à
          # partir de laquelle le reste fait 4 + 32·n octets. Même règle que
          # extractInnerCalldata, dont la longueur des métadonnées n'est pas
          # documentée et n'est donc pas codée en dur.
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
      # L'engagement lu onchain prime sur celui recopié dans la spec : c'est le
      # seul des deux que nous ne contrôlons pas.
      if [ "$RECONSTRUCTED_HASH" = "$ACTION_HASH" ]; then REPLAY_PASS=true; else REPLAY_PASS=false; fi
      ;;
    *)
      skip "  ${KIND} : non rejoué par ce script"
      note "  kinds rejoués : erc20_balance{,_delta}, erc20_allowance, aave_health_factor,"
      note "  no_new_approvals, calldata_matches_commitment. Les autres demandent un"
      note "  tracer ou un décodage ABI que cast ne fait pas seul — utiliser l'évaluateur."
      continue
      ;;
  esac

  REPLAYED=$((REPLAYED + 1))
  [ "$REPLAY_PASS" = "false" ] && RECOMPUTED_VERDICT="slashed"

  # On compare le booléen ET la valeur observée. Le booléen seul laisserait
  # passer un `observed` maquillé — « la condition tenait, voici un chiffre
  # arrangé » — alors que c'est justement le chiffre que le verdict prétend
  # rendre auditable. Les `observed` de l'évaluateur commencent tous par la
  # valeur, les détails suivent entre parenthèses : on compare le premier champ.
  if [ "$REPLAY_PASS" = "$DOC_PASS" ] && [ "${REPLAY_OBSERVED%% *}" = "${DOC_OBSERVED%% *}" ]; then
    AGREED=$((AGREED + 1))
    ok "  rejeu: pass=${REPLAY_PASS} observed=${REPLAY_OBSERVED}"
  else
    bad "  rejeu: pass=${REPLAY_PASS} observed=${REPLAY_OBSERVED} — le document annonce pass=${DOC_PASS} observed=${DOC_OBSERVED}"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# Conclusion
# ─────────────────────────────────────────────────────────────────────────────
section "verdict"

# Le verdict est une conjonction pure : toutes les post-conditions, sans
# court-circuit. Recalculé ici sur les seuls checks rejoués — si l'un n'a pas
# pu l'être, on le dit au lieu de conclure à sa place.
field "checks rejoués" "${AGREED}/${REPLAYED} d'accord avec le document (${TOTAL} publiés)"

DOC_SELF="$(printf '%s' "$REC" | jq -r 'if ([.checks[].pass] | all) then "honored" else "slashed" end')"
expect_eq "verdict = conjonction des checks publiés" "$DOC_SELF" "$DOC_VERDICT"

if [ "$REPLAYED" -eq "$TOTAL" ]; then
  expect_eq "verdict recalculé depuis la chaîne" "$DOC_VERDICT" "$RECOMPUTED_VERDICT"
else
  skip "verdict non recalculable intégralement : $((TOTAL - REPLAYED)) check(s) non rejoué(s)"
fi

if [ -n "$ONCHAIN_VERDICT" ]; then
  expect_eq "status onchain (${STATUS_NAME})" "$DOC_VERDICT" "$ONCHAIN_VERDICT"
else
  skip "status onchain ${STATUS_NAME} : le protocole n'a pas encore tranché"
fi

printf '\n'
if [ "$FAILURES" -eq 0 ] && [ "$REPLAYED" -eq "$TOTAL" ]; then
  printf '%s%sVERDICT REPRODUIT%s — %s, %d/%d checks rejoués à l’identique au bloc %s.\n' \
    "$B" "$GREEN" "$Z" "$DOC_VERDICT" "$AGREED" "$TOTAL" "$EVAL_BLOCK"
  exit 0
elif [ "$FAILURES" -eq 0 ]; then
  printf '%s%sVERDICT REPRODUIT PARTIELLEMENT%s — %s, %d/%d checks rejoués, aucune divergence. %d vérification(s) sautée(s).\n' \
    "$B" "$YELLOW" "$Z" "$DOC_VERDICT" "$REPLAYED" "$TOTAL" "$SKIPPED"
  exit 0
else
  printf '%s%sDIVERGENCE%s — %d vérification(s) en échec. Le verdict publié ne se reproduit pas.\n' \
    "$B" "$RED" "$Z" "$FAILURES"
  exit 1
fi
