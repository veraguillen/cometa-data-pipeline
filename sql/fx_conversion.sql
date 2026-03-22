-- =============================================================================
-- fx_conversion.sql
-- Cometa Pipeline — Currency Conversion Layer (BigQuery)
-- =============================================================================
--
-- Convención de tasas (hereda de fx_service.py / StaticFxProvider):
--   rate = unidades_de_divisa_extranjera por 1 USD
--   Ejemplos:
--     MXN 2025 = 17.80  →  1 USD = 17.80 MXN
--     EUR 2025 =  0.91  →  1 USD =  0.91 EUR
--     USD XXXX =  1.00  →  identity
--
--   Conversión:  amount_usd = amount_local / rate
--
-- Secciones:
--   §1  dim_fx_rates          — tabla de tasas mensuales
--   §2  SEED                  — carga inicial desde RATE_TABLE (Python → BQ)
--   §3  v_kpi_usd             — vista principal con fallback y filtro de %
--   §4  v_kpi_usd_audit       — vista de auditoría (cobertura FX)
--   §5  QA queries            — verificación de integridad
-- =============================================================================


-- =============================================================================
-- §1  TABLA dim_fx_rates
-- =============================================================================
-- Granularidad: un registro por (currency_code, year, month).
-- Particionada por year para limitar el scan en consultas de rango temporal.
-- Clustered por currency_code para joins selectivos.
--
-- Cuando un mes específico no tiene tasa real (ej. datos proyectados o
-- meses futuros aún sin cierre), la vista §3 aplica LAST_VALUE IGNORE NULLS
-- sobre la partición de (currency_code) ordenada cronológicamente.

CREATE TABLE IF NOT EXISTS `cometa_vault.dim_fx_rates`
(
  -- Identificación
  currency_code  STRING  NOT NULL,  -- ISO 4217: "MXN", "BRL", "USD", ...
  year           INT64   NOT NULL,  -- Año gregoriano: 2019, 2020, ..., 2026
  month          INT64   NOT NULL,  -- Mes 1–12

  -- Tasa
  rate           FLOAT64 NOT NULL,  -- Unidades de divisa por 1 USD (>0 siempre)
  rate_type      STRING  NOT NULL,  -- "annual_avg" | "monthly_avg" | "spot" | "projected"
  source         STRING,            -- "IMF_WEO" | "FED_H10" | "manual" | "carried_forward"

  -- Auditoría
  loaded_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  is_estimated   BOOL      NOT NULL DEFAULT FALSE  -- TRUE si es carry-forward o proyección
)
PARTITION BY RANGE_BUCKET(year, GENERATE_ARRAY(2019, 2031, 1))
CLUSTER BY currency_code
OPTIONS (
  description = "Monthly FX rates: units of foreign currency per 1 USD. Mirrors StaticFxProvider.RATE_TABLE in fx_service.py."
);

-- Constraint lógico (BigQuery no tiene PK nativos, se controla con MERGE):
-- UNIQUE (currency_code, year, month)


-- =============================================================================
-- §2  SEED — carga inicial desde RATE_TABLE de fx_service.py
-- =============================================================================
-- Estrategia: las tasas anuales promedio se replican a los 12 meses del año.
-- Esto elimina gaps dentro de los años cargados.
-- Para años sin datos → §3 aplica carry-forward automático.

