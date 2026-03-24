#!/usr/bin/env bash
SA="cometa-vault-sa@cometa-mvp.iam.gserviceaccount.com"
for SECRET in cometa-jwt-secret cometa-gcp-credentials cometa-resend-key; do
  gcloud secrets add-iam-policy-binding $SECRET --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" --project=cometa-mvp --quiet && echo "$SECRET OK"
done
gcloud builds submit . --config=cloudbuild.yaml --project=cometa-mvp
