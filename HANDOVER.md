# Cometa Vault — Production Handover

## Architecture Map (Nivel 5)

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT BROWSER                                                 │
│  Next.js 16 · React 19 · Tailwind v4                           │
│  Cloud Run: cometa-vault-frontend-92572839783.us-central1       │
│  Port: 8080 (standalone output)                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS / SSE  (JWT Bearer)
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  FASTAPI BACKEND                                                │
│  Python 3.11 · Uvicorn 2 workers                               │
│  Cloud Run: cometa-api-*.us-central1.run.app                   │
│  Port: 8080                                                     │
│                                                                 │
│  Key endpoints:                                                 │
│   POST /api/login          JWT issuance (bcrypt + hybrid IDs)  │
│   GET  /api/me             Session validation                   │
│   POST /upload             PDF → Document AI → BigQuery        │
│   POST /api/chat           RAG chat (blocking)                 │
│   POST /api/chat/stream    RAG chat (SSE tokens)               │
│   GET  /api/export/csv     KPI data export (UTF-8 BOM)         │
│   GET  /api/portfolio-*    Portfolio analytics                  │
└────────┬───────────────────────────┬────────────────────────────┘
         │ google-cloud-bigquery     │ vertexai / google-genai
         ▼                           ▼
┌────────────────┐       ┌──────────────────────────────┐
│  BigQuery      │       │  Vertex AI / Gemini           │
│  cometa-mvp    │       │  gemini-2.5-flash             │
│                │       │  Location: us-central1        │
│  Tables:       │       │                               │
│  submissions   │       │  RAG pipeline:                │
│  fact_kpi_val  │       │  BQ context → XML prompt      │
│  dim_company   │       │  → Gemini → SSE stream        │
└────────────────┘       └──────────────────────────────┘
         │
         │ google-cloud-documentai
         ▼
┌──────────────────────────────┐
│  Document AI                 │
│  Processor: c5e1adfde68e63cf │
│  Location: us                │
│  PDF → structured JSON KPIs  │
└──────────────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│  Cloud Storage               │
│  ingesta-financiera-raw-*    │
│  Raw PDFs + processed output │
└──────────────────────────────┘
```

---

## Precision Semaphore

The system enforces a **90% confidence threshold** on KPI extraction:

- Gemini returns `confidence: float (0.0–1.0)` per KPI field
- `merge_consolidated_results()` resolves conflicts across PDF chunks: highest `confidence_score` wins
- `resolve_context_conflicts()` in `ai_engine.py` deduplicates RAG context: same rule
- `_extract_kpi_confidence_scores()` surfaces per-KPI scores to the frontend checklist
- KPIs with `confidence < 0.70` include an explanation in the `description` field
- `fact_kpi_values.is_valid` is set `FALSE` when confidence is below threshold

Do not modify the prompt's `confidence` instruction in `api.py` lines 1545–1650 without
a full regression test on the confidence scoring.

---

## Deployment — Step by Step

### Prerequisites

```bash
gcloud auth login
gcloud config set project cometa-mvp
gcloud services enable run.googleapis.com \
                        bigquery.googleapis.com \
                        documentai.googleapis.com \
                        aiplatform.googleapis.com \
                        secretmanager.googleapis.com \
                        artifactregistry.googleapis.com
```

### 1. Create secrets in Secret Manager

```bash
# Service account JSON (from cometa_key.json)
gcloud secrets create cometa-sa-json \
  --data-file=cometa_key.json

# JWT signing secret (min 32 chars)
echo -n "$(python -c "import secrets; print(secrets.token_hex(32))")" | \
  gcloud secrets create cometa-jwt-secret --data-file=-

# NextAuth secret
echo -n "$(openssl rand -hex 32)" | \
  gcloud secrets create cometa-nextauth-secret --data-file=-
