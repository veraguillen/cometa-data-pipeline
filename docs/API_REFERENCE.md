# Cometa Vault — Referencia de API

**Versión:** 1.3.0
**Servidor:** `http://localhost:8000` (desarrollo)
**Framework:** FastAPI — documentación interactiva en `/docs` (Swagger) y `/redoc`
**Fuente:** Auditado directamente desde `src/api.py` — 2026-03-16
**Última actualización:** 2026-03-16 — PDF Chunking, 16 KPIs en manual-entry, coerción Pydantic, flujo de confirmación

> **Regla de oro de esta documentación:** Todo lo descrito aquí existe en el código. Nada está inferido ni asumido.

---

## Índice de endpoints

| Método | Ruta | Rol | Descripción |
|--------|------|-----|-------------|
| `POST` | `/upload` | SOCIO / ANALISTA | Procesar documento financiero |
| `PUT` | `/api/kpi-update` | ANALISTA | Corregir un KPI en BigQuery |
| `POST` | `/api/manual-entry` | ANALISTA | Ingresar KPIs sin documento |
| `DELETE` | `/api/submission` | ANALISTA | Eliminar un blob del vault GCS |
| `GET` | `/api/portfolio-companies` | ANALISTA | Listar empresas por fondo |
| `GET` | `/api/result/{file_hash}` | ANALISTA | Obtener JSON de Gemini por hash |
| `GET` | `/api/results` | ANALISTA | Listar resultados de una empresa |
| `GET` | `/api/results/all` | ANALISTA | Listar resultados de todos los fondos |
| `GET` | `/api/analytics/portfolio` | ANALISTA | KPIs agregados por fondo (BigQuery) |
| `GET` | `/api/audit` | ANALISTA | Auditoría SQL post-insert |
| `GET` | `/api/audit/fidelity/{submission_id}` | ANALISTA | Reporte de fidelidad completo |
| `GET` | `/health` | Sistema | Estado del servidor |
| `GET` | `/upload-page` | SOCIO | Página HTML de carga |
| `GET` | `/dashboard` | ANALISTA | Dashboard HTML estático |

---

## CORS

Configurable vía variable de entorno `CORS_ORIGINS` (array JSON).
Default: `["http://localhost:3000"]`

```bash
CORS_ORIGINS=["http://localhost:3000","https://app.cometa.vc"]
```

---

## `POST /upload`

Recibe un documento financiero, lo procesa con Gemini 2.5, construye el contrato de 16 KPIs y persiste en GCS + BigQuery.

### Request

```
Content-Type: multipart/form-data
```

| Campo | Tipo | Ubicación | Obligatorio | Notas |
|-------|------|-----------|:-----------:|-------|
| `file` | `UploadFile` | Form-data | Sí | Ver formatos aceptados abajo |
| `founder-email` | `string` | Header | No | Si contiene `@`, el dominio se usa como `company_id` de respaldo |
| `company-id` | `string` | Header | No | Tiene prioridad sobre el dominio del email |

**Formatos aceptados:** `.pdf` · `.csv` · `.xlsx` · `.xls` · `.parquet` · `.docx` · `.doc`

### Pipeline interno (orden de ejecución)

```
1. Validar extensión
2. SHA-256(bytes)[:16]  →  file_hash
3. Buscar file_hash en vault/{company_domain}/ de GCS
   ├── Encontrado → retornar resultado cacheado (no gasta créditos de IA)
   └── No encontrado → continuar
4. Guardar en temp/{file_hash}_{filename}
5. Inicializar GeminiAuditor + DocumentAIAdapter
6. Enrutar por tipo:
   ├── .csv/.xlsx/.xls/.parquet → _process_tabular()       (Markdown → Gemini)
   ├── .docx/.doc               → _process_docx()          (texto+tablas → Gemini)
   └── .pdf                     → _chunk_and_process_pdf()
         ├── ≤ 90 páginas → gemini.extraer_y_auditar() directo
         └── > 90 páginas → split_pdf_to_chunks(90p) → N llamadas → merge_consolidated_results()
7. detect_company_from_text(json + filename)  →  company_domain, portfolio_id
8. build_contract()  →  16 KPIs + derivación + FX
9. COMPANY_BUCKET[company_domain]  →  build_checklist_status()
10. insert_contract()  →  BigQuery (non-fatal si BQ caído)
11. Subir JSON resultado a GCS: vault/{company_domain}/{file_hash}_result.json
12. Subir archivo original a GCS: vault/{company_domain}/raw/{file_hash}_{filename}
13. Eliminar temp/{file_hash}_{filename}
```

