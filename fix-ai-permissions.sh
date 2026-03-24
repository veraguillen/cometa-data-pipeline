#!/usr/bin/env bash
SA="cometa-vault-sa@cometa-mvp.iam.gserviceaccount.com"
for ROLE in roles/aiplatform.user roles/ml.developer roles/bigquery.jobUser; do
  gcloud projects add-iam-policy-binding cometa-mvp --member="serviceAccount:$SA" --role="$ROLE" --condition=None --quiet && echo "$ROLE OK"
done
gcloud run services update cometa-vault --region=us-central1 --project=cometa-mvp --service-account=$SA --quiet && echo "Service updated"
