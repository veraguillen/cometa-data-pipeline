#!/usr/bin/env bash
gcloud run services update cometa-vault-frontend --region=us-central1 --project=cometa-mvp --image=us-central1-docker.pkg.dev/cometa-mvp/cometa-vault/frontend:latest --port=3000 --quiet && echo "Frontend redeployed OK"
