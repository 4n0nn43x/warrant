#!/usr/bin/env bash
#
# Deploy a published, signed image — and refuse to deploy anything else.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this replaces `docker build` on the host
# ─────────────────────────────────────────────────────────────────────────────
#
# `release.yml` builds the image, scans it before publishing, signs the digest
# with cosign, attaches an SBOM and records provenance. Rebuilding on the target
# machine throws all of that away: what runs is then a local build nobody signed,
# scanned or attested, and the signature in the registry describes an artifact
# that is not the one serving traffic.
#
# So this script pulls, and the verification is a **precondition**, not a report.
# If `cosign verify` fails, nothing is pulled and nothing is restarted; the
# running containers keep serving the last image that did verify.
#
# ─────────────────────────────────────────────────────────────────────────────
# What the two flags actually do
# ─────────────────────────────────────────────────────────────────────────────
#
# `cosign verify` **without** `--certificate-identity-regexp` and
# `--certificate-oidc-issuer` accepts any valid Sigstore signature from anyone on
# earth. It succeeds on an attacker's image signed by an attacker's workflow.
# Those two flags are the entire policy; the rest is plumbing.
#
# The identity is pinned to this repository's workflows *and to a `v*` tag*, so
# an image signed from a branch, a fork or a pull request does not pass.
#
# Usage:
#   scripts/deploy.sh v0.1.1        # on the host, or over ssh
#   IMAGE_TAG=0.1.1 scripts/deploy.sh

set -euo pipefail

REPO="${WARRANT_REPO:-4n0nn43x/warrant}"
REGISTRY="${WARRANT_REGISTRY:-ghcr.io}"
TAG="${1:-${IMAGE_TAG:-latest}}"
TAG="${TAG#v}"                      # accept v0.1.1 and 0.1.1 alike
IMAGE="$REGISTRY/$REPO:$TAG"

APP_DIR="${WARRANT_APP_DIR:-$HOME/apps/warrant}"
DATA_DIR="$APP_DIR/data"
ENV_DIR="$APP_DIR/deploy"

say() { printf '\n\033[1m── %s\033[0m\n' "$1"; }

say "resolving $IMAGE"
# Resolve the tag to a digest once, and use the digest everywhere after. A tag is
# mutable: verifying `:0.1.1` and then pulling `:0.1.1` are two lookups, and
# nothing guarantees they return the same bytes.
DIGEST=$(docker buildx imagetools inspect "$IMAGE" --format '{{.Manifest.Digest}}')
PINNED="$REGISTRY/$REPO@$DIGEST"
echo "  $DIGEST"

say "verifying the signature"
# Keyless: the identity comes from the CI OIDC token, so there is no public key
# to distribute and none to rotate.
cosign verify "$PINNED" \
  --certificate-identity-regexp "^https://github\.com/${REPO}/\.github/workflows/.+@refs/tags/v.+" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  > /dev/null
echo "  signature ok — built by ${REPO} from a v* tag"

say "verifying the SBOM attestation"
# Non-fatal, deliberately. GHCR's referrers index can lag minutes behind an
# attestation attached moments earlier — on v0.1.0 this took 34 minutes in CI and
# seconds elsewhere. A signed image whose SBOM has not propagated yet is still a
# signed image; refusing to deploy over it would trade a real guarantee for a
# timing artefact.
if cosign verify-attestation --type cyclonedx "$PINNED" \
     --certificate-identity-regexp "^https://github\.com/${REPO}/\.github/workflows/.+@refs/tags/v.+" \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com > /dev/null 2>&1; then
  echo "  SBOM attestation ok"
else
  echo "  SBOM attestation not resolvable yet — continuing (the signature is what gates)"
fi

say "pulling"
docker pull -q "$PINNED"

say "restarting"
# `docker restart` re-runs the *existing* container: it re-reads neither the image
# nor --env-file. Recreating is the only way a new image or a changed variable
# actually takes effect — a lesson this deployment learned the slow way.
docker rm -f warrant-gateway warrant-settler >/dev/null 2>&1 || true

docker run -d --name warrant-gateway \
  --env-file "$ENV_DIR/gateway.env" \
  --user 1002:1002 \
  -p 127.0.0.1:8402:8402 \
  -v "$DATA_DIR:/data" \
  --restart unless-stopped --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --pids-limit 256 \
  "$PINNED" > /dev/null

# No published port and no health check: the Settler serves no HTTP at all, and
# the image's health probe targets the Gateway's /healthz. A check that always
# fails is worse than none — it makes the status line unreadable for both.
docker run -d --name warrant-settler \
  --env-file "$ENV_DIR/settler.env" \
  --user 1002:1002 \
  -v "$DATA_DIR:/data" \
  --restart unless-stopped --no-healthcheck --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --pids-limit 256 \
  "$PINNED" node packages/server/dist/bin/settler.js > /dev/null

say "waiting for health"
for _ in $(seq 1 30); do
  status=$(docker inspect warrant-gateway --format '{{.State.Health.Status}}' 2>/dev/null || echo starting)
  [ "$status" = healthy ] && break
  sleep 2
done

docker ps --filter name=warrant --format '  {{.Names}}  {{.Status}}'

say "smoke test"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 http://127.0.0.1:8402/healthz || echo 000)
echo "  /healthz  $code"
[ "$code" = 200 ] || { echo "  the Gateway is not answering — check: docker logs warrant-gateway" >&2; exit 1; }

printf '\n\033[1mdeployed\033[0m  %s\n' "$PINNED"
