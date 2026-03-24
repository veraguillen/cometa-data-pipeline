#!/usr/bin/env bash
# setup-gcp.sh — Configura IAM, Artifact Registry y lanza el build completo
# Uso: bash setup-gcp.sh
set -e

PROJECT="cometa-mvp"
REGION="us-central1"
SA="cometa-vault-sa@${PROJECT}.iam.gserviceaccount.com"

echo "==> [1/6] Artifact Registry"
gcloud artifacts repositories create cometa-vault \
  --repository-format=docker \
  --location="${REGION}" \
  --project="${PROJECT}" 2>/dev/null || echo "  ya existe, ok"

echo "==> [2/6] Service Account"
gcloud iam service-accounts create cometa-vault-sa \
  --display-name="Cometa Vault SA" \
  --project="${PROJECT}" 2>/dev/null || echo "  ya existe, ok"

echo "==> [3/6] Permisos del Service Account"
for ROLE in \
  roles/run.admin \
  roles/run.invoker \
  roles/bigquery.dataEditor \
  roles/bigquery.jobUser \
  roles/storage.objectAdmin \
  roles/secretmanager.secretAccessor \
  roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${SA}" \
    --role="${ROLE}" \
    --quiet 2>/dev/null && echo "  ${ROLE} ok"
done

echo "==> [4/6] Permisos del agente Cloud Build"
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT}" --format="value(projectNumber)")
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/secretmanager.secretAccessor \
  roles/artifactregistry.writer \
  roles/storage.objectAdmin; do
  gcloud projects add-iam-policy-binding "${PROJECT}" \
    --member="serviceAccount:${CB_SA}" \
    --role="${ROLE}" \
    --quiet 2>/dev/null && echo "  ${ROLE} ok"
done

echo "==> [5/6] Secrets disponibles"
gcloud secrets list --project="${PROJECT}"

echo ""
echo "==> [6/6] Lanzando build completo (backend + frontend)..."
echo "    Esto tarda ~10-15 min"
gcloud builds submit . --config=cloudbuild.yaml --project="${PROJECT}"
