# Cometa Vault — Arquitectura de Datos

**Última actualización:** 2026-03-22
**Proyecto GCP:** `cometa-mvp`
**Dataset BigQuery:** `cometa_vault`

---

## Visión general

```
PDF / Excel / CSV
        │
        ▼  POST /upload (multipart)
   FastAPI + Gemini 2.5 Flash
        │
        ▼  build_contract()
   submission + kpi_rows
        │
        ├──► submissions        (1 fila por documento)
        └──► fact_kpi_values    (N filas, una por KPI extraído)
                │
                ▼  PUT /api/kpi-update (analista)
           is_manually_edited = TRUE
                │
                ▼
           audit_log            (trazabilidad de cambios)
```

---

## Tablas BigQuery

### `submissions`

Registro de cada documento procesado. Una fila por archivo subido.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `submission_id` | STRING | UUID v4 — clave primaria y de trazabilidad |
| `file_hash` | STRING | SHA-256[:16] — clave de deduplicación (Rule 8) |
| `company_id` | STRING | ID canónico de la empresa (lowercase) |
| `portfolio_id` | STRING | Portafolio al que pertenece la empresa |
| `founder_email` | STRING | Email del founder que subió el documento |
| `original_filename` | STRING | Nombre del archivo original |
| `submitted_at` | TIMESTAMP | UTC — momento de recepción |
| `period_id` | STRING | Período inferido: `PYYYYQxMyy` (ej. `P2025Q1M01`) |
| `period_consistent` | BOOL | `TRUE` si todos los KPIs coinciden en período |
| `kpi_count_total` | INT64 | Total de KPIs generados (incluye derivados) |
| `kpi_count_valid` | INT64 | KPIs con `is_valid=TRUE` |
| `avg_confidence` | FLOAT64 | Promedio de confidence score de Gemini |
| `status` | STRING | `processed` · `pending_human_review` · `empty` |
| `detected_currency` | STRING | ISO 4217 detectado (ej. `USD`, `MXN`) |
| `is_latest_version` | BOOL | `TRUE` si es la versión más reciente del mismo hash |
| `gcs_result_path` | STRING | `vault/{company}/{hash}_result.json` |

### `fact_kpi_values`

Una fila por KPI por submisión. Tabla central del modelo analítico.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `submission_id` | STRING | FK → `submissions.submission_id` |
| `company_id` | STRING | FK → `dim_company.company_id` |
| `period_id` | STRING | FK → período canónico |
| `kpi_key` | STRING | Clave del KPI (ej. `revenue_growth`, `gross_profit_margin`) |
| `kpi_label` | STRING | Etiqueta legible (ej. `"Revenue Growth"`) |
| `raw_value` | STRING | Valor original tal como Gemini lo extrajo |
| `numeric_value` | FLOAT64 | Valor parseado a número |
| `unit` | STRING | Unidad canónica (`%`, `$`, `$M`, `$K`, `$B`) |
| `is_valid` | BOOL | `FALSE` si el valor no es parseable como número |
| `confidence` | FLOAT64 | Score 0.0–1.0 asignado por Gemini |
| `source_description` | STRING | Cita exacta del documento o `"calculated"` |
| `original_currency` | STRING | Moneda del documento (`USD`, `MXN`, etc.) |
| `fx_rate` | FLOAT64 | Tasa de conversión a USD (1.0 si ya es USD) |
| `normalized_value_usd` | FLOAT64 | Valor convertido a USD |
| `is_manually_edited` | BOOL | `FALSE`=Legacy (IA) · `TRUE`=Verified (analista) |
| `inserted_at` | TIMESTAMP | UTC — momento de escritura en BQ |

### `dim_company`

Catálogo de empresas del portafolio. Se sincroniza al arrancar el backend (`ensure_schema()`).

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `company_id` | STRING | PK — slug lowercase único (ej. `laniakea`) |
| `display_name` | STRING | Nombre comercial para UI |
| `portfolio_id` | STRING | Portafolio de pertenencia |
| `sector_bucket` | STRING | Vertical: `SAAS` · `LEND` · `ECOM` · `INSUR` · `OTH` |
| `is_active` | BOOL | `FALSE` para empresas dadas de baja del portafolio |

