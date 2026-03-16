# Cometa Vault — Contrato de Datos

**Fuente:** `src/core/data_contract.py`
**Auditado:** 2026-03-16 — sin inferencias, solo código verificado
**Última actualización:** 2026-03-16 — PDF Chunking, `_ensure_fm_sections`, normalización de unidades

---

## Propósito

`data_contract.py` es el transformador central del pipeline. Convierte el JSON crudo de Gemini en el contrato canónico estructurado que se persiste en BigQuery:

```
Gemini JSON  →  build_contract()  →  { submission, kpi_rows, raw_gemini, integrity }
```

---

## Reglas de negocio implementadas

| Regla | Descripción | Ubicación |
|-------|-------------|-----------|
| Rule 4 | Todo valor de métrica se parsea y valida como numérico. Valores no numéricos se almacenan con `is_valid=False`. | `parse_numeric()` |
| Rule 8 | `file_hash` (SHA-256[:16]) se incrusta en `submission` como clave de deduplicación. | `build_contract()` |
| Bonus | `period_id` se infiere del contenido del documento y se verifica consistencia entre todos los KPI rows. | `infer_period_id()` |

---

## Esquema del JSON de Gemini (prompt FASE 2)

El prompt impone esta estructura exacta. Cualquier desviación es detectada por `build_contract()`.

```json
{
  "_document_context": {
    "currency":    "USD",
    "period":      "FY2025",
    "scale":       "millions",
    "scale_notes": "Footer note: 'amounts in USD millions'"
  },
  "financial_metrics_2025": {
    "revenue_growth": {
      "value": "36%",
      "confidence": 0.95,
      "description": "Income Statement YoY comparison, p.4"
    },
    "profit_margins": {
      "gross_profit_margin": { "value": "68%", "confidence": 0.92, "description": "..." },
      "ebitda_margin":       { "value": "-12%", "confidence": 0.88, "description": "..." }
    },
    "cash_flow_indicators": {
      "cash_in_bank_end_of_year": { "value": "$9.7M", "confidence": 0.97, "description": "..." },
      "annual_cash_flow":         { "value": "-$3.2M", "confidence": 0.91, "description": "..." }
    },
    "debt_ratios": {
      "working_capital_debt": { "value": "$1.1M", "confidence": 0.85, "description": "..." }
    },
    "base_metrics": {
      "revenue": { "value": "$4.2M",  "confidence": 0.97, "description": "..." },
      "ebitda":  { "value": "-$0.8M", "confidence": 0.88, "description": "..." },
      "cogs":    { "value": "$1.3M",  "confidence": 0.90, "description": "..." }
    },
    "sector_metrics": {
      "mrr":          { "value": "$350K", "confidence": 0.94, "description": "..." },
      "churn_rate":   { "value": "2.1%",  "confidence": 0.82, "description": "..." },
      "cac":          { "value": "$120",  "confidence": 0.78, "description": "..." },
      "portfolio_size": { "value": "$25M", "confidence": 0.95, "description": "..." },
      "npl_ratio":    { "value": "3.4%",  "confidence": 0.91, "description": "..." },
      "gmv":          { "value": "$8.5M", "confidence": 0.93, "description": "..." },
      "loss_ratio":   { "value": "62%",   "confidence": 0.89, "description": "..." }
    }
  }
}
```

**Regla de Gemini:** Si una métrica no aparece en el documento, debe escribir `null` — no `"N/A"`, no `"---"`. El parser detecta `null` y no genera un `kpi_row` inválido.

---

## `parse_numeric()` — Rule 4

Convierte strings financieros en valores flotantes.

### Tabla de conversión exacta

| Input | `numeric_value` | `unit` |
|-------|:---------------:|:------:|
| `"36%"` | `36.0` | `%` |
| `"-0.74%"` | `-0.74` | `%` |
| `"$9.7M"` | `9_700_000.0` | `$M` |
| `"-$3.2M"` | `-3_200_000.0` | `$M` |
| `"$1.1K"` | `1_100.0` | `$K` |
| `"$4.2B"` | `4_200_000_000.0` | `$B` |
| `"null"` | `None` | `None` |
| `"N/A"` | `None` | `None` |
| `"---"` | `None` | `None` |
| `""` | `None` | `None` |
| `"texto_no_numerico"` | `None` | `None` |

Cuando `numeric_value` es `None` → `is_valid = False`.

---

## `detect_currency()` — Detección de moneda

Lee `gemini_json["_document_context"]["currency"]`.

