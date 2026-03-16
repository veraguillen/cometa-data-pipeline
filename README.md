# Cometa Vault — Pipeline de Inteligencia Financiera

Plataforma de extracción, normalización y auditoría de KPIs financieros para el portafolio de startups de Cometa. Procesa documentos financieros (PDF, Excel, CSV, DOCX) mediante Vertex AI / Gemini 2.5 Flash y persiste los datos estructurados en Google BigQuery.

---

## Requisitos previos

| Herramienta | Versión mínima |
|---|---|
| Python | 3.11+ |
| Node.js | 18+ |
| npm | 9+ |
| Cuenta GCP | Con acceso a Vertex AI, BigQuery, Cloud Storage y Document AI |

---

## Inicio rápido

### 1. Clonar el repositorio

```bash
git clone <url-del-repo>
cd cometa-pipeline
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Edita `.env` y completa los valores reales:

```env
GOOGLE_APPLICATION_CREDENTIALS=cometa_key.json   # ruta a tu service account key
GOOGLE_PROJECT_ID=tu-proyecto-gcp
BIGQUERY_DATASET=cometa_vault_test
GCS_INPUT_BUCKET=nombre-de-tu-bucket
GCS_OUTPUT_BUCKET=nombre-de-tu-bucket
VERTEX_AI_LOCATION=us-central1
CORS_ORIGINS=["http://localhost:3000"]
```

> El archivo `cometa_key.json` (service account de GCP) va en la raíz del proyecto y **nunca se sube a git**.

### 3. Backend (Python / FastAPI)

```bash
# Crear y activar entorno virtual
python -m venv venv

# Windows
venv\Scripts\activate

# macOS / Linux
source venv/bin/activate

# Instalar dependencias
pip install -r requirements.txt

# Iniciar servidor
uvicorn src.api:app --reload --port 8000
```

El backend queda disponible en `http://localhost:8000`.
Documentación interactiva: `http://localhost:8000/docs`

> Al arrancar, el backend intenta sincronizar el esquema de BigQuery (timeout 15 s). Si BQ no responde, el servidor inicia igual — la persistencia es no-fatal por diseño.

### 4. Frontend (Next.js)

```bash
cd frontend
npm install
npm run dev
```

La app queda disponible en `http://localhost:3000`.

---

## Estructura del proyecto

```
cometa-pipeline/
├── src/
│   ├── api.py                        # Todos los endpoints HTTP (FastAPI)
│   ├── main.py                       # Entry point alternativo
│   ├── adapters/
│   │   ├── google_cloud.py           # Cliente Vertex AI / Gemini
│   │   └── document_ai.py            # Google Document AI (OCR)
│   └── core/
│       ├── data_contract.py          # KPI_REGISTRY, derivación, checklist
│       ├── auditor.py                # Motor de auditoría de fidelidad
│       ├── db_writer.py              # BigQuery writer
│       ├── kpi_engine.py             # Cálculo y normalización de KPIs
│       └── fx_service.py             # Tasas FMI, normalización a USD
│
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── page.tsx              # Router por rol (SOCIO / ANALISTA)
│       │   ├── dashboard/            # Página principal del dashboard
│       │   └── success/page.tsx      # Confirmación de envío
│       └── components/
│           ├── SocioView.tsx             # Portal de carga para founders
│           ├── AnalistaDashboard.tsx     # Dashboard global analistas
│           ├── SmartChecklistFounder.tsx # Checklist interactivo por sector
│           ├── ConfirmSubmitButton.tsx   # Botón de confirmación con tooltip
│           ├── FidelityAuditDetail.tsx   # Reporte de fidelidad (full-page)
│           └── FidelityAuditPanel.tsx    # Panel compacto para tablas
│
├── docs/
│   ├── API_REFERENCE.md              # Documentación completa de endpoints
│   ├── DATA_CONTRACT.md              # Contrato de datos, KPIs y derivación
│   ├── KPI_REGISTRY.md               # Catálogo de KPIs y verticales
│   └── WORKFLOW.md                   # Flujo completo de la plataforma
│
├── scripts/
│   └── dim_company_seed.sql          # Seed de empresas del portafolio
├── tests/                            # Tests del backend
├── templates/                        # HTML estáticos de respaldo
├── assets/                           # Diccionarios y datos de referencia
├── .env.example                      # Plantilla de variables de entorno
├── requirements.txt                  # Dependencias Python
└── README.md
```

---

## Variables de entorno — referencia completa

Ver `.env.example` para la lista completa. Las variables obligatorias son:

| Variable | Descripción |
|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | Ruta al archivo `cometa_key.json` |
| `GOOGLE_PROJECT_ID` | ID del proyecto en GCP |
| `BIGQUERY_DATASET` | Dataset de BigQuery (ej. `cometa_vault_test`) |
| `GCS_INPUT_BUCKET` | Bucket de entrada para documentos |
| `GCS_OUTPUT_BUCKET` | Bucket de salida para resultados |
| `VERTEX_AI_LOCATION` | Región de Vertex AI (ej. `us-central1`) |

---

## Stack tecnológico

| Capa | Tecnología |
|---|---|
| Backend | Python 3.11+, FastAPI 0.115, Uvicorn |
| IA | Vertex AI — Gemini 2.5 Flash |
| Base de datos | Google BigQuery |
| Almacenamiento | Google Cloud Storage |
| Frontend | Next.js, React 19, TypeScript 5, Tailwind CSS 4, Shadcn/UI |
| OCR | Google Document AI |

---

## KPIs extraídos (16 total)

| Grupo | KPIs |
|---|---|
| **Base** | `revenue` · `ebitda` · `cogs` |
| **Core** | `revenue_growth` · `gross_profit_margin` · `ebitda_margin` · `cash_in_bank_end_of_year` · `annual_cash_flow` · `working_capital_debt` |
| **SAAS** | `mrr` · `churn_rate` · `cac` |
| **LEND** | `portfolio_size` · `npl_ratio` |
| **ECOM** | `gmv` · `cac` |
| **INSUR** | `loss_ratio` · `cac` |

Ver catálogo completo → [`docs/DATA_CONTRACT.md`](docs/DATA_CONTRACT.md)

---

## Roles del sistema

| Rol | Acceso |
|---|---|
| **SOCIO** | Sube documentos, ve checklist de su empresa, confirma reporte |
| **ANALISTA** | Dashboard global, corrección de KPIs, auditoría de fidelidad, entrada manual |

El rol se selecciona en la pantalla de login y se persiste en `localStorage`.

---

## Documentación técnica

| Documento | Contenido |
|---|---|
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Endpoints, parámetros, request/response |
| [`docs/DATA_CONTRACT.md`](docs/DATA_CONTRACT.md) | KPI_REGISTRY, motor de derivación, checklist sectorial |
| [`docs/KPI_REGISTRY.md`](docs/KPI_REGISTRY.md) | Catálogo de KPIs, DIM_METRIC, SECTOR_REQUIREMENTS |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | Flujo end-to-end, decisiones de diseño |
