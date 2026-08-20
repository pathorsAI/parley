#!/usr/bin/env bash
#
# Create the Google Cloud half of Play publishing and push the key into GitHub,
# so `android-release.yml` can upload to Play (RELEASING.md §7).
#
# What this does NOT do, because there is no API for it: linking the Cloud
# project to the Play developer account, and granting the service account the
# Release manager role. Linking is what *enables* the Play Developer API, so it
# cannot itself go through that API — it is Play Console web UI, by hand, and
# the script prints the exact steps when it finishes.
#
# Idempotent: re-running reuses an existing project and service account, and
# only ever mints a fresh key.
#
#   ./android/scripts/create-play-service-account.sh
#
set -euo pipefail

PROJECT_ID="${PLAY_PROJECT_ID:-pathors-play}"
SA_NAME="parley-play-publisher"
REPO="${PLAY_SECRET_REPO:-pathorsAI/parley}"
# The Play Console owner. A key minted from any other identity still works, but
# a project owned by a personal account is a bus factor of one.
WANT_ACCOUNT="${PLAY_GCLOUD_ACCOUNT:-contact@pathors.com}"

die() { echo "error: $*" >&2; exit 1; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v gcloud >/dev/null || die "gcloud is not installed"
command -v gh >/dev/null || die "gh is not installed"

step "Checking the gcloud login"
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
[ -n "$ACCOUNT" ] && [ "$ACCOUNT" != "(unset)" ] || die "no active gcloud account — run: gcloud auth login"
# Tokens expire silently; the only honest check is a call that needs one.
gcloud projects list --limit=1 >/dev/null 2>&1 \
  || die "the gcloud token for $ACCOUNT is stale — run: gcloud auth login"
if [ "$ACCOUNT" != "$WANT_ACCOUNT" ]; then
  echo "warning: active account is $ACCOUNT, not the Play owner $WANT_ACCOUNT."
  echo "         Continue only if that account can create projects for Pathors."
  read -r -p "         Continue? [y/N] " reply
  [ "$reply" = "y" ] || exit 1
fi
echo "using $ACCOUNT"

step "Project $PROJECT_ID"
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "already exists — reusing"
else
  # A Play account links exactly one Cloud project and moving it later is
  # painful, so this is deliberately a dedicated project, not an app's.
  gcloud projects create "$PROJECT_ID" --name="Pathors Play publishing" \
    || die "could not create $PROJECT_ID (the id may be taken globally — set PLAY_PROJECT_ID and retry)"
fi

step "Enabling the Play Developer API"
# Only works once the project is linked in the Play Console. Say so plainly
# rather than dying, since everything below still needs doing.
if gcloud services enable androidpublisher.googleapis.com --project="$PROJECT_ID" 2>/dev/null; then
  echo "androidpublisher.googleapis.com enabled"
else
  echo "could not enable it yet — this usually means the project is not linked"
  echo "in the Play Console yet (manual step 1 below). Re-run this script after"
  echo "linking, or enable it from the Cloud Console."
fi

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

step "Service account $SA_EMAIL"
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "already exists — reusing"
else
  # No project-level IAM roles on purpose: everything this identity may do is
  # granted in the Play Console, not in Cloud IAM.
  gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" \
    --display-name="Parley Play publisher"
fi

step "Minting a JSON key"
KEYFILE="$(mktemp -t play-sa-XXXXXX.json)"
chmod 600 "$KEYFILE"
# The key is the whole credential; keep it off disk for as long as possible and
# never inside the repo.
trap 'rm -f "$KEYFILE"' EXIT
gcloud iam service-accounts keys create "$KEYFILE" \
  --iam-account="$SA_EMAIL" --project="$PROJECT_ID"

step "Setting PLAY_SERVICE_ACCOUNT_JSON on $REPO"
gh secret set PLAY_SERVICE_ACCOUNT_JSON --repo "$REPO" < "$KEYFILE"
echo "set"

if command -v pb >/dev/null; then
  step "Filing the key in patchbay"
  pb key store google-play-service-account-parley \
    --label "Google Play publisher SA — Parley ($SA_EMAIL)" \
    --purpose "Uploads app bundles to the Play internal track from android-release.yml; mirrors GitHub secret PLAY_SERVICE_ACCOUNT_JSON on $REPO" \
    --value "$(cat "$KEYFILE")" --overwrite 2>/dev/null \
    && echo "stored" \
    || echo "skipped (store it by hand: pb key store google-play-service-account-parley)"
fi

cat <<MANUAL

$(printf '\033[1m')Two steps left, and neither has an API.$(printf '\033[0m')

1. Play Console → Setup → API access → link the Cloud project "$PROJECT_ID".
   This is what turns the Play Developer API on; it cannot be done through the
   API it enables. If the enable step above failed, re-run this script after.

2. Same page, under Service accounts, "$SA_EMAIL"
   appears → Grant access → role $(printf '\033[1m')Release manager$(printf '\033[0m') → App permissions: Parley
   only → Invite user.

Then check it end to end:

   git tag android-v0.1.1 && git push origin android-v0.1.1

A 403 "The caller does not have permission" on the first run is usually just
permissions propagating on a fresh account — wait and re-run the workflow
before assuming it is misconfigured.

Remember the first bundle for the package cannot go through the API at all.
If nothing has been uploaded to Play by hand yet, do that first — see
android/RELEASING.md → "Play service account".
MANUAL