- Si el campo existe y es un código ISO 4217 de 3 letras mayúsculas (`[A-Z]{3}`): lo acepta.
- En cualquier otro caso (ausente, malformado, tipo incorrecto): retorna `"USD"` como default conservador.

---

## `infer_period_id()` — Inferencia de período

Escanea todo el JSON de Gemini (serializado como string) buscando patrones `20XX`.

```python
year_pat = re.compile(r'\b(20\d{2})\b')
# Retorna el año más frecuente → "FY{año}"
# Si no encuentra ningún año → "FY{año_actual}"
```

---

## `build_contract()` — Función principal

### Firma

```python
def build_contract(
    gemini_json:       dict,
    file_hash:         str,
    company_id:        str,
    founder_email:     str,
    original_filename: str,
    portfolio_id:      str = "",
) -> dict
```

### Flujo interno

```
1. submission_id = uuid.uuid4()
2. period_id     = infer_period_id(gemini_json)
3. currency      = detect_currency(gemini_json)
4. fx            = get_fx_provider()

5. Para cada KPI en KPI_REGISTRY (16 total):
   a. _dig(gemini_json, kpi_def["path"])  →  node
   b. raw_value   = node["value"]
   c. description = node["description"]
   d. parse_numeric(raw_value)  →  (numeric_value, unit)
   e. is_valid = numeric_value is not None
   f. confidence = float(node["confidence"]) o None
   g. FX normalization:
      - USD:     fx_rate=1.0,  normalized_value_usd=numeric_value
      - no-USD:  fx_rate=fx.get_rate(currency, year),
                 normalized_value_usd=numeric_value/fx_rate  (o None si tasa ausente)
   h. Append a kpi_rows

6. calculate_derived_kpis(kpi_rows)  →  derived_rows
   kpi_rows.extend(derived_rows)

7. Integrity checks:
   - valid_count, valid_ratio
   - period_consistent (¿todos los rows tienen el mismo period_id?)
   - avg_confidence de KPIs con confidence != None
   - Si avg_confidence < 0.85 → status = "pending_human_review"
   - Si valid_count > 0        → status = "processed"
   - Si valid_count == 0       → status = "empty"

8. Build submission dict
9. Return { submission, kpi_rows, raw_gemini, integrity }
```

### Estructura completa del retorno

```python
{
  "submission": {
    "submission_id":     str,   # UUID v4
    "file_hash":         str,   # SHA-256[:16] — clave de dedup (Rule 8)
    "company_id":        str,
    "founder_email":     str,
    "original_filename": str,
    "submitted_at":      str,   # ISO-8601 UTC
    "period_id":         str,   # "FY2025"
    "period_consistent": bool,
    "kpi_count_total":   int,   # incluye filas derivadas
    "kpi_count_valid":   int,
    "avg_confidence":    float | None,
    "status":            str,   # "processed" | "pending_human_review" | "empty"
    "detected_currency": str,   # ISO 4217
    "portfolio_id":      str,
  },
  "kpi_rows": [
    {
      "submission_id":       str,
      "kpi_key":             str,
      "kpi_label":           str,
      "raw_value":           str | None,
      "numeric_value":       float | None,
      "unit":                str | None,
      "period_id":           str,
      "source_description":  str | None,  # cita exacta de fuente o "calculated"
      "is_valid":            bool,
      "original_currency":   str,
      "fx_rate":             float | None,
      "normalized_value_usd": float | None,
      "confidence":          float | None,
    }
  ],
  "raw_gemini": { ... },  # JSON original de Gemini sin modificar
  "integrity": {
    "period_consistent": bool,
    "valid_ratio":       float,  # valid_count / total_count, redondeado a 2 decimales
    "warnings":          [str],
  }
}
```

---

## Motor de Derivación — `calculate_derived_kpis()`

Calcula KPIs que pueden obtenerse matemáticamente de los base metrics. Se ejecuta **después** de construir todos los KPI rows de Gemini.

### Regla 1 — `gross_profit_margin`

**Pre-condiciones** (todas deben cumplirse):
1. `revenue` está en `kpi_rows` con `is_valid=True` y `numeric_value != None`
2. `revenue != 0`
3. `cogs` está en `kpi_rows` con `is_valid=True` y `numeric_value != None`
4. `gross_profit_margin` NO existe aún en `kpi_rows`

**Fórmula:**
```
gross_profit_margin = (revenue - cogs) / revenue
```

**Ejemplo:** `revenue=4_200_000`, `cogs=1_300_000` → `(4.2M - 1.3M) / 4.2M = 0.6905`

