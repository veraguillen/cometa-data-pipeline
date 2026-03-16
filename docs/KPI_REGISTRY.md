# Cometa Vault — Catálogo de KPIs

**Fuente:** `src/core/data_contract.py` → `KPI_REGISTRY` y `SECTOR_REQUIREMENTS`
          `src/core/db_writer.py`     → `DIM_METRIC` y `COMPANY_BUCKET`
          `frontend/src/components/SmartChecklistFounder.tsx` → `BASE_KPI_KEYS` y `SECTOR_KPI_MAP`
**Auditado:** 2026-03-16
**Última actualización:** 2026-03-16 — aliases GMV, agrupación sectorial frontend, audit de bucket_mismatch

Este documento es el registro oficial de todas las métricas financieras que el pipeline extrae, valida y persiste. Es la fuente de verdad para desarrolladores de frontend, analistas y cualquier consumidor de la API.

---

## KPI_REGISTRY — 16 KPIs completos

Definidos en `data_contract.py:40`. Cada entrada define la ruta exacta dentro del JSON que Gemini debe generar.

### Grupo 1: Core financiero (todos los sectores)

| `kpi_key` | `kpi_label` | Ruta en JSON de Gemini | `unit_type` |
|-----------|-------------|------------------------|:-----------:|
| `revenue_growth` | Revenue Growth | `financial_metrics_2025 → revenue_growth` | `pct` |
| `gross_profit_margin` | Gross Profit Margin | `financial_metrics_2025 → profit_margins → gross_profit_margin` | `pct` |
| `ebitda_margin` | EBITDA Margin | `financial_metrics_2025 → profit_margins → ebitda_margin` | `pct` |
| `cash_in_bank_end_of_year` | Cash in Bank | `financial_metrics_2025 → cash_flow_indicators → cash_in_bank_end_of_year` | `usd` |
| `annual_cash_flow` | Annual Cash Flow | `financial_metrics_2025 → cash_flow_indicators → annual_cash_flow` | `usd` |
| `working_capital_debt` | Working Capital Debt | `financial_metrics_2025 → debt_ratios → working_capital_debt` | `usd` |

### Grupo 2: Base metrics (inputs del motor de derivación)

| `kpi_key` | `kpi_label` | Ruta en JSON de Gemini | `unit_type` |
|-----------|-------------|------------------------|:-----------:|
| `revenue` | Total Revenue | `financial_metrics_2025 → base_metrics → revenue` | `usd` |
| `ebitda` | EBITDA | `financial_metrics_2025 → base_metrics → ebitda` | `usd` |
| `cogs` | Cost of Goods Sold | `financial_metrics_2025 → base_metrics → cogs` | `usd` |

### Grupo 3: Sector metrics (verticales específicas)

| `kpi_key` | `kpi_label` | Ruta en JSON de Gemini | `unit_type` | Vertical |
|-----------|-------------|------------------------|:-----------:|:--------:|
| `mrr` | Monthly Recurring Revenue | `financial_metrics_2025 → sector_metrics → mrr` | `usd` | SAAS |
| `churn_rate` | Churn Rate | `financial_metrics_2025 → sector_metrics → churn_rate` | `pct` | SAAS |
| `cac` | Customer Acquisition Cost | `financial_metrics_2025 → sector_metrics → cac` | `usd` | ALL |
| `portfolio_size` | Loan Portfolio Size | `financial_metrics_2025 → sector_metrics → portfolio_size` | `usd` | LEND |
| `npl_ratio` | Non-Performing Loan Ratio | `financial_metrics_2025 → sector_metrics → npl_ratio` | `pct` | LEND |
| `gmv` | Gross Merchandise Value | `financial_metrics_2025 → sector_metrics → gmv` | `usd` | ECOM |
| `loss_ratio` | Loss Ratio | `financial_metrics_2025 → sector_metrics → loss_ratio` | `pct` | INSUR |

### Aliases de extracción — GMV (`skydropx` y ECOM)

El KPI `gmv` tiene aliases adicionales para detectar terminología alternativa en documentos:

| Alias | Motivo |
|-------|--------|
| `"Gross Merchandise Value"` | Nombre canónico en inglés |
| `"Total Sales Volume"` | Terminología logística (Skydropx) |
| `"Total Transaction Value"` | Plataformas de pagos |
| `"GMV"` | Acrónimo directo |
| `"Valor Total de Transacciones"` | Español estándar |
| `"Volumen de Ventas"` | Español alternativo |

---

## DIM_METRIC — Registro de dimensión (`db_writer.py`)

Mirror en Python de la tabla `dim_metric` de BigQuery. Define el catálogo canónico con la unidad esperada y el alcance por bucket.

| `kpi_key` | `label` | `unit_expected` | `bucket_id` |
|-----------|---------|:---------------:|:-----------:|
| `revenue_growth` | Revenue Growth | `%` | ALL |
| `gross_profit_margin` | Gross Profit Margin | `%` | ALL |
| `ebitda_margin` | EBITDA Margin | `%` | ALL |
| `cash_in_bank_end_of_year` | Cash in Bank | `$` | ALL |
| `annual_cash_flow` | Annual Cash Flow | `$` | ALL |
| `working_capital_debt` | Working Capital Debt | `$` | ALL |
| `revenue` | Total Revenue | `$` | ALL |
| `ebitda` | EBITDA | `$` | ALL |
| `cogs` | Cost of Goods Sold | `$` | ALL |
| `mrr` | Monthly Recurring Revenue | `$` | SAAS |
| `churn_rate` | Churn Rate | `%` | SAAS |
| `cac` | Customer Acquisition Cost | `$` | ALL |
| `portfolio_size` | Loan Portfolio Size | `$` | LEND |
| `npl_ratio` | Non-Performing Loan Ratio | `%` | LEND |
| `gmv` | Gross Merchandise Value | `$` | ECOM |
| `loss_ratio` | Loss Ratio | `%` | INSUR |

`bucket_id = "ALL"` significa que la métrica aplica a cualquier empresa independientemente de su vertical.

---

## SECTOR_REQUIREMENTS — KPIs obligatorios por vertical

Un reporte se considera **completo** cuando todos los KPIs de la lista están presentes con `is_valid=True` y `numeric_value != None`.

```
SAAS  → revenue, mrr, churn_rate, cac         (4 KPIs)
LEND  → revenue, portfolio_size, npl_ratio     (3 KPIs)
ECOM  → revenue, gmv, cac                     (3 KPIs)
INSUR → revenue, loss_ratio, cac              (3 KPIs)
OTH   → revenue, ebitda                       (2 KPIs)
```

---

## Agrupación sectorial — Frontend (`SmartChecklistFounder.tsx`)

El frontend divide los KPIs en dos grupos visuales. Solo los KPIs del grupo activo se renderizan en el DOM — los KPIs de otras verticales **no existen en el árbol React**.

### `BASE_KPI_KEYS` — Métricas Financieras Generales (siempre visibles)

```
revenue, ebitda, cogs,
revenue_growth, gross_profit_margin, ebitda_margin,
cash_in_bank_end_of_year, annual_cash_flow, working_capital_debt
```

### `SECTOR_KPI_MAP` — Métricas de Operación (solo para la vertical activa)

| Bucket | KPIs visibles |
|--------|--------------|
| `SAAS` | `mrr`, `churn_rate`, `cac` |
| `ECOM` | `gmv`, `cac` |
| `LEND` | `portfolio_size`, `npl_ratio` |
| `INSUR` | `loss_ratio`, `cac` |
| `OTH` | *(ninguno — solo base)* |

### Regla de filtrado

```typescript
const bucketVisible = new Set([...BASE_KPI_KEYS, ...SECTOR_KPI_MAP[bucketId]]);
// Solo se renderizan KPIs en bucketVisible — los demás no entran al array ni al DOM
```

Esto previene errores de validación backend: si Gemini extrae un `npl_ratio` para una empresa SAAS (con baja confianza), ese KPI no aparece en el formulario del founder ni se incluye en el body de `/api/manual-entry`.

---

## COMPANY_BUCKET — Verticales del portafolio

### Fondo VII (10 empresas)

| Empresa | Vertical |
|---------|:--------:|
| conekta | SAAS |
| kueski | LEND |
| mpower | LEND |
| bnext | SAAS |
| yotepresto | LEND |
| ivoy | ECOM |
| bewe | SAAS |
| skydropx | ECOM |
| bitso | SAAS |
| cabify | ECOM |

