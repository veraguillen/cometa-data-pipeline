"""
metric_catalog.py
─────────────────
Canonical metric registry for the Cometa Pipeline.

Responsibilities:
  1. Assign a stable K-ID (K001…K016) to every known KPI — single source of truth.
  2. Expose a synonym dictionary that maps free-text metric names (from Excel
     headers, PDFs, Gemini output) to their canonical kpi_key.
  3. Provide canonical_metric_map(raw_name) — the public entry point for any
     component that needs to resolve an arbitrary string to a canonical metric.

Design rules:
  - K-IDs are permanent; once assigned they never change.
  - kpi_key values are snake_case and must match KPI_REGISTRY in data_contract.py
    and DIM_METRIC in db_writer.py (those remain the domain-logic sources of truth;
    this module only adds the ID layer and the synonym index).
  - Synonyms are case-insensitive, accent-insensitive, and whitespace-collapsed.
  - Unknown metrics return K_UNKNOWN and flag the row for manual review.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Final


# ═══════════════════════════════════════════════════════════════════════════════
# CATÁLOGO CANÓNICO
# ═══════════════════════════════════════════════════════════════════════════════
# Cada entrada define:
#   metric_id   — ID permanente (nunca cambia)
#   kpi_key     — snake_case, debe coincidir con KPI_REGISTRY / DIM_METRIC
#   label       — nombre oficial para mostrar en UI / BigQuery
#   unit_type   — "pct" | "usd"   (hereda de DIM_METRIC)
#   bucket_id   — vertical al que aplica ("ALL" | "SAAS" | "LEND" | "ECOM" | "INSUR")

METRIC_CATALOG: Final[list[dict]] = [
    # ── Core financials (todos los verticales) ─────────────────────────────────
    {
        "metric_id": "K001",
        "kpi_key":   "revenue",
        "label":     "Total Revenue",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K002",
        "kpi_key":   "revenue_growth",
        "label":     "Revenue Growth",
        "unit_type": "pct",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K003",
        "kpi_key":   "gross_profit_margin",
        "label":     "Gross Profit Margin",
        "unit_type": "pct",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K004",
        "kpi_key":   "ebitda",
        "label":     "EBITDA",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K005",
        "kpi_key":   "ebitda_margin",
        "label":     "EBITDA Margin",
        "unit_type": "pct",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K006",
        "kpi_key":   "cogs",
        "label":     "Cost of Goods Sold",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K007",
        "kpi_key":   "cash_in_bank_end_of_year",
        "label":     "Cash in Bank",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K008",
        "kpi_key":   "annual_cash_flow",
        "label":     "Annual Cash Flow",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    {
        "metric_id": "K009",
        "kpi_key":   "working_capital_debt",
        "label":     "Working Capital Debt",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    # ── SaaS ───────────────────────────────────────────────────────────────────
    {
        "metric_id": "K010",
        "kpi_key":   "mrr",
        "label":     "Monthly Recurring Revenue",
        "unit_type": "usd",
        "bucket_id": "SAAS",
    },
    {
        "metric_id": "K011",
        "kpi_key":   "churn_rate",
        "label":     "Churn Rate",
        "unit_type": "pct",
        "bucket_id": "SAAS",
    },
    {
        "metric_id": "K012",
        "kpi_key":   "cac",
        "label":     "Customer Acquisition Cost",
        "unit_type": "usd",
        "bucket_id": "ALL",
    },
    # ── Lending ────────────────────────────────────────────────────────────────
    {
        "metric_id": "K013",
        "kpi_key":   "portfolio_size",
        "label":     "Loan Portfolio Size",
        "unit_type": "usd",
        "bucket_id": "LEND",
    },
    {
        "metric_id": "K014",
        "kpi_key":   "npl_ratio",
        "label":     "Non-Performing Loan Ratio",
        "unit_type": "pct",
        "bucket_id": "LEND",
    },
    # ── eCommerce ──────────────────────────────────────────────────────────────
    {
        "metric_id": "K015",
        "kpi_key":   "gmv",
        "label":     "Gross Merchandise Value",
        "unit_type": "usd",
        "bucket_id": "ECOM",
    },
    # ── Insurance ──────────────────────────────────────────────────────────────
    {
        "metric_id": "K016",
        "kpi_key":   "loss_ratio",
        "label":     "Loss Ratio",
        "unit_type": "pct",
        "bucket_id": "INSUR",
    },
]


# ═══════════════════════════════════════════════════════════════════════════════
# DICCIONARIO DE SINÓNIMOS
# ═══════════════════════════════════════════════════════════════════════════════
# Clave  → kpi_key canónico.
# Las variantes cubren: inglés, español, abreviaturas, encabezados de Excel LatAm,
# formatos de exportación de ERP (SAP, Aspel, Contpaq), y salidas frecuentes de Gemini.
# La normalización (acentos, mayúsculas, espacios) se aplica antes de buscar aquí.

_SYNONYM_CATALOG: Final[dict[str, str]] = {

    # ── K001 · Total Revenue ───────────────────────────────────────────────────
    "revenue":                          "revenue",
    "total revenue":                    "revenue",
    "net revenue":                      "revenue",
    "total sales":                      "revenue",
    "sales":                            "revenue",
    "ventas":                           "revenue",
    "ventas totales":                   "revenue",
    "ventas netas":                     "revenue",
    "ingresos":                         "revenue",
    "ingresos totales":                 "revenue",
    "ingresos netos":                   "revenue",
    "facturacion":                      "revenue",
    "facturacion total":                "revenue",
    "facturacion neta":                 "revenue",
    "top line":                         "revenue",
    "gross revenue":                    "revenue",
    "revenues":                         "revenue",
    "total de ventas":                  "revenue",
    "total ingresos":                   "revenue",

    # ── K002 · Revenue Growth ─────────────────────────────────────────────────
    "revenue growth":                   "revenue_growth",
    "revenue growth rate":              "revenue_growth",
    "sales growth":                     "revenue_growth",
    "growth":                           "revenue_growth",
    "growth rate":                      "revenue_growth",
    "crecimiento":                      "revenue_growth",
    "crecimiento de ingresos":          "revenue_growth",
    "crecimiento de ventas":            "revenue_growth",
    "crecimiento de revenue":           "revenue_growth",
    "crecimiento anual":                "revenue_growth",
    "tasa de crecimiento":              "revenue_growth",
    "variacion de ingresos":            "revenue_growth",
    "variacion de ventas":              "revenue_growth",
    "yoy revenue":                      "revenue_growth",
    "yoy growth":                       "revenue_growth",
    "year over year growth":            "revenue_growth",

    # ── K003 · Gross Profit Margin ────────────────────────────────────────────
    "gross profit margin":              "gross_profit_margin",
    "gross margin":                     "gross_profit_margin",
    "gpm":                              "gross_profit_margin",
    "margen bruto":                     "gross_profit_margin",
    "margen de contribucion":           "gross_profit_margin",
    "margen de ganancia bruta":         "gross_profit_margin",
    "margen bruto de utilidad":         "gross_profit_margin",
    "utilidad bruta":                   "gross_profit_margin",
    "gross profit":                     "gross_profit_margin",
    "margen contribucion":              "gross_profit_margin",

    # ── K004 · EBITDA ─────────────────────────────────────────────────────────
    "ebitda":                           "ebitda",
    "earnings before interest taxes depreciation amortization": "ebitda",
    "earnings before interest and taxes": "ebitda",
    "utilidad operativa":               "ebitda",
    "utilidad antes de intereses e impuestos": "ebitda",
    "uafida":                           "ebitda",
    "resultado operativo":              "ebitda",
    "operating income":                 "ebitda",
    "ebit":                             "ebitda",   # aproximacion aceptable sin D&A
    "beneficio operativo":              "ebitda",

    # ── K005 · EBITDA Margin ──────────────────────────────────────────────────
    "ebitda margin":                    "ebitda_margin",
    "ebitda margin %":                  "ebitda_margin",
    "margen ebitda":                    "ebitda_margin",
    "margen operativo":                 "ebitda_margin",
    "margen de ebitda":                 "ebitda_margin",
    "operating margin":                 "ebitda_margin",
    "margen uafida":                    "ebitda_margin",
    "operating profit margin":          "ebitda_margin",

    # ── K006 · Cost of Goods Sold ─────────────────────────────────────────────
    "cogs":                             "cogs",
    "cost of goods sold":               "cogs",
    "cost of revenue":                  "cogs",
    "cost of sales":                    "cogs",
    "costo de ventas":                  "cogs",
    "costo de mercancia vendida":       "cogs",
    "costo de bienes vendidos":         "cogs",
    "costos variables":                 "cogs",
    "direct costs":                     "cogs",
    "costos directos":                  "cogs",
    "costo de produccion":              "cogs",
    "costo mercaderia vendida":         "cogs",

    # ── K007 · Cash in Bank ───────────────────────────────────────────────────
    "cash in bank":                     "cash_in_bank_end_of_year",
    "cash in bank end of year":         "cash_in_bank_end_of_year",
    "cash and cash equivalents":        "cash_in_bank_end_of_year",
    "cash":                             "cash_in_bank_end_of_year",
    "efectivo":                         "cash_in_bank_end_of_year",
    "caja":                             "cash_in_bank_end_of_year",
    "efectivo y equivalentes":          "cash_in_bank_end_of_year",
    "caja y bancos":                    "cash_in_bank_end_of_year",
    "saldo bancario":                   "cash_in_bank_end_of_year",
    "disponible":                       "cash_in_bank_end_of_year",
    "saldo en caja":                    "cash_in_bank_end_of_year",
    "cash balance":                     "cash_in_bank_end_of_year",
    "bank balance":                     "cash_in_bank_end_of_year",
    "liquidity":                        "cash_in_bank_end_of_year",
    "liquidez":                         "cash_in_bank_end_of_year",
    "cash position":                    "cash_in_bank_end_of_year",

    # ── K008 · Annual Cash Flow ───────────────────────────────────────────────
    "annual cash flow":                 "annual_cash_flow",
    "cash flow":                        "annual_cash_flow",
    "cashflow":                         "annual_cash_flow",
    "free cash flow":                   "annual_cash_flow",
    "fcf":                              "annual_cash_flow",
    "flujo de caja":                    "annual_cash_flow",
    "flujo de efectivo":                "annual_cash_flow",
    "flujo de caja anual":              "annual_cash_flow",
    "flujo de efectivo anual":          "annual_cash_flow",
    "cash flow anual":                  "annual_cash_flow",
    "operating cash flow":              "annual_cash_flow",
    "flujo operativo":                  "annual_cash_flow",
    "generacion de caja":               "annual_cash_flow",

    # ── K009 · Working Capital Debt ───────────────────────────────────────────
    "working capital debt":             "working_capital_debt",
    "working capital":                  "working_capital_debt",
    "capital de trabajo":               "working_capital_debt",
    "deuda de capital de trabajo":      "working_capital_debt",
    "deuda capital trabajo":            "working_capital_debt",
    "net working capital":              "working_capital_debt",
    "capital circulante":               "working_capital_debt",
    "deuda circulante":                 "working_capital_debt",
    "short term debt":                  "working_capital_debt",
    "deuda corto plazo":                "working_capital_debt",

    # ── K010 · Monthly Recurring Revenue (SaaS) ───────────────────────────────
    "mrr":                              "mrr",
    "monthly recurring revenue":        "mrr",
    "ingreso recurrente mensual":       "mrr",
    "revenue recurrente mensual":       "mrr",
    "ingresos recurrentes mensuales":   "mrr",
    "arr / 12":                         "mrr",
    "recurring revenue":                "mrr",
    "subscription revenue":             "mrr",
    "ingresos por suscripcion":         "mrr",
    "ingresos suscripciones":           "mrr",

    # ── K011 · Churn Rate (SaaS) ──────────────────────────────────────────────
    "churn rate":                       "churn_rate",
    "churn":                            "churn_rate",
    "customer churn":                   "churn_rate",
    "monthly churn":                    "churn_rate",
    "tasa de abandono":                 "churn_rate",
    "tasa de cancelacion":              "churn_rate",
    "tasa de churn":                    "churn_rate",
    "cancelaciones":                    "churn_rate",
    "logo churn":                       "churn_rate",
    "revenue churn":                    "churn_rate",
    "desercion":                        "churn_rate",
    "tasa de desercion":                "churn_rate",
    "rotacion de clientes":             "churn_rate",

    # ── K012 · Customer Acquisition Cost ──────────────────────────────────────
    "cac":                              "cac",
    "customer acquisition cost":        "cac",
    "costo de adquisicion":             "cac",
    "costo de adquisicion de cliente":  "cac",
    "costo por cliente":                "cac",
    "costo por usuario":                "cac",
    "costo de adquisicion de usuario":  "cac",
    "acquisition cost":                 "cac",
    "cost per acquisition":             "cac",
    "cpa":                              "cac",

    # ── K013 · Loan Portfolio Size (Lending) ──────────────────────────────────
    "portfolio size":                   "portfolio_size",
    "loan portfolio size":              "portfolio_size",
    "loan portfolio":                   "portfolio_size",
    "cartera":                          "portfolio_size",
    "cartera de credito":               "portfolio_size",
    "cartera de prestamos":             "portfolio_size",
    "cartera total":                    "portfolio_size",
    "portafolio de prestamos":          "portfolio_size",
    "portafolio de creditos":           "portfolio_size",
    "book size":                        "portfolio_size",
    "total loan book":                  "portfolio_size",
    "originaciones":                    "portfolio_size",
    "originations":                     "portfolio_size",

    # ── K014 · Non-Performing Loan Ratio (Lending) ────────────────────────────
    "npl ratio":                        "npl_ratio",
    "npl":                              "npl_ratio",
    "non performing loan ratio":        "npl_ratio",
    "non-performing loan ratio":        "npl_ratio",
    "non performing loans":             "npl_ratio",
    "cartera vencida":                  "npl_ratio",
    "mora":                             "npl_ratio",
    "morosidad":                        "npl_ratio",
    "tasa de mora":                     "npl_ratio",
    "indice de morosidad":              "npl_ratio",
    "cartera morosa":                   "npl_ratio",
    "creditos vencidos":                "npl_ratio",
    "default rate":                     "npl_ratio",
    "tasa de incumplimiento":           "npl_ratio",

    # ── K015 · Gross Merchandise Value (eCommerce) ────────────────────────────
    "gmv":                              "gmv",
    "gross merchandise value":          "gmv",
    "total sales volume":               "gmv",
    "total transaction value":          "gmv",
    "valor bruto de mercancia":         "gmv",
    "valor total de transacciones":     "gmv",
    "volumen de ventas":                "gmv",
    "volumen bruto":                    "gmv",
    "transacciones totales":            "gmv",
    "valor de pedidos":                 "gmv",
    "valor pedidos":                    "gmv",
    "total orders value":               "gmv",

    # ── K016 · Loss Ratio (Insurance) ─────────────────────────────────────────
    "loss ratio":                       "loss_ratio",
    "siniestralidad":                   "loss_ratio",
    "tasa de siniestros":               "loss_ratio",
    "indice de siniestralidad":         "loss_ratio",
    "ratio de perdidas":                "loss_ratio",
    "combined ratio":                   "loss_ratio",
    "sinister ratio":                   "loss_ratio",
    "siniestros":                       "loss_ratio",
    "tasa de perdida":                  "loss_ratio",
    "frecuencia de siniestros":         "loss_ratio",
}


# ═══════════════════════════════════════════════════════════════════════════════
# ÍNDICE INVERTIDO — construido una sola vez al importar el módulo
# ═══════════════════════════════════════════════════════════════════════════════

def _strip_accents(text: str) -> str:
    """NFKD decomposition → drop combining characters → recompose."""
    return "".join(
        c for c in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(c)
    )


def _normalize_text(raw: str) -> str:
    """
    Canonical text normalization pipeline:
      1. Strip leading/trailing whitespace
      2. Lowercase
      3. Remove accent marks (ñ → n, á → a, etc.)
      4. Collapse internal whitespace to single space
      5. Remove all non-alphanumeric characters except spaces
         (handles hyphens, slashes, parentheses in Excel headers)
    """
    s = raw.strip().lower()
    s = _strip_accents(s)
    s = re.sub(r"[^\w\s]", " ", s)   # punctuation → space
    s = re.sub(r"\s+", " ", s).strip()
    return s


# Inverted index: normalized_synonym → kpi_key
_SYNONYM_INDEX: dict[str, str] = {
    _normalize_text(k): v
    for k, v in _SYNONYM_CATALOG.items()
}

# Forward index: kpi_key → catalog entry (for O(1) enrichment)
_CATALOG_BY_KEY: dict[str, dict] = {
    entry["kpi_key"]: entry
    for entry in METRIC_CATALOG
}


# ═══════════════════════════════════════════════════════════════════════════════
# TIPOS DE RETORNO
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass(frozen=True)
class MetricMatch:
    """Result of a canonical_metric_map() lookup."""
    metric_id:    str        # "K001" … "K016" | "K_UNKNOWN"
    kpi_key:      str        # snake_case key used throughout the pipeline
    label:        str        # official display name
    unit_type:    str        # "pct" | "usd" | "unknown"
    bucket_id:    str        # "ALL" | "SAAS" | "LEND" | "ECOM" | "INSUR" | "UNKNOWN"
    is_known:     bool       # False → needs manual review
    raw_input:    str        # original string received (for audit trail)
    normalized:   str        # what was actually looked up (for debugging)


_UNKNOWN: Final[MetricMatch] = MetricMatch(
    metric_id  = "K_UNKNOWN",
    kpi_key    = "unknown",
    label      = "Unknown Metric",
    unit_type  = "unknown",
    bucket_id  = "UNKNOWN",
    is_known   = False,
    raw_input  = "",
    normalized = "",
)


# ═══════════════════════════════════════════════════════════════════════════════
# FUNCIÓN PÚBLICA
# ═══════════════════════════════════════════════════════════════════════════════

def canonical_metric_map(raw_name: str) -> MetricMatch:
    """
    Map a free-text metric name to its canonical Cometa metric.

    Normalizes the input (strips accents, lowercases, collapses whitespace,
    removes punctuation) and looks it up in the synonym index.

    Args:
        raw_name: Any metric label as it appears in an Excel header, PDF row,
                  Gemini output, or manual entry form.

    Returns:
        MetricMatch with the canonical metric_id, kpi_key, label, unit_type,
        and bucket_id. If no match is found, returns a MetricMatch with
        metric_id="K_UNKNOWN" and is_known=False — the caller must flag
        the row for manual review.

    Examples:
        >>> canonical_metric_map("Ventas Totales").metric_id
        'K001'
        >>> canonical_metric_map("  EBITDA  ").kpi_key
        'ebitda'
        >>> canonical_metric_map("Tasa de Abandono").label
        'Churn Rate'
        >>> canonical_metric_map("xyz_gibberish").is_known
        False
    """
    if not raw_name or not raw_name.strip():
        return _UNKNOWN

    normalized = _normalize_text(raw_name)
    kpi_key = _SYNONYM_INDEX.get(normalized)

    if kpi_key is None:
        # Return unknown sentinel with audit trail
        return MetricMatch(
            metric_id  = "K_UNKNOWN",
            kpi_key    = "unknown",
            label      = "Unknown Metric",
            unit_type  = "unknown",
            bucket_id  = "UNKNOWN",
            is_known   = False,
            raw_input  = raw_name,
            normalized = normalized,
        )

    entry = _CATALOG_BY_KEY[kpi_key]
    return MetricMatch(
        metric_id  = entry["metric_id"],
        kpi_key    = kpi_key,
        label      = entry["label"],
        unit_type  = entry["unit_type"],
        bucket_id  = entry["bucket_id"],
        is_known   = True,
        raw_input  = raw_name,
        normalized = normalized,
    )


def resolve_metric_id(kpi_key: str) -> str | None:
    """
    Quick lookup: kpi_key → metric_id. Returns None if key is not in catalog.
    Useful for enriching existing KPI rows that already have a resolved kpi_key.

    Example:
        >>> resolve_metric_id("mrr")
        'K010'
    """
    entry = _CATALOG_BY_KEY.get(kpi_key)
    return entry["metric_id"] if entry else None


# ═══════════════════════════════════════════════════════════════════════════════
# TESTS DE UNIDAD
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys

    _GREEN = ""
    _RED   = ""
    _RESET = ""

    _cases: list[tuple[str, str, str]] = [
        # (raw_input,                  expected_metric_id, expected_kpi_key)

        # ── Inglés canónico ─────────────────────────────────────────────────
        ("Revenue",                    "K001", "revenue"),
        ("Total Revenue",              "K001", "revenue"),
        ("Revenue Growth",             "K002", "revenue_growth"),
        ("Gross Profit Margin",        "K003", "gross_profit_margin"),
        ("EBITDA",                     "K004", "ebitda"),
        ("EBITDA Margin",              "K005", "ebitda_margin"),
        ("Cost of Goods Sold",         "K006", "cogs"),
        ("Cash in Bank",               "K007", "cash_in_bank_end_of_year"),
        ("Annual Cash Flow",           "K008", "annual_cash_flow"),
        ("Working Capital Debt",       "K009", "working_capital_debt"),
        ("Monthly Recurring Revenue",  "K010", "mrr"),
        ("Churn Rate",                 "K011", "churn_rate"),
        ("Customer Acquisition Cost",  "K012", "cac"),
        ("Loan Portfolio Size",        "K013", "portfolio_size"),
        ("Non-Performing Loan Ratio",  "K014", "npl_ratio"),
        ("Gross Merchandise Value",    "K015", "gmv"),
        ("Loss Ratio",                 "K016", "loss_ratio"),

        # ── Español con acentos ─────────────────────────────────────────────
        ("Ventas Totales",             "K001", "revenue"),
        ("Ingresos",                   "K001", "revenue"),
        ("Facturación",                "K001", "revenue"),   # acento
        ("Crecimiento de Ingresos",    "K002", "revenue_growth"),
        ("Margen Bruto",               "K003", "gross_profit_margin"),
        ("Utilidad Operativa",         "K004", "ebitda"),
        ("Margen Operativo",           "K005", "ebitda_margin"),
        ("Costo de Ventas",            "K006", "cogs"),
        ("Caja y Bancos",              "K007", "cash_in_bank_end_of_year"),
        ("Flujo de Caja",              "K008", "annual_cash_flow"),
        ("Capital de Trabajo",         "K009", "working_capital_debt"),
        ("Ingreso Recurrente Mensual", "K010", "mrr"),
        ("Tasa de Abandono",           "K011", "churn_rate"),
        ("Cancelaciones",              "K011", "churn_rate"),
        ("Costo de Adquisición",       "K012", "cac"),   # acento
        ("Cartera de Crédito",         "K013", "portfolio_size"),  # acento
        ("Morosidad",                  "K014", "npl_ratio"),
        ("Cartera Vencida",            "K014", "npl_ratio"),
        ("Volumen de Ventas",          "K015", "gmv"),
        ("Siniestralidad",             "K016", "loss_ratio"),

        # ── Variaciones de formato ──────────────────────────────────────────
        ("  EBITDA  ",                 "K004", "ebitda"),     # espacios extra
        ("cogs",                       "K006", "cogs"),       # todo minúsculas
        ("MRR",                        "K010", "mrr"),        # todo mayúsculas
        ("NPL",                        "K014", "npl_ratio"),
        ("CAC",                        "K012", "cac"),
        ("GMV",                        "K015", "gmv"),
        ("FCF",                        "K008", "annual_cash_flow"),
        ("UAFIDA",                     "K004", "ebitda"),

        # ── Abreviaturas / acrónimos ────────────────────────────────────────
        ("GPM",                        "K003", "gross_profit_margin"),
        ("YoY Growth",                 "K002", "revenue_growth"),
        ("YoY Revenue",                "K002", "revenue_growth"),

        # ── Fallback esperado ───────────────────────────────────────────────
        ("xyz_gibberish",              "K_UNKNOWN", "unknown"),
        ("",                           "K_UNKNOWN", "unknown"),
        ("   ",                        "K_UNKNOWN", "unknown"),
        ("Total de activos",           "K_UNKNOWN", "unknown"),
    ]

    passed = 0
    failed = 0

    print("\n" + "=" * 70)
    print("  metric_catalog - suite de tests")
    print("=" * 70)

    for raw, exp_id, exp_key in _cases:
        result = canonical_metric_map(raw)
        ok = result.metric_id == exp_id and result.kpi_key == exp_key
        icon = "PASS" if ok else "FAIL"
        if ok:
            passed += 1
            print(f"  [{icon}]  {raw!r:40s}  -> {result.metric_id}  {result.label}")
        else:
            failed += 1
            print(
                f"  [{icon}]  {raw!r:40s}"
                f"  got=({result.metric_id}, {result.kpi_key})"
                f"  expected=({exp_id}, {exp_key})"
            )

    # resolve_metric_id spot check
    assert resolve_metric_id("mrr") == "K010"
    assert resolve_metric_id("unknown_key") is None

    print("=" * 70)
    total = passed + failed
    if failed == 0:
        print(f"  All {total} tests passed [OK]")
    else:
        print(f"  {failed}/{total} tests FAILED")
        sys.exit(1)
    print("=" * 70 + "\n")
