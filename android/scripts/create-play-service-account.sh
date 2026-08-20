#!/usr/bin/env bash
#
# Create the Google Cloud half of Play publishing — keyless — so
# `android-release.yml` can upload to Play (RELEASING.md §7).
#
# No service-account key is minted. The pathors.com organization enforces
# iam.disableServiceAccountKeyCreation, and that is the right default: a Play
# publishing key in a GitHub secret is a long-lived credential that can ship
# code to users. Instead this wires Workload Identity Federation, so each run
# exchanges GitHub's own OIDC token for a credential that expires by itself.
#
# What this does NOT do, because there is no API for it: linking the Cloud
# project to the Play developer account, and granting the service account the
# Release manager role. Linking is what *enables* the Play Developer API, so it
# cannot itself go through that API — it is Play Console web UI, by hand, and
# the script prints the exact steps when it finishes.
#
# Idempotent: re-running reuses whatever already exists, so it is also the way
# to repair one piece of the setup.
#
#   ./android/scripts/create-play-service-account.sh
#
set -euo pipefail

PROJECT_ID="${PLAY_PROJECT_ID:-pathors-play}"
SA_NAME="parley-play-publisher"
POOL="github"
PROVIDER="pathorsai"
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

step "Workload Identity Federation for GitHub Actions"
# No key is minted, and none can be: the pathors.com organization enforces
# iam.disableServiceAccountKeyCreation. That is the right default — a Play
# publishing key in a GitHub secret is a long-lived credential that can ship
# code to users — so the release authenticates with the OIDC token GitHub mints
# per run instead, and nothing is left at rest.
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com --project="$PROJECT_ID"

if gcloud iam workload-identity-pools describe "$POOL" \
     --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "pool $POOL already exists — reusing"
else
  gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" \
    --location=global --display-name="GitHub Actions"
fi

if gcloud iam workload-identity-pools providers describe "$PROVIDER" \
     --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  echo "provider $PROVIDER already exists — reusing"
else
  # The attribute condition is the outer fence: without it any GitHub repository
  # in the world can present a token to this provider.
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL" \
    --display-name="pathorsAI repos" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository_owner=='${REPO%%/*}'"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

step "Letting $REPO — and only $REPO — impersonate the publisher"
# The inner fence. The provider trusts the whole org; this trusts one repo.
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}" \
  >/dev/null
echo "bound"

step "Publishing the config to $REPO"
# Variables, not secrets: neither value authorizes anything on its own, and
# reading them out of the workflow logs is how you debug a failed release.
gh variable set PLAY_WIF_PROVIDER --repo "$REPO" --body "$WIF_PROVIDER"
gh variable set PLAY_PUBLISHER_SERVICE_ACCOUNT --repo "$REPO" --body "$SA_EMAIL"
echo "PLAY_WIF_PROVIDER              $WIF_PROVIDER"
echo "PLAY_PUBLISHER_SERVICE_ACCOUNT $SA_EMAIL"

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
android/RELEASING.md → "Play publishing".
MANUAL
