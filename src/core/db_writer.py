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

import hashlib
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
    "gaia":        "SAAS",   # Fondo VII — insurtech/sustainability
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
    "morgana":     "INSUR",
    "duppla":      "LEND",
    "kala":        "OTH",
    "pulsar":      "SAAS",
    "solvento":    "LEND",
    "numia":       "SAAS",
}

# ── Portfolio registry ────────────────────────────────────────────────────────
# Single source of truth for startup → fund assignment.
# Key: lowercase company name (no dots/dashes). Value: portfolio metadata.

PORTFOLIO_MAP: dict[str, dict] = {
    # ── Fondo VII — overview (fund-level KPIs, not a startup) ─────────────────
    "fund_vii_overview": {
        "portfolio_id":   "VII",
        "portfolio_name": "Fondo VII",
        "display_name":   "Fondo VII — Overview",
        "entity_type":    "FUND_OVERVIEW",
    },
    # ── Fondo VII (9 compañías) ────────────────────────────────────────────────
    "conekta":     {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "kueski":      {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "mpower":      {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "bnext":       {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "yotepresto":  {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "ivoy":        {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "bewe":        {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "skydropx":    {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},
    "gaia":        {"portfolio_id": "VII",  "portfolio_name": "Fondo VII"},  # COMP_GAIA
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
    "morgana":     {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "duppla":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "kala":        {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "pulsar":      {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "solvento":    {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
    "numia":       {"portfolio_id": "CIII", "portfolio_name": "Fondo CIII"},
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

UPLOAD_LOGS_SCHEMA = [
    # ── Recibo digital — audit trail de cada finalize ─────────────────────
    bigquery.SchemaField("log_id",        "STRING",    mode="REQUIRED"),  # uuid4
    bigquery.SchemaField("company_id",    "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("founder_email", "STRING",    mode="REQUIRED"),
    bigquery.SchemaField("vault_seal",    "STRING",    mode="REQUIRED"),  # SHA-256 hex
    bigquery.SchemaField("file_hashes",  "STRING"),    # JSON array
    bigquery.SchemaField("file_count",   "INTEGER"),
    bigquery.SchemaField("manual_kpis",  "STRING"),    # JSON dict (optional)
    bigquery.SchemaField("finalized_at", "TIMESTAMP",  mode="REQUIRED"),
    bigquery.SchemaField("period_id",    "STRING"),    # e.g. "2024" or "P2025Q4"
]

AI_AUDIT_LOGS_SCHEMA = [
    # ── Consultas al motor de IA — trail de quién preguntó qué y sobre quién ──
    bigquery.SchemaField("audit_id",        "STRING",   mode="REQUIRED"),  # uuid4
    bigquery.SchemaField("user_id",         "STRING",   mode="REQUIRED"),  # ANA-/FND- hybrid ID
    bigquery.SchemaField("user_name",       "STRING"),                     # display name del JWT
    bigquery.SchemaField("user_role",       "STRING"),                     # ANALISTA|FOUNDER|SOCIO
    bigquery.SchemaField("company_id",      "STRING"),                     # empresa consultada
    bigquery.SchemaField("portfolio_id",    "STRING"),                     # fondo (opcional)
    bigquery.SchemaField("endpoint",        "STRING"),                     # /api/chat | /api/chat/stream
    bigquery.SchemaField("question_hash",   "STRING"),                     # SHA-256 — nunca texto plano
    bigquery.SchemaField("question_len",    "INTEGER"),                    # longitud de la pregunta
    bigquery.SchemaField("context_rows",    "INTEGER"),                    # filas de BQ en el contexto
    bigquery.SchemaField("has_legacy_data", "BOOL"),                       # ¿algún KPI sin verificar?
    bigquery.SchemaField("vault_seal_ref",  "STRING"),                     # último vault seal del company
    bigquery.SchemaField("queried_at",      "TIMESTAMP", mode="REQUIRED"),
]

DIM_KPI_METADATA_SCHEMA = [
    # ── Master KPI dictionary — seed + update via WRITE_TRUNCATE ──────────────
    bigquery.SchemaField("kpi_key",             "STRING",  mode="REQUIRED"),  # 'mrr', 'cac'
    bigquery.SchemaField("display_name",        "STRING",  mode="REQUIRED"),  # 'Monthly Recurring Revenue'
    bigquery.SchemaField("vertical",            "STRING",  mode="REQUIRED"),  # 'GENERAL'|'SAAS'|'FINTECH'|'MARKETPLACE'|'INSURTECH'
    bigquery.SchemaField("description",         "STRING"),                    # AI-facing explanation
    bigquery.SchemaField("unit",                "STRING"),                    # 'USD'|'Percentage'|'Number'|'Ratio'
    bigquery.SchemaField("min_historical_year", "INTEGER"),                   # year data started being tracked formally
    bigquery.SchemaField("is_required",         "BOOL"),                      # mandatory for the vertical
    bigquery.SchemaField("example_value",       "STRING"),                    # UI hint, e.g. "$120K"
    bigquery.SchemaField("updated_at",          "TIMESTAMP"),
]

# ── KPI seed data — single source of truth for the entire catalogue ────────────
# vertical values align with UploadFlow.tsx Vertical type:
#   GENERAL   = applies to every company regardless of model (was "ALL" in DIM_METRIC)
#   SAAS      = SaaS / subscription software
#   FINTECH   = Lending, neobanking, payments
#   MARKETPLACE = eCommerce, logistics platforms
#   INSURTECH = Insurance technology
_KPI_METADATA_SEED: list[dict] = [
    # ── Core / GENERAL ────────────────────────────────────────────────────────
    {
        "kpi_key": "revenue", "display_name": "Total Revenue",
        "vertical": "GENERAL", "unit": "USD", "is_required": True,
        "example_value": "$2.4M", "min_historical_year": 2020,
        "description": (
            "Ingresos totales reconocidos en el período. Métrica fundamental para evaluar tamaño "
            "y trayectoria de crecimiento. Incluye todas las fuentes de ingresos reconocidos "
            "según principios contables aplicables. Analizar junto al revenue_growth para "
            "determinar momentum del negocio."
        ),
    },
    {
        "kpi_key": "revenue_growth", "display_name": "Revenue Growth YoY",
        "vertical": "GENERAL", "unit": "Percentage", "is_required": True,
        "example_value": "45%", "min_historical_year": 2020,
        "description": (
            "Tasa de crecimiento porcentual de ingresos año sobre año. Indicador crítico de "
            "momentum. Valores >100% YoY son señal de hipercrecimiento en etapas tempranas. "
            "Comparar con benchmarks del sector: SaaS B2B líder ~80-120%, marketplace ~50-80%."
        ),
    },
    {
        "kpi_key": "gross_profit_margin", "display_name": "Gross Profit Margin",
        "vertical": "GENERAL", "unit": "Percentage", "is_required": True,
        "example_value": "68%", "min_historical_year": 2020,
        "description": (
            "Ingresos menos COGS como porcentaje de ingresos. Refleja eficiencia del modelo de "
            "negocio. Referencia: SaaS B2B >70%, marketplace 30-60%, lending varía por modelo. "
            "Mejora sostenida del margen bruto indica economías de escala."
        ),
    },
    {
        "kpi_key": "ebitda", "display_name": "EBITDA",
        "vertical": "GENERAL", "unit": "USD", "is_required": False,
        "example_value": "-$800K", "min_historical_year": 2020,
        "description": (
            "Beneficio operativo antes de intereses, impuestos, depreciación y amortización en "
            "términos absolutos (USD). Junto con ebitda_margin permite comparar empresas de "
            "distintos tamaños en el portafolio."
        ),
    },
    {
        "kpi_key": "ebitda_margin", "display_name": "EBITDA Margin",
        "vertical": "GENERAL", "unit": "Percentage", "is_required": True,
        "example_value": "-12%", "min_historical_year": 2020,
        "description": (
            "EBITDA como porcentaje de ingresos. Proxy de rentabilidad operativa. EBITDA "
            "negativo es esperable en startups pre-rentabilidad; la tendencia de mejora "
            "interanual es el indicador clave. Path to profitability: cuántos años hasta EBITDA=0."
        ),
    },
    {
        "kpi_key": "cogs", "display_name": "Cost of Goods Sold",
        "vertical": "GENERAL", "unit": "USD", "is_required": False,
        "example_value": "$780K", "min_historical_year": 2020,
        "description": (
            "Costos directos de producción o entrega del servicio. En SaaS incluye hosting y "
            "soporte; en marketplace incluye logística o comisiones de transacción. Fundamental "
            "para calcular el margen bruto real."
        ),
    },
    {
        "kpi_key": "cash_in_bank_end_of_year", "display_name": "Cash in Bank (EoY)",
        "vertical": "GENERAL", "unit": "USD", "is_required": True,
        "example_value": "$1.2M", "min_historical_year": 2020,
        "description": (
            "Efectivo disponible al cierre del año fiscal. Combinar con burn rate mensual para "
            "estimar runway restante. Runway < 12 meses es señal crítica de alerta. "
            "Indicador primario de salud de tesorería en due diligence."
        ),
    },
    {
        "kpi_key": "annual_cash_flow", "display_name": "Annual Cash Flow",
        "vertical": "GENERAL", "unit": "USD", "is_required": False,
        "example_value": "-$400K", "min_historical_year": 2020,
        "description": (
            "Flujo de caja neto generado o consumido en el año (operaciones + inversión + "
            "financiación). Negativo es normal en fases de inversión agresiva. La tendencia "
            "de mejora interanual (reducción del burn) es más relevante que el valor puntual."
        ),
    },
    {
        "kpi_key": "working_capital_debt", "display_name": "Working Capital Debt",
        "vertical": "GENERAL", "unit": "USD", "is_required": False,
        "example_value": "$300K", "min_historical_year": 2020,
        "description": (
            "Deuda de capital de trabajo: líneas de crédito operativas y deuda a corto plazo. "
            "Evalúa la estructura de financiación de operaciones diarias y el riesgo de "
            "liquidez. Alto ratio deuda-ingresos puede indicar dependencia de financiación externa."
        ),
    },
    {
        "kpi_key": "cac", "display_name": "Customer Acquisition Cost",
        "vertical": "GENERAL", "unit": "USD", "is_required": False,
        "example_value": "$380", "min_historical_year": 2021,
        "description": (
            "Costo promedio para adquirir un cliente nuevo (marketing + ventas / nuevos clientes). "
            "Analizar siempre junto al LTV: CAC/LTV < 0.33 es el ratio objetivo para SaaS "
            "saludable. CAC en ascenso sostenido indica saturación del canal de adquisición."
        ),
    },
    # ── SaaS ──────────────────────────────────────────────────────────────────
    {
        "kpi_key": "mrr", "display_name": "Monthly Recurring Revenue",
        "vertical": "SAAS", "unit": "USD", "is_required": True,
        "example_value": "$120K", "min_historical_year": 2021,
        "description": (
            "Ingresos recurrentes mensuales predecibles de contratos activos. Métrica central "
            "de SaaS: ARR = MRR × 12. Descomponer en New MRR, Expansion MRR y Churned MRR "
            "para entender el motor de crecimiento. Target de Cometa: MRR con crecimiento "
            "MoM consistente >5% en etapa de tracción."
        ),
    },
    {
        "kpi_key": "churn_rate", "display_name": "Churn Rate",
        "vertical": "SAAS", "unit": "Percentage", "is_required": True,
        "example_value": "2.5%", "min_historical_year": 2021,
        "description": (
            "Porcentaje de clientes o MRR perdidos en el período. Referencia: churn mensual "
            "<2% es excelente para SaaS B2B, <5% para B2C. Alto churn erosiona el ARR y "
            "eleva el CAC efectivo al forzar reemplazo constante de clientes perdidos. "
            "Correlación inversa con NPS y calidad de onboarding."
        ),
    },
    {
        "kpi_key": "ltv", "display_name": "Customer Lifetime Value",
        "vertical": "SAAS", "unit": "USD", "is_required": False,
        "example_value": "$4,500", "min_historical_year": 2022,
        "description": (
            "Valor total esperado de un cliente durante toda su relación con la empresa. "
            "LTV = ARPU / Churn Rate (mensual). NOTA: Esta es una métrica de implementación "
            "reciente en Cometa Vault (desde 2022). Si no aparece en datos históricos pre-2022, "
            "no es una falla de datos sino una expansión del diccionario de métricas."
        ),
    },
    # ── Fintech / Lending ──────────────────────────────────────────────────────
    {
        "kpi_key": "portfolio_size", "display_name": "Loan Portfolio Size",
        "vertical": "FINTECH", "unit": "USD", "is_required": True,
        "example_value": "$8.5M", "min_historical_year": 2020,
        "description": (
            "Cartera de créditos activa (saldo total de préstamos vigentes en el período). "
            "Indicador del escale del negocio de lending. Analizar junto al NPL ratio para "
            "evaluar calidad de cartera. Crecimiento de cartera sin deterioro del NPL "
            "indica underwriting sólido."
        ),
    },
    {
        "kpi_key": "npl_ratio", "display_name": "Non-Performing Loan Ratio",
        "vertical": "FINTECH", "unit": "Percentage", "is_required": True,
        "example_value": "3.2%", "min_historical_year": 2020,
        "description": (
            "Porcentaje de la cartera con pagos vencidos >90 días. Referencia: NPL <5% es "
            "aceptable en lending digital; >10% es señal de alerta sobre underwriting o "
            "gestión de cobranza. Métrica regulatoria crítica. Aumentos bruscos del NPL "
            "anticipan deterioro del P&L en 2-3 trimestres."
        ),
    },
    {
        "kpi_key": "tpv", "display_name": "Total Payment Volume",
        "vertical": "FINTECH", "unit": "USD", "is_required": False,
        "example_value": "$42M", "min_historical_year": 2021,
        "description": (
            "Volumen total de pagos o transacciones procesados en el período. Para fintechs de "
            "pagos, el TPV es el indicador de escala equivalente al GMV en marketplaces. "
            "NOTA: Métrica incorporada al diccionario de Cometa en 2021 para fintechs de pagos."
        ),
    },
    {
        "kpi_key": "take_rate", "display_name": "Take Rate",
        "vertical": "FINTECH", "unit": "Percentage", "is_required": False,
        "example_value": "1.8%", "min_historical_year": 2021,
        "description": (
            "Porcentaje del volumen de transacciones que se retiene como revenue (comisión). "
            "Aplica a fintechs de pagos (sobre TPV) y marketplaces (sobre GMV). "
            "El take rate refleja el poder de negociación y el valor añadido de la plataforma."
        ),
    },
    # ── Marketplace / eCommerce ───────────────────────────────────────────────
    {
        "kpi_key": "gmv", "display_name": "Gross Merchandise Value",
        "vertical": "MARKETPLACE", "unit": "USD", "is_required": True,
        "example_value": "$5.1M", "min_historical_year": 2020,
        "description": (
            "Valor total de transacciones procesadas por la plataforma antes de descuentos y "
            "devoluciones. Métrica de volumen, no de revenue real. Revenue = GMV × Take Rate. "
            "Crecimiento de GMV sin crecimiento equivalente de revenue indica compresión del "
            "take rate (señal de competencia o subsidio de transacciones)."
        ),
    },
    # ── Insurtech ─────────────────────────────────────────────────────────────
    {
        "kpi_key": "loss_ratio", "display_name": "Loss Ratio",
        "vertical": "INSURTECH", "unit": "Percentage", "is_required": True,
        "example_value": "58%", "min_historical_year": 2022,
        "description": (
            "Proporción de primas recaudadas pagadas como siniestros. Referencia: <60% es "
            "excelente, 60-80% es operacionalmente sostenible, >100% implica pérdidas técnicas. "
            "Métrica central del underwriting de riesgo. NOTA: Incorporada al diccionario de "
            "Cometa en 2022 con la expansión al sector insurtech del portafolio."
        ),
    },
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


def _sync_dim_kpi_metadata(client: bigquery.Client, table_id: str) -> None:
    """
    Seed dim_kpi_metadata from _KPI_METADATA_SEED via WRITE_TRUNCATE.

    WRITE_TRUNCATE replaces all rows atomically so adding a new KPI to
    _KPI_METADATA_SEED and restarting the server is the only operation
    needed to make it available to the API, the UploadFlow, and Gemini.

    Requires only bigquery.dataEditor (same as _sync_dim_company).
    """
    now = datetime.now(timezone.utc).isoformat()
    rows = [{**row, "updated_at": now} for row in _KPI_METADATA_SEED]
    try:
        job_config = bigquery.LoadJobConfig(
            schema=DIM_KPI_METADATA_SCHEMA,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        )
        job = client.load_table_from_json(rows, table_id, job_config=job_config)
        job.result()
        print(f"✅ [BQ] dim_kpi_metadata seeded: {len(rows)} KPIs via WRITE_TRUNCATE")
    except Exception as e:
        print(f"⚠️  [BQ] dim_kpi_metadata seed failed (non-fatal): {e}")


def _create_v_data_coverage_view(client: bigquery.Client, ds_ref: str) -> None:
    """
    Create (or replace) the v_data_coverage BigQuery view.

    The view crosses dim_company × dim_kpi_metadata × fact_kpi_values to produce
    a coverage heat-map:  which companies are filling their mandatory KPIs and
    which ones have gaps.

    Vertical mapping (dim_kpi_metadata.vertical → dim_company.bucket_id):
      GENERAL   → always included (applies to all)
      SAAS      → bucket_id = 'SAAS'
      FINTECH   → bucket_id IN ('LEND', 'FINTECH')
      MARKETPLACE → bucket_id IN ('ECOM', 'MARKETPLACE')
      INSURTECH → bucket_id IN ('INSUR', 'INSURTECH')
    """
    view_id = f"{ds_ref}.v_data_coverage"
    sql = f"""
        SELECT
            c.company_key,
            c.portfolio_id,
            m.kpi_key,
            m.display_name          AS kpi_display_name,
            m.vertical              AS kpi_vertical,
            m.unit                  AS kpi_unit,
            m.is_required,
            COUNT(f.id)             AS submissions_count,
            MAX(s.submitted_at)     AS last_submitted_at,
            MIN(s.period_id)        AS earliest_period,
            MAX(s.period_id)        AS latest_period,
            COUNTIF(COALESCE(f.is_manually_edited, FALSE))  AS verified_count,
            CASE
                WHEN COUNT(f.id) = 0                                          THEN 'missing'
                WHEN COUNTIF(COALESCE(f.is_manually_edited, FALSE)) > 0       THEN 'verified'
                ELSE 'legacy'
            END                     AS coverage_status
        FROM `{ds_ref}.dim_company` c
        CROSS JOIN `{ds_ref}.dim_kpi_metadata` m
        LEFT JOIN `{ds_ref}.submissions` s
            ON LOWER(s.company_id) LIKE CONCAT('%', c.company_key, '%')
        LEFT JOIN `{ds_ref}.fact_kpi_values` f
            ON  f.submission_id = s.submission_id
            AND f.kpi_key       = m.kpi_key
            AND f.is_valid      = TRUE
        WHERE
            m.vertical = 'GENERAL'
            OR (m.vertical = 'SAAS'        AND c.bucket_id = 'SAAS')
            OR (m.vertical = 'FINTECH'     AND c.bucket_id IN ('LEND', 'FINTECH'))
            OR (m.vertical = 'MARKETPLACE' AND c.bucket_id IN ('ECOM', 'MARKETPLACE'))
            OR (m.vertical = 'INSURTECH'   AND c.bucket_id IN ('INSUR', 'INSURTECH'))
        GROUP BY
            c.company_key, c.portfolio_id,
            m.kpi_key, m.display_name, m.vertical, m.unit, m.is_required
        ORDER BY
            c.company_key, m.vertical, m.kpi_key
    """
    try:
        view = bigquery.Table(view_id)
        view.view_query = sql
        # CREATE OR REPLACE: delete first if exists, then recreate
        try:
            client.delete_table(view_id)
        except Exception:
            pass
        client.create_table(view)
        print(f"✅ [BQ] View ready: {view_id}")
    except Exception as e:
        print(f"⚠️  [BQ] v_data_coverage view creation failed (non-fatal): {e}")


def query_kpi_metadata(vertical: str | None = None) -> list[dict]:
    """
    Fetch KPI metadata from dim_kpi_metadata.

    Args:
        vertical: One of 'SAAS', 'FINTECH', 'MARKETPLACE', 'INSURTECH', or None.
                  When provided, returns GENERAL KPIs plus vertical-specific ones.
                  When None, returns the full catalogue.

    Returns:
        List of dicts with keys: kpi_key, display_name, vertical, description,
        unit, min_historical_year, is_required, example_value.
    """
    ds = _dataset_ref()
    try:
        client = _get_bq_client()
        if vertical:
            sql = f"""
                SELECT kpi_key, display_name, vertical, description,
                       unit, min_historical_year, is_required, example_value
                FROM `{ds}.dim_kpi_metadata`
                WHERE vertical = 'GENERAL' OR vertical = @vertical
                ORDER BY is_required DESC, vertical, kpi_key
            """
            from google.cloud import bigquery as _bq
            job = client.query(
                sql,
                job_config=_bq.QueryJobConfig(
                    query_parameters=[
                        _bq.ScalarQueryParameter("vertical", "STRING", vertical.upper()),
                    ]
                ),
            )
        else:
            sql = f"""
                SELECT kpi_key, display_name, vertical, description,
                       unit, min_historical_year, is_required, example_value
                FROM `{ds}.dim_kpi_metadata`
                ORDER BY vertical, is_required DESC, kpi_key
            """
            job = client.query(sql)

        return [dict(r) for r in job.result()]
    except Exception as e:
        print(f"⚠️  [BQ] query_kpi_metadata failed, falling back to seed: {e}")
        # Graceful fallback: serve seed data in-process so startup errors don't break the UploadFlow
        if vertical:
            v_upper = vertical.upper()
            return [
                {k: v for k, v in row.items() if k != "updated_at"}
                for row in _KPI_METADATA_SEED
                if row["vertical"] in ("GENERAL", v_upper)
            ]
        return [
            {k: v for k, v in row.items() if k != "updated_at"}
            for row in _KPI_METADATA_SEED
        ]


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

    # upload_logs — audit receipts for finalized expedientes
    logs_ref   = f"{ds_ref}.upload_logs"
    logs_table = bigquery.Table(logs_ref, schema=UPLOAD_LOGS_SCHEMA)
    client.create_table(logs_table, exists_ok=True)
    print(f"✅ [BQ] Table ready: {logs_ref}")

    # ai_audit_logs — trail de cada consulta al motor de IA
    ai_audit_ref   = f"{ds_ref}.ai_audit_logs"
    ai_audit_table = bigquery.Table(ai_audit_ref, schema=AI_AUDIT_LOGS_SCHEMA)
    client.create_table(ai_audit_table, exists_ok=True)
    print(f"✅ [BQ] Table ready: {ai_audit_ref}")

    # dim_kpi_metadata — master KPI dictionary (seed via WRITE_TRUNCATE)
    meta_ref   = f"{ds_ref}.dim_kpi_metadata"
    meta_table = bigquery.Table(meta_ref, schema=DIM_KPI_METADATA_SCHEMA)
    client.create_table(meta_table, exists_ok=True)
    print(f"✅ [BQ] Table ready: {meta_ref}")
    _sync_dim_kpi_metadata(client, meta_ref)

    # v_data_coverage — cross-company KPI coverage heat map (view)
    _create_v_data_coverage_view(client, ds_ref)


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
            {**row, "id": str(uuid.uuid4()), "created_at": now, "last_upload_at": now}
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

    # ── 2. Parse the new value (Rule 4) ───────────────────────────────────
    raw_to_parse  = new_raw_value.strip() if new_raw_value else None
    numeric_value, unit = parse_numeric(raw_to_parse)
    is_valid      = numeric_value is not None

    if not is_valid:
        print(
            f"⚠️  [BQ] update_kpi_value — '{new_raw_value}' is not numeric; "
            "stored with is_valid=False"
        )

    if not rows:
        # ── 3a. INSERT — row does not exist yet (analyst adding a new KPI) ─
        import uuid as _uuid
        new_id = str(_uuid.uuid4())
        insert_sql = f"""
            INSERT INTO `{kpi_table_id}`
                (id, submission_id, kpi_key, raw_value, numeric_value, unit,
                 is_valid, is_manually_edited, edited_at, created_at,
                 source_description)
            VALUES
                (@id, @submission_id, @kpi_key, @new_raw, @numeric_value, @unit,
                 @is_valid, TRUE, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(),
                 'analyst_manual')
        """
        insert_cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("id",            "STRING",  new_id),
            bigquery.ScalarQueryParameter("submission_id", "STRING",  submission_id),
            bigquery.ScalarQueryParameter("kpi_key",       "STRING",  kpi_key),
            bigquery.ScalarQueryParameter("new_raw",       "STRING",  new_raw_value),
            bigquery.ScalarQueryParameter("numeric_value", "FLOAT64", numeric_value),
            bigquery.ScalarQueryParameter("unit",          "STRING",  unit),
            bigquery.ScalarQueryParameter("is_valid",      "BOOL",    is_valid),
        ])
        job = client.query(insert_sql, job_config=insert_cfg)
        job.result()
        if job.errors:
            raise RuntimeError(f"[BQ] KPI insert DML errors: {job.errors}")

        print(
            f"✅ [BQ] KPI inserted (new) — submission:{submission_id} | "
            f"kpi:{kpi_key} | '{new_raw_value}' | valid={is_valid}"
        )
        return {
            "submission_id":      submission_id,
            "kpi_key":            kpi_key,
            "raw_value":          new_raw_value,
            "numeric_value":      numeric_value,
            "unit":               unit,
            "is_valid":           is_valid,
            "is_manually_edited": True,
            "original_raw_value": None,
        }

    original_raw: Optional[str] = rows[0]["raw_value"]

    # ── 3b. DML UPDATE — row exists, overwrite with audit trail ───────────
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


# ── Upload log — recibo digital del expediente finalizado ─────────────────────

def insert_upload_log(
    company_id:    str,
    founder_email: str,
    vault_seal:    str,
    file_hashes:   list[str],
    manual_kpis:   dict[str, str] | None = None,
    period_id:     str = "",
) -> str:
    """
    Insert an audit receipt into upload_logs after a founder finalizes.

    Parameters
    ----------
    company_id    : Lowercase company slug or domain.
    founder_email : Authenticated founder's email from JWT.
    vault_seal    : 64-char SHA-256 hex from hash_service.generate_vault_seal().
    file_hashes   : List of file SHA-256 prefixes included in this expediente.
    manual_kpis   : Optional dict of manually entered KPI key → value pairs.
    period_id     : Optional period label (e.g. "2024", "P2025Q4").

    Returns
    -------
    str — The generated log_id (UUID4).

    Notes
    -----
    Never raises — failures are logged and silently swallowed so the Founder
    UX is never interrupted by an audit write error.
    """
    log_id = str(uuid.uuid4())
    now    = datetime.now(timezone.utc)
    row    = {
        "log_id":        log_id,
        "company_id":    company_id.lower().strip(),
        "founder_email": founder_email.lower().strip(),
        "vault_seal":    vault_seal,
        "file_hashes":   json.dumps(sorted(file_hashes)),
        "file_count":    len(file_hashes),
        "manual_kpis":   json.dumps(manual_kpis) if manual_kpis else None,
        "finalized_at":  now.isoformat(),
        "period_id":     period_id or now.strftime("%Y"),
    }
    try:
        client   = _get_bq_client()
        ds_ref   = _dataset_ref()
        table_id = f"{ds_ref}.upload_logs"
        _load_rows(client, table_id, [row], UPLOAD_LOGS_SCHEMA)
        print(f"✅ [BQ/upload_logs] Recibo guardado: {log_id} | {company_id}")
    except Exception as err:
        print(f"⚠️  [BQ/upload_logs] Insert failed (non-fatal): {err}")
    return log_id


# ── AI Audit Log — trail de cada consulta al motor de IA ─────────────────────

def insert_ai_audit_log(
    user_id:         str,
    user_name:       str,
    user_role:       str,
    question:        str,
    context_rows:    int,
    has_legacy_data: bool,
    endpoint:        str,
    company_id:      str       = "",
    portfolio_id:    str       = "",
    vault_seal_ref:  str       = "",
) -> str:
    """
    Insert one row into ai_audit_logs after every AI chat query.

    The raw question is NEVER stored — only its SHA-256 hash and length.
    This satisfies data minimisation requirements while preserving audit
    value (same question = same hash lets analysts detect repeated queries).

    Parameters
    ----------
    user_id         : Hybrid ID from JWT (ANA-XXXXXX / FND-XXXXXX).
    user_name       : Display name from JWT `name` claim.
    user_role       : Role from JWT (ANALISTA | FOUNDER | SOCIO).
    question        : Raw question — hashed here, never persisted as text.
    context_rows    : Number of BQ rows included in the Gemini context.
    has_legacy_data : True when any context row lacks manual verification.
    endpoint        : "/api/chat" or "/api/chat/stream".
    company_id      : Company slug queried (empty for portfolio-wide queries).
    portfolio_id    : Portfolio filter applied (empty if none).
    vault_seal_ref  : Latest vault seal for this company (from upload_logs).

    Returns
    -------
    str — Generated audit_id (UUID4). Empty string on failure (non-fatal).
    """
    audit_id     = str(uuid.uuid4())
    question_hash = hashlib.sha256(question.encode("utf-8")).hexdigest()
    row = {
        "audit_id":        audit_id,
        "user_id":         user_id or "unknown",
        "user_name":       user_name or "",
        "user_role":       user_role or "",
        "company_id":      company_id or "",
        "portfolio_id":    portfolio_id or "",
        "endpoint":        endpoint,
        "question_hash":   question_hash,
        "question_len":    len(question),
        "context_rows":    context_rows,
        "has_legacy_data": has_legacy_data,
        "vault_seal_ref":  vault_seal_ref or "",
        "queried_at":      datetime.now(timezone.utc).isoformat(),
    }
    try:
        client   = _get_bq_client()
        ds_ref   = _dataset_ref()
        table_id = f"{ds_ref}.ai_audit_logs"
        _load_rows(client, table_id, [row], AI_AUDIT_LOGS_SCHEMA)
        print(
            f"🔍 [BQ/ai_audit] {user_id} consultó '{company_id or portfolio_id}' "
            f"({context_rows} rows, legacy={has_legacy_data})"
        )
    except Exception as err:
        print(f"⚠️  [BQ/ai_audit] Insert failed (non-fatal): {err}")
        return ""
    return audit_id


# ── Coverage heatmap query ────────────────────────────────────────────────────

def query_coverage(portfolio_id: Optional[str] = None) -> dict:
    """
    Returns per-company × per-period KPI coverage matrix for the heatmap.

    Queries the last 8 quarters of submissions (is_latest_version = TRUE) and
    groups KPI counts by (company_id, period_id).

    Parameters
    ----------
    portfolio_id : str | None
        When provided, restricts results to submissions belonging to that fund.

    Returns
    -------
    {
        "companies": [{"key": str, "display": str, "portfolio_id": str}],
        "periods":   [str],          # canonical PYYYYQxMyy, sorted chronologically
        "cells":     [
            {
                "company":        str,
                "period":         str,
                "status":         "verified" | "legacy" | "missing",
                "kpi_count":      int,
                "verified_count": int,
                "legacy_count":   int,
            }
        ]
    }
    """
    client = _get_bq_client()
    ds     = _dataset_ref()

    portfolio_filter = (
        "AND LOWER(s.portfolio_id) = LOWER(@portfolio_id)"
        if portfolio_id else ""
    )

    sql = f"""
        SELECT
            LOWER(s.company_id)                                                    AS company,
            -- Use period_id when available; fall back to the upload year so
            -- submissions without an extracted period still appear in the heatmap.
            COALESCE(
                NULLIF(TRIM(s.period_id), ''),
                CONCAT('P', FORMAT_TIMESTAMP('%Y', s.submitted_at))
            )                                                                       AS period,
            COUNT(DISTINCT f.kpi_key)                                               AS kpi_count,
            COUNTIF(COALESCE(f.is_manually_edited, FALSE) AND f.is_valid = TRUE)    AS verified_count,
            COUNTIF(
                NOT COALESCE(f.is_manually_edited, FALSE) AND f.is_valid = TRUE
            )                                                                        AS legacy_count
        FROM `{ds}.submissions` s
        JOIN `{ds}.fact_kpi_values` f
            ON  f.submission_id = s.submission_id
            AND f.is_valid = TRUE
        WHERE
            COALESCE(s.is_latest_version, TRUE) = TRUE
            {portfolio_filter}
        GROUP BY 1, 2
        ORDER BY 1, 2
    """

    job_cfg = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("portfolio_id", "STRING", portfolio_id or ""),
    ]) if portfolio_id else None

    try:
        rows = list(client.query(sql, job_config=job_cfg).result())
    except Exception:
        return {"companies": [], "periods": [], "cells": []}

    companies_seen: dict[str, str] = {}   # key → portfolio_id
    periods_seen:   set[str]       = set()
    cells: list[dict] = []

    for row in rows:
        company   = (row.company or "unknown").strip()
        period    = (row.period  or "").strip()
        if not period or not company:
            continue

        if company not in companies_seen:
            companies_seen[company] = lookup_portfolio(company)
        periods_seen.add(period)

        verified  = int(row.verified_count or 0)
        legacy    = int(row.legacy_count   or 0)
        kpi_count = int(row.kpi_count      or 0)
        status    = (
            "verified" if verified > 0 else
            "legacy"   if legacy   > 0 else
            "missing"
        )

        cells.append({
            "company":        company,
            "period":         period,
            "status":         status,
            "kpi_count":      kpi_count,
            "verified_count": verified,
            "legacy_count":   legacy,
        })

    # PYYYYQxMyy sorts correctly as a plain string
    sorted_periods   = sorted(periods_seen)
    def _display(key: str) -> str:
        """'acme.com' → 'acme' · 'my-startup.io' → 'my-startup'"""
        name = key.split(".")[0] if "." in key else key
        return name.replace("-", " ").replace("_", " ").title()

    sorted_companies = [
        {"key": k, "display": _display(k), "portfolio_id": v}
        for k, v in sorted(companies_seen.items())
    ]

    return {
        "companies": sorted_companies,
        "periods":   sorted_periods,
        "cells":     cells,
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
