#!/usr/bin/env bash
# deploy.sh — Cometa Vault · Google Cloud Run deployment
#
# Usage:
#   ./deploy.sh [--env staging|production]
#
# Prerequisites:
#   gcloud auth login
#   gcloud config set project cometa-429714
#   docker (if building locally; omit --source for Cloud Build)
#
# All sensitive values are injected as Cloud Run secrets / env vars.
# Never commit real values to this file — use your CI/CD secret manager.

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-cometa-429714}"
REGION="${CLOUD_RUN_REGION:-us-central1}"
SERVICE_NAME="${CLOUD_RUN_SERVICE:-cometa-vault-api}"
IMAGE_TAG="gcr.io/${PROJECT_ID}/${SERVICE_NAME}:latest"

# Dataset changes per environment (override via ENV= or edit below)
ENV="${1:-production}"
if [[ "$ENV" == "staging" ]]; then
  BQ_DATASET="cometa_vault_test"
  MIN_INSTANCES=0
  MAX_INSTANCES=3
  CONCURRENCY=10
else
  BQ_DATASET="cometa_vault"
  MIN_INSTANCES=1          # keep-warm: avoids cold starts for analysts
  MAX_INSTANCES=10
  CONCURRENCY=20
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Cometa Vault — Cloud Run Deployment"
echo "  Environment : ${ENV}"
echo "  Project     : ${PROJECT_ID}"
echo "  Region      : ${REGION}"
echo "  Service     : ${SERVICE_NAME}"
echo "  Dataset     : ${BQ_DATASET}"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── Safety check: required secrets must be set ────────────────────────────────
# These variables must be exported in your shell before running, or set via
# your CI/CD platform (GitHub Actions / Cloud Build substitutions).

: "${JWT_SECRET:?  ERROR: JWT_SECRET is not set. Export it before deploying.}"
: "${RESEND_KEY:?   ERROR: RESEND_KEY is not set. Export it before deploying.}"

# ── Step 1: Build and push the container image ────────────────────────────────
echo "── Step 1: Building and pushing container image ──────────────────"
gcloud builds submit \
  --project="${PROJECT_ID}" \
  --tag="${IMAGE_TAG}" \
  .

echo ""
echo "── Step 2: Deploying to Cloud Run ────────────────────────────────"
gcloud run deploy "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --image="${IMAGE_TAG}" \
  --platform=managed \
  --allow-unauthenticated \
  --port=8080 \
  --cpu=1 \
  --memory=1Gi \
  --min-instances="${MIN_INSTANCES}" \
  --max-instances="${MAX_INSTANCES}" \
  --concurrency="${CONCURRENCY}" \
  --timeout=300 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-env-vars="BIGQUERY_DATASET=${BQ_DATASET}" \
  --set-env-vars="BQ_PROJECT=${PROJECT_ID}" \
  --set-env-vars="ENVIRONMENT=${ENV}" \
  --set-env-vars="SKIP_ORIGIN_CHECK=false" \
  --set-env-vars="PYTHONUNBUFFERED=1" \
  --set-secrets="JWT_SECRET=cometa-jwt-secret:latest" \
  --set-secrets="RESEND_KEY=cometa-resend-key:latest" \
  --service-account="cometa-vault-sa@${PROJECT_ID}.iam.gserviceaccount.com"

# ── Step 3: Print the deployed URL ────────────────────────────────────────────
echo ""
echo "── Step 3: Deployment status ─────────────────────────────────────"
SERVICE_URL=$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --format="value(status.url)")

echo ""
echo "  Service URL : ${SERVICE_URL}"
echo "  Health check: ${SERVICE_URL}/health"
echo ""

# Quick smoke test
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${SERVICE_URL}/health" || echo "000")
if [[ "$HTTP_STATUS" == "200" ]]; then
  echo "  ✓  Health check passed (HTTP 200)"
else
  echo "  ⚠  Health check returned HTTP ${HTTP_STATUS} — check logs:"
  echo "     gcloud run services logs read ${SERVICE_NAME} --region=${REGION} --limit=50"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Deployment complete — ${ENV} · $(date '+%Y-%m-%d %H:%M:%S')"
echo "═══════════════════════════════════════════════════════════════"
echo ""