### Response — archivo nuevo (200)

```json
{
  "status": "success",
  "message": "Archivo procesado exitosamente",
  "duplicate": false,
  "result": {
    "_document_context": {
      "currency": "USD",
      "period": "FY2025",
      "scale": "millions",
      "scale_notes": "Stated in document footer: 'amounts in USD millions'"
    },
    "financial_metrics_2025": { "..." }
  },
  "submission": {
    "submission_id":     "550e8400-e29b-41d4-a716-446655440000",
    "file_hash":         "a3f9c1b2d4e5f678",
    "company_id":        "simetrik",
    "founder_email":     "ceo@simetrik.com",
    "original_filename": "financials_2025.pdf",
    "submitted_at":      "2026-03-16T18:00:00+00:00",
    "period_id":         "FY2025",
    "period_consistent": true,
    "kpi_count_total":   18,
    "kpi_count_valid":   16,
    "avg_confidence":    0.882,
    "status":            "processed",
    "detected_currency": "USD",
    "portfolio_id":      "CIII"
  },
  "kpi_rows": [
    {
      "submission_id":       "550e8400-...",
      "kpi_key":             "revenue",
      "kpi_label":           "Total Revenue",
      "raw_value":           "$4.2M",
      "numeric_value":       4200000.0,
      "unit":                "$M",
      "period_id":           "FY2025",
      "source_description":  "Income Statement, line 1, p.8",
      "is_valid":            true,
      "original_currency":   "USD",
      "fx_rate":             1.0,
      "normalized_value_usd": 4200000.0,
      "confidence":          0.95
    }
  ],
  "integrity": {
    "period_consistent": true,
    "valid_ratio": 0.89,
    "warnings": []
  },
  "db": {
    "inserted": true,
    "duplicate": false,
    "submission_id": "550e8400-..."
  },
  "file_hash": "a3f9c1b2d4e5f678",
  "company_domain": "simetrik",
  "checklist_status": {
    "bucket": "SAAS",
    "is_complete": true,
    "present_kpis": ["cac", "churn_rate", "mrr", "revenue"],
    "missing_critical_kpis": [],
    "display_message": "Reporte SaaS completo. Todos los KPIs criticos presentes."
  }
}
```

### Response — duplicado detectado (200)

```json
{
  "status": "success",
  "message": "Documento reconocido en la bóveda de Cometa. Sincronizando métricas...",
  "duplicate": true,
  "result": { "..." },
  "file_hash": "a3f9c1b2d4e5f678",
  "company_domain": "simetrik"
}
```

> **Importante:** La respuesta de duplicado NO incluye `submission`, `kpi_rows`, `integrity`, `db`, ni `checklist_status`. El frontend debe manejar ambas estructuras inspeccionando el campo `duplicate`.

### `submission.status` — valores posibles

| Valor | Condición de activación |
|-------|------------------------|
| `"processed"` | `kpi_count_valid > 0` y `avg_confidence >= 0.85` |
| `"pending_human_review"` | `avg_confidence < 0.85` (threshold en `data_contract.py:571`) |
| `"empty"` | `kpi_count_valid == 0` |

### Errores

| Código | Causa |
|--------|-------|
| `400` | Extensión no soportada |
| `500` | Error de credenciales GCS (`GCS_AUTH`) o fallo general de procesamiento |

---

## `PUT /api/kpi-update`

Persiste una corrección manual de analista sobre un KPI existente en BigQuery.

### Request Body (JSON)

```json
{
  "submission_id": "550e8400-e29b-41d4-a716-446655440000",
  "metric_id":     "revenue_growth",
  "value":         "42%"
}
```

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `submission_id` | `string` | UUID de la submission en BigQuery |
| `metric_id` | `string` | `kpi_key` exacto (ej. `"revenue_growth"`, `"ebitda_margin"`) |
| `value` | `string` | Nuevo valor con unidad (ej. `"42%"`, `"$8.5M"`) — pasa por `parse_numeric()` |

