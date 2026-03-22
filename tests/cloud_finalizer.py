#!/usr/bin/env python3
"""
cloud_finalizer.py — Vuelco histórico a BigQuery usando Python como puente.

PASOS:
  1. Crear/reemplazar dim_company (26 entidades: 25 companies + COMP_FUND_VII_OVERVIEW)
  2. Subir histo/legacy_ready.jsonl a GCS
  3. Crear stg_legacy_fact_kpis y cargar el JSONL desde GCS

Prerequisitos:
  pip install google-cloud-bigquery google-cloud-storage

Uso:
  .\\venv\\Scripts\\python.exe cloud_finalizer.py
  .\\venv\\Scripts\\python.exe cloud_finalizer.py --skip-upload   (si el JSONL ya está en GCS)
  .\\venv\\Scripts\\python.exe cloud_finalizer.py --dry-run       (solo valida config, no escribe)
"""

from __future__ import annotations

import sys
import io
import os
import argparse
from pathlib import Path

# UTF-8 en Windows
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
else:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

try:
    from dotenv import load_dotenv
    load_dotenv(override=True)
except ImportError:
    pass

# ── Config ─────────────────────────────────────────────────────────────────────
ROOT            = Path(__file__).parent
JSONL_LOCAL     = ROOT / "histo" / "legacy_ready.jsonl"
CREDENTIALS     = os.getenv("GOOGLE_APPLICATION_CREDENTIALS",
                            str(ROOT / "cometa_key.json"))
PROJECT         = os.getenv("GOOGLE_CLOUD_PROJECT", "cometa-mvp")
DATASET         = os.getenv("BIGQUERY_DATASET", "cometa_vault_test")
GCS_BUCKET      = os.getenv("GCS_INPUT_BUCKET",
                            "ingesta-financiera-raw-cometa-mvp")
GCS_JSONL_PATH  = "legacy/legacy_ready.jsonl"
GCS_JSONL_URI   = f"gs://{GCS_BUCKET}/{GCS_JSONL_PATH}"
TABLE_DIM       = f"{PROJECT}.{DATASET}.dim_company"
TABLE_STG       = f"{PROJECT}.{DATASET}.stg_legacy_fact_kpis"

# ── CLI args ───────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser()
parser.add_argument("--skip-upload", action="store_true",
                    help="Omite la subida a GCS (el JSONL ya esta en el bucket)")
parser.add_argument("--dry-run", action="store_true",
                    help="Valida config y archivos sin escribir nada")
args = parser.parse_args()

# ── Banner ─────────────────────────────────────────────────────────────────────
print("=" * 62)
print("  COMETA VAULT — Cloud Finalizer")
print("=" * 62)
print(f"  Project    : {PROJECT}")
print(f"  Dataset    : {DATASET}")
print(f"  Bucket     : {GCS_BUCKET}")
print(f"  JSONL      : {JSONL_LOCAL}")
print(f"  Credentials: {CREDENTIALS}")
if args.dry_run:
    print("  MODE       : DRY RUN — no se escribira nada")
print()

# ── Pre-flight checks ──────────────────────────────────────────────────────────
errors = []
if not Path(CREDENTIALS).exists():
    errors.append(f"Service account JSON no encontrado: {CREDENTIALS}")
if not JSONL_LOCAL.exists():
    errors.append(f"JSONL no encontrado: {JSONL_LOCAL}")

if errors:
    for e in errors:
        print(f"ERROR  {e}")
    sys.exit(1)

jsonl_rows = sum(1 for _ in JSONL_LOCAL.open(encoding="utf-8"))
print(f"Pre-flight OK  ({jsonl_rows:,} lineas en JSONL)")
print()

if args.dry_run:
    print("DRY RUN completado — config valida.")
    sys.exit(0)

# ── Imports de GCP ─────────────────────────────────────────────────────────────
try:
    from google.cloud import bigquery, storage
    from google.oauth2 import service_account
except ImportError:
    print("ERROR  Faltan dependencias:")
    print("       .\\venv\\Scripts\\pip install google-cloud-bigquery google-cloud-storage")
    sys.exit(1)

creds = service_account.Credentials.from_service_account_file(
    CREDENTIALS,
    scopes=["https://www.googleapis.com/auth/cloud-platform"],
)
bq  = bigquery.Client(project=PROJECT, credentials=creds)
gcs = storage.Client(project=PROJECT, credentials=creds)


# ─────────────────────────────────────────────────────────────────────────────
# PASO 1 — dim_company (CREATE OR REPLACE + INSERT 26 filas)
# ─────────────────────────────────────────────────────────────────────────────
print("PASO 1/3  Creando dim_company...")

DDL_DIM = f"""
CREATE OR REPLACE TABLE `{TABLE_DIM}` (
  comp_id       STRING NOT NULL,
  company_id    STRING NOT NULL,
  display_name  STRING,
  portfolio_id  STRING NOT NULL,
  entity_type   STRING NOT NULL,
  sector        STRING,
  is_active     BOOL   NOT NULL
)
"""