### `dim_kpi_metadata`

Diccionario de KPIs. Sirve como contexto dinámico para el RAG conversacional.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `kpi_key` | STRING | PK — clave canónica del KPI |
| `label` | STRING | Nombre legible |
| `description` | STRING | Definición del KPI para el LLM |
| `unit_type` | STRING | Tipo de unidad esperada |
| `sector_relevance` | STRING | Verticals donde este KPI es relevante |
| `is_derived` | BOOL | `TRUE` si es calculado matemáticamente (no extraído) |

### `audit_log`

Registro de cada corrección manual realizada por analistas.

| Campo | Tipo | Descripción |
|-------|------|-------------|
| `audit_id` | STRING | UUID v4 — clave primaria |
| `submission_id` | STRING | FK → submisión original del KPI |
| `company_id` | STRING | Empresa afectada |
| `kpi_key` | STRING | KPI modificado |
| `old_value` | FLOAT64 | Valor anterior a la corrección |
| `new_value` | FLOAT64 | Valor ingresado por el analista |
| `analyst_user_id` | STRING | ID Híbrido (`ANA-XXXXXX`) del analista |
| `changed_at` | TIMESTAMP | UTC — momento del cambio |
| `reason` | STRING | Justificación opcional del analista |

---

## Vista `v_data_coverage`

Vista materializada para el Portfolio Coverage Heatmap. Precalcula cobertura empresa × período.

```sql
CREATE OR REPLACE VIEW `cometa-mvp.cometa_vault.v_data_coverage` AS
SELECT
    LOWER(s.company_id)                                              AS company,
    s.period_id                                                      AS period,
    COUNT(DISTINCT f.kpi_key)                                        AS kpi_count,
    COUNTIF(COALESCE(f.is_manually_edited, FALSE) = TRUE
            AND f.is_valid = TRUE)                                   AS verified_count,
    COUNTIF(COALESCE(f.is_manually_edited, FALSE) = FALSE
            AND f.is_valid = TRUE)                                   AS legacy_count
FROM `cometa-mvp.cometa_vault.submissions` s
JOIN `cometa-mvp.cometa_vault.fact_kpi_values` f
    ON  f.submission_id = s.submission_id
    AND f.is_valid = TRUE
WHERE
    s.period_id IS NOT NULL
    AND s.period_id != ''
    AND COALESCE(s.is_latest_version, TRUE) = TRUE
GROUP BY 1, 2
ORDER BY 1, 2;
```

### Semántica de las columnas

| Columna | Significado |
|---------|-------------|
| `verified_count` | KPIs confirmados por un analista (`is_manually_edited=TRUE`) |
| `legacy_count` | KPIs extraídos por IA, sin revisión humana |
| `kpi_count` | Total de KPIs válidos en esa celda (`verified + legacy`) |

### Clasificación de celdas en el heatmap

| `verified_count` | `legacy_count` | Estado UI | Visual |
|:---:|:---:|---|---|
| > 0 | cualquiera | **Verified** | Color acento del tema (verde/azul) |
| 0 | > 0 | **Legacy** | Ámbar `#F59E0B` |
| — | — | **Missing** | Rojo pulsante con animación `cometa-pulse` |

Las celdas `Missing` no aparecen en la query (JOIN excluye empresas sin datos). El frontend detecta ausencia comparando todas las combinaciones empresa × período posibles contra el `Map` retornado por la API.

---

## Formato canónico de período — `period_id`

```
P{YYYY}Q{x}M{yy}
```

| Segmento | Significado | Ejemplo |
|----------|-------------|---------|
| `P` | Prefijo literal | — |
| `YYYY` | Año fiscal (4 dígitos) | `2025` |
| `Q{x}` | Trimestre (1–4) | `Q1` |
| `M{yy}` | Mes de cierre del trimestre | `M03` |

