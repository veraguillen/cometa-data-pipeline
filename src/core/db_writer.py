"""
db_writer.py
────────────
Persists the canonical data contract to BigQuery.

Tables (created automatically on first run):
  {dataset}.submissions      — one row per unique PDF  (file_hash dedup)
  {dataset}.fact_kpi_values  — one row per KPI per submission

Rule 8 (Deduplication) is enforced at the DB layer:
  Before any insert we query submissions.file_hash. If it already exists,
  we skip the insert and return { inserted: False, duplicate: True }.

Dataset is configured via env var BIGQUERY_DATASET (default: cometa_vault).
"""

import json
import os
import pathlib
import uuid
from datetime import datetime, timezone
from typing import Optional

from google.cloud import bigquery
from google.oauth2 import service_account

# Local import kept at module level (no circular dependency: data_contract
# never imports from db_writer).
from src.core.data_contract import parse_numeric

# audit_contract is defined later in this file and called within insert_contract.


# ── Metric registry (dim_metric) ─────────────────────────────────────────────
# Single source of truth for KPI catalogue, expected unit, and which bucket
# each metric belongs to.
# bucket_id "ALL" means the metric applies to every company regardless of type.
# This mirrors the dim_metric table that would live in BigQuery.

DIM_METRIC: dict[str, dict] = {
    # ── Core financial (all verticals) ────────────────────────────────────────
    "revenue_growth":          {"label": "Revenue Growth",            "unit_expected": "%",   "bucket_id": "ALL"},
    "gross_profit_margin":     {"label": "Gross Profit Margin",       "unit_expected": "%",   "bucket_id": "ALL"},
    "ebitda_margin":           {"label": "EBITDA Margin",             "unit_expected": "%",   "bucket_id": "ALL"},
    "cash_in_bank_end_of_year":{"label": "Cash in Bank",              "unit_expected": "$",   "bucket_id": "ALL"},
    "annual_cash_flow":        {"label": "Annual Cash Flow",          "unit_expected": "$",   "bucket_id": "ALL"},
    "working_capital_debt":    {"label": "Working Capital Debt",      "unit_expected": "$",   "bucket_id": "ALL"},
    # ── Base metrics (derivation inputs) ──────────────────────────────────────
    "revenue":                 {"label": "Total Revenue",             "unit_expected": "$",   "bucket_id": "ALL"},
    "ebitda":                  {"label": "EBITDA",                    "unit_expected": "$",   "bucket_id": "ALL"},
    "cogs":                    {"label": "Cost of Goods Sold",        "unit_expected": "$",   "bucket_id": "ALL"},
    # ── SaaS sector metrics ───────────────────────────────────────────────────
    "mrr":                     {"label": "Monthly Recurring Revenue", "unit_expected": "$",   "bucket_id": "SAAS"},
    "churn_rate":              {"label": "Churn Rate",                "unit_expected": "%",   "bucket_id": "SAAS"},
    "cac":                     {"label": "Customer Acquisition Cost", "unit_expected": "$",   "bucket_id": "ALL"},
    # ── Lending sector metrics ────────────────────────────────────────────────
    "portfolio_size":          {"label": "Loan Portfolio Size",       "unit_expected": "$",   "bucket_id": "LEND"},
    "npl_ratio":               {"label": "Non-Performing Loan Ratio", "unit_expected": "%",   "bucket_id": "LEND"},
    # ── eCommerce sector metrics ──────────────────────────────────────────────
    "gmv":                     {"label": "Gross Merchandise Value",   "unit_expected": "$",   "bucket_id": "ECOM"},
    # ── Insurtech sector metrics ──────────────────────────────────────────────
    "loss_ratio":              {"label": "Loss Ratio",                "unit_expected": "%",   "bucket_id": "INSUR"},
}

# ── Company bucket registry ───────────────────────────────────────────────────
# Maps each company key to its vertical/bucket for consistency checks.
# SAAS companies must not receive LEND- or ECOM-exclusive metrics.

COMPANY_BUCKET: dict[str, str] = {
    # ── Fondo VII (10 compañías) ───────────────────────────────────────────────
    "conekta":     "SAAS",
    "kueski":      "LEND",
    "mpower":      "LEND",
    "bnext":       "SAAS",
    "yotepresto":  "LEND",
    "ivoy":        "ECOM",
    "bewe":        "SAAS",
    "skydropx":    "ECOM",
    "bitso":       "SAAS",
    "cabify":      "ECOM",
    # ── Fondo CIII (20 compañías) ─────────────────────────────────────────────
    "simetrik":    "SAAS",
    "guros":       "INSUR",
    "quinio":      "ECOM",
    "hackmetrix":  "SAAS",
    "hunty":       "SAAS",
    "atani":       "OTH",
    "cluvi":       "SAAS",
    "kuona":       "SAAS",
    "prometeo":    "OTH",
    "territorium": "SAAS",
    "m1":          "INSUR",
    "morgana":     "INSUR",
    "duppla":      "LEND",
    "kala":        "OTH",
    "pulsar":      "SAAS",
    "solvento":    "LEND",
    "numia":       "SAAS",
    "r2":          "LEND",
    "dapta":       "SAAS",
    "rintin":      "ECOM",
}

# ── Portfolio registry ────────────────────────────────────────────────────────
# Single source of truth for startup → fund assignment.
# Key: lowercase company name (no dots/dashes). Value: portfolio metadata.