### Regla 2 — `ebitda_margin`

**Pre-condiciones** (todas deben cumplirse):
1. `revenue` válido y `!= 0`
2. `ebitda` está en `kpi_rows` con `is_valid=True` y `numeric_value != None`
3. `ebitda_margin` NO existe aún en `kpi_rows`

**Fórmula:**
```
ebitda_margin = ebitda / revenue
```

**Ejemplo:** `ebitda=-800_000`, `revenue=4_200_000` → `-800K / 4.2M = -0.1905`

### Campos de toda fila derivada

```python
{
  "source_description": "calculated",   # origen siempre "calculated"
  "confidence":         1.0,            # certeza absoluta (es matemática pura)
  "is_valid":           True,
  "fx_rate":            1.0,            # si currency == "USD"
  "normalized_value_usd": <valor>,      # igual a numeric_value si USD
}
```

### Principio no-destructivo

Si Gemini ya extrajo `gross_profit_margin` directamente del PDF, la Regla 1 **no se ejecuta**. El motor solo actúa cuando el campo no existe previamente.

---

## Checklist Sectorial — `build_checklist_status()`

### Firma

```python
def build_checklist_status(kpi_rows: list[dict], bucket_id: str) -> dict
```

### Definición de "presente"

Un KPI cuenta como presente solo si `is_valid=True` **y** `numeric_value is not None`.

### `SECTOR_REQUIREMENTS` — requerimientos exactos por vertical

```python
{
  "SAAS":  ["revenue", "mrr", "churn_rate", "cac"],
  "LEND":  ["revenue", "portfolio_size", "npl_ratio"],
  "ECOM":  ["revenue", "gmv", "cac"],
  "INSUR": ["revenue", "loss_ratio", "cac"],
  "OTH":   ["revenue", "ebitda"],
}
```

### Retorno exacto

```python
{
  "bucket":                str,    # el bucket_id recibido
  "is_complete":           bool,
  "present_kpis":          [str],  # sorted(), todos los KPIs válidos presentes
  "missing_critical_kpis": [str],  # KPIs requeridos que faltan
  "display_message":       str,    # mensaje listo para mostrar al founder
}
```

### `display_message` — lógica exacta

| Condición | Mensaje |
|-----------|---------|
| `bucket_id` no está en `SECTOR_REQUIREMENTS` | `"Sector '{bucket_id}' sin checklist definido — revisa SECTOR_REQUIREMENTS."` |
| `is_complete = True` | `"Reporte {bucket_id} completo. Todos los KPIs criticos presentes."` |
| `is_complete = False` | `"Atencion: Reporte {label} incompleto. Faltan: {missing_str}."` |

Labels de sector: `SAAS→"SaaS"`, `LEND→"Lending"`, `ECOM→"E-Commerce"`, `INSUR→"Insurance"`, `OTH→"General"`.

---

---

## PDF Chunking — `split_pdf_to_chunks()` y `merge_consolidated_results()`

Implementado en `src/api.py`. Resuelve el límite de páginas de Gemini para PDFs largos.

### Constante

```python
_PDF_CHUNK_SIZE = 90  # páginas máximas por llamada a Gemini
```

### `split_pdf_to_chunks(file_bytes, size=90) → list[bytes]`

Función pura (no escribe a disco):

```
1. fitz.open(stream=file_bytes, filetype="pdf")  →  src_doc
2. total_pages = len(src_doc)
3. Si total_pages ≤ size → retorna [file_bytes] (sin fragmentar)
4. n_chunks = ceil(total_pages / size)
5. Por cada bloque i:
     chunk_doc.insert_pdf(src_doc, from_page=i*size, to_page=min((i+1)*size-1, total-1))
     chunks.append(chunk_doc.tobytes())
6. Retorna list[bytes]  — nunca toca disco
```

### `merge_consolidated_results(jsons: list[dict]) → dict`

Fusiona N resultados de Gemini con la regla **highest-confidence-wins**:

```
1. merged = deepcopy(jsons[0])
2. Para cada chunk_json en jsons[1:]:
     Para cada kpi_def en KPI_REGISTRY:
       existing = _get(merged, path)
       incoming = _get(chunk_json, path)
       Si incoming.value != None:
         Si existing.value == None → _set(merged, path, incoming)
         Si incoming.confidence > existing.confidence → _set(merged, path, incoming)
3. _ensure_fm_sections(merged)
4. Retorna merged
```

El alias `merge_kpi_results = merge_consolidated_results` existe por compatibilidad.