```

### 2. Deploy the FastAPI backend

```bash
gcloud run deploy cometa-api \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --concurrency 20 \
  --min-instances 0 \
  --max-instances 5 \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --set-secrets="GCP_SERVICE_ACCOUNT_JSON=cometa-sa-json:latest,JWT_SECRET=cometa-jwt-secret:latest" \
  --set-env-vars="\
GOOGLE_CLOUD_PROJECT=cometa-mvp,\
GOOGLE_PROJECT_ID=cometa-mvp,\
BIGQUERY_DATASET=cometa_vault,\
VERTEX_LOCATION=us-central1,\
GEMINI_MODEL=gemini-2.5-flash,\
DOCUMENT_AI_PROCESSOR_ID=c5e1adfde68e63cf,\
DOCUMENT_AI_LOCATION=us,\
GCS_INPUT_BUCKET=ingesta-financiera-raw-cometa-mvp,\
GCS_OUTPUT_BUCKET=ingesta-financiera-raw-cometa-mvp,\
ENVIRONMENT=production,\
SKIP_ORIGIN_CHECK=false,\
EMAIL_FROM=no-reply@cometa.vc,\
EMAIL_FROM_NAME=Cometa Vault,\
CORS_ORIGINS=[\"https://cometa-vault-frontend-92572839783.us-central1.run.app\"]"
```

> **Email transport**: Set `RESEND_API_KEY` (recommended) or `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASSWORD`
> via `--set-secrets` (store in Secret Manager) or `--set-env-vars`.
> If neither is configured the service still starts — emails are logged to stdout.

Record the backend URL: `https://cometa-api-<HASH>-uc.a.run.app`

### 3. Deploy the Next.js frontend

```bash
cd frontend

gcloud run deploy cometa-vault-frontend \
  --source . \
  --region us-central1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --concurrency 80 \
  --min-instances 0 \
  --max-instances 5 \
  --memory 512Mi \
  --cpu 1 \
  --set-secrets="NEXTAUTH_SECRET=cometa-nextauth-secret:latest" \
  --set-env-vars="\
NEXT_PUBLIC_API_URL=https://cometa-api-<HASH>-uc.a.run.app,\
NEXTAUTH_URL=https://cometa-vault-frontend-92572839783.us-central1.run.app,\
ENVIRONMENT=production"
```

> **Note**: Replace `<HASH>` with the actual backend service hash from step 2.
> `NEXT_PUBLIC_API_URL` must point to the **backend** Cloud Run service, not the frontend.

### 4. Run BigQuery schema migration

Run **once** after the first deploy (or after any schema-breaking release).
Safe to re-run — idempotent via `ADD COLUMN IF NOT EXISTS`.

```bash
# Dry-run first — shows DDL without executing
python src/scripts/migrate_bq.py --dry-run

# Apply
python src/scripts/migrate_bq.py --project cometa-mvp --dataset cometa_vault
```

Columns added:

| Column | Type | Purpose |
|--------|------|---------|
| `confidence_score` | `FLOAT64` | Per-KPI Gemini extraction confidence (0.0–1.0) |
| `last_upload_at` | `TIMESTAMP` | UTC timestamp when the source document was ingested |

### 5. Verify the deployment

```bash
# Backend health
curl https://cometa-api-<HASH>-uc.a.run.app/health

# Frontend
open https://cometa-vault-frontend-92572839783.us-central1.run.app
```

---

## Local Development

```bash
# Backend
cp env.template .env           # fill in variables
.\venv\Scripts\python.exe -m uvicorn src.api:app --reload --port 8000

# Frontend (new terminal)
cd frontend
cp .env.production .env.local  # then set NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev
```

---

## Service Account Permissions

The service account (`agente-cometa@cometa-mvp.iam.gserviceaccount.com`) requires:

| Role | Purpose |
|------|---------|
| `roles/bigquery.dataEditor` | CREATE / INSERT / SELECT on `cometa_vault` dataset |
| `roles/bigquery.jobUser` | Run query jobs |
| `roles/documentai.apiUser` | Submit PDF parsing requests |
| `roles/storage.objectAdmin` | Read/write GCS buckets |
| `roles/aiplatform.user` | Invoke Vertex AI / Gemini |

```bash
# Grant all roles
SA="agente-cometa@cometa-mvp.iam.gserviceaccount.com"
PROJECT="cometa-mvp"
for ROLE in roles/bigquery.dataEditor roles/bigquery.jobUser \
            roles/documentai.apiUser roles/storage.objectAdmin \
            roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:$SA" --role="$ROLE"
done
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/api.py` | FastAPI routes, middleware, auth, CSV export |
| `src/ai_engine.py` | Gemini prompt builder, conflict resolution, streaming |
| `src/core/db_writer.py` | BigQuery schema + ingestion |
| `src/adapters/google_cloud.py` | GeminiAuditor — Vertex AI wrapper |
| `frontend/src/services/api-client.ts` | Axios + SSE + CSV download helpers |
| `frontend/src/contexts/ThemeContext.tsx` | 3-theme system (obsidian / slate / umber) |
| `frontend/src/components/analyst/AITerminal.tsx` | SSE streaming chat UI |
| `Dockerfile` | Backend multistage build |
| `frontend/Dockerfile` | Frontend multistage build (Next.js standalone) |
| `env.template` | All required environment variables documented |