PORTFOLIO_MAP: dict[str, dict] = {
    # ── Fondo VII (10 compañías) ───────────────────────────────────────────────
    "conekta":     {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "kueski":      {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "mpower":      {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "bnext":       {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "yotepresto":  {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "ivoy":        {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "bewe":        {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "skydropx":    {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "bitso":       {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "cabify":      {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    # ── Fondo CIII (20 compañías) ─────────────────────────────────────────────
    "simetrik":    {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "guros":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "quinio":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "hackmetrix":  {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "hunty":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "atani":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "cluvi":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "kuona":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "prometeo":    {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "territorium": {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "m1":          {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "morgana":     {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "duppla":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "kala":        {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "pulsar":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "solvento":    {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "numia":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "r2":          {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "dapta":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "rintin":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
}


# Sorted longest-first so "skydropx" is checked before "sky", avoiding false positives
_SORTED_COMPANY_NAMES = sorted(PORTFOLIO_MAP.keys(), key=len, reverse=True)


def _normalize_company_key(company_id: str) -> str:
    """
    Derive the canonical COMPANY_BUCKET key from a raw company_id string.

    Strategy (applied in order, stops at first match):
    1. Strip domain suffix and lowercase:  "simetrik.com" → "simetrik"
    2. Exact match against COMPANY_BUCKET keys          → return immediately
    3. Strip hyphens/underscores, exact match           → return immediately
    4. Prefix match: raw starts with "<key>-" or "<key>_"
       Handles "m1-insurtech" → "m1", "bnext-mx" → "bnext"
    5. Fallback to stripped string (for dim_company SQL query)

    This prevents OBS-05: guiones que son sufijos de país/producto no deben
    eliminar la raíz de la clave (ej. "m1-insurtech" → "m1", no "m1insurtech").
    """
    base = company_id.lower().split(".")[0]   # strip domain

    # Step 2: exact match (most common case: "simetrik", "kueski", etc.)
    if base in COMPANY_BUCKET:
        return base

    # Step 3: stripped exact match ("yote_presto" → "yotepresto")
    stripped = base.replace("-", "").replace("_", "")
    if stripped in COMPANY_BUCKET:
        return stripped

    # Step 4: prefix match — check if base starts with "<key>-" or "<key>_"
    # Sorted longest-first to avoid "m" matching before "m1"
    for key in sorted(COMPANY_BUCKET.keys(), key=len, reverse=True):
        if base.startswith(key + "-") or base.startswith(key + "_"):
            return key

    # Step 5: fallback — return stripped for the SQL query; will show in_dim_company=False
    return stripped


def detect_company_from_text(text: str) -> tuple[str, str]:
    """
    Scan raw text (Gemini JSON, filename, etc.) for portfolio company names.
    Returns (company_key, portfolio_id) or ("unknown", "unknown").

    Longest names are matched first to prevent shorter keys (e.g. "next")
    from matching substrings inside longer ones (e.g. "conekta").

    Three-pass strategy to handle filenames with special chars:
    Pass 1 — Raw lowercase:  "skydropx _ board update" → finds "skydropx" ✓
    Pass 2 — Normalized:     separators (_, -, spaces) colapsados a un espacio
              "skydropx_board" → "skydropx board" → "skydropx" encontrado ✓
    Pass 3 — Stripped:       todos los no-alfanuméricos eliminados
              "skydropxboardupdate" contiene "skydropx" ✓
              (captura casos de concatenación sin separador)
    """
    import re as _re

    text_lower  = text.lower()
    # Normalize: cualquier secuencia de chars no-alfanuméricos → espacio
    text_norm   = _re.sub(r'[^a-z0-9]+', ' ', text_lower).strip()
    # Strip: eliminar todo lo que no sea letra o dígito
    text_strip  = _re.sub(r'[^a-z0-9]', '', text_lower)

    for name in _SORTED_COMPANY_NAMES:
        # name_strip: versión sin guiones (todos los nombres del portafolio
        # son alfanuméricos, pero lo mantenemos por consistencia)
        name_strip = _re.sub(r'[^a-z0-9]', '', name)

        if (name in text_lower          # Pass 1: búsqueda directa
                or name in text_norm    # Pass 2: separadores normalizados
                or name_strip in text_strip):  # Pass 3: texto y nombre sin separadores
            info = PORTFOLIO_MAP[name]
            return name, info["portfolio_id"]

    return "unknown", "unknown"


def lookup_portfolio(company_id: str) -> str:
    """
    Infer portfolio_id from a company_id string (email domain or company name).

    Matching strategy: strip dots, dashes, underscores then check if any
    registered company key appears as a substring.

    Examples:
      "simetrik.com"   → "CIII"
      "conekta.com"    → "VII"
      "acme-corp"      → "unknown"
    """
    normalized = company_id.lower().replace(".", "").replace("-", "").replace("_", "")
    for name, info in PORTFOLIO_MAP.items():
        if name.replace("-", "") in normalized:
            return info["portfolio_id"]
    return "unknown"


# ── Schema definitions ────────────────────────────────────────────────────────

SUBMISSIONS_SCHEMA = [
    bigquery.SchemaField("submission_id",     "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("file_hash",         "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("company_id",        "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("founder_email",     "STRING"),
    bigquery.SchemaField("original_filename", "STRING"),
    bigquery.SchemaField("submitted_at",      "TIMESTAMP", mode="REQUIRED"),
    bigquery.SchemaField("period_id",         "STRING"),
    bigquery.SchemaField("period_consistent", "BOOL"),
    bigquery.SchemaField("kpi_count_total",   "INTEGER"),
    bigquery.SchemaField("kpi_count_valid",   "INTEGER"),
    bigquery.SchemaField("status",             "STRING"),
    bigquery.SchemaField("avg_confidence",     "FLOAT64"),
    bigquery.SchemaField("is_latest_version",  "BOOL"),
    bigquery.SchemaField("raw_gemini",         "JSON"),
    bigquery.SchemaField("created_at",         "TIMESTAMP"),
    bigquery.SchemaField("detected_currency",  "STRING"),
    bigquery.SchemaField("portfolio_id",       "STRING"),
]

DIM_COMPANY_SCHEMA = [
    bigquery.SchemaField("company_key",    "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("company_name",   "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("portfolio_id",   "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("portfolio_name", "STRING"),
    bigquery.SchemaField("bucket_id",      "STRING"),
    bigquery.SchemaField("updated_at",     "TIMESTAMP"),
]

FACT_KPI_SCHEMA = [
    bigquery.SchemaField("id",                  "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("submission_id",       "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("kpi_key",             "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("kpi_label",           "STRING"),
    bigquery.SchemaField("raw_value",           "STRING"),
    bigquery.SchemaField("numeric_value",       "FLOAT64"),
    bigquery.SchemaField("unit",                "STRING"),
    bigquery.SchemaField("period_id",           "STRING"),
    bigquery.SchemaField("source_description",  "STRING"),
    bigquery.SchemaField("is_valid",            "BOOL"),
    bigquery.SchemaField("created_at",          "TIMESTAMP"),
    # ── Analyst audit trail ───────────────────────────────────────────────
    bigquery.SchemaField("is_manually_edited",  "BOOL"),
    bigquery.SchemaField("edited_at",           "TIMESTAMP"),
    bigquery.SchemaField("edited_raw_value",    "STRING"),   # pre-edit value
    # ── FX normalization ─────────────────────────────────────────────────
    # original_currency  — ISO 4217 code as detected by Gemini FASE 1
    # fx_rate            — annual-average units-of-currency per 1 USD used
    # normalized_value_usd — numeric_value / fx_rate  (apples-to-apples USD)
    bigquery.SchemaField("original_currency",     "STRING"),
    bigquery.SchemaField("fx_rate",               "FLOAT64"),
    bigquery.SchemaField("normalized_value_usd",  "FLOAT64"),
    bigquery.SchemaField("confidence",            "FLOAT64"),
]

# Columns added after initial deployment — migrated idempotently on startup.
# New tables receive them via FACT_KPI_SCHEMA directly.
# Existing tables get them added by _ensure_audit_columns at startup.
_AUDIT_FIELDS = [
    # Core fields missing from pre-created tables
    bigquery.SchemaField("id",                   "STRING"),   # NULLABLE — can't add REQUIRED to existing table
    bigquery.SchemaField("submission_id",        "STRING"),
    bigquery.SchemaField("kpi_key",              "STRING"),
    bigquery.SchemaField("kpi_label",            "STRING"),
    bigquery.SchemaField("raw_value",            "STRING"),
    bigquery.SchemaField("numeric_value",        "FLOAT64"),
    bigquery.SchemaField("unit",                 "STRING"),
    bigquery.SchemaField("period_id",            "STRING"),
    bigquery.SchemaField("source_description",   "STRING"),
    bigquery.SchemaField("is_valid",             "BOOL"),
    bigquery.SchemaField("created_at",           "TIMESTAMP"),
    # Analyst audit trail
    bigquery.SchemaField("is_manually_edited",   "BOOL"),
    bigquery.SchemaField("edited_at",            "TIMESTAMP"),
    bigquery.SchemaField("edited_raw_value",     "STRING"),
    # FX normalization
    bigquery.SchemaField("original_currency",    "STRING"),
    bigquery.SchemaField("fx_rate",              "FLOAT64"),
    bigquery.SchemaField("normalized_value_usd", "FLOAT64"),
    # Gemini confidence score
    bigquery.SchemaField("confidence",           "FLOAT64"),
]

# submissions table: full migration list.
# Every field in SUBMISSIONS_SCHEMA that may be absent in pre-created tables
# is listed here so _ensure_submission_new_columns adds it idempotently.
_SUBMISSION_NEW_FIELDS = [
    bigquery.SchemaField("file_hash",          "STRING"),
    bigquery.SchemaField("founder_email",      "STRING"),
    bigquery.SchemaField("original_filename",  "STRING"),
    bigquery.SchemaField("submitted_at",       "TIMESTAMP"),
    bigquery.SchemaField("period_id",          "STRING"),
    bigquery.SchemaField("period_consistent",  "BOOL"),
    bigquery.SchemaField("kpi_count_total",    "INTEGER"),
    bigquery.SchemaField("kpi_count_valid",    "INTEGER"),
    bigquery.SchemaField("status",             "STRING"),
    bigquery.SchemaField("avg_confidence",     "FLOAT64"),
    bigquery.SchemaField("is_latest_version",  "BOOL"),
    bigquery.SchemaField("raw_gemini",         "JSON"),
    bigquery.SchemaField("created_at",         "TIMESTAMP"),
    bigquery.SchemaField("detected_currency",  "STRING"),
    bigquery.SchemaField("portfolio_id",       "STRING"),
]


# ── Client factory ────────────────────────────────────────────────────────────

def _get_bq_client() -> bigquery.Client:
    """
    Build a BigQuery client using explicit Service Account credentials when
    available, falling back to Application Default Credentials (ADC) for
    Cloud Run / GCE deployments.
    """
    project_id = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")

    sa_path: Optional[str] = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not sa_path:
        # Fallback: look for cometa_key.json at the repo root
        candidate = pathlib.Path(__file__).parent.parent.parent / "cometa_key.json"
        sa_path = str(candidate) if candidate.exists() else None

    if sa_path and os.path.exists(sa_path):
        creds = service_account.Credentials.from_service_account_file(sa_path)
        return bigquery.Client(project=project_id, credentials=creds)

    print("⚠️  [BQ] No explicit credentials found — using ADC")
    return bigquery.Client(project=project_id)


def _dataset_ref() -> str:
    project_id  = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")
    dataset_id  = os.getenv("BIGQUERY_DATASET", "cometa_vault")
    return f"{project_id}.{dataset_id}"


# ── Schema bootstrap ──────────────────────────────────────────────────────────

def _ensure_submission_new_columns(client: bigquery.Client, sub_table_id: str) -> None:
    """Idempotent migration: add detected_currency + portfolio_id to submissions."""
    try:
        table    = client.get_table(sub_table_id)
        existing = {f.name for f in table.schema}
        missing  = [f for f in _SUBMISSION_NEW_FIELDS if f.name not in existing]
        if missing:
            table.schema = list(table.schema) + missing
            client.update_table(table, ["schema"])
            print(f"✅ [BQ] Submissions columns added: {[f.name for f in missing]}")
    except Exception as e:
        print(f"⚠️  [BQ] Could not add submissions columns (non-fatal): {e}")


def _ensure_audit_columns(client: bigquery.Client, kpi_table_id: str) -> None:
    """
    Idempotent migration: add the three analyst-audit columns to
    fact_kpi_values if they were created before this schema version.
    Safe to call on every startup — skips columns that already exist.
    """
    try:
        table = client.get_table(kpi_table_id)
        existing = {f.name for f in table.schema}
        missing  = [f for f in _AUDIT_FIELDS if f.name not in existing]
        if missing:
            table.schema = list(table.schema) + missing
            client.update_table(table, ["schema"])
            print(f"✅ [BQ] Audit columns added: {[f.name for f in missing]}")
    except Exception as e:
        print(f"⚠️  [BQ] Could not add audit columns (non-fatal): {e}")


def _sync_dim_company(client: bigquery.Client, table_id: str) -> None:
    """
    Sync dim_company with PORTFOLIO_MAP on every startup using WRITE_TRUNCATE.

    WRITE_TRUNCATE replaces all rows atomically — no DELETE DML permission required.
    This fixes the BigQuery 403 that occurred when the service account lacked
    bigquery.tables.delete / bigquery.tables.updateData for DML DELETE statements.

    Requires only bigquery.dataEditor role (covers create + truncate + insert).
    """
    now = datetime.now(timezone.utc).isoformat()

    rows = [
        {
            "company_key":    key,
            "company_name":   key.capitalize(),
            "portfolio_id":   info["portfolio_id"],
            "portfolio_name": info["portfolio_name"],
            "bucket_id":      COMPANY_BUCKET.get(key, "OTH"),
            "updated_at":     now,
        }
        for key, info in PORTFOLIO_MAP.items()
    ]

    try:
        job_config = bigquery.LoadJobConfig(
            schema=DIM_COMPANY_SCHEMA,
            # Truncate + replace atomically — no DELETE permission needed
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        )
        job = client.load_table_from_json(rows, table_id, job_config=job_config)
        job.result()  # block until complete
        print(f"✅ [BQ] dim_company synced via WRITE_TRUNCATE: {len(rows)} companies")
    except Exception as e:
        # Non-fatal: dim_company is a reference table; pipeline continues without it.
        print(f"⚠️  [BQ] dim_company sync failed (non-fatal): {e}")


def ensure_schema() -> None:
    """
    Create the BigQuery dataset and all tables if they don't already exist.
    Also runs column migrations for existing tables.
    Safe to call on every API startup — uses exists_ok=True semantics.
    """
    client     = _get_bq_client()
    ds_ref     = _dataset_ref()
    location   = os.getenv("VERTEX_LOCATION", "us-central1")

    # Dataset
    ds = bigquery.Dataset(ds_ref)
    ds.location = location
    client.create_dataset(ds, exists_ok=True)
    print(f"✅ [BQ] Dataset ready: {ds_ref}")

    # submissions
    sub_ref   = f"{ds_ref}.submissions"
    sub_table = bigquery.Table(sub_ref, schema=SUBMISSIONS_SCHEMA)
    client.create_table(sub_table, exists_ok=True)
    print(f"✅ [BQ] Table ready: {sub_ref}")

    # fact_kpi_values
    kpi_ref   = f"{ds_ref}.fact_kpi_values"
    kpi_table = bigquery.Table(kpi_ref, schema=FACT_KPI_SCHEMA)
    client.create_table(kpi_table, exists_ok=True)
    print(f"✅ [BQ] Table ready: {kpi_ref}")

    # dim_company
    dim_ref   = f"{ds_ref}.dim_company"
    dim_table = bigquery.Table(dim_ref, schema=DIM_COMPANY_SCHEMA)
    created   = False
    try:
        client.get_table(dim_ref)
    except Exception:
        client.create_table(dim_table)
        created = True
    print(f"✅ [BQ] Table ready: {dim_ref}")
    _sync_dim_company(client, dim_ref)  # always sync — keeps dim_company in lockstep

    # Migrate columns added after initial deployment (idempotent)
    _ensure_audit_columns(client, kpi_ref)
    _ensure_submission_new_columns(client, sub_ref)


# ── Load helper ───────────────────────────────────────────────────────────────

def _load_rows(
    client: bigquery.Client,
    table_id: str,
    rows: list[dict],
    schema: list | None = None,
) -> None:
    """
    Insert rows via load_table_from_json (batch load job).

    Why not insert_rows_json (streaming)?
    BigQuery streaming inserts buffer schema changes for several minutes after
    ALTER TABLE ADD COLUMN. load_table_from_json sees the updated schema
    immediately, so newly migrated columns are writable right away.

    schema=None  → autodetect=False, uses existing table schema (safe for
                   tables that were pre-created with a different column set).
    schema=list  → enforces exact schema, used only when creating fresh tables.

    The load job is synchronous (job.result() blocks until complete).
    """
    job_config = bigquery.LoadJobConfig(
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        ignore_unknown_values=True,   # extra keys in dict are silently dropped
    )
    if schema is not None:
        job_config.schema = schema
    else:
        job_config.autodetect = False   # use existing table schema
    job = client.load_table_from_json(rows, table_id, job_config=job_config)
    job.result()  # raises google.api_core.exceptions.GoogleAPIError on failure


# ── Main insert function ──────────────────────────────────────────────────────

def insert_contract(contract: dict) -> dict:
    """
    Persist a data contract to BigQuery.

    Implements Rule 8 — Deduplication:
      1. Query submissions WHERE file_hash = <hash>.
      2. If a row exists → skip insert, return { inserted: False, duplicate: True }.
      3. Otherwise → insert submission row + all kpi_rows.

    Parameters
    ----------
    contract : dict returned by data_contract.build_contract()

    Returns
    -------
    {
      "inserted":        bool,
      "duplicate":       bool,
      "submission_id":   str,
      "kpi_count_valid": int
    }
    """
    client     = _get_bq_client()
    ds_ref     = _dataset_ref()
    now        = datetime.now(timezone.utc).isoformat()

    submission = contract["submission"]
    kpi_rows   = contract["kpi_rows"]
    raw_gemini = contract["raw_gemini"]

    sub_table_id = f"{ds_ref}.submissions"
    kpi_table_id = f"{ds_ref}.fact_kpi_values"

    # ── Pre-insert audit ──────────────────────────────────────────────────
    audit = audit_contract(contract)
    if not audit["passed"]:
        # Log every error but only abort on critical ones (not unit warnings)
        blocking = [e for e in audit["errors"] if e["check"] != "bucket_mismatch"]
        for err in audit["errors"]:
            print(f"[Audit] ERROR  [{err['check']}] {err['kpi_key']}: {err['detail']}")
        for wrn in audit["warnings"]:
            print(f"[Audit] WARN   [{wrn['check']}] {wrn['kpi_key']}: {wrn['detail']}")
        if blocking:
            raise ValueError(
                f"[Audit] Insert aborted — {len(blocking)} blocking error(s): "
                + "; ".join(e["detail"] for e in blocking)
            )
        print(f"[Audit] Non-blocking errors detected — insert proceeds with warnings.")
    else:
        print(f"[Audit] Pre-insert audit PASSED (bucket={audit['company_bucket']})")

    # ── Rule 8: Deduplication check (by file_hash) ───────────────────────
    dedup_sql = f"""
        SELECT submission_id
        FROM   `{sub_table_id}`
        WHERE  file_hash = @file_hash
        LIMIT  1
    """
    job_cfg = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("file_hash", "STRING", submission["file_hash"])
        ]
    )
    existing = list(client.query(dedup_sql, job_config=job_cfg).result())

    if existing:
        existing_id = existing[0]["submission_id"]
        print(f"⚠️  [BQ] Dedup — file_hash already in vault: {submission['file_hash']}")
        return {
            "inserted":        False,
            "duplicate":       True,
            "submission_id":   existing_id,
            "kpi_count_valid": submission.get("kpi_count_valid", 0),
        }

    # ── Mejora B: Mark previous versions for same (company_id, period_id) ─
    # If the founder re-uploads a corrected document (different bytes → new
    # hash, same logical period), we retire the old submission so dashboards
    # and analytics always query WHERE is_latest_version = TRUE.
    # Note: BigQuery DML has ~90 min streaming buffer delay, which is fine
    # for analyst review workflows that run hours/days after upload.
    company_id_val = submission.get("company_id", "")
    period_id_val  = submission.get("period_id", "")

    if company_id_val and period_id_val:
        retire_sql = f"""
            UPDATE `{sub_table_id}`
            SET    is_latest_version = FALSE
            WHERE  company_id  = @company_id
              AND  period_id   = @period_id
              AND  (is_latest_version IS NULL OR is_latest_version = TRUE)
        """
        retire_cfg = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("company_id", "STRING", company_id_val),
                bigquery.ScalarQueryParameter("period_id",  "STRING", period_id_val),
            ]
        )
        try:
            client.query(retire_sql, job_config=retire_cfg).result()
            print(
                f"📦 [BQ] Previous submissions for "
                f"{company_id_val}/{period_id_val} marked is_latest_version=FALSE"
            )
        except Exception as retire_err:
            # Non-fatal: old version flag failure doesn't block the new insert
            print(f"⚠️  [BQ] Could not retire previous versions (non-fatal): {retire_err}")

    # ── Insert submission ─────────────────────────────────────────────────
    # Ensure portfolio_id is set — fallback to lookup if build_contract
    # was called without it (e.g. legacy clients).
    portfolio_id = submission.get("portfolio_id") or lookup_portfolio(
        submission.get("company_id", "")
    )
    sub_row = {
        **submission,
        "portfolio_id":      portfolio_id,
        "is_latest_version": True,
        "raw_gemini":        json.dumps(raw_gemini, ensure_ascii=False),
        "created_at":        now,
    }

    # Use load_table_from_json instead of insert_rows_json so that newly
    # migrated columns are available immediately (streaming insert buffers
    # schema changes for several minutes after ALTER TABLE ADD COLUMN).
    _load_rows(client, sub_table_id, [sub_row], SUBMISSIONS_SCHEMA)
    print(f"✅ [BQ] Submission inserted: {submission['submission_id']}")

    # ── Insert kpi_rows ───────────────────────────────────────────────────
    if kpi_rows:
        kpi_payload = [
            {**row, "id": str(uuid.uuid4()), "created_at": now}
            for row in kpi_rows
        ]
        try:
            _load_rows(client, kpi_table_id, kpi_payload)   # schema=None → uses table's existing schema
            print(
                f"✅ [BQ] KPIs inserted: "
                f"{submission['kpi_count_valid']}/{submission['kpi_count_total']} valid"
            )
        except Exception as kpi_err:
            # Submission is already committed; log but don't abort the response.
            print(f"⚠️  [BQ] fact_kpi_values insert error (submission intact): {kpi_err}")

    return {
        "inserted":        True,
        "duplicate":       False,
        "submission_id":   submission["submission_id"],
        "kpi_count_valid": submission["kpi_count_valid"],
    }


# ── Analyst edit function ─────────────────────────────────────────────────────

def update_kpi_value(
    submission_id: str,
    kpi_key: str,
    new_raw_value: str,
) -> dict:
    """
    Overwrite a single KPI row in fact_kpi_values with a manually corrected
    value, preserving a full audit trail.

    Steps
    -----
    1. Verify the row exists; fetch current raw_value for the audit field.
    2. Run parse_numeric on the new value (Rule 4 — numeric integrity).
    3. DML UPDATE the row, setting:
         raw_value          ← new value
         numeric_value      ← parsed float (or NULL if non-numeric)
         unit               ← detected unit
         is_valid           ← True if parse_numeric succeeded
         is_manually_edited ← TRUE
         edited_at          ← CURRENT_TIMESTAMP()
         edited_raw_value   ← original value (pre-edit snapshot)

    Notes
    -----
    BigQuery DML cannot modify rows that are still in the streaming buffer
    (~90 min after insert).  For an MVP workflow where analysts review
    documents hours/days after upload this is not a practical constraint.

    Raises
    ------
    ValueError  — row not found (wrong submission_id / kpi_key).
    RuntimeError — BigQuery DML job returned errors.
    """
    client       = _get_bq_client()
    ds_ref       = _dataset_ref()
    kpi_table_id = f"{ds_ref}.fact_kpi_values"

    # ── 1. Verify row exists & capture current value for audit ────────────
    check_sql = f"""
        SELECT id, raw_value
        FROM   `{kpi_table_id}`
        WHERE  submission_id = @submission_id
          AND  kpi_key       = @kpi_key
        LIMIT  1
    """
    check_cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("submission_id", "STRING", submission_id),
        bigquery.ScalarQueryParameter("kpi_key",       "STRING", kpi_key),
    ])
    rows = list(client.query(check_sql, job_config=check_cfg).result())

    if not rows:
        raise ValueError(
            f"KPI row not found — submission_id={submission_id}, kpi_key={kpi_key}"
        )

    original_raw: Optional[str] = rows[0]["raw_value"]

    # ── 2. Parse the new value (Rule 4) ───────────────────────────────────
    raw_to_parse  = new_raw_value.strip() if new_raw_value else None
    numeric_value, unit = parse_numeric(raw_to_parse)
    is_valid      = numeric_value is not None

    if not is_valid:
        print(
            f"⚠️  [BQ] update_kpi_value — '{new_raw_value}' is not numeric; "
            "stored with is_valid=False"
        )

    # ── 3. DML UPDATE ─────────────────────────────────────────────────────
    # numeric_value may be NULL — BigQuery accepts None for nullable FLOAT64
    # parameters via the Python client.
    update_sql = f"""
        UPDATE `{kpi_table_id}`
        SET
            raw_value          = @new_raw,
            numeric_value      = @numeric_value,
            unit               = @unit,
            is_valid           = @is_valid,
            is_manually_edited = TRUE,
            edited_at          = CURRENT_TIMESTAMP(),
            edited_raw_value   = @original_raw
        WHERE submission_id = @submission_id
          AND kpi_key       = @kpi_key
    """
    update_cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("new_raw",       "STRING",  new_raw_value),
        bigquery.ScalarQueryParameter("numeric_value", "FLOAT64", numeric_value),
        bigquery.ScalarQueryParameter("unit",          "STRING",  unit),
        bigquery.ScalarQueryParameter("is_valid",      "BOOL",    is_valid),
        bigquery.ScalarQueryParameter("original_raw",  "STRING",  original_raw),
        bigquery.ScalarQueryParameter("submission_id", "STRING",  submission_id),
        bigquery.ScalarQueryParameter("kpi_key",       "STRING",  kpi_key),
    ])

    job = client.query(update_sql, job_config=update_cfg)
    job.result()  # block until complete

    if job.errors:
        raise RuntimeError(f"[BQ] KPI update DML errors: {job.errors}")

    print(
        f"✅ [BQ] KPI edited — submission:{submission_id} | kpi:{kpi_key} | "
        f"'{original_raw}' → '{new_raw_value}' | valid={is_valid}"
    )

    return {
        "submission_id":      submission_id,
        "kpi_key":            kpi_key,
        "raw_value":          new_raw_value,
        "numeric_value":      numeric_value,
        "unit":               unit,
        "is_valid":           is_valid,
        "is_manually_edited": True,
        "original_raw_value": original_raw,
    }


# ── Portfolio analytics query ─────────────────────────────────────────────────

def query_portfolio_analytics(portfolio_id: str) -> dict:
    """
    Aggregate fact_kpi_values + submissions by month and company for one portfolio.

    Returns
    -------
    {
      "series": [
        {
          "month": "2025-03",           # FORMAT_TIMESTAMP('%Y-%m', submitted_at)
          "company_id": "simetrik",
          "portfolio_id": "CIII",
          "submission_count": 2,
          "revenue_growth": 36.0,       # AVG of valid rows; None when absent
          "gross_profit_margin": 68.0,
          "ebitda_margin": -12.0,
          "cash_in_bank_end_of_year": 9700000.0,
          "annual_cash_flow": -3200000.0,
          "working_capital_debt": 1100000.0
        },
        ...
      ],
      "summary": {
        "total_submissions": 7,
        "companies_count": 3,
        "companies": ["simetrik", "guros", ...],
        "date_range": {"min": "2025-01", "max": "2025-03"}
      }
    }

    Notes
    -----
    - Only rows with is_valid = TRUE are included.
    - AVG per KPI per (month, company) — if a company filed twice in the same month,
      the values are averaged rather than doubled.
    - None values (missing KPI for that company/month) are preserved as null in JSON.
    """
    client = _get_bq_client()
    ds     = _dataset_ref()

    sql = f"""
        SELECT
          FORMAT_TIMESTAMP('%Y-%m', s.submitted_at)                                   AS month,
          s.company_id,
          s.portfolio_id,
          COUNT(DISTINCT s.submission_id)                                             AS submission_count,
          AVG(CASE WHEN k.kpi_key = 'revenue_growth'            THEN k.numeric_value END) AS revenue_growth,
          AVG(CASE WHEN k.kpi_key = 'gross_profit_margin'       THEN k.numeric_value END) AS gross_profit_margin,
          AVG(CASE WHEN k.kpi_key = 'ebitda_margin'             THEN k.numeric_value END) AS ebitda_margin,
          AVG(CASE WHEN k.kpi_key = 'cash_in_bank_end_of_year'  THEN k.numeric_value END) AS cash_in_bank_end_of_year,
          AVG(CASE WHEN k.kpi_key = 'annual_cash_flow'          THEN k.numeric_value END) AS annual_cash_flow,
          AVG(CASE WHEN k.kpi_key = 'working_capital_debt'      THEN k.numeric_value END) AS working_capital_debt
        FROM   `{ds}.submissions`     s
        JOIN   `{ds}.fact_kpi_values` k  USING (submission_id)
        WHERE  k.is_valid     = TRUE
          AND  s.portfolio_id = @portfolio_id
        GROUP  BY 1, 2, 3
        ORDER  BY 1 ASC, 2 ASC
    """

    job_cfg = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("portfolio_id", "STRING", portfolio_id)
        ]
    )

    print(f"📊 [BQ] Ejecutando analytics query para portfolio={portfolio_id}...")
    rows = list(client.query(sql, job_config=job_cfg).result())
    print(f"   Filas retornadas: {len(rows)}")

    series = [
        {
            "month":                    row.month,
            "company_id":               row.company_id,
            "portfolio_id":             row.portfolio_id,
            "submission_count":         row.submission_count,
            "revenue_growth":           row.revenue_growth,
            "gross_profit_margin":      row.gross_profit_margin,
            "ebitda_margin":            row.ebitda_margin,
            "cash_in_bank_end_of_year": row.cash_in_bank_end_of_year,
            "annual_cash_flow":         row.annual_cash_flow,
            "working_capital_debt":     row.working_capital_debt,
        }
        for row in rows
    ]

    companies = sorted({r["company_id"] for r in series if r.get("company_id")})
    months    = [r["month"] for r in series if r.get("month")]

    return {
        "series": series,
        "summary": {
            "total_submissions": sum(r["submission_count"] for r in series),
            "companies_count":   len(companies),
            "companies":         companies,
            "date_range": {
                "min": min(months) if months else None,
                "max": max(months) if months else None,
            },
        },
    }


# ── Audit engine ──────────────────────────────────────────────────────────────

def audit_contract(contract: dict) -> dict:
    """
    Pre-insert audit that validates the data contract in Python before any
    BigQuery write. Mirrors the SQL audit logic but runs locally — zero
    latency, no BQ cost, works even when BQ is offline.

    Checks
    ------
    1. Duplicates     — unique constraint on (company_id, kpi_key, period_id).
    2. Orphans        — every kpi_row must reference the contract's submission_id.
    3. Bucket mismatch — kpi_key must be valid for the company's vertical
                        (bucket_id="ALL" metrics pass for every company).
    4. Unit warning   — numeric value's unit must match DIM_METRIC.unit_expected.
    5. Period format  — period_id must match FY<YYYY>, H[12] <YYYY>,
                        Q[1-4] <YYYY>, or <YYYY>M<MM>.

    Returns
    -------
    {
      "passed": bool,
      "errors":   [ {"check": str, "kpi_key": str, "detail": str} ],
      "warnings": [ {"check": str, "kpi_key": str, "detail": str} ],
    }
    """
    import re

    submission = contract["submission"]
    kpi_rows   = contract["kpi_rows"]
    sub_id     = submission["submission_id"]
    company_id = submission.get("company_id", "unknown")
    period_id  = submission.get("period_id", "")

    # Resolve company bucket (strip domain suffixes, lowercase)
    company_key = company_id.lower().replace(".", "").replace("-", "").replace("_", "")
    matched_bucket = "UNKNOWN"
    for name, bucket in COMPANY_BUCKET.items():
        if name in company_key:
            matched_bucket = bucket
            break

    PERIOD_PATTERN = re.compile(
        r"^(FY\d{4}|H[12]\s?\d{4}|Q[1-4]\s?\d{4}|\d{4}M\d{2})$",
        re.IGNORECASE,
    )

    errors:   list[dict] = []
    warnings: list[dict] = []

    # ── Check 5: Period format ─────────────────────────────────────────────
    if not PERIOD_PATTERN.match(period_id.strip()):
        errors.append({
            "check":   "period_format",
            "kpi_key": "*",
            "detail":  (
                f"period_id '{period_id}' does not match expected formats "
                "(FY2025, H1 2025, Q4 2025, 2025M01)."
            ),
        })

    # ── Checks 1, 2, 3, 4 per kpi_row ─────────────────────────────────────
    seen_keys: set[str] = set()

    for row in kpi_rows:
        kpi_key = row.get("kpi_key", "?")

        # Check 2: Orphan — submission_id must match
        if row.get("submission_id") != sub_id:
            errors.append({
                "check":   "orphan",
                "kpi_key": kpi_key,
                "detail":  (
                    f"kpi_row.submission_id '{row.get('submission_id')}' "
                    f"does not match contract submission_id '{sub_id}'."
                ),
            })

        # Check 1: Duplicate within this contract
        logical_key = f"{kpi_key}|{period_id}"
        if logical_key in seen_keys:
            errors.append({
                "check":   "duplicate",
                "kpi_key": kpi_key,
                "detail":  (
                    f"Duplicate row detected for (kpi_key='{kpi_key}', "
                    f"period_id='{period_id}'). Only one row per metric per period allowed."
                ),
            })
        seen_keys.add(logical_key)

        # Check 3: Bucket mismatch
        metric_def = DIM_METRIC.get(kpi_key)
        if metric_def is None:
            errors.append({
                "check":   "unknown_metric",
                "kpi_key": kpi_key,
                "detail":  (
                    f"Metric '{kpi_key}' is not registered in DIM_METRIC. "
                    "It will be discarded (not persisted)."
                ),
            })
        else:
            metric_bucket = metric_def["bucket_id"]
            if (
                metric_bucket != "ALL"
                and matched_bucket != "UNKNOWN"
                and metric_bucket != matched_bucket
            ):
                # Alucinación de vertical: Gemini extrajo una métrica de otro sector.
                # Solo escala a ERROR si la confianza es extremadamente alta (>0.95),
                # lo que indicaría que el documento realmente menciona esa métrica como
                # KPI de negocio propio.  En caso contrario se silencia como DEBUG para
                # no contaminar los logs con falsos positivos sectoriales.
                kpi_confidence = row.get("confidence")
                is_high_confidence = (
                    kpi_confidence is not None and float(kpi_confidence) > 0.95
                )
                mismatch_detail = (
                    f"Metric '{kpi_key}' belongs to bucket '{metric_bucket}' "
                    f"but company '{company_id}' is classified as '{matched_bucket}'. "
                    f"(confidence={kpi_confidence})"
                )
                if is_high_confidence:
                    # Alta confianza + bucket incorrecto → posible error de datos real
                    errors.append({
                        "check":   "bucket_mismatch",
                        "kpi_key": kpi_key,
                        "detail":  mismatch_detail,
                    })
                else:
                    # Baja/media confianza → alucinación de vertical, solo DEBUG
                    print(f"[Audit] DEBUG  [bucket_mismatch] {kpi_key}: {mismatch_detail}")

            # Check 4: Unit warning
            unit_expected = metric_def["unit_expected"]
            unit_actual   = row.get("unit") or ""
            # Flexible match: "$M", "$K", "$B" all satisfy expected "$"
            unit_base = unit_actual.replace("M", "").replace("K", "").replace("B", "")
            if unit_expected and unit_base and unit_expected not in unit_base and unit_base not in unit_expected:
                warnings.append({
                    "check":   "unit_mismatch",
                    "kpi_key": kpi_key,
                    "detail":  (
                        f"Expected unit '{unit_expected}' for '{kpi_key}', "
                        f"got '{unit_actual}'."
                    ),
                })

    passed = len(errors) == 0
    return {
        "passed":   passed,
        "errors":   errors,
        "warnings": warnings,
        "company_bucket": matched_bucket,
    }


def run_audit_query(portfolio_id: Optional[str] = None) -> dict:
    """
    Runs the BigQuery post-insert audit SQL across fact_kpi_values.
    Returns rows flagged as ERROR or WARNING with their audit_status.

    This is the SQL-layer counterpart to audit_contract() (Python pre-insert).
    Run it manually or on a schedule to catch any data that slipped through.

    Parameters
    ----------
    portfolio_id : optional filter — "VII" or "CIII". If None, audits all funds.

    Returns
    -------
    {
      "total_rows":    int,
      "errors":        int,
      "warnings":      int,
      "flagged_rows":  [ { ...row fields + audit_status } ]
    }
    """
    client = _get_bq_client()
    ds     = _dataset_ref()

    portfolio_filter = (
        "AND s.portfolio_id = @portfolio_id" if portfolio_id else ""
    )

    sql = f"""
        WITH ranked AS (
            SELECT
                f.id,
                f.submission_id,
                f.kpi_key,
                f.period_id,
                s.company_id,
                s.portfolio_id,
                f.unit,
                f.numeric_value,
                f.confidence,
                f.is_valid,
                f.is_manually_edited,
                s.is_latest_version,
                COUNT(*) OVER(
                    PARTITION BY f.submission_id, s.company_id, f.kpi_key, f.period_id
                ) AS dup_count
            FROM `{ds}.fact_kpi_values` f
            JOIN `{ds}.submissions`     s USING (submission_id)
            WHERE s.is_latest_version = TRUE
              {portfolio_filter}
        )
        SELECT
            *,
            CASE
                WHEN dup_count > 1
                    THEN 'ERROR: Duplicado'
                WHEN NOT is_valid
                    THEN 'ERROR: Valor no numérico'
                WHEN confidence IS NOT NULL AND confidence < 0.70
                    THEN 'ERROR: Confianza crítica (<0.70)'
                WHEN confidence IS NOT NULL AND confidence < 0.85
                    THEN 'ADVERTENCIA: Confianza baja (<0.85)'
                ELSE 'PASS'
            END AS audit_status
        FROM ranked
        WHERE
            dup_count > 1
            OR NOT is_valid
            OR (confidence IS NOT NULL AND confidence < 0.85)
        ORDER BY audit_status DESC, company_id, kpi_key
    """

    params = []
    if portfolio_id:
        params.append(bigquery.ScalarQueryParameter("portfolio_id", "STRING", portfolio_id))

    job_cfg = bigquery.QueryJobConfig(query_parameters=params)

    print(f"[Audit] Ejecutando audit query — portfolio={portfolio_id or 'ALL'}...")
    rows = list(client.query(sql, job_config=job_cfg).result())

    flagged = [dict(row) for row in rows]
    errors   = sum(1 for r in flagged if r["audit_status"].startswith("ERROR"))
    warnings = sum(1 for r in flagged if r["audit_status"].startswith("ADVERTENCIA"))

    print(f"[Audit] Resultado: {errors} errores, {warnings} advertencias ({len(flagged)} filas totales)")

    return {
        "total_rows":   len(flagged),
        "errors":       errors,
        "warnings":     warnings,
        "flagged_rows": flagged,
    }


# ── Fidelity Audit (Senior Data Auditor report) ───────────────────────────────

def run_fidelity_audit(submission_id: str) -> dict:
    """
    Full fidelity audit report for a specific submission.

    Covers three audit domains:
    ─────────────────────────────────────────────────────
    1. identity_check
       • Verifies company_id exists in dim_company (30 official records).
       • Validates bucket_id matches the canonical COMPANY_BUCKET registry.

    2. calculator_audit
       • Labels each KPI as "gemini" (extracted by Gemini) or "calculated"
         (derived by Python derivation engine).
       • Re-computes gross_profit_margin and ebitda_margin from raw base
         metrics stored in fact_kpi_values, then compares to the stored value.
       • Flags discrepancies > 0.5 percentage points as WARN; > 2pp as ERROR.
       • If a margin was extracted by Gemini AND also re-calculable, compares
         both to detect founder reporting vs actual discrepancy.

    3. checklist_diagnosis
       • Cross-references valid KPI keys against SECTOR_REQUIREMENTS for the
         company's bucket.  Returns complete / incomplete + missing list.

    Parameters
    ----------
    submission_id : UUID string of the target submission.

    Returns
    -------
    {
      "submission_id": str,
      "audited_at":    str  (ISO-8601),
      "overall_status": "PASS" | "WARN" | "FAIL",
      "identity_check": {
        "company_id":           str,
        "in_dim_company":       bool,
        "bucket_expected":      str,   # from COMPANY_BUCKET Python registry
        "bucket_in_db":         str,   # from dim_company BigQuery table
        "bucket_match":         bool,
        "portfolio_id":         str,
        "is_latest_version":    bool,
        "period_id":            str,
        "status":               str,   # processed | pending_human_review | empty
        "avg_confidence":       float | null,
        "findings":             [str]
      },
      "calculator_audit": {
        "kpi_rows": [
          {
            "kpi_key":          str,
            "origin":           "gemini" | "calculated",
            "raw_value":        str,
            "numeric_value":    float | null,
            "confidence":       float | null,
            "recalculated_value": float | null,   # only for derivable KPIs
            "delta_pct_points": float | null,
            "calc_status":      "OK" | "WARN" | "ERROR" | "N/A"
          }
        ],
        "discrepancies":  int,
        "findings":       [str]
      },
      "checklist_diagnosis": {
        "bucket":               str,
        "required_kpis":        [str],
        "present_valid_kpis":   [str],
        "missing_kpis":         [str],
        "is_complete":          bool,
        "display_message":      str,
        "findings":             [str]
      },
      "summary": {
        "total_findings":  int,
        "errors":          int,
        "warnings":        int,
      }
    }
    """
    from src.core.data_contract import SECTOR_REQUIREMENTS

    client = _get_bq_client()
    ds     = _dataset_ref()
    now    = datetime.now(timezone.utc).isoformat()

    findings_error: list[str] = []
    findings_warn:  list[str] = []

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 1 — Fetch submission metadata
    # ═══════════════════════════════════════════════════════════════════════
    sub_sql = f"""
        SELECT
            company_id,
            period_id,
            status,
            avg_confidence,
            is_latest_version,
            portfolio_id
        FROM `{ds}.submissions`
        WHERE submission_id = @sid
        LIMIT 1
    """
    sub_rows = list(client.query(
        sub_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("sid", "STRING", submission_id)
        ])
    ).result())

    if not sub_rows:
        raise ValueError(f"submission_id '{submission_id}' not found in BigQuery.")

    sub = sub_rows[0]
    company_id    = sub["company_id"] or "unknown"
    period_id     = sub["period_id"]  or ""
    sub_status    = sub["status"]     or "unknown"
    avg_conf      = sub["avg_confidence"]
    is_latest     = sub["is_latest_version"]
    portfolio_id  = sub["portfolio_id"] or ""

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 2 — Identity check against dim_company
    # ═══════════════════════════════════════════════════════════════════════
    dim_sql = f"""
        SELECT company_key, bucket_id, portfolio_id
        FROM   `{ds}.dim_company`
        WHERE  company_key = @company_key
        LIMIT  1
    """
    # OBS-05: use smart normalization — preserves key roots like "m1" from "m1-insurtech"
    company_key = _normalize_company_key(company_id)

    dim_rows = list(client.query(
        dim_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("company_key", "STRING", company_key)
        ])
    ).result())

    in_dim_company = bool(dim_rows)
    bucket_in_db   = dim_rows[0]["bucket_id"] if dim_rows else None

    # Python registry is always authoritative
    bucket_expected = COMPANY_BUCKET.get(company_key, "UNKNOWN")
    bucket_match    = (bucket_in_db == bucket_expected) if bucket_in_db else False

    identity_findings: list[str] = []
    if not in_dim_company:
        msg = f"ERROR: company_id '{company_id}' (key='{company_key}') no encontrado en dim_company. No pertenece al portafolio oficial de 30 companias."
        identity_findings.append(msg)
        findings_error.append(msg)
    if bucket_in_db and not bucket_match:
        msg = f"ERROR: Bucket mismatch — dim_company tiene '{bucket_in_db}' pero COMPANY_BUCKET registra '{bucket_expected}' para '{company_key}'. Sincronizar dim_company."
        identity_findings.append(msg)
        findings_error.append(msg)
    if not is_latest:
        msg = f"WARN: Esta submission no es la version mas reciente (is_latest_version=FALSE). Los KPIs puede que hayan sido reemplazados por un re-upload posterior."
        identity_findings.append(msg)
        findings_warn.append(msg)
    if sub_status == "pending_human_review":
        msg = f"WARN: Submission marcada como pending_human_review (avg_confidence={avg_conf})."
        identity_findings.append(msg)
        findings_warn.append(msg)
    if not identity_findings:
        identity_findings.append("OK: Identidad verificada — empresa en portafolio oficial con bucket correcto.")

    identity_check = {
        "company_id":        company_id,
        "company_key":       company_key,
        "in_dim_company":    in_dim_company,
        "bucket_expected":   bucket_expected,
        "bucket_in_db":      bucket_in_db,
        "bucket_match":      bucket_match,
        "portfolio_id":      portfolio_id,
        "is_latest_version": is_latest,
        "period_id":         period_id,
        "status":            sub_status,
        "avg_confidence":    float(avg_conf) if avg_conf is not None else None,
        "findings":          identity_findings,
    }

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 3 — Fetch all KPI rows for this submission
    # ═══════════════════════════════════════════════════════════════════════
    kpi_sql = f"""
        SELECT
            kpi_key,
            kpi_label,
            raw_value,
            numeric_value,
            unit,
            confidence,
            source_description,
            is_valid
        FROM `{ds}.fact_kpi_values`
        WHERE submission_id = @sid
        ORDER BY kpi_key
    """
    kpi_bq_rows = list(client.query(
        kpi_sql,
        job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("sid", "STRING", submission_id)
        ])
    ).result())

    # Build indexed maps for math re-verification
    kpi_map: dict[str, dict] = {}
    for r in kpi_bq_rows:
        kpi_map[r["kpi_key"]] = {
            "raw_value":         r["raw_value"],
            "numeric_value":     float(r["numeric_value"]) if r["numeric_value"] is not None else None,
            "unit":              r["unit"],
            "confidence":        float(r["confidence"]) if r["confidence"] is not None else None,
            "source_description":r["source_description"] or "",
            "is_valid":          r["is_valid"],
        }

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 4 — Calculator audit
    # ═══════════════════════════════════════════════════════════════════════
    DERIVABLE = {
        "gross_profit_margin": {
            "formula": "(revenue - cogs) / revenue",
            "deps":    ["revenue", "cogs"],
        },
        "ebitda_margin": {
            "formula": "ebitda / revenue",
            "deps":    ["revenue", "ebitda"],
        },
    }

    calc_kpi_rows: list[dict] = []
    calc_discrepancies = 0
    calc_findings: list[str] = []

    for r in kpi_bq_rows:
        kpi_key    = r["kpi_key"]
        origin     = "calculated" if "calculated" in (r["source_description"] or "") else "gemini"
        stored_val = kpi_map[kpi_key]["numeric_value"]

        recalculated = None
        delta        = None
        calc_status  = "N/A"

        if kpi_key in DERIVABLE:
            rule      = DERIVABLE[kpi_key]
            deps      = rule["deps"]
            dep_vals  = {d: kpi_map.get(d, {}).get("numeric_value") for d in deps}
            all_deps  = all(v is not None for v in dep_vals.values())

            if all_deps:
                rev = dep_vals.get("revenue", 0.0)
                if rev and rev != 0.0:
                    if kpi_key == "gross_profit_margin":
                        recalculated = (rev - dep_vals["cogs"]) / rev
                    elif kpi_key == "ebitda_margin":
                        recalculated = dep_vals["ebitda"] / rev

                    if stored_val is not None and recalculated is not None:
                        # Both in ratio form (e.g. 0.68). Delta in percentage points.
                        delta = abs(stored_val - recalculated) * 100
                        if delta > 2.0:
                            calc_status = "ERROR"
                            msg = (
                                f"ERROR [{kpi_key}]: Discrepancia alta de {delta:.2f}pp — "
                                f"almacenado={stored_val:.4f} vs recalculado={recalculated:.4f} "
                                f"({rule['formula']}). Posible error de reporte del founder."
                            )
                            calc_findings.append(msg)
                            findings_error.append(msg)
                            calc_discrepancies += 1
                        elif delta > 0.5:
                            calc_status = "WARN"
                            msg = (
                                f"WARN [{kpi_key}]: Discrepancia menor de {delta:.2f}pp — "
                                f"almacenado={stored_val:.4f} vs recalculado={recalculated:.4f}. "
                                "Revisar escala o redondeo."
                            )
                            calc_findings.append(msg)
                            findings_warn.append(msg)
                            calc_discrepancies += 1
                        else:
                            calc_status = "OK"
                    elif recalculated is not None and stored_val is None:
                        calc_status = "WARN"
                        msg = f"WARN [{kpi_key}]: Valor no almacenado pero recalculable = {recalculated:.4f}. El extractor Gemini no lo encontro en el PDF."
                        calc_findings.append(msg)
                        findings_warn.append(msg)
            else:
                missing_deps = [d for d, v in dep_vals.items() if v is None]
                calc_status = "N/A"
                if origin == "gemini" and stored_val is not None:
                    calc_status = "OK"  # Gemini found it directly, deps missing but value present

        elif origin == "calculated":
            # Non-derivable metric marked as "calculated" — data integrity issue
            calc_status = "WARN"
            msg = f"WARN [{kpi_key}]: source='calculated' pero no es un KPI derivable conocido. Revisar derivation engine."
            calc_findings.append(msg)
            findings_warn.append(msg)
        elif r["is_valid"]:
            calc_status = "OK"
        else:
            calc_status = "WARN"

        calc_kpi_rows.append({
            "kpi_key":            kpi_key,
            "origin":             origin,
            "raw_value":          r["raw_value"],
            "numeric_value":      stored_val,
            "unit":               r["unit"],
            "confidence":         kpi_map[kpi_key]["confidence"],
            "is_valid":           r["is_valid"],
            "recalculated_value": round(recalculated, 6) if recalculated is not None else None,
            "delta_pct_points":   round(delta, 4) if delta is not None else None,
            "calc_status":        calc_status,
        })

    if not calc_findings:
        calc_findings.append("OK: Todos los KPIs derivables verificados matematicamente sin discrepancias.")

    calculator_audit = {
        "kpi_rows":       calc_kpi_rows,
        "discrepancies":  calc_discrepancies,
        "findings":       calc_findings,
    }

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 5 — Checklist diagnosis
    # ═══════════════════════════════════════════════════════════════════════
    effective_bucket = bucket_in_db or bucket_expected
    required_kpis    = SECTOR_REQUIREMENTS.get(effective_bucket, [])

    present_valid = [
        k for k, v in kpi_map.items()
        if v.get("is_valid") and v.get("numeric_value") is not None
    ]
    missing_kpis  = [k for k in required_kpis if k not in present_valid]
    is_complete   = len(missing_kpis) == 0

    sector_labels = {
        "SAAS": "SaaS", "LEND": "Lending", "ECOM": "E-Commerce",
        "INSUR": "Insurance", "OTH": "General",
    }
    bucket_label = sector_labels.get(effective_bucket, effective_bucket)

    if not required_kpis:
        check_display = f"Sector '{effective_bucket}' sin checklist definido en SECTOR_REQUIREMENTS."
        checklist_findings = [f"WARN: {check_display}"]
        findings_warn.append(checklist_findings[0])
    elif is_complete:
        check_display = f"Reporte {bucket_label} COMPLETO — todos los KPIs criticos presentes: {', '.join(required_kpis)}."
        checklist_findings = [f"OK: {check_display}"]
    else:
        missing_str   = ", ".join(missing_kpis)
        check_display = f"Reporte {bucket_label} INCOMPLETO — faltan: {missing_str}."
        checklist_findings = [f"WARN: {check_display}"]
        msg = f"WARN [checklist]: {check_display}"
        findings_warn.append(msg)

    checklist_diagnosis = {
        "bucket":             effective_bucket,
        "required_kpis":      required_kpis,
        "present_valid_kpis": sorted(present_valid),
        "missing_kpis":       missing_kpis,
        "is_complete":        is_complete,
        "display_message":    check_display,
        "findings":           checklist_findings,
    }

    # ═══════════════════════════════════════════════════════════════════════
    # PASO 6 — Overall verdict
    # ═══════════════════════════════════════════════════════════════════════
    total_errors   = len(findings_error)
    total_warnings = len(findings_warn)

    if total_errors > 0:
        overall = "FAIL"
    elif total_warnings > 0:
        overall = "WARN"
    else:
        overall = "PASS"

    print(
        f"[FidelityAudit] {submission_id} → {overall} "
        f"({total_errors} errores, {total_warnings} advertencias)"
    )

    return {
        "submission_id":       submission_id,
        "audited_at":          now,
        "overall_status":      overall,
        "identity_check":      identity_check,
        "calculator_audit":    calculator_audit,
        "checklist_diagnosis": checklist_diagnosis,
        "summary": {
            "total_findings": total_errors + total_warnings,
            "errors":         total_errors,
            "warnings":       total_warnings,
        },
    }
