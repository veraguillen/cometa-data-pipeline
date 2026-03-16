# Cometa Vault — Flujo de Trabajo

**Última actualización:** 2026-03-16

Guía completa de cómo opera la plataforma: desde que un founder sube un PDF hasta que el analista ve los KPIs en el dashboard.

---

## Roles del sistema

| Rol          | Quién es                          | Qué puede hacer                                    |
|--------------|-----------------------------------|----------------------------------------------------|
| **SOCIO**    | Founder / representante de empresa | Sube documentos financieros y ve sus propios reportes |
| **ANALISTA** | Equipo interno de Cometa           | Ve todos los fondos, corrige KPIs, entra datos manualmente |

---

## Mapa del flujo completo

```
[SOCIO]                        [BACKEND]                        [GCP]
   │                               │                               │
   │── Login (email + rol) ───────►│                               │
   │                               │                               │
   │── Arrastra PDF ──────────────►│                               │
   │                         Valida formato                        │
   │                         Calcula SHA-256                       │
   │                               │──── ¿Hash existe en vault? ──►│ GCS
   │                               │◄─── SÍ: devuelve resultado ───│
   │◄─ Muestra resultado cacheado ─│                               │
   │                               │                               │
   │                         NO: archivo nuevo                     │
   │                         ¿PDF > 90 páginas?                    │
   │                         SÍ → split_pdf_to_chunks()            │
   │                               │──── Chunk 1/N → Vertex AI ───►│ Gemini 2.5
   │                               │◄─── JSON KPIs + confianza ────│
   │                               │──── Chunk 2/N → Vertex AI ───►│
   │                               │◄─── JSON KPIs + confianza ────│
   │                         merge_consolidated_results()          │
   │                         (highest-confidence-wins)             │
   │                               │                               │
   │                         Detecta empresa (silent)              │
   │                         Asigna fondo (VII / CIII)             │
   │                         _ensure_fm_sections()                 │
   │                         Parsea y normaliza KPIs               │
   │                         Normaliza unidades ($/%/$M)           │
   │                         Motor de derivación (ratio KPIs)      │
   │                         Convierte a USD (FX)                  │
   │                         build_checklist_status()              │
   │                               │──── Guarda resultado ─────────►│ GCS vault/
   │                               │──── Inserta submission ───────►│ BigQuery
   │                               │──── Inserta fact_kpi_values ──►│ BigQuery
   │◄─ Respuesta: contrato +  ─────│                               │
   │   checklist_status + kpi_rows │                               │
   │                               │                               │
   │── SmartChecklistFounder ──────│ (renderiza KPIs por vertical) │
   │   BaseGroup + SectorGroup     │                               │
   │   [Ingresa KPIs faltantes]    │                               │
   │── Confirmar Envío ────────────►│                               │
   │                         Sanitiza valores frontend             │
   │                               │──── POST /api/manual-entry ──►│ BigQuery
   │◄─ router.push("/success") ────│                               │
   │                               │                               │
[ANALISTA]                         │                               │
   │── Ve dashboard global ───────►│                               │
   │                               │──── Lee vault/* ─────────────►│ GCS
   │                               │──── Lee fact_kpi_values ──────►│ BigQuery
   │◄─ Todos los resultados ───────│                               │
   │                               │                               │
   │── Corrige un KPI ────────────►│                               │
   │                               │──── UPDATE fact_kpi_values ───►│ BigQuery
   │◄─ Confirmación ───────────────│                               │
```

---

## Paso a paso detallado

### 1. Login

El usuario ingresa su email y selecciona su rol (`SOCIO` o `ANALISTA`).

- La sesión se guarda en `localStorage` (clave `cometa_user_session`).
- El rol determina qué vista se muestra:
  - **SOCIO** → `SocioView`: portal de carga limitado a su empresa.
  - **ANALISTA** → `AnalistaDashboard`: vista global con todos los fondos.
- No hay password: el rol es la única barrera de acceso en esta versión.

---

### 2. Subida de documento (SOCIO)

El founder arrastra un archivo o usa el selector. Formatos aceptados:

```
.pdf  .csv  .xlsx  .xls  .parquet  .docx  .doc
```

El frontend envía una request `POST /upload` con:
- El archivo como `multipart/form-data`
- Header `founder-email`: email del usuario logueado
- Header `company-id`: dominio de la empresa (extraído del email)

---

### 3. Deduplicación por hash

El backend calcula un **SHA-256** del contenido binario del archivo.

