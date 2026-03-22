-- ================================================================
-- Cometa Vault — Production Load Script v01
-- Generated : 2026-03-21
-- Source    : histo/legacy_ready.jsonl  (4,268 rows — 3,353 valid)
-- Staging   : cometa-mvp.cometa_vault.stg_legacy_fact_kpis
-- Target    : cometa-mvp.cometa_vault.fact_kpi
-- ================================================================
-- EXECUTION ORDER:
--   STEP 0 → STEP 1 → STEP 2 → STEP 3 (review!) → STEP 4 → STEP 5
-- DO NOT run STEP 4 without reviewing STEP 3 output first.
-- ================================================================


-- ── STEP 0: Populate dim_company master catalogue ─────────────
-- Run ONCE. Idempotent via CREATE OR REPLACE.
-- entity_type distinguishes portfolio startups from fund overviews.
-- fund_id: F001 = Cometa CIII | F002 = Cometa VII

CREATE OR REPLACE TABLE `cometa-mvp.cometa_vault.dim_company` (
  comp_id       STRING NOT NULL,
  company_id    STRING NOT NULL,
  display_name  STRING,
  portfolio_id  STRING NOT NULL,
  entity_type   STRING NOT NULL,   -- 'COMPANY' | 'FUND_OVERVIEW'
  sector        STRING,            -- 'SAAS'|'LEND'|'ECOM'|'INSUR'|'OTH'|NULL
  is_active     BOOL   NOT NULL
);

INSERT INTO `cometa-mvp.cometa_vault.dim_company`
  (comp_id, company_id, display_name, portfolio_id, entity_type, sector, is_active)
VALUES
  -- ── Fondo VII — Fund-level overview ───────────────────────────────────────
  ('COMP_FUND_VII_OVERVIEW', 'fund_vii_overview', 'Fondo VII — Overview Consolidado',
   'VII', 'FUND_OVERVIEW', NULL, TRUE),

  -- ── Fondo VII — Portfolio companies ───────────────────────────────────────
  ('COMP_CONEKTA',    'conekta',    'Conekta',    'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_KUESKI',     'kueski',     'Kueski',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_MPOWER',     'mpower',     'MPower',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_BNEXT',      'bnext',      'Bnext',      'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_YOTEPRESTO', 'yotepresto', 'YoTePresto', 'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_IVOY',       'ivoy',       'iVoy',       'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_BEWE',       'bewe',       'Bewe',       'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_SKYDROPX',   'skydropx',   'Skydropx',   'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_GAIA',       'gaia',       'Gaia',       'VII',  'COMPANY', 'SAAS',  TRUE),

  -- ── Fondo CIII — Portfolio companies ──────────────────────────────────────
  ('COMP_SIMETRIK',    'simetrik',    'Simetrik',    'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_GUROS',       'guros',       'Guros',       'CIII', 'COMPANY', 'INSUR', TRUE),
  ('COMP_QUINIO',      'quinio',      'Quinio',      'CIII', 'COMPANY', 'ECOM',  TRUE),
  ('COMP_HACKMETRIX',  'hackmetrix',  'Hackmetrix',  'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_HUNTY',       'hunty',       'Hunty',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_ATANI',       'atani',       'Atani',       'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_CLUVI',       'cluvi',       'Cluvi',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_KUONA',       'kuona',       'Kuona',       'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_PROMETEO',    'prometeo',    'Prometeo',    'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_TERRITORIUM', 'territorium', 'Territorium', 'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_MORGANA',     'morgana',     'Morgana',     'CIII', 'COMPANY', 'INSUR', TRUE),
  ('COMP_DUPPLA',      'duppla',      'Duppla',      'CIII', 'COMPANY', 'LEND',  TRUE),
  ('COMP_KALA',        'kala',        'Kala',        'CIII', 'COMPANY', 'OTH',   TRUE),
  ('COMP_PULSAR',      'pulsar',      'Pulsar',      'CIII', 'COMPANY', 'SAAS',  TRUE),
  ('COMP_SOLVENTO',    'solvento',    'Solvento',    'CIII', 'COMPANY', 'LEND',  TRUE),
  ('COMP_NUMIA',       'numia',       'Numia',       'CIII', 'COMPANY', 'SAAS',  TRUE);


-- ── STEP 1: Create staging table ──────────────────────────────
-- Schema aligned with base/DiccionarioYDiagrama.md (fact_kpi contract)

