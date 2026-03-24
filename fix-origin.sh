#!/usr/bin/env bash
gcloud run services update cometa-vault --region=us-central1 --project=cometa-mvp --update-env-vars=SKIP_ORIGIN_CHECK=true --quiet && echo "DONE"