```
SHA-256(file_bytes) → "a3f9c1..."
```

Busca ese hash en GCS (`vault/{company_id}/`):

- **Duplicado encontrado** → devuelve el resultado ya almacenado sin gastar créditos de IA. El frontend muestra el resultado de inmediato con un mensaje de "documento reconocido".
- **Archivo nuevo** → continúa al siguiente paso.

---

### 4. Extracción con Vertex AI / Gemini 2.5 Flash

#### 4a. Chunking para PDFs largos

Antes de enviar a Gemini, el backend verifica el número de páginas:

```
≤ 90 páginas → llamada directa a gemini.extraer_y_auditar()
> 90 páginas → split_pdf_to_chunks(size=90)
                 → N bloques de bytes (no escribe a disco intermedio)
                 → N llamadas paralelas a Gemini
                 → merge_consolidated_results()  (highest-confidence-wins)
```

`merge_consolidated_results()` recorre el `KPI_REGISTRY` (16 KPIs) y por cada uno elige el valor con mayor `confidence` entre todos los bloques. Si un bloque no encontró el KPI (`value=null`), se ignora.

#### 4b. Contexto de industria en el prompt

El prompt se construye en dos partes para compatibilidad con Python 3.10:

```python
_prompt_prefix = f"""
Eres un auditor financiero senior.
Estás analizando una empresa de la vertical {_bucket_id}.
{_sector_instruction}   ← instrucción específica por vertical
"""
_prompt_body = """..."""   # JSON schema — string regular (no f-string)
prompt_config = _prompt_prefix + _prompt_body
```

Instrucciones sectoriales:
- **SAAS** — priorizar MRR, Churn Rate, CAC
- **LEND** — priorizar Portfolio Size, NPL Ratio
- **ECOM** — priorizar GMV; detectar aliases: "Total Sales Volume", "Gross Merchandise Value"
- **INSUR** — priorizar Loss Ratio
- **OTH** — extraer métricas financieras estándar

#### 4c. Fases del prompt

**Fase 1 — Análisis Previo:** Gemini infiere moneda, período, escala y zonas de ambigüedad. Resultado en `_document_context`.

**Fase 2 — Extracción estricta al esquema:** Gemini extrae los **16 KPIs** con tres campos por métrica:

| Campo | Descripción |
|-------|-------------|
| `value` | Valor con unidad y escala: `"36%"`, `"$9.7M"`, `"-$320K"` |
| `confidence` | Certeza del modelo (0.0–1.0) |
| `description` | Cita exacta de la fuente en el documento |

**Los 16 KPIs extraídos:**

| Grupo | KPI | Vertical |
|-------|-----|:--------:|
| Core | `revenue_growth`, `gross_profit_margin`, `ebitda_margin` | ALL |
| Core | `cash_in_bank_end_of_year`, `annual_cash_flow`, `working_capital_debt` | ALL |
| Base | `revenue`, `ebitda`, `cogs` | ALL |
| Sector | `mrr`, `churn_rate`, `cac` | SAAS |
| Sector | `portfolio_size`, `npl_ratio` | LEND |
| Sector | `gmv` | ECOM |
| Sector | `loss_ratio`, `cac` | INSUR |

---

### 5. Detección silenciosa de empresa

El backend escanea el JSON de Gemini + el nombre del archivo buscando coincidencias con el `PORTFOLIO_MAP` definido en `src/core/db_writer.py`.

- Si detecta la empresa: sobreescribe el `company_domain` y asigna el `portfolio_id` correcto automáticamente.
- Si no detecta: usa el dominio del email como identificador.

Esto permite que un analista interno suba documentos sin necesidad de especificar manualmente a qué empresa pertenecen.

---

### 6. Construcción del contrato canónico

`src/core/data_contract.py` convierte el JSON de Gemini en un contrato estructurado:

```
_ensure_fm_sections(gemini_json)
    └─ Garantiza que financial_metrics_2025 tenga las 6 secciones (con {} si faltan):
       revenue_growth, profit_margins, cash_flow_indicators,
       debt_ratios, base_metrics, sector_metrics

build_contract(gemini_json, file_hash, company_id, founder_email, ...)
    │
    ├─ parse_numeric("36%")       → numeric_value=36.0, unit="%"
    ├─ parse_numeric("$9.7M")     → numeric_value=9_700_000.0, unit="$M"
    ├─ _normalize_unit_synonym()  → "usd"→"$", "pct"→"%", "usdm"→"$M"
    ├─ detect_currency()          → "MXN"
    ├─ FX normalization           → normalized_value_usd
    ├─ calculate_derived_kpis()   → gross_profit_margin, ebitda_margin (si no extraídos)
    └─ integrity check            → warnings, avg_confidence, status
```