### Fondo CIII (20 empresas)

| Empresa | Vertical |
|---------|:--------:|
| simetrik | SAAS |
| guros | INSUR |
| quinio | ECOM |
| hackmetrix | SAAS |
| hunty | SAAS |
| atani | OTH |
| cluvi | SAAS |
| kuona | SAAS |
| prometeo | OTH |
| territorium | SAAS |
| m1 | INSUR |
| morgana | INSUR |
| duppla | LEND |
| kala | OTH |
| pulsar | SAAS |
| solvento | LEND |
| numia | SAAS |
| r2 | LEND |
| dapta | SAAS |
| rintin | ECOM |

### Resumen por vertical

| Vertical | Cantidad | Empresas |
|----------|:--------:|---------|
| SAAS | 12 | conekta, bnext, bewe, bitso, simetrik, hackmetrix, hunty, cluvi, kuona, territorium, pulsar, numia, dapta |
| LEND | 6 | kueski, mpower, yotepresto, duppla, solvento, r2 |
| ECOM | 5 | ivoy, skydropx, cabify, quinio, rintin |
| INSUR | 3 | guros, m1, morgana |
| OTH | 3 | atani, prometeo, kala |

---

## Audit — `bucket_mismatch`

Cuando el auditor detecta que un KPI pertenece a una vertical diferente a la de la empresa:

| Condición | Comportamiento |
|-----------|---------------|
| `confidence > 0.95` | Se registra como `ERROR: bucket_mismatch` en el reporte de fidelidad |
| `confidence ≤ 0.95` | Solo `DEBUG` print en servidor — **no aparece en el reporte** |

**Rationale:** KPIs fuera de vertical con confianza baja son ruido de Gemini (alucinaciones), no errores reales del reporte. Solo elevamos la alarma cuando Gemini está muy seguro de que extrajo el dato, lo cual sí indica un problema de identidad de empresa.

---

## KPIs derivados automáticamente

El motor de derivación (`calculate_derived_kpis()`) puede generar estas métricas automáticamente si los inputs base están disponibles:

| KPI derivado | Fórmula | Inputs necesarios |
|--------------|---------|------------------|
| `gross_profit_margin` | `(revenue - cogs) / revenue` | `revenue > 0`, `cogs` |
| `ebitda_margin` | `ebitda / revenue` | `revenue > 0`, `ebitda` |

La derivación solo ocurre si el KPI **no fue extraído por Gemini directamente**. Los valores derivados se identifican por `source_description = "calculated"` y `confidence = 1.0`.

---

## Niveles de confianza de Gemini

| Rango | Interpretación | Semáforo frontend |
|-------|---------------|:-----------------:|
| `>= 0.90` | Dato explícito, sin ambigüedad, fuente directa | Verde |
| `0.70 – 0.89` | Requirió cálculo menor o inferencia razonable | Amarillo |
| `< 0.70` | Ambiguo, estimado, parcial o fuente indirecta | Rojo |
| `= 1.0` | Derivado por Python (certeza matemática) | Verde |

Threshold del sistema: `0.85`. Submissions con `avg_confidence < 0.85` se marcan como `pending_human_review`.

---

## Campos de un `kpi_row` completo

Estructura de cada elemento en el array `kpi_rows` del contrato:

```typescript
{
  submission_id:        string,    // UUID de la submission
  kpi_key:              string,    // ej. "revenue_growth"
  kpi_label:            string,    // ej. "Revenue Growth"
  raw_value:            string | null,  // ej. "36%", "$9.7M"
  numeric_value:        number | null,  // ej. 36.0, 9700000.0
  unit:                 string | null,  // ej. "%", "$M"
  period_id:            string,    // ej. "FY2025"
  source_description:   string | null,  // cita de fuente o "calculated"
  is_valid:             boolean,
  original_currency:    string,    // ISO 4217 — ej. "USD", "MXN"
  fx_rate:              number | null,  // unidades de moneda por 1 USD
  normalized_value_usd: number | null,  // numeric_value / fx_rate
  confidence:           number | null,  // 0.0 – 1.0
}
```