### Comportamiento

- Valida el nuevo valor con `parse_numeric()` (Rule 4).
- Escribe en BigQuery: `is_manually_edited = TRUE`, `edited_at = CURRENT_TIMESTAMP()`.
- Preserva el valor original en `edited_raw_value` para trazabilidad de auditoría.

### Response (200)

```json
{
  "status":  "success",
  "message": "KPI 'revenue_growth' actualizado correctamente"
}
```

### Errores

| Código | Causa |
|--------|-------|
| `404` | Par `(submission_id, metric_id)` no encontrado en BigQuery |
| `500` | Error de conexión con BigQuery |

---

## `POST /api/manual-entry`

Persiste KPIs ingresados manualmente sin PDF. Construye un JSON sintético que imita la estructura de Gemini y lo procesa con el mismo pipeline `build_contract()`.

### Request Body (JSON)

```json
{
  "company_id":               "simetrik",
  "portfolio_id":             "CIII",
  "period_id":                "FY2025",
  "founder_email":            "analista@cometa.vc",
  "submission_id":            "550e8400-e29b-41d4-a716-446655440000",
  "revenue_growth":           "36%",
  "gross_profit_margin":      "68%",
  "ebitda_margin":            "-12%",
  "cash_in_bank_end_of_year": "$9.7M",
  "annual_cash_flow":         "-$3.2M",
  "working_capital_debt":     "$1.1M",
  "revenue":                  "$4.2M",
  "ebitda":                   "-$0.8M",
  "cogs":                     "$1.3M",
  "mrr":                      "$350K",
  "churn_rate":               "2.1%",
  "cac":                      "$120",
  "portfolio_size":           "$25M",
  "npl_ratio":                "3.4%",
  "gmv":                      "$8.5M",
  "loss_ratio":               "62%"
}
```

| Campo | Tipo | Obligatorio | Default | Notas |
|-------|------|:-----------:|---------|-------|
| `company_id` | `string` | Sí | — | |
| `portfolio_id` | `string` | Sí | — | |
| `period_id` | `string` | No | `"FY2025"` | |
| `founder_email` | `string` | No | `""` | |
| `submission_id` | `string \| null` | No | `null` | Liga la entrada al upload original |
| `revenue_growth` | `string \| null` | No | `null` | KPI core |
| `gross_profit_margin` | `string \| null` | No | `null` | KPI core |
| `ebitda_margin` | `string \| null` | No | `null` | KPI core |
| `cash_in_bank_end_of_year` | `string \| null` | No | `null` | KPI core |
| `annual_cash_flow` | `string \| null` | No | `null` | KPI core |
| `working_capital_debt` | `string \| null` | No | `null` | KPI core |
| `revenue` | `string \| null` | No | `null` | Base metric |
| `ebitda` | `string \| null` | No | `null` | Base metric |
| `cogs` | `string \| null` | No | `null` | Base metric |
| `mrr` | `string \| null` | No | `null` | SAAS |
| `churn_rate` | `string \| null` | No | `null` | SAAS |
| `cac` | `string \| null` | No | `null` | SAAS / ECOM / INSUR |
| `portfolio_size` | `string \| null` | No | `null` | LEND |
| `npl_ratio` | `string \| null` | No | `null` | LEND |
| `gmv` | `string \| null` | No | `null` | ECOM |
| `loss_ratio` | `string \| null` | No | `null` | INSUR |

### Coerción automática de tipos (`model_validator`)

Pydantic ejecuta un `model_validator(mode="before")` sobre los 16 campos KPI antes de validar:

| Input recibido | Resultado |
|---------------|-----------|
| `""` (string vacío) | `null` |
| `1200.5` (número) | `"1200.5"` (string para `parse_numeric`) |
| `"36%"` | `"36%"` (sin cambio) |
| `null` | `null` (sin cambio) |

Esto previene errores 422 cuando el frontend envía campos vacíos o valores numéricos pre-parseados.

Todos los nodos se crean con `confidence = 1.0` y `source_description = "Entrada manual del Analista"`.