CREATE OR REPLACE TABLE `cometa-mvp.cometa_vault.stg_legacy_fact_kpis` (
  id                    STRING    NOT NULL,
  company_id            STRING    NOT NULL,   -- COMP_* format  (e.g. 'COMP_SIMETRIK')
  metric_id             STRING,               -- Kxxx format    (e.g. 'K001')
  kpi_key               STRING    NOT NULL,   -- snake_case name (e.g. 'revenue')
  kpi_label             STRING,
  period_id             STRING    NOT NULL,   -- PYYYYQxMyy     (e.g. 'P2020Q1M03')
  raw_value             STRING,
  numeric_value         FLOAT64,
  unit                  STRING,
  currency_original     STRING,
  normalized_value_usd  FLOAT64,
  fx_rate               FLOAT64,
  fund_id               STRING,               -- F001 = CIII | F002 = VII
  bucket_id             STRING,               -- B01-B06
  portfolio_id          STRING,               -- 'CIII' | 'VII'
  is_valid              BOOL,
  value_status          STRING,               -- 'valid' | 'missing_legacy' | 'excel_error'
  confidence_score      FLOAT64,
  source_description    STRING,
  created_at            TIMESTAMP,
  last_upload_at        TIMESTAMP
);


-- ── STEP 2: Load JSONL from GCS ───────────────────────────────
-- Upload command (run from repo root):
--   gsutil cp histo/legacy_ready.jsonl \
--     gs://ingesta-financiera-raw-cometa-mvp/legacy/legacy_ready.jsonl

LOAD DATA INTO `cometa-mvp.cometa_vault.stg_legacy_fact_kpis`
FROM FILES (
  format                = 'NEWLINE_DELIMITED_JSON',
  uris                  = ['gs://ingesta-financiera-raw-cometa-mvp/legacy/legacy_ready.jsonl'],
  ignore_unknown_values = TRUE
);


-- ── STEP 3: Validate — REVIEW BEFORE PROCEEDING ───────────────
-- Expected: 3,353 valid rows across 26 entities (25 companies + 1 FUND_OVERVIEW)
-- Check: missing_fx_rows = 0 (all currencies normalized to USD)
-- Check: earliest_period >= P2020Q1M03 | latest_period <= P2025Q4M12

SELECT
  s.company_id,
  d.display_name,
  d.entity_type,
  s.portfolio_id,
  COUNT(*)                                                          AS total_rows,
  COUNTIF(s.value_status = 'valid')                                AS valid_rows,
  COUNTIF(s.value_status = 'missing_legacy')                       AS missing_rows,
  COUNT(DISTINCT s.kpi_key)                                        AS distinct_kpis,
  MIN(s.period_id)                                                 AS earliest_period,
  MAX(s.period_id)                                                 AS latest_period,
  COUNTIF(s.normalized_value_usd IS NULL
          AND s.currency_original != 'USD'
          AND s.value_status = 'valid')                            AS missing_fx_rows
FROM `cometa-mvp.cometa_vault.stg_legacy_fact_kpis` s
LEFT JOIN `cometa-mvp.cometa_vault.dim_company` d USING (company_id)
GROUP BY 1, 2, 3, 4
ORDER BY d.entity_type DESC, s.portfolio_id, s.company_id;


-- ── STEP 4: Promote to production ─────────────────────────────
-- Safety gates enforced in WHERE clause:
--   1. value_status = 'valid'     — never insert missing_legacy rows
--   2. period_id <= 'P2025Q4M12'  — never touch 2026+ data
--   3. NOT EXISTS                 — never overwrite existing rows (dedup)
--
-- Covers 3,353 valid historical KPI records.
-- After execution, run STEP 5 to verify counts.

INSERT INTO `cometa-mvp.cometa_vault.fact_kpi`
  (submission_id, company_id, fund_id, bucket_id, period_id, metric_id,
   value, value_status, notes, created_at)
SELECT
  CONCAT('LEGACY_', s.id)                         AS submission_id,
  s.company_id,
  s.fund_id,
  s.bucket_id,
  s.period_id,
  s.metric_id,
  COALESCE(s.normalized_value_usd, s.numeric_value) AS value,
  'reported'                                       AS value_status,
  s.source_description                             AS notes,
  s.created_at
FROM `cometa-mvp.cometa_vault.stg_legacy_fact_kpis` s
WHERE s.value_status = 'valid'
  AND s.period_id <= 'P2025Q4M12'                 -- gate: no 2026+ data
  AND NOT EXISTS (
    SELECT 1 FROM `cometa-mvp.cometa_vault.fact_kpi` p
    WHERE p.company_id = s.company_id
      AND p.metric_id  = s.metric_id
      AND p.period_id  = s.period_id
  );


-- ── STEP 5: Audit after promotion ─────────────────────────────
SELECT
  d.entity_type,
  f.fund_id,
  d.portfolio_id,
  COUNT(*)               AS rows_loaded,
  COUNT(DISTINCT f.company_id) AS companies,
  MIN(f.period_id)       AS earliest_period,
  MAX(f.period_id)       AS latest_period,
  MIN(f.created_at)      AS load_ts
FROM `cometa-mvp.cometa_vault.fact_kpi` f
LEFT JOIN `cometa-mvp.cometa_vault.dim_company` d
  ON d.company_id = f.company_id
WHERE f.submission_id LIKE 'LEGACY_%'
GROUP BY 1, 2, 3
ORDER BY 1 DESC, 2, 3;
