-- =============================================================================
-- dim_company_seed.sql
-- Cometa Vault — BigQuery
-- =============================================================================
-- Propósito : Cargar (o recargar) la tabla dim_company con las 30 compañías
--             definitivas del portafolio Cometa (Fondo VII + Fondo CIII).
--
-- Estrategia: DELETE + INSERT dentro de una transacción lógica.
--             En BigQuery se usa el patrón TRUNCATE → INSERT para garantizar
--             atomicidad sin requerir permisos de DML DELETE.
--             Si prefieres MERGE (upsert), el bloque alternativo está al final.
--
-- Prerequisito: La tabla ya debe existir con este schema:
--   company_key    STRING  NOT NULL
--   company_name   STRING  NOT NULL
--   portfolio_id   STRING  NOT NULL   -- 'VII' | 'CIII'
--   portfolio_name STRING
--   bucket_id      STRING             -- 'SAAS'|'LEND'|'ECOM'|'INSUR'|'OTH'
--   updated_at     TIMESTAMP
--
-- Ejecutar: En la consola de BigQuery o con bq query --use_legacy_sql=false
-- =============================================================================

-- ── PASO 1: Crear tabla si no existe ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `cometa-mvp.cometa_vault.dim_company` (
    company_key    STRING    NOT NULL,
    company_name   STRING    NOT NULL,
    portfolio_id   STRING    NOT NULL,
    portfolio_name STRING,
    bucket_id      STRING,
    updated_at     TIMESTAMP
);

-- ── PASO 2: Vaciar y recargar (TRUNCATE + INSERT) ─────────────────────────────
-- BigQuery no tiene TRUNCATE nativo; usamos DELETE sin WHERE (equivalente).
-- Nota: requiere bigquery.dataEditor en el dataset.

DELETE FROM `cometa-mvp.cometa_vault.dim_company` WHERE TRUE;

-- ── PASO 3: Insertar las 30 compañías definitivas ────────────────────────────
INSERT INTO `cometa-mvp.cometa_vault.dim_company`
    (company_key, company_name, portfolio_id, portfolio_name, bucket_id, updated_at)
VALUES

-- ════════════════════════════════════════════════════════════════════════════
-- FONDO VII  (10 compañías)
-- ════════════════════════════════════════════════════════════════════════════
  ('conekta',    'Conekta',    'VII',  'Fondo VII',  'SAAS',  CURRENT_TIMESTAMP()),
  ('kueski',     'Kueski',     'VII',  'Fondo VII',  'LEND',  CURRENT_TIMESTAMP()),
  ('mpower',     'MPower',     'VII',  'Fondo VII',  'LEND',  CURRENT_TIMESTAMP()),
  ('bnext',      'Bnext',      'VII',  'Fondo VII',  'SAAS',  CURRENT_TIMESTAMP()),
  ('yotepresto', 'Yotepresto', 'VII',  'Fondo VII',  'LEND',  CURRENT_TIMESTAMP()),
  ('ivoy',       'iVoy',       'VII',  'Fondo VII',  'ECOM',  CURRENT_TIMESTAMP()),
  ('bewe',       'Bewe',       'VII',  'Fondo VII',  'SAAS',  CURRENT_TIMESTAMP()),
  ('skydropx',   'Skydropx',   'VII',  'Fondo VII',  'ECOM',  CURRENT_TIMESTAMP()),
  ('bitso',      'Bitso',      'VII',  'Fondo VII',  'SAAS',  CURRENT_TIMESTAMP()),
  ('cabify',     'Cabify',     'VII',  'Fondo VII',  'ECOM',  CURRENT_TIMESTAMP()),