**Deduplicación:** `file_hash = SHA-256("{company_id}:{period_id}:{uuid4()}")[:16]` — siempre único. No hay deduplicación entre entradas manuales del mismo período.

### Response (200)

```json
{
  "status":     "success",
  "message":    "Datos de simetrik guardados correctamente",
  "submission": { "..." },
  "kpi_rows":   [ "..." ],
  "db":         { "inserted": true, "duplicate": false, "submission_id": "..." }
}
```

---

## `DELETE /api/submission`

Elimina un blob del vault en GCS. **El registro en BigQuery no se elimina** — esto preserva la trazabilidad de auditoría.

### Query Parameters

| Parámetro | Tipo | Obligatorio |
|-----------|------|:-----------:|
| `file_hash` | `string` | Sí |
| `company_id` | `string` | Sí |

Busca el blob dentro de `vault/{company_id}/` cuyo `metadata.file_hash` coincida.

### Response (200)

```json
{ "status": "success", "deleted": 1, "file_hash": "a3f9c1b2d4e5f678" }
```

### Errores

| Código | Causa |
|--------|-------|
| `404` | Ningún blob en `vault/{company_id}/` tiene ese `file_hash` |
| `500` | Error de GCS |

---

## `GET /api/portfolio-companies`

Lista las empresas del portafolio agrupadas por fondo.

### Query Parameters

| Parámetro | Tipo | Obligatorio | Descripción |
|-----------|------|:-----------:|-------------|
| `portfolio_id` | `string` | No | `"VII"` o `"CIII"`. Sin valor: retorna ambos fondos |

### Response (200)

```json
{
  "status": "success",
  "portfolios": [
    {
      "portfolio_id":   "CIII",
      "portfolio_name": "Fondo CIII",
      "companies":      ["Atani", "Cluvi", "Dapta", "..."]
    },
    {
      "portfolio_id":   "VII",
      "portfolio_name": "Fondo VII",
      "companies":      ["Bewe", "Bitso", "Bnext", "..."]
    }
  ]
}
```

Empresas capitalizadas con `.capitalize()`, ordenadas alfabéticamente. Fondos ordenados alfabéticamente.

---

## `GET /api/result/{file_hash}`

Recupera el JSON crudo de Gemini para un hash específico. Busca en el prefijo `staging/` del bucket.

### Path Parameter

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `file_hash` | `string` | 16 primeros caracteres del SHA-256 del archivo |

### Response (200)

El JSON de Gemini tal como fue almacenado en GCS.

### Errores

| Código | Causa |
|--------|-------|
| `404` | Hash no encontrado en `staging/` |

---

## `GET /api/results`

Lista todos los resultados JSON del vault de una empresa específica.

### Query Parameters

| Parámetro | Tipo | Obligatorio |
|-----------|------|:-----------:|
| `company_id` | `string` | Sí — retorna `400` si se omite |

### Response (200)

```json
{
  "status":     "success",
  "results":    [ "..." ],
  "company_id": "simetrik",
  "total":      3
}
```

Cada elemento del array `results`:

```json
{
  "id":   "a3f9c1b2d4e5f678_result",
  "data": { "JSON de Gemini" },
  "date": "2026-03-15T18:00:00",
  "metadata": {
    "original_filename": "financials.pdf",
    "founder_email":     "ceo@simetrik.com",
    "file_hash":         "a3f9c1b2d4e5f678",
    "processed_at":      "2026-03-15T18:00:00",
    "gcs_path":          "vault/simetrik/a3f9c1b2d4e5f678_result.json",
    "portfolio_id":      "CIII"
  }
}
```

Ordenado por `processed_at` descendente (más reciente primero).

---

## `GET /api/results/all`

Devuelve todos los resultados de todos los fondos. Recorre el prefijo `vault/` completo. Usado por el dashboard del analista al montar.

### Sin parámetros.

### Response (200)

```json
{
  "status":  "success",
  "results": [ "..." ],
  "total":   42
}
```

Idéntico al formato de `/api/results`, con la adición de `"company_domain"` en cada `metadata`.

---

## `GET /api/analytics/portfolio`