DML_DIM = f"""
INSERT INTO `{TABLE_DIM}`
  (comp_id, company_id, display_name, portfolio_id, entity_type, sector, is_active)
VALUES
  ('COMP_FUND_VII_OVERVIEW', 'fund_vii_overview', 'Fondo VII — Overview Consolidado', 'VII',  'FUND_OVERVIEW', NULL,    TRUE),
  ('COMP_CONEKTA',    'conekta',    'Conekta',    'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_KUESKI',     'kueski',     'Kueski',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_MPOWER',     'mpower',     'MPower',     'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_BNEXT',      'bnext',      'Bnext',      'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_YOTEPRESTO', 'yotepresto', 'YoTePresto', 'VII',  'COMPANY', 'LEND',  TRUE),
  ('COMP_IVOY',       'ivoy',       'iVoy',       'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_BEWE',       'bewe',       'Bewe',       'VII',  'COMPANY', 'SAAS',  TRUE),
  ('COMP_SKYDROPX',   'skydropx',   'Skydropx',   'VII',  'COMPANY', 'ECOM',  TRUE),
  ('COMP_GAIA',       'gaia',       'Gaia',       'VII',  'COMPANY', 'SAAS',  TRUE),
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
  ('COMP_NUMIA',       'numia',       'Numia',       'CIII', 'COMPANY', 'SAAS',  TRUE)
"""

try:
    bq.query(DDL_DIM).result()
    bq.query(DML_DIM).result()
    # Verify row count
    count = list(bq.query(f"SELECT COUNT(*) AS n FROM `{TABLE_DIM}`").result())[0].n
    print(f"PASO COMPLETADO  dim_company creada con {count} filas")
except Exception as exc:
    print(f"ERROR en PASO 1: {exc}")
    sys.exit(1)

print()


# ─────────────────────────────────────────────────────────────────────────────
# PASO 2 — Subir JSONL a GCS
# ─────────────────────────────────────────────────────────────────────────────
if args.skip_upload:
    print("PASO 2/3  Upload omitido (--skip-upload)")
else:
    print(f"PASO 2/3  Subiendo {JSONL_LOCAL.name} a GCS...")
    try:
        bucket = gcs.bucket(GCS_BUCKET)
        blob   = bucket.blob(GCS_JSONL_PATH)
        blob.upload_from_filename(str(JSONL_LOCAL))
        size_mb = blob.size / 1_048_576 if blob.size else 0
        # Refresh metadata
        blob.reload()
        size_mb = blob.size / 1_048_576
        print(f"PASO COMPLETADO  gs://{GCS_BUCKET}/{GCS_JSONL_PATH}  ({size_mb:.2f} MB)")
    except Exception as exc:
        print(f"ERROR en PASO 2: {exc}")
        sys.exit(1)

print()


# ─────────────────────────────────────────────────────────────────────────────
# PASO 3 — Crear stg_legacy_fact_kpis y cargar desde GCS
# ─────────────────────────────────────────────────────────────────────────────
print(f"PASO 3/3  Creando {TABLE_STG} y cargando JSONL...")

DDL_STG = f"""
CREATE OR REPLACE TABLE `{TABLE_STG}` (
  id                    STRING    NOT NULL,
  company_id            STRING    NOT NULL,
  metric_id             STRING,
  kpi_key               STRING    NOT NULL,
  kpi_label             STRING,
  period_id             STRING    NOT NULL,
  raw_value             STRING,
  numeric_value         FLOAT64,
  unit                  STRING,
  currency_original     STRING,
  normalized_value_usd  FLOAT64,
  fx_rate               FLOAT64,
  fund_id               STRING,
  bucket_id             STRING,
  portfolio_id          STRING,
  is_valid              BOOL,
  value_status          STRING,
  confidence_score      FLOAT64,
  source_description    STRING,
  created_at            TIMESTAMP,
  last_upload_at        TIMESTAMP
)
"""

try:
    bq.query(DDL_STG).result()
    print(f"  Tabla staging creada")
except Exception as exc:
    print(f"ERROR creando staging table: {exc}")
    sys.exit(1)

# Load via LoadJob (más confiable que LOAD DATA SQL desde el cliente Python)
job_config = bigquery.LoadJobConfig(
    source_format          = bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
    ignore_unknown_values  = True,
    write_disposition      = bigquery.WriteDisposition.WRITE_APPEND,
)

try:
    load_job = bq.load_table_from_uri(GCS_JSONL_URI, TABLE_STG, job_config=job_config)
    print(f"  Job iniciado: {load_job.job_id}")
    load_job.result()   # espera a que termine

    dest_table = bq.get_table(TABLE_STG)
    n_rows = dest_table.num_rows
    print(f"PASO COMPLETADO  {n_rows:,} filas cargadas en {TABLE_STG}")
    if load_job.errors:
        print(f"  Advertencias del job:")
        for e in load_job.errors[:5]:
            print(f"    {e}")
except Exception as exc:
    print(f"ERROR en PASO 3 (load): {exc}")
    sys.exit(1)

print()
print("=" * 62)
print("  FINALIZADO — datos historicos listos en BigQuery")
print()
print("  SIGUIENTE PASO MANUAL (en BigQuery console):")
print(f"  Ejecuta STEP 3 de sql/production_v01.sql para validar")
print(f"  y luego STEP 4 para promover a fact_kpi.")
print("=" * 62)