MERGE `cometa_vault.dim_fx_rates` AS target
USING (
  -- Fan-out: 1 tasa anual → 12 filas mensuales
  -- Fuente: RATE_TABLE de fx_service.py (trascrito aquí como VALUES)
  WITH raw_annual AS (
    SELECT currency_code, year, rate, 'annual_avg' AS rate_type, 'StaticFxProvider' AS source
    FROM UNNEST([
      -- ── MXN ────────────────────────────────────────────────────────────
      STRUCT('MXN' AS currency_code, 2019 AS year, 19.26 AS rate),
      STRUCT('MXN', 2020, 21.49), STRUCT('MXN', 2021, 20.27),
      STRUCT('MXN', 2022, 20.12), STRUCT('MXN', 2023, 17.18),
      STRUCT('MXN', 2024, 17.15), STRUCT('MXN', 2025, 17.80),
      -- ── BRL ────────────────────────────────────────────────────────────
      STRUCT('BRL', 2019,  3.94), STRUCT('BRL', 2020,  5.39),
      STRUCT('BRL', 2021,  5.40), STRUCT('BRL', 2022,  5.17),
      STRUCT('BRL', 2023,  4.99), STRUCT('BRL', 2024,  5.10),
      STRUCT('BRL', 2025,  5.25),
      -- ── COP ────────────────────────────────────────────────────────────
      STRUCT('COP', 2019, 3281.0), STRUCT('COP', 2020, 3694.0),
      STRUCT('COP', 2021, 3743.0), STRUCT('COP', 2022, 4255.0),
      STRUCT('COP', 2023, 4325.0), STRUCT('COP', 2024, 4150.0),
      STRUCT('COP', 2025, 4350.0),
      -- ── ARS ────────────────────────────────────────────────────────────
      STRUCT('ARS', 2019,   48.2), STRUCT('ARS', 2020,   70.5),
      STRUCT('ARS', 2021,   95.1), STRUCT('ARS', 2022,  130.8),
      STRUCT('ARS', 2023,  350.0), STRUCT('ARS', 2024,  900.0),
      STRUCT('ARS', 2025, 1100.0),
      -- ── CLP ────────────────────────────────────────────────────────────
      STRUCT('CLP', 2019,  703.0), STRUCT('CLP', 2020,  792.0),
      STRUCT('CLP', 2021,  759.0), STRUCT('CLP', 2022,  874.0),
      STRUCT('CLP', 2023,  840.0), STRUCT('CLP', 2024,  920.0),
      STRUCT('CLP', 2025,  960.0),
      -- ── PEN ────────────────────────────────────────────────────────────
      STRUCT('PEN', 2019, 3.34), STRUCT('PEN', 2020, 3.49),
      STRUCT('PEN', 2021, 3.88), STRUCT('PEN', 2022, 3.84),
      STRUCT('PEN', 2023, 3.74), STRUCT('PEN', 2024, 3.80),
      STRUCT('PEN', 2025, 3.85),
      -- ── EUR ────────────────────────────────────────────────────────────
      STRUCT('EUR', 2019, 0.893), STRUCT('EUR', 2020, 0.877),
      STRUCT('EUR', 2021, 0.846), STRUCT('EUR', 2022, 0.951),
      STRUCT('EUR', 2023, 0.924), STRUCT('EUR', 2024, 0.925),
      STRUCT('EUR', 2025, 0.910),
      -- ── GBP ────────────────────────────────────────────────────────────
      STRUCT('GBP', 2019, 0.784), STRUCT('GBP', 2020, 0.780),
      STRUCT('GBP', 2021, 0.727), STRUCT('GBP', 2022, 0.812),
      STRUCT('GBP', 2023, 0.804), STRUCT('GBP', 2024, 0.790),
      STRUCT('GBP', 2025, 0.785),
      -- ── CAD ────────────────────────────────────────────────────────────
      STRUCT('CAD', 2019, 1.327), STRUCT('CAD', 2020, 1.341),
      STRUCT('CAD', 2021, 1.254), STRUCT('CAD', 2022, 1.301),
      STRUCT('CAD', 2023, 1.350), STRUCT('CAD', 2024, 1.360),
      STRUCT('CAD', 2025, 1.380),
      -- ── JPY ────────────────────────────────────────────────────────────
      STRUCT('JPY', 2019, 109.0), STRUCT('JPY', 2020, 106.8),
      STRUCT('JPY', 2021, 109.8), STRUCT('JPY', 2022, 131.5),
      STRUCT('JPY', 2023, 140.5), STRUCT('JPY', 2024, 149.7),
      STRUCT('JPY', 2025, 152.0),
      -- ── USD (identidad) ────────────────────────────────────────────────
      STRUCT('USD', 2019, 1.0), STRUCT('USD', 2020, 1.0),
      STRUCT('USD', 2021, 1.0), STRUCT('USD', 2022, 1.0),
      STRUCT('USD', 2023, 1.0), STRUCT('USD', 2024, 1.0),
      STRUCT('USD', 2025, 1.0)
    ])
  ),
  months AS (
    SELECT month FROM UNNEST(GENERATE_ARRAY(1, 12)) AS month
  )
  SELECT
    r.currency_code,
    r.year,
    m.month,
    r.rate,
    r.rate_type,
    r.source,
    CURRENT_TIMESTAMP()  AS loaded_at,
    FALSE                AS is_estimated
  FROM raw_annual r
  CROSS JOIN months m

) AS source
ON  target.currency_code = source.currency_code
AND target.year          = source.year
AND target.month         = source.month