KPIs agregados desde BigQuery para un fondo, agrupados por mes y empresa.

### Query Parameters

| Parámetro | Default |
|-----------|---------|
| `portfolio_id` | `"CIII"` |

### Response (200)

```json
{ "status": "success", "..." }
```

La estructura interna es delegada completamente a `query_portfolio_analytics()` en `db_writer.py`.

---

## `GET /api/audit`

Ejecuta la auditoría SQL post-insert sobre `fact_kpi_values`. Devuelve únicamente las filas con algún tipo de problema (PASS se omite).

Solo consulta submissions con `is_latest_version = TRUE`.

### Query Parameters

| Parámetro | Obligatorio | Descripción |
|-----------|:-----------:|-------------|
| `portfolio_id` | No | `"VII"` o `"CIII"`. Sin valor: audita todos los fondos |

### Clasificación de `audit_status` (por prioridad)

| Condición | `audit_status` |
|-----------|---------------|
| Mismo `(submission_id, company_id, kpi_key, period_id)` aparece más de una vez | `ERROR: Duplicado` |
| `is_valid = FALSE` | `ERROR: Valor no numérico` |
| `confidence < 0.70` | `ERROR: Confianza crítica (<0.70)` |
| `confidence < 0.85` | `ADVERTENCIA: Confianza baja (<0.85)` |

### Response (200)

```json
{
  "status":       "success",
  "total_rows":   12,
  "errors":       3,
  "warnings":     9,
  "flagged_rows": [
    {
      "id":                 "...",
      "submission_id":      "...",
      "kpi_key":            "ebitda_margin",
      "period_id":          "FY2025",
      "company_id":         "simetrik",
      "portfolio_id":       "CIII",
      "unit":               "%",
      "numeric_value":      -0.12,
      "confidence":         0.65,
      "is_valid":           true,
      "is_manually_edited": false,
      "is_latest_version":  true,
      "dup_count":          1,
      "audit_status":       "ERROR: Confianza crítica (<0.70)"
    }
  ]
}
```

---

## `GET /api/audit/fidelity/{submission_id}`

Reporte de Fidelidad de Datos completo para una submission específica. Ejecuta tres auditorías encadenadas contra BigQuery.

### Path Parameter

| Parámetro | Tipo | Descripción |
|-----------|------|-------------|
| `submission_id` | `string` | UUID devuelto por `/upload` o `/api/results` |

### Pipeline interno

| Paso | Consulta / Acción |
|------|-------------------|
| 1 | `SELECT` de `submissions` WHERE `submission_id = @sid` |
| 2 | `SELECT` de `dim_company` WHERE `company_key = @company_key` |
| 3 | `SELECT` de `fact_kpi_values` WHERE `submission_id = @sid` |
| 4 | Re-verificación matemática de `gross_profit_margin` y `ebitda_margin` |
| 5 | Cruce con `SECTOR_REQUIREMENTS[bucket]` |
| 6 | Veredicto global |

**Normalización de `company_key`:**
```python
company_key = company_id.lower().split(".")[0].replace("-","").replace("_","")
```

### Umbrales del `calculator_audit`

| Delta (pp absolutos) | `calc_status` |
|----------------------|---------------|
| `<= 0.5` | `OK` |
| `> 0.5` y `<= 2.0` | `WARN` |
| `> 2.0` | `ERROR` — posible manipulación de reporte |

### Determinación de `origin` por KPI

```python
origin = "calculated" if "calculated" in source_description else "gemini"
```

### `overall_status` — lógica de veredicto

```
errores > 0   → "FAIL"
warnings > 0  → "WARN"
ambos == 0    → "PASS"
```

### Response (200) — estructura completa