**Ejemplos:**

| Período natural | `period_id` |
|---|---|
| Q1 2025 (ene–mar) | `P2025Q1M03` |
| Q2 2025 (abr–jun) | `P2025Q2M06` |
| Q3 2025 (jul–sep) | `P2025Q3M09` |
| Q4 2025 (oct–dic) | `P2025Q4M12` |

Este formato ordena cronológicamente con un `ORDER BY period_id ASC` simple sin necesidad de parsing adicional.

El módulo `src/core/kpi_transformer.py` normaliza variantes de entrada (`FY2025`, `Q1 2025`, `2025-Q1`) al formato canónico.

---

## Pipeline de ingesta — flujo completo

```
1. Founder sube archivo
   POST /upload  →  multipart/form-data
   │  Campos: file, company_id, founder_email, portfolio_id

2. FastAPI valida la petición
   │  Pydantic UploadRequest — si falla → 422
   │  SHA-256 del archivo
   │  Consulta BQ: ¿file_hash ya existe?  →  si sí → 409 Conflict

3. Almacenamiento raw
   │  GCS: gs://ingesta-financiera-raw-cometa-mvp/vault/{company}/raw/{hash}.pdf

4. Extracción con Gemini 2.5 Flash
   │  Si PDF > 90 páginas → split_pdf_to_chunks() → N llamadas a Gemini
   │  merge_consolidated_results() con regla highest-confidence-wins
   │  Output: JSON con structure financiera normalizada

5. build_contract()
   │  Genera submission_id (UUID v4)
   │  Infiere period_id desde el contenido
   │  Parsea cada KPI: parse_numeric() → (numeric_value, unit, is_valid)
   │  Normaliza moneda: FX via IMF annual rates
   │  Calcula derivados: gross_profit_margin, ebitda_margin
   │  Valida integridad: avg_confidence, period_consistent

6. Escritura en BigQuery
   │  INSERT INTO submissions
   │  INSERT INTO fact_kpi_values  (N filas, is_manually_edited=FALSE)

7. Almacenamiento del resultado
   │  GCS: gs://cometa-vault-results/vault/{company}/{hash}_result.json

8. Respuesta al founder
   │  200 OK  →  { submission_id, status, kpi_count_valid, ... }
```

---

## Corrección analista — flujo de verificación

```
Analista edita KPI en BentoGrid
        │
        ▼  PUT /api/kpi-update
        │  Body: { submission_id, kpi_key, new_value, analyst_user_id }
        │
        ├──► UPDATE fact_kpi_values
        │    SET numeric_value = new_value,
        │        is_manually_edited = TRUE
        │    WHERE submission_id = ? AND kpi_key = ?
        │
        └──► INSERT INTO audit_log
             { audit_id, submission_id, company_id, kpi_key,
               old_value, new_value, analyst_user_id, changed_at }
```

Después de la corrección, el KPI pasa de estado `Legacy` a `Verified`. El heatmap de cobertura refleja el cambio en la próxima llamada a `GET /api/analyst/coverage`.

---

## Almacenamiento GCS

| Bucket | Contenido | Patrón de ruta |
|--------|-----------|----------------|
| `ingesta-financiera-raw-cometa-mvp` | Documentos originales | `vault/{company}/raw/{hash}.{ext}` |
| `cometa-vault-results` | Resultados JSON del pipeline | `vault/{company}/{hash}_result.json` |

Ambos buckets tienen retención indefinida. Los archivos nunca se eliminan — el pipeline es append-only por diseño.

---

## Claves de deduplicación

| Mecanismo | Campo | Alcance |
|-----------|-------|---------|
| Deduplicación de archivo | `file_hash` (SHA-256[:16]) | Evita reprocesar el mismo PDF |
| Trazabilidad de proceso | `submission_id` (UUID v4) | Une todos los artefactos de una submisión |
| Unicidad empresa-período | `(company_id, period_id)` | Cobertura por celda en el heatmap |

---

*Cometa Vault — Arquitectura de Datos · 2026*