WHEN NOT MATCHED THEN INSERT (
  currency_code, year, month, rate, rate_type, source, loaded_at, is_estimated
) VALUES (
  source.currency_code, source.year, source.month, source.rate,
  source.rate_type, source.source, source.loaded_at, source.is_estimated
)

WHEN MATCHED AND target.is_estimated = TRUE THEN UPDATE SET
  -- Sobrescribir solo si el registro existente era estimado (carry-forward)
  rate        = source.rate,
  rate_type   = source.rate_type,
  source      = source.source,
  loaded_at   = source.loaded_at,
  is_estimated = FALSE;


-- =============================================================================
-- §3  VISTA PRINCIPAL  v_kpi_usd
-- =============================================================================
-- Produce una fila por KPI con:
--   amount_usd     — monto convertido a USD (NULL si moneda desconocida)
--   fx_rate_used   — tasa aplicada (para trazabilidad)
--   fx_source      — "exact" | "carry_forward" | "identity" | "not_monetary"
--
-- Reglas de negocio:
--   R1. KPIs con unit_expected="%" NUNCA se convierten (fx_source = "not_monetary").
--   R2. Si currency = "USD" → multiplicador = 1.0 (fx_source = "identity").
--   R3. Si existe tasa exacta (year+month+currency) → la usa (fx_source = "exact").
--   R4. Si no existe tasa para ese mes → carry-forward al último mes disponible
--       dentro de la misma moneda (fx_source = "carry_forward").
--   R5. Si no existe ninguna tasa para esa moneda → amount_usd = NULL,
--       fx_source = "unknown_currency".

CREATE OR REPLACE VIEW `cometa_vault.v_kpi_usd` AS

WITH
-- ── Extraer year y month desde period_id (formato P2025Q1M03) ──────────────
kpi_with_period AS (
  SELECT
    f.kpi_value_id,
    f.submission_id,
    f.kpi_key,
    f.kpi_label,
    f.raw_value,
    f.numeric_value,
    f.unit,
    f.unit_type,                    -- "usd" | "pct"
    f.is_valid,
    s.company_id,
    s.portfolio_id,
    s.period_id,                    -- "P2025Q1M03"
    s.currency,                     -- "MXN" | "BRL" | "USD" | ...
    s.submitted_at,

    -- Extraer año y mes del period_id canónico
    CAST(REGEXP_EXTRACT(s.period_id, r'^P(\d{4})') AS INT64)   AS period_year,
    CAST(REGEXP_EXTRACT(s.period_id, r'M(\d{2})$') AS INT64)   AS period_month

  FROM `cometa_vault.fact_kpi_values`  f
  JOIN `cometa_vault.submissions`       s USING (submission_id)
  WHERE f.is_valid = TRUE
),