```json
{
  "status": "success",
  "submission_id": "550e8400-...",
  "audited_at": "2026-03-16T18:00:00+00:00",
  "overall_status": "WARN",
  "identity_check": {
    "company_id":        "simetrik",
    "company_key":       "simetrik",
    "in_dim_company":    true,
    "bucket_expected":   "SAAS",
    "bucket_in_db":      "SAAS",
    "bucket_match":      true,
    "portfolio_id":      "CIII",
    "is_latest_version": true,
    "period_id":         "FY2025",
    "status":            "processed",
    "avg_confidence":    0.882,
    "findings": [
      "OK: Identidad verificada — empresa en portafolio oficial con bucket correcto."
    ]
  },
  "calculator_audit": {
    "kpi_rows": [
      {
        "kpi_key":            "gross_profit_margin",
        "origin":             "calculated",
        "raw_value":          "68.3200%",
        "numeric_value":      0.6832,
        "unit":               "%",
        "confidence":         1.0,
        "is_valid":           true,
        "recalculated_value": 0.6832,
        "delta_pct_points":   0.0,
        "calc_status":        "OK"
      },
      {
        "kpi_key":            "ebitda_margin",
        "origin":             "gemini",
        "raw_value":          "-12%",
        "numeric_value":      -0.12,
        "unit":               "%",
        "confidence":         0.91,
        "is_valid":           true,
        "recalculated_value": -0.1430,
        "delta_pct_points":   2.30,
        "calc_status":        "ERROR"
      }
    ],
    "discrepancies": 1,
    "findings": [
      "ERROR [ebitda_margin]: Discrepancia alta de 2.30pp — almacenado=-0.1200 vs recalculado=-0.1430 (ebitda / revenue). Posible error de reporte del founder."
    ]
  },
  "checklist_diagnosis": {
    "bucket":             "SAAS",
    "required_kpis":      ["revenue", "mrr", "churn_rate", "cac"],
    "present_valid_kpis": ["cac", "mrr", "revenue"],
    "missing_kpis":       ["churn_rate"],
    "is_complete":        false,
    "display_message":    "Reporte SaaS INCOMPLETO — faltan: churn_rate.",
    "findings": [
      "WARN: Reporte SaaS INCOMPLETO — faltan: churn_rate."
    ]
  },
  "summary": {
    "total_findings": 2,
    "errors":         1,
    "warnings":       1
  }
}
```

### Caso especial — `submission_id` no encontrado

Retorna HTTP **200** (no 404) con:

```json
{
  "status": "success",
  "submission_id": "...",
  "audited_at": "...",
  "overall_status": "FAIL",
  "error": "submission_id '...' not found in BigQuery."
}
```

> El cliente debe inspeccionar `overall_status` o el campo `error`, no el código HTTP.

---

---

## Flujo del Founder — Confirmación de reporte

Una vez que `/upload` responde con `checklist_status`, el frontend ejecuta este flujo:

```
POST /upload
  └── res.checklist_status
        ├── is_complete = true  → ConfirmSubmitButton activo (gradiente azul)
        └── is_complete = false → ConfirmSubmitButton deshabilitado (opacidad 40%)
                                  + Tooltip con missing_critical_kpis

ConfirmSubmitButton.onClick()
  └── SmartChecklistFounder.handleConfirm()
        ├── Sanitizar valores: strip "$", "%", "," → numeric string
        ├── [si hay manualValues] POST /api/manual-entry
        │     body = { company_id, portfolio_id, period_id, founder_email,
        │              submission_id, ...kpisSanitizados }
        └── router.push("/success")

/success (app/success/page.tsx)
  └── Vista de confirmación:
        - Check SVG verde animado
        - "Datos Cargados"
        - Botón "Volver al Dashboard" → router.push("/dashboard")
```

### Sanitización del frontend antes del envío

La función `sanitizeKpiValue(raw: string)` en `SmartChecklistFounder.tsx`:

| Input del usuario | Valor enviado al backend |
|-------------------|--------------------------|
| `"1,200.50"` | `"1200.50"` |
| `"$8.5M"` | `"85"` (strip $ — el backend luego interpreta) |
| `"36%"` | `"36"` |
| `""` | `null` (no se incluye en el body) |
| `"-"` | `null` |
| `"texto"` | `null` |

> Los valores `null` se omiten del body JSON enviado al backend, por lo que Pydantic nunca los ve como strings vacíos.

---

## `GET /health`

```json
{ "status": "healthy", "service": "cometa-pipeline-api" }
```

---

## `GET /upload-page`

Sirve `templates/upload.html`. Retorna `404` si el template no existe.

## `GET /dashboard`

Sirve `templates/dashboard.html`. Retorna `404` si el template no existe.