### Orquestador — `_chunk_and_process_pdf(temp_path, gemini, prompt_config)`

```
1. Leer bytes del archivo temp
2. split_pdf_to_chunks() → chunks
3. Si len(chunks) == 1 → gemini.extraer_y_auditar() directo (sin overhead)
4. Para cada chunk:
     a. Escribir bytes a {temp_path}_chunk{i}.pdf
     b. gemini.extraer_y_auditar() → raw JSON string
     c. json.loads(raw) → dict
     d. Append a chunk_results
     e. finally: os.remove(chunk_path)
5. merge_consolidated_results(chunk_results) → merged
6. Retorna json.dumps(merged)
```

Si **todos** los chunks fallan → `RuntimeError("[Chunking] Ningún bloque fue procesado")`.

---

## `_ensure_fm_sections()` — Garantía de estructura

Antes de pasar el JSON a `build_contract()`, se garantiza que `financial_metrics_2025` contenga estas 6 secciones (con `{}` como default si faltan):

```python
_REQUIRED_FM_SECTIONS = (
    "revenue_growth", "profit_margins", "cash_flow_indicators",
    "debt_ratios", "base_metrics", "sector_metrics",
)
```

Esto previene `KeyError` en `build_contract()` cuando Gemini omite una sección completa (ej. `sector_metrics` en un documento sin KPIs sectoriales).

---

## Normalización de unidades — `_normalize_unit_synonym()`

Implementado en `data_contract.py`. Mapea variantes textuales al símbolo canónico antes de persistir el `unit` en BigQuery.

### `_UNIT_SYNONYMS`

| Input (case-insensitive) | Canónico |
|--------------------------|:--------:|
| `"usd"`, `"dollars"`, `"usd_amount"`, `"us dollars"` | `"$"` |
| `"mxn"`, `"eur"`, `"brl"`, `"cop"` | `"$"` |
| `"pct"`, `"percentage"`, `"ratio"`, `"decimal"`, `"rate"` | `"%"` |

Escalas combinadas: si el input termina en `M`, `K` o `B` y el prefijo está en el mapa, se genera `"$M"`, `"$K"`, `"$B"`, etc.

**Ejemplos:**

| Input de Gemini | `unit` almacenado |
|-----------------|:-----------------:|
| `"usd"` | `"$"` |
| `"pct"` | `"%"` |
| `"usdm"` | `"$M"` |
| `"percentage"` | `"%"` |
| `"MXN"` | `"$"` |

Se aplica en `build_contract()` antes de construir cada `kpi_row`:

```python
raw_unit       = unit or kpi_def["unit_type"]
normalized_unit = _normalize_unit_synonym(raw_unit)
kpi_rows.append({ ..., "unit": normalized_unit, ... })
```

---

## Contexto de industria en el prompt de Gemini

Al construir `prompt_config` en `api.py`, se inyecta el `bucket_id` de la empresa y una instrucción sectorial específica:

```python
_bucket_id         = COMPANY_BUCKET.get(company_domain, "UNKNOWN")
_sector_instruction = _sector_hints[_bucket_id]   # SAAS / LEND / ECOM / INSUR / OTH

_prompt_prefix = f"""
Eres un auditor financiero senior...
Estás analizando una empresa de la vertical {_bucket_id}.
{_sector_instruction}
"""
_prompt_body   = """..."""   # JSON schema — string regular, no f-string (evita SyntaxError Python 3.10)
prompt_config  = _prompt_prefix + _prompt_body
```

Esto previene que Gemini extraiga KPIs de otras verticales con alta confianza.

---

## Normalización de moneda (FX)

Implementado en `src/core/fx_service.py`.

Para documentos en moneda no-USD:

```python
normalized_value_usd = numeric_value / fx_rate
```

donde `fx_rate` = unidades de moneda local por 1 USD (tasa promedio anual del FMI).

Si no existe tasa para la combinación `(currency, year)`:
- `fx_rate = None`
- `normalized_value_usd = None`
- Se agrega un `warning` al `integrity.warnings` del contrato

Para documentos USD: `fx_rate = 1.0`, `normalized_value_usd = numeric_value` (sin conversión).

---

## Umbral de confianza

```python
CONFIDENCE_THRESHOLD = 0.85
```

- `avg_confidence >= 0.85` → `status = "processed"`
- `avg_confidence < 0.85`  → `status = "pending_human_review"` + warning en `integrity.warnings`
- Sin valores de confidence → `avg_confidence = None`, sin cambio de status por este motivo