El contrato tiene cuatro partes:
- **`submission`**: metadatos (empresa, fondo, período, hash, email, avg_confidence, status).
- **`kpi_rows`**: una fila por KPI con valor parseado, unidad normalizada, tasa FX y flag de validez.
- **`raw_gemini`**: JSON original de Gemini sin modificar (trazabilidad).
- **`integrity`**: `period_consistent`, `valid_ratio`, `warnings[]`.

---

### 7. Normalización de moneda (FX)

`src/core/fx_service.py` convierte todas las métricas monetarias a USD usando tasas promedio anuales del FMI.

```
normalized_value_usd = numeric_value / fx_rate
```

Monedas soportadas: MXN, BRL, COP, ARS, CLP, PEN, EUR, GBP, CAD, JPY.

Si la moneda no está en la tabla o el año no tiene tasa, el campo `normalized_value_usd` queda en `NULL` y se añade un warning al contrato.

---

### 8. Persistencia en GCS y BigQuery

**Google Cloud Storage:**
```
vault/{company_id}/{file_hash}_result.json   ← JSON de Gemini
vault/{company_id}/raw/{file_hash}_archivo.pdf ← archivo original
```

**BigQuery (`cometa_vault`):**
```
dim_company        ← catálogo de empresas por fondo (se sincroniza al arrancar)
submissions        ← una fila por documento único
fact_kpi_values    ← una fila por KPI por submission
```

Si BigQuery no está disponible (timeout, error 403), la operación **no falla**: el resultado se guarda igual en GCS y el frontend recibe la respuesta. BigQuery es no-fatal por diseño.

---

### 9. SmartChecklistFounder — Validación sectorial del SOCIO

Tras recibir la respuesta de `/upload`, el frontend renderiza `SmartChecklistFounder` con la información de `checklist_status` y `kpi_rows`. El componente aplica renderizado condicional por vertical:

#### Agrupación visual (dos secciones)

**Métricas Financieras Generales** (siempre visible — 9 KPIs base):
```
revenue, ebitda, cogs,
revenue_growth, gross_profit_margin, ebitda_margin,
cash_in_bank_end_of_year, annual_cash_flow, working_capital_debt
```

**Métricas de Operación · {Vertical}** (solo si `sectorGroup.length > 0`):

| Bucket | KPIs mostrados |
|--------|---------------|
| SAAS | mrr, churn_rate, cac |
| ECOM | gmv, cac |
| LEND | portfolio_size, npl_ratio |
| INSUR | loss_ratio, cac |
| OTH | *(solo sección base)* |

KPIs de otras verticales **no existen en el DOM** — esto previene errores de validación en el body del POST.

#### Semáforo de estado

| Color | Condición |
|-------|-----------|
| Verde | `confidence ≥ 0.85` — dato fiable |
| Azul | `source_description = "calculated"` — derivado matemáticamente |
| Ámbar | `0.70 ≤ confidence < 0.85` — revisar |
| Rojo | `is_valid = false` o `numeric_value = null` — KPI faltante → input manual inline |

#### Botón de confirmación — `ConfirmSubmitButton`

| Estado | Condición | Visual |
|--------|-----------|--------|
| Deshabilitado | `missing_critical_kpis.length > 0` | Opacidad 40% + Tooltip con KPIs faltantes |
| Activo | Todos los KPIs críticos presentes o completados manualmente | Gradiente `#00237F → #64CAE4` |
| Cargando | Guardando en BQ | Spinner + "Guardando en Bóveda…" |

Al confirmar:
1. `sanitizeKpiValue()` limpia los inputs manuales (`"1,200.50"` → `"1200.50"`)
2. Si hay valores manuales: `POST /api/manual-entry` con los 16 KPIs + `submission_id`
3. `router.push("/success")` → página de confirmación

#### Página de éxito — `/success`

Vista limpia (dark): check SVG verde animado, "Datos Cargados", botón "Volver al Dashboard".

---

### 10. Vista del ANALISTA

Al abrir el dashboard, el analista ve:

1. **Selector de fondo** — `Fondo VII` / `Fondo CIII`
2. **Lista de resultados** — todos los documentos procesados de todas las empresas del fondo seleccionado, ordenados de más reciente a más antiguo.
3. **Cards de KPIs** — muestra los 6 indicadores con semáforo de confianza:
   - Verde: `confidence ≥ 0.90`
   - Amarillo: `0.70 ≤ confidence < 0.90`
   - Rojo: `confidence < 0.70`
4. **Toggle de moneda** — si el documento es en moneda no-USD, aparece un toggle para ver valores en moneda original o convertidos a USD.

---

### 11. Corrección de KPIs (ANALISTA)

Cuando Gemini extrae un valor incorrecto o con baja confianza, el analista puede corregirlo:

1. Click en **Editar Datos** (ícono de lápiz).
2. Los campos con `confidence < 0.85` aparecen resaltados en ámbar.
3. El analista ingresa el valor corregido con su unidad: `"42%"`, `"$8.5M"`, `"-$320K"`.
4. Click en **Guardar** → `PUT /api/kpi-update`.
5. BigQuery actualiza la fila con:
   - `is_manually_edited = TRUE`
   - `edited_at = CURRENT_TIMESTAMP()`
   - `edited_raw_value = <valor anterior>` (snapshot de auditoría)
6. El dashboard se actualiza de forma optimista (sin reload).

---

### 12. Entrada manual de KPIs (ANALISTA o SOCIO)

Cuando no hay PDF disponible, los KPIs se ingresan directamente desde `SmartChecklistFounder` o desde la pestaña de Auditoría Manual:

1. El founder ve los KPIs faltantes (estado rojo) con un input inline.
2. Ingresa el valor con su formato natural: `"36%"`, `"$9.7M"`, `"1,200"`.
3. `sanitizeKpiValue()` en el frontend limpia el valor antes de enviarlo:
   - Elimina `$`, `%`, `,`, espacios → string numérico limpio
   - Valores inválidos o vacíos → `null` (no se incluyen en el body)
4. `POST /api/manual-entry` con hasta los 16 KPIs + `submission_id` (liga al upload).
5. Backend aplica `model_validator`:
   - `""` → `null` (previene 422 por strings vacíos)
   - `float/int` → `str` (para `parse_numeric`)
6. El backend genera un hash único `SHA-256("{company}:{period}:{uuid4()}")[:16]`.
7. Persiste en BigQuery con `confidence = 1.0` y `description = "Entrada manual del Analista"`.
8. `router.push("/success")` completa el flujo.

---

## Estructura de carpetas clave

```
cometa-pipeline/
│
├── src/                              ← Backend (Python / FastAPI)
│   ├── api.py                        ← Todos los endpoints HTTP
│   │                                    split_pdf_to_chunks()
│   │                                    merge_consolidated_results()
│   │                                    _ensure_fm_sections()
│   │                                    _chunk_and_process_pdf()
│   │                                    ManualEntryRequest + model_validator
│   ├── adapters/
│   │   ├── google_cloud.py           ← Cliente de Vertex AI / Gemini
│   │   └── document_ai.py            ← Adapter para Document AI (OCR avanzado)
│   └── core/
│       ├── data_contract.py          ← Parser de KPIs + contrato + derivación
│       │                                KPI_REGISTRY (16 KPIs)
│       │                                _UNIT_SYNONYMS + _normalize_unit_synonym()
│       │                                build_checklist_status()
│       ├── db_writer.py              ← Escritura en BigQuery + PORTFOLIO_MAP
│       │                                COMPANY_BUCKET + DIM_METRIC
│       │                                run_fidelity_audit()
│       └── fx_service.py             ← Tasas de cambio FMI + conversión a USD
│
├── frontend/                         ← Frontend (Next.js 15 / TypeScript)
│   └── src/
│       ├── app/
│       │   ├── page.tsx              ← Router por rol (SOCIO / ANALISTA)
│       │   └── success/
│       │       └── page.tsx          ← Página de confirmación post-upload
│       ├── components/
│       │   ├── LoginScreen.tsx       ← Pantalla de login
│       │   ├── SocioView.tsx         ← Portal de carga (arrastra + checklist)
│       │   ├── SmartChecklistFounder.tsx ← Semáforo sectorial + inputs manuales
│       │   │                              BASE_KPI_KEYS + SECTOR_KPI_MAP
│       │   │                              KpiGroupSection (2 secciones visuales)
│       │   │                              sanitizeKpiValue()
│       │   ├── ConfirmSubmitButton.tsx ← CTA con Tooltip de KPIs faltantes
│       │   ├── AnalistaDashboard.tsx ← Dashboard global para analistas
│       │   ├── FileUploader.tsx      ← Componente drag & drop
│       │   └── kpi-card.tsx          ← Tarjeta individual de KPI con semáforo
│       └── styles/
│           └── cometa-branding.css   ← Tokens de diseño y animaciones
│
├── docs/                             ← Documentación técnica
│   ├── API_REFERENCE.md
│   ├── DATA_CONTRACT.md
│   ├── KPI_REGISTRY.md
│   └── WORKFLOW.md                   ← Este archivo
├── templates/                        ← HTMLs alternativos
├── data/                             ← Datos de referencia locales
└── tests/                            ← Tests del backend
```