-- ── Construir el índice FX con carry-forward usando ventana ───────────────
-- LAST_VALUE IGNORE NULLS no es nativo en BQ; simulamos con MAX_BY o
-- filtrando sobre una subconsulta ordenada. Usamos el approach de
-- "llenar gaps hacia adelante" con LAST_VALUE sobre ventana explícita.
fx_filled AS (
  SELECT
    currency_code,
    year,
    month,
    rate,
    rate_type,
    is_estimated,
    -- Ordinal cronológico para el fallback de carry-forward
    LAST_VALUE(rate) OVER (
      PARTITION BY currency_code
      ORDER BY year * 100 + month  -- ordinal: 202503 → Mar 2025
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS rate_carried_forward
  FROM `cometa_vault.dim_fx_rates`
),

-- ── Join KPIs con tasas FX ─────────────────────────────────────────────────
kpi_joined AS (
  SELECT
    k.*,
    fx_exact.rate                     AS rate_exact,
    fx_exact.rate_type                AS rate_type_exact,

    -- Carry-forward: tasa del mes más reciente disponible para esa moneda
    fx_cf.rate_carried_forward        AS rate_fallback

  FROM kpi_with_period k

  -- R3: intento de join exacto (currency + year + month)
  LEFT JOIN fx_filled fx_exact
    ON  fx_exact.currency_code = UPPER(COALESCE(k.currency, 'USD'))
    AND fx_exact.year          = k.period_year
    AND fx_exact.month         = k.period_month
    AND fx_exact.is_estimated  = FALSE

  -- R4: join de carry-forward (último mes ≤ período del KPI para esa moneda)
  LEFT JOIN (
    SELECT
      currency_code,
      year,
      month,
      rate_carried_forward,
      -- Seleccionamos el row más reciente anterior o igual al período del KPI
      ROW_NUMBER() OVER (
        PARTITION BY currency_code
        ORDER BY year * 100 + month DESC
      ) AS rn
    FROM fx_filled
  ) fx_cf
    ON  fx_cf.currency_code = UPPER(COALESCE(k.currency, 'USD'))
    AND fx_cf.year * 100 + fx_cf.month <= k.period_year * 100 + k.period_month
    AND fx_cf.rn = 1
)

-- ── Cálculo final con todas las reglas ────────────────────────────────────
SELECT
  kpi_value_id,
  submission_id,
  company_id,
  portfolio_id,
  period_id,
  period_year,
  period_month,
  currency,
  kpi_key,
  kpi_label,
  raw_value,
  numeric_value,
  unit,
  unit_type,
  is_valid,
  submitted_at,

  -- Tasa efectiva aplicada (para trazabilidad)
  CASE
    WHEN unit_type = 'pct'                    THEN NULL       -- R1: % nunca convierte
    WHEN UPPER(COALESCE(currency,'USD'))='USD' THEN 1.0       -- R2: identidad
    WHEN rate_exact IS NOT NULL               THEN rate_exact -- R3: tasa exacta
    WHEN rate_fallback IS NOT NULL            THEN rate_fallback  -- R4: carry-forward
    ELSE NULL                                                 -- R5: moneda desconocida
  END AS fx_rate_used,

  -- Monto en USD
  CASE
    WHEN unit_type = 'pct'
      THEN numeric_value                                       -- R1: sin conversión

    WHEN UPPER(COALESCE(currency, 'USD')) = 'USD'
      THEN numeric_value                                       -- R2: identidad

    WHEN rate_exact IS NOT NULL AND rate_exact > 0
      THEN ROUND(numeric_value / rate_exact, 2)               -- R3: exacta

    WHEN rate_fallback IS NOT NULL AND rate_fallback > 0
      THEN ROUND(numeric_value / rate_fallback, 2)            -- R4: carry-forward

    ELSE NULL                                                  -- R5: sin tasa
  END AS amount_usd,

  -- Origen de la tasa (trazabilidad / auditoría)
  CASE
    WHEN unit_type = 'pct'
      THEN 'not_monetary'
    WHEN UPPER(COALESCE(currency, 'USD')) = 'USD'
      THEN 'identity'
    WHEN rate_exact IS NOT NULL
      THEN 'exact'
    WHEN rate_fallback IS NOT NULL
      THEN 'carry_forward'
    ELSE 'unknown_currency'
  END AS fx_source,

  -- Flag de advertencia para rows con carry-forward o moneda desconocida
  CASE
    WHEN unit_type != 'pct'
      AND UPPER(COALESCE(currency,'USD')) != 'USD'
      AND rate_exact IS NULL
      AND rate_fallback IS NOT NULL
      THEN TRUE
    ELSE FALSE
  END AS fx_is_approximate

FROM kpi_joined;


-- =============================================================================
-- §4  VISTA DE AUDITORÍA  v_kpi_usd_audit
-- =============================================================================
-- Resumen de cobertura FX para detectar monedas sin tasa o carry-forwards masivos.

CREATE OR REPLACE VIEW `cometa_vault.v_kpi_usd_audit` AS

SELECT
  currency,
  fx_source,
  COUNT(*)                              AS kpi_count,
  COUNT(DISTINCT company_id)            AS companies_affected,
  COUNT(DISTINCT period_id)             AS periods_affected,
  SUM(CASE WHEN amount_usd IS NULL AND unit_type = 'usd'
           THEN 1 ELSE 0 END)           AS rows_without_conversion,
  ROUND(AVG(fx_rate_used), 4)           AS avg_rate_applied,
  MAX(submitted_at)                     AS latest_submission
FROM `cometa_vault.v_kpi_usd`
GROUP BY currency, fx_source
ORDER BY rows_without_conversion DESC, kpi_count DESC;


-- =============================================================================
-- §5  QA QUERIES — ejecutar después del SEED para verificar integridad
-- =============================================================================

-- Q1: Verificar que el seed cargó exactamente N currencies × 12 meses × 7 años
-- Esperado: 11 monedas × 12 meses × 7 años = 924 filas
SELECT
  COUNT(*)                 AS total_rows,
  COUNT(DISTINCT currency_code) AS currencies,
  MIN(year)                AS year_min,
  MAX(year)                AS year_max
FROM `cometa_vault.dim_fx_rates`;
-- Resultado esperado: total_rows=924, currencies=11, year_min=2019, year_max=2025


-- Q2: Sin gaps en la serie mensual por moneda (toda moneda debe tener 12 meses/año)
SELECT
  currency_code,
  year,
  COUNT(*) AS months_loaded
FROM `cometa_vault.dim_fx_rates`
GROUP BY currency_code, year
HAVING COUNT(*) != 12
ORDER BY currency_code, year;
-- Resultado esperado: 0 filas


-- Q3: Ninguna tasa debe ser ≤ 0 (protege contra división por cero en la vista)
SELECT currency_code, year, month, rate
FROM `cometa_vault.dim_fx_rates`
WHERE rate <= 0;
-- Resultado esperado: 0 filas


-- Q4: USD siempre debe tener rate = 1.0
SELECT *
FROM `cometa_vault.dim_fx_rates`
WHERE currency_code = 'USD' AND rate != 1.0;
-- Resultado esperado: 0 filas


-- Q5: Cobertura FX en la vista — debe mostrar 0 rows con fx_source = 'unknown_currency'
SELECT fx_source, COUNT(*) AS count
FROM `cometa_vault.v_kpi_usd_audit`
GROUP BY fx_source
ORDER BY fx_source;


-- Q6: Verificar que los KPIs de porcentaje NO fueron convertidos
SELECT
  kpi_key,
  unit_type,
  currency,
  numeric_value,
  amount_usd,
  fx_source
FROM `cometa_vault.v_kpi_usd`
WHERE unit_type = 'pct'
  AND amount_usd != numeric_value   -- no debería ocurrir nunca
LIMIT 10;
-- Resultado esperado: 0 filas


-- Q7: Spot check de conversión MXN → USD
-- Para revenue = $100 MXN en período P2025Q1M03 (rate=17.80):
-- amount_usd esperado = 100 / 17.80 = 5.618
SELECT
  kpi_key,
  currency,
  period_id,
  numeric_value,
  fx_rate_used,
  amount_usd,
  fx_source
FROM `cometa_vault.v_kpi_usd`
WHERE currency = 'MXN'
  AND period_id LIKE 'P2025%'
  AND kpi_key = 'revenue'
LIMIT 5;