-- ════════════════════════════════════════════════════════════════════════════
-- FONDO CIII  (20 compañías)
-- ════════════════════════════════════════════════════════════════════════════
  ('simetrik',    'Simetrik',    'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('guros',       'Guros',       'CIII', 'Fondo CIII', 'INSUR', CURRENT_TIMESTAMP()),
  ('quinio',      'Quinio',      'CIII', 'Fondo CIII', 'ECOM',  CURRENT_TIMESTAMP()),
  ('hackmetrix',  'Hackmetrix',  'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('hunty',       'Hunty',       'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('atani',       'Atani',       'CIII', 'Fondo CIII', 'OTH',   CURRENT_TIMESTAMP()),
  ('cluvi',       'Cluvi',       'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('kuona',       'Kuona',       'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('prometeo',    'Prometeo',    'CIII', 'Fondo CIII', 'OTH',   CURRENT_TIMESTAMP()),
  ('territorium', 'Territorium', 'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('m1',          'M1',          'CIII', 'Fondo CIII', 'INSUR', CURRENT_TIMESTAMP()),
  ('morgana',     'Morgana',     'CIII', 'Fondo CIII', 'INSUR', CURRENT_TIMESTAMP()),
  ('duppla',      'Duppla',      'CIII', 'Fondo CIII', 'LEND',  CURRENT_TIMESTAMP()),
  ('kala',        'Kala',        'CIII', 'Fondo CIII', 'OTH',   CURRENT_TIMESTAMP()),
  ('pulsar',      'Pulsar',      'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('solvento',    'Solvento',    'CIII', 'Fondo CIII', 'LEND',  CURRENT_TIMESTAMP()),
  ('numia',       'Numia',       'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('r2',          'R2',          'CIII', 'Fondo CIII', 'LEND',  CURRENT_TIMESTAMP()),
  ('dapta',       'Dapta',       'CIII', 'Fondo CIII', 'SAAS',  CURRENT_TIMESTAMP()),
  ('rintin',      'Rintin',      'CIII', 'Fondo CIII', 'ECOM',  CURRENT_TIMESTAMP());


-- ── PASO 4: Verificación post-carga ──────────────────────────────────────────
-- Ejecuta esta query por separado para confirmar los conteos.

SELECT
    portfolio_id,
    portfolio_name,
    COUNT(*)                                          AS total_companies,
    COUNTIF(bucket_id = 'SAAS')                       AS saas,
    COUNTIF(bucket_id = 'LEND')                       AS lend,
    COUNTIF(bucket_id = 'ECOM')                       AS ecom,
    COUNTIF(bucket_id = 'INSUR')                      AS insur,
    COUNTIF(bucket_id = 'OTH')                        AS oth
FROM `cometa-mvp.cometa_vault.dim_company`
GROUP BY 1, 2
ORDER BY 1;

-- Resultado esperado:
-- portfolio_id | total | saas | lend | ecom | insur | oth
-- CIII         |  20   |  9   |  4   |  2   |   3   |  3  (incl. Rintin ECOM)  -- (ajustar si cambian buckets)
-- VII          |  10   |  4   |  3   |  3   |   0   |  0


-- ── ALTERNATIVA: MERGE (upsert idempotente) ───────────────────────────────────
-- Úsalo si quieres poder volver a ejecutar el script sin limpiar primero.
-- Requiere bigquery.dataEditor + bigquery.dataViewer en el dataset.

/*
MERGE `cometa-mvp.cometa_vault.dim_company` AS target
USING (
  SELECT * FROM UNNEST([
    STRUCT('conekta'    AS company_key, 'Conekta'    AS company_name, 'VII'  AS portfolio_id, 'Fondo VII'  AS portfolio_name, 'SAAS'  AS bucket_id),
    STRUCT('kueski',     'Kueski',     'VII',  'Fondo VII',  'LEND'),
    STRUCT('mpower',     'MPower',     'VII',  'Fondo VII',  'LEND'),
    STRUCT('bnext',      'Bnext',      'VII',  'Fondo VII',  'SAAS'),
    STRUCT('yotepresto', 'Yotepresto', 'VII',  'Fondo VII',  'LEND'),
    STRUCT('ivoy',       'iVoy',       'VII',  'Fondo VII',  'ECOM'),
    STRUCT('bewe',       'Bewe',       'VII',  'Fondo VII',  'SAAS'),
    STRUCT('skydropx',   'Skydropx',   'VII',  'Fondo VII',  'ECOM'),
    STRUCT('bitso',      'Bitso',      'VII',  'Fondo VII',  'SAAS'),
    STRUCT('cabify',     'Cabify',     'VII',  'Fondo VII',  'ECOM'),
    STRUCT('simetrik',   'Simetrik',   'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('guros',      'Guros',      'CIII', 'Fondo CIII', 'INSUR'),
    STRUCT('quinio',     'Quinio',     'CIII', 'Fondo CIII', 'ECOM'),
    STRUCT('hackmetrix', 'Hackmetrix', 'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('hunty',      'Hunty',      'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('atani',      'Atani',      'CIII', 'Fondo CIII', 'OTH'),
    STRUCT('cluvi',      'Cluvi',      'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('kuona',      'Kuona',      'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('prometeo',   'Prometeo',   'CIII', 'Fondo CIII', 'OTH'),
    STRUCT('territorium','Territorium','CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('m1',         'M1',         'CIII', 'Fondo CIII', 'INSUR'),
    STRUCT('morgana',    'Morgana',    'CIII', 'Fondo CIII', 'INSUR'),
    STRUCT('duppla',     'Duppla',     'CIII', 'Fondo CIII', 'LEND'),
    STRUCT('kala',       'Kala',       'CIII', 'Fondo CIII', 'OTH'),
    STRUCT('pulsar',     'Pulsar',     'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('solvento',   'Solvento',   'CIII', 'Fondo CIII', 'LEND'),
    STRUCT('numia',      'Numia',      'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('r2',         'R2',         'CIII', 'Fondo CIII', 'LEND'),
    STRUCT('dapta',      'Dapta',      'CIII', 'Fondo CIII', 'SAAS'),
    STRUCT('rintin',     'Rintin',     'CIII', 'Fondo CIII', 'ECOM')
  ])
) AS source
ON target.company_key = source.company_key
WHEN MATCHED THEN UPDATE SET
    company_name   = source.company_name,
    portfolio_id   = source.portfolio_id,
    portfolio_name = source.portfolio_name,
    bucket_id      = source.bucket_id,
    updated_at     = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT
    (company_key, company_name, portfolio_id, portfolio_name, bucket_id, updated_at)
VALUES
    (source.company_key, source.company_name, source.portfolio_id,
     source.portfolio_name, source.bucket_id, CURRENT_TIMESTAMP());
*/


-- ── PASO 5: Audit query post-carga ───────────────────────────────────────────
-- Detecta compañías en fact_kpi_values que no tienen registro en dim_company
-- (integridad referencial — valores huérfanos).

SELECT DISTINCT
    k.submission_id,
    k.kpi_key,
    s.company_id,
    s.portfolio_id
FROM `cometa-mvp.cometa_vault.fact_kpi_values` k
JOIN `cometa-mvp.cometa_vault.submissions`     s USING (submission_id)
LEFT JOIN `cometa-mvp.cometa_vault.dim_company` d
    ON s.company_id = d.company_key
WHERE d.company_key IS NULL
ORDER BY s.company_id, k.kpi_key;
-- Si retorna 0 filas: integridad referencial OK.