---

## Variables de entorno necesarias

```bash
# GCP
GOOGLE_APPLICATION_CREDENTIALS=./cometa_key.json
GOOGLE_PROJECT_ID=cometa-mvp

# BigQuery
BIGQUERY_DATASET=cometa_vault

# Vertex AI
VERTEX_AI_LOCATION=us-central1

# GCS
GCS_INPUT_BUCKET=ingesta-financiera-raw-cometa-mvp
GCS_OUTPUT_BUCKET=<bucket de resultados>

# Frontend
CORS_ORIGINS=["http://localhost:3000"]
```

---

## Cómo arrancar el proyecto localmente

```bash
# 1. Backend
cd cometa-pipeline
python -m venv venv
venv/Scripts/activate          # Windows
# source venv/bin/activate     # Mac/Linux

pip install -r requirements.txt
uvicorn src.api:app --reload --port 8000

# 2. Frontend (en otra terminal)
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

Al arrancar, el backend intenta conectarse a BigQuery con un timeout de 15 segundos. Si no hay conexión disponible, el servidor arranca igual — BigQuery es no-fatal.

---

## Decisiones de diseño relevantes

| Decisión | Razón |
|---|---|
| Deduplicación por SHA-256 | Evita reprocesar el mismo archivo y gastar tokens de Gemini |
| BigQuery no-fatal al startup | El servidor no queda zombi si GCP no responde |
| `confidence` por KPI | Permite al analista priorizar qué revisar manualmente |
| `_document_context` en Fase 1 | Gemini infiere moneda/escala antes de extraer, evitando errores de normalización |
| FX con tasas anuales del FMI | Comparación justa entre empresas de distintos países |
| Audit trail en `fact_kpi_values` | `edited_raw_value` preserva el valor original de Gemini para trazabilidad |
| `portfolio_id` asignado desde `PORTFOLIO_MAP` | Un solo lugar para mantener el catálogo de empresas por fondo |
| PDF Chunking a 90 páginas | Gemini tiene límite de páginas; bloques de 90 + merge evita errores en PDFs largos |
| `merge_consolidated_results` highest-confidence-wins | El mejor dato de cualquier bloque gana — no se pierde información entre chunks |
| `_ensure_fm_sections()` antes de `build_contract` | Previene `KeyError` cuando Gemini omite secciones completas del JSON |
| `_UNIT_SYNONYMS` en `data_contract` | Normaliza "usd"/"pct"/"ratio" → "$"/"%"; BigQuery siempre recibe el símbolo canónico |
| Contexto de industria en prompt | Gemini focalizado en la vertical reduce alucinaciones de KPIs ajenos al sector |
| `bucket_mismatch` solo ERROR si `confidence > 0.95` | Alucinaciones de bajo confidence son ruido; solo se escala si Gemini está muy seguro |
| `BASE_KPI_KEYS` + `SECTOR_KPI_MAP` en frontend | KPIs de otras verticales no existen en el DOM — previene enviarlos al backend |
| `sanitizeKpiValue()` antes del POST | El founder escribe `"$1,200"` — la limpieza garantiza que llegue `"1200"` a Pydantic |
| `model_validator(mode="before")` en Pydantic | `""` → `null` y `float` → `str` antes de validar — elimina errores 422 del frontend |
| `submission_id` en `manual-entry` | Liga la entrada manual al upload original para trazabilidad de auditoría |
| `ConfirmSubmitButton` + Tooltip | UX: el founder sabe exactamente qué falta antes de poder confirmar |
| Página `/success` independiente | Separación clara entre flujo de carga y confirmación; evita estado sucio en `SocioView` |