---

## Theme System

Three brand-compliant themes — switched via `ThemeSwitcher` in the analyst header:

| Token | Obsidiana & Steel | Ivory & Slate | Deep Umber & Gold |
|-------|-------------------|---------------|-------------------|
| `--cometa-bg` | `#000000` | `#F4F1EB` | `#1A0F07` |
| `--cometa-accent` | `#64CAE4` | `#ECE5BC` | `#ECE5BC` |
| `--cometa-fg` | `#FFFFFF` | `#000000` | `#F0EDE6` |

Theme selection persists in `localStorage` under key `cometa_theme`.

---

## Conectar el dominio cometa.vc y activar SSL

Cloud Run emite certificados TLS automáticamente cuando se mapea un dominio personalizado.
No se necesita Nginx ni Let's Encrypt externo.

### Paso 1 — Verificar propiedad del dominio

```bash
# Solo la primera vez (omitir si el dominio ya está verificado en Google Search Console)
gcloud domains verify cometa.vc
```

Abre el enlace que imprime el comando y sigue la guía de verificación DNS (registro TXT).

### Paso 2 — Mapear el dominio al frontend

```bash
gcloud beta run domain-mappings create \
  --service   cometa-vault-frontend \
  --domain    cometa.vc \
  --region    us-central1
```

El comando devuelve registros DNS para añadir en tu proveedor de dominio:

| Tipo | Nombre | Destino |
|------|--------|---------|
| `A`  | `@`    | `216.239.32.21` |
| `A`  | `@`    | `216.239.34.21` |
| `A`  | `@`    | `216.239.36.21` |
| `A`  | `@`    | `216.239.38.21` |
| `AAAA` | `@`  | `2001:4860:4802:32::15` |
| `AAAA` | `@`  | `2001:4860:4802:34::15` |
| `AAAA` | `@`  | `2001:4860:4802:36::15` |
| `AAAA` | `@`  | `2001:4860:4802:38::15` |

> Verifica los valores exactos con:
> ```bash
> gcloud beta run domain-mappings describe --domain cometa.vc --region us-central1
> ```

### Paso 3 — Mapear subdominio `www` (redirección)

```bash
gcloud beta run domain-mappings create \
  --service   cometa-vault-frontend \
  --domain    www.cometa.vc \
  --region    us-central1
```

Añade un registro `CNAME www → ghs.googlehosted.com.` en tu proveedor.

### Paso 4 — Mapear el backend API

```bash
gcloud beta run domain-mappings create \
  --service   cometa-api \
  --domain    api.cometa.vc \
  --region    us-central1
```

Añade `CNAME api → ghs.googlehosted.com.` y actualiza `NEXT_PUBLIC_API_URL`:

```bash
gcloud run services update cometa-vault-frontend \
  --region us-central1 \
  --update-env-vars NEXT_PUBLIC_API_URL=https://api.cometa.vc
```

### Paso 5 — Verificar SSL (provisioning automático)

```bash
# Muestra el estado del certificado: ACTIVE cuando está listo (~15 min tras propagación DNS)
gcloud beta run domain-mappings describe \
  --domain cometa.vc \
  --region us-central1 \
  --format "value(status.resourceRecords[0].rrdata,status.conditions[0].message)"
```

El SSL es emitido y renovado automáticamente por Google. No se necesita ninguna acción adicional.

### Paso 6 — Actualizar CORS y NEXTAUTH_URL

Una vez el dominio está activo, actualiza las variables de entorno del backend:

```bash
gcloud run services update cometa-api \
  --region us-central1 \
  --update-env-vars \
    'CORS_ORIGINS=["https://cometa.vc","https://www.cometa.vc"]'
```

Y el frontend:

```bash
gcloud run services update cometa-vault-frontend \
  --region us-central1 \
  --update-env-vars \
    NEXTAUTH_URL=https://cometa.vc
```

---

## Known Constraints

- **Python 3.10** is used locally; Docker uses **3.11**. Schedule upgrade before `google-api-core` EOL (Oct 2026).
- `users.json` is a flat-file user store — adequate for the current team size (~20 users). Migrate to Cloud Firestore or Cloud SQL if headcount grows.
- SSE streaming (`/api/chat/stream`) requires Cloud Run `--timeout 300` and `--timeout-keep-alive 120` in Uvicorn to avoid premature connection cuts on long Gemini responses.
- PDF chunking is CPU-bound. Set Cloud Run `--concurrency 10-20` on the backend service to avoid memory pressure when multiple uploads are concurrent.
