#!/usr/bin/env bash
#
# Brings the remote Settler's verdict documents home, so that
# `pnpm verdicts:publish` can do what it already does.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this exists
# ─────────────────────────────────────────────────────────────────────────────
#
# The Settler runs on a host; `verdicts/` lives in git. Between the two there was
# nothing. A Settler on a remote host writes `<VERDICT_DIR>/<warrantId>` and
# inscribes `feedbackURI = <VERDICT_BASE_URI><warrantId>` onchain — where
# VERDICT_BASE_URI points at raw.githubusercontent.com. The document is on the
# host, the URI names GitHub, and the URI is **immutable**. Every settlement
# would therefore inscribe a permanent link to a file the public cannot reach.
#
# The failure is silent in the way that matters: the Settler is healthy, the
# verdict is correct, the hash is true. Only availability is missing, and only a
# third party ever finds out.
#
# ─────────────────────────────────────────────────────────────────────────────
# What this script deliberately does NOT do
# ─────────────────────────────────────────────────────────────────────────────
#
# It does not commit, and it does not push. `scripts/publish-verdicts.ts` states
# the reason and it is worth repeating: publication is a two-step operation on
# purpose, because "a daemon that both slashes a bond and writes the repository's
# history would hold two authorities for no gain". Handing the remote Settler a
# GitHub write key would collapse exactly that split.
#
# So the mechanical half is automated — fetching bytes — and the half that
# carries authority stays with a human running `--write` and reading the diff.
#
# Usage:
#   scripts/pull-verdicts.sh                 # fetch, then report what would change
#   WARRANT_SETTLER_HOST=user@host scripts/pull-verdicts.sh
#
# Then, once the report looks right:
#   pnpm verdicts:publish --write && git add verdicts && git commit

set -euo pipefail

HOST="${WARRANT_SETTLER_HOST:-deploy@srv1186438.hstgr.cloud}"
REMOTE_DIR="${WARRANT_SETTLER_VERDICT_DIR:-~/apps/warrant/data/verdicts}"
SSH_KEY="${WARRANT_SETTLER_SSH_KEY:-$HOME/.ssh/id_ed25519}"

cd "$(dirname "$0")/.."
LOCAL_DIR=".warrant/verdicts"   # one of the two paths publish-verdicts.ts scans

echo "pulling verdicts"
echo "  from  $HOST:$REMOTE_DIR"
echo "  into  $LOCAL_DIR"

mkdir -p "$LOCAL_DIR"

# No --delete. The local tree also holds documents from earlier Settler runs, and
# a verdict already published is still a verdict: deleting it here would drop a
# document whose hash is inscribed onchain, on the sole ground that the current
# host no longer has it.
before=$(find "$LOCAL_DIR" -type f 2>/dev/null | wc -l)

rsync -az --info=stats1 \
  -e "ssh -i $SSH_KEY -o BatchMode=yes" \
  "$HOST:$REMOTE_DIR/" "$LOCAL_DIR/" \
  || { echo "rsync failed — is the host reachable and the key right?" >&2; exit 1; }

after=$(find "$LOCAL_DIR" -type f 2>/dev/null | wc -l)
echo "  documents: $before -> $after"

echo
echo "── what publishing would change ──────────────────────────────────────"
# Dry run by design: this prints the diff and writes nothing. The bytes are
# checked against the project's own canonical form before any copy, so a
# reformatted document shows up here rather than as a stranger's failed
# verification.
pnpm verdicts:publish

cat <<'EOF'

Nothing has been copied into verdicts/ and nothing has been committed.
If the report above is what you expect:

    pnpm verdicts:publish --write
    git add verdicts && git commit -m "verdicts: publish <n> settled warrants"
    git push

Until that push lands, the feedbackURI inscribed onchain answers 404. The hash is
already true; only availability lags — and `replay-verdict.sh` says so explicitly
when it has to fall back.
EOF
