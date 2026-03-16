"""
data_contract.py
────────────────
Transforms the raw Gemini JSON into the canonical Cometa data contract:

    {
      "submission": { ...metadata + dedup key... },
      "kpi_rows":   [ ...one row per KPI...       ],
      "raw_gemini": { ...original Gemini output... }
    }

Rules enforced here:
  Rule 4  – Every metric value is parsed and validated as numeric.
             Non-numeric values are stored with is_valid=False.
  Rule 8  – file_hash is embedded in `submission` as the deduplication key.
  Bonus   – period_id is inferred from the document and checked for
             consistency across all rows.
"""

import re
import uuid
from collections import Counter
from datetime import datetime, timezone
from typing import Optional

from src.core.fx_service import get_fx_provider


# ── KPI Registry ──────────────────────────────────────────────────────────────
# Single source of truth for which metrics we extract, where to find them in
# the Gemini JSON tree, and their expected unit category.
#
# Paths mirror the Gemini prompt schema exactly:
#   financial_metrics_2025.base_metrics    — revenue, ebitda, cogs
#   financial_metrics_2025.profit_margins  — margins (derived or direct)
#   financial_metrics_2025.cash_flow_indicators
#   financial_metrics_2025.debt_ratios
#   financial_metrics_2025.sector_metrics  — sector-specific KPIs

KPI_REGISTRY = [
    # ── Core financial metrics ─────────────────────────────────────────────
    {
        "kpi_key":   "revenue_growth",
        "kpi_label": "Revenue Growth",
        "path":      ["financial_metrics_2025", "revenue_growth"],
        "unit_type": "pct",
    },
    {
        "kpi_key":   "gross_profit_margin",
        "kpi_label": "Gross Profit Margin",
        "path":      ["financial_metrics_2025", "profit_margins", "gross_profit_margin"],
        "unit_type": "pct",
    },
    {
        "kpi_key":   "ebitda_margin",
        "kpi_label": "EBITDA Margin",
        "path":      ["financial_metrics_2025", "profit_margins", "ebitda_margin"],
        "unit_type": "pct",
    },
    {
        "kpi_key":   "cash_in_bank_end_of_year",
        "kpi_label": "Cash in Bank",
        "path":      ["financial_metrics_2025", "cash_flow_indicators", "cash_in_bank_end_of_year"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "annual_cash_flow",
        "kpi_label": "Annual Cash Flow",
        "path":      ["financial_metrics_2025", "cash_flow_indicators", "annual_cash_flow"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "working_capital_debt",
        "kpi_label": "Working Capital Debt",
        "path":      ["financial_metrics_2025", "debt_ratios", "working_capital_debt"],
        "unit_type": "usd",
    },
    # ── Base metrics (inputs for derivation engine) ────────────────────────
    {
        "kpi_key":   "revenue",
        "kpi_label": "Total Revenue",
        "path":      ["financial_metrics_2025", "base_metrics", "revenue"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "ebitda",
        "kpi_label": "EBITDA",
        "path":      ["financial_metrics_2025", "base_metrics", "ebitda"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "cogs",
        "kpi_label": "Cost of Goods Sold",
        "path":      ["financial_metrics_2025", "base_metrics", "cogs"],
        "unit_type": "usd",
    },
    # ── Sector metrics ─────────────────────────────────────────────────────
    # SAAS
    {
        "kpi_key":   "mrr",
        "kpi_label": "Monthly Recurring Revenue",
        "path":      ["financial_metrics_2025", "sector_metrics", "mrr"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "churn_rate",
        "kpi_label": "Churn Rate",
        "path":      ["financial_metrics_2025", "sector_metrics", "churn_rate"],
        "unit_type": "pct",
    },
    {
        "kpi_key":   "cac",
        "kpi_label": "Customer Acquisition Cost",
        "path":      ["financial_metrics_2025", "sector_metrics", "cac"],
        "unit_type": "usd",
    },
    # LEND
    {
        "kpi_key":   "portfolio_size",
        "kpi_label": "Loan Portfolio Size",
        "path":      ["financial_metrics_2025", "sector_metrics", "portfolio_size"],
        "unit_type": "usd",
    },
    {
        "kpi_key":   "npl_ratio",
        "kpi_label": "Non-Performing Loan Ratio",
        "path":      ["financial_metrics_2025", "sector_metrics", "npl_ratio"],
        "unit_type": "pct",
    },
    # ECOM
    {
        "kpi_key":   "gmv",
        "kpi_label": "Gross Merchandise Value",
        "path":      ["financial_metrics_2025", "sector_metrics", "gmv"],
        "unit_type": "usd",
        # Aliases used in logistics/e-commerce reports — referenced in the Gemini prompt
        # so the model knows to map these terms to the gmv JSON key.
        "aliases": [
            "Gross Merchandise Value",
            "Total Sales Volume",
            "Total Transaction Value",
            "GMV",
            "Valor Total de Transacciones",
            "Volumen de Ventas",
        ],
    },
    # INSUR
    {
        "kpi_key":   "loss_ratio",
        "kpi_label": "Loss Ratio",
        "path":      ["financial_metrics_2025", "sector_metrics", "loss_ratio"],
        "unit_type": "pct",
    },
]


# ── Sector requirements checklist ──────────────────────────────────────────────
# KPIs that MUST be present for a submission to be considered complete per sector.

SECTOR_REQUIREMENTS: dict[str, list[str]] = {
    "SAAS":  ["revenue", "mrr", "churn_rate", "cac"],
    "LEND":  ["revenue", "portfolio_size", "npl_ratio"],
    "ECOM":  ["revenue", "gmv", "cac"],
    "INSUR": ["revenue", "loss_ratio", "cac"],
    "OTH":   ["revenue", "ebitda"],
}


# ── Unit synonym normalization ────────────────────────────────────────────────
# Gemini sometimes returns the unit field (or a fallback unit_type) using
# text synonyms instead of canonical symbols.  Mapping them here eliminates
# spurious WARN [unit_mismatch] entries downstream without changing semantics.

_UNIT_SYNONYMS: dict[str, str] = {
    # USD / money synonyms  →  canonical "$"
    "usd":        "$",
    "dollars":    "$",
    "usd_amount": "$",
    "us dollars": "$",
    "mxn":        "$",   # treated as dollar-class for unit check; FX handled separately
    "eur":        "$",
    "brl":        "$",
    "cop":        "$",
    # Percentage synonyms  →  canonical "%"
    "pct":        "%",
    "percentage": "%",
    "ratio":      "%",
    "decimal":    "%",
    "rate":       "%",
}


def _normalize_unit_synonym(unit: str) -> str:
    """
    Map a raw unit string to its canonical symbol ("$" or "%").

    Scale suffixes (M, K, B) are preserved: "usdM" → "$M", "pct" → "%".
    The lookup is case-insensitive and strips leading/trailing whitespace.

    Returns the original string unchanged if no synonym matches, so callers
    can safely pass any unit without risk of silent corruption.
    """
    if not unit:
        return unit
    stripped = unit.strip()
    # Separate scale suffix (M / K / B) if present
    lower = stripped.lower()
    # Check full string first
    if lower in _UNIT_SYNONYMS:
        return _UNIT_SYNONYMS[lower]
    # Check base without trailing scale letter
    if len(lower) > 1 and lower[-1] in ("m", "k", "b"):
        base  = lower[:-1]
        scale = stripped[-1].upper()
        if base in _UNIT_SYNONYMS:
            return _UNIT_SYNONYMS[base] + scale
    return stripped


# ── Internal helpers ──────────────────────────────────────────────────────────

def _dig(obj: dict, path: list[str]) -> Optional[dict]:
    """
    Navigate a nested dict by a list of keys.
    Returns the node at the end of the path, or None if any key is missing.
    """
    current = obj
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def parse_numeric(raw: Optional[str]) -> tuple[Optional[float], Optional[str]]:
    """
    Rule 4 — Convert a financial string to (numeric_value, unit_detected).

    Handles:
      "36%"     → (36.0,          "%")
      "$9.7M"   → (9_700_000.0,   "$M")
      "-0.74%"  → (-0.74,         "%")
      "$1.1K"   → (1_100.0,       "$K")
      "$4.2B"   → (4_200_000_000, "$B")
      "null"    → (None,           None)

    Returns (None, None) for any value that cannot be made numeric.
    """
    if raw is None or str(raw).strip().lower() in ("null", "n/a", "---", "", "none"):
        return None, None

    s = str(raw).strip()
    is_negative = s.startswith("-")
    s = s.lstrip("+-")

    # Detect base unit symbol
    unit: Optional[str] = None
    if "%" in s:
        unit = "%"
        s = s.replace("%", "")
    elif "$" in s:
        unit = "$"
        s = s.replace("$", "")

    # Detect scale multiplier
    multiplier = 1.0
    upper_s = s.upper()
    if upper_s.endswith("B"):
        multiplier = 1_000_000_000.0
        s = s[:-1]
        unit = (unit or "") + "B"
    elif upper_s.endswith("M"):
        multiplier = 1_000_000.0
        s = s[:-1]
        unit = (unit or "") + "M"
    elif upper_s.endswith("K"):
        multiplier = 1_000.0
        s = s[:-1]
        unit = (unit or "") + "K"

    s = s.replace(",", "").strip()

    try:
        value = float(s) * multiplier
        return (-value if is_negative else value), unit
    except ValueError:
        return None, None


def detect_currency(gemini_json: dict) -> str:
    """
    Extract the document currency from the _document_context block written
    by Gemini's FASE 1 analysis.

    Falls back to 'USD' if the field is absent, malformed, or not a 3-letter
    ISO 4217 code — conservative default to avoid silent conversion errors.
    """
    ctx = gemini_json.get("_document_context") or {}
    raw = ctx.get("currency", "USD")
    if not isinstance(raw, str):
        return "USD"
    code = raw.strip().upper()
    # Accept only plausible ISO 4217 codes (3 uppercase letters)
    return code if re.fullmatch(r"[A-Z]{3}", code) else "USD"


def _period_year(period_id: str) -> int:
    """
    Extract the 4-digit reporting year from a period_id string.
    Examples: 'FY2025' → 2025,  'H1 2025' → 2025,  '2025' → 2025.
    Falls back to current year if no 20XX pattern is found.
    """
    match = re.search(r"(20\d{2})", period_id)
    return int(match.group(1)) if match else datetime.now(timezone.utc).year


def infer_period_id(gemini_json: dict) -> str:
    """
    Infer the reporting period from description fields inside the Gemini JSON.

    Strategy:
      1. Find all 4-digit years matching 20XX anywhere in the JSON text.
      2. Return "FY<most_common_year>".
      3. Fall back to "FY<current_year>" if no year is found.
    """
    year_pat = re.compile(r'\b(20\d{2})\b')
    matches = year_pat.findall(str(gemini_json))
    if matches:
        return "FY" + Counter(matches).most_common(1)[0][0]
    return f"FY{datetime.now(timezone.utc).year}"


# ── Derivation engine ─────────────────────────────────────────────────────────

def calculate_derived_kpis(
    kpi_rows: list[dict],
    submission_id: str,
    period_id: str,
    currency: str,
) -> list[dict]:
    """
    Compute KPIs that can be derived mathematically from base metrics.

    Rules
    -----
    1. gross_margin  = (revenue - cogs) / revenue  — if revenue > 0 and cogs present.
       Only added if gross_profit_margin was NOT already extracted by Gemini.
    2. ebitda_margin = ebitda / revenue             — if revenue > 0 and ebitda present.
       Only added if ebitda_margin was NOT already extracted by Gemini.

    Returns a (possibly empty) list of new kpi_row dicts to append to kpi_rows.
    All derived rows carry confidence=1.0 and source_description='calculated'.
    """
    # Build index of existing valid rows for quick lookup
    valid_index: dict[str, float] = {
        r["kpi_key"]: r["numeric_value"]
        for r in kpi_rows
        if r.get("is_valid") and r.get("numeric_value") is not None
    }
    existing_keys = {r["kpi_key"] for r in kpi_rows}

    derived: list[dict] = []

    def _derived_row(kpi_key: str, kpi_label: str, value: float, unit: str) -> dict:
        return {
            "submission_id":      submission_id,
            "kpi_key":            kpi_key,
            "kpi_label":          kpi_label,
            "raw_value":          f"{round(value * 100, 4)}%" if unit == "%" else str(round(value, 6)),
            "numeric_value":      round(value, 6),
            "unit":               unit,
            "period_id":          period_id,
            "source_description": "calculated",
            "is_valid":           True,
            "original_currency":  currency,
            "fx_rate":            1.0 if currency == "USD" else None,
            "normalized_value_usd": round(value, 6) if currency == "USD" else None,
            "confidence":         1.0,
        }

    revenue = valid_index.get("revenue")

    # Rule 1: gross_margin from revenue + cogs
    if (
        revenue and revenue != 0
        and "cogs" in valid_index
        and "gross_profit_margin" not in existing_keys
    ):
        cogs = valid_index["cogs"]
        gross_margin = (revenue - cogs) / revenue
        derived.append(_derived_row("gross_profit_margin", "Gross Profit Margin (calc)", gross_margin, "%"))
        print(f"[Calc] gross_profit_margin derived: {gross_margin:.4f}")

    # Rule 2: ebitda_margin from ebitda + revenue
    if (
        revenue and revenue != 0
        and "ebitda" in valid_index
        and "ebitda_margin" not in existing_keys
    ):
        ebitda = valid_index["ebitda"]
        ebitda_margin = ebitda / revenue
        derived.append(_derived_row("ebitda_margin", "EBITDA Margin (calc)", ebitda_margin, "%"))
        print(f"[Calc] ebitda_margin derived: {ebitda_margin:.4f}")

    return derived


# ── Sector checklist ───────────────────────────────────────────────────────────

def build_checklist_status(kpi_rows: list[dict], bucket_id: str) -> dict:
    """
    Validate whether the submission contains all mandatory KPIs for its sector.

    Parameters
    ----------
    kpi_rows  : list of kpi_row dicts from build_contract (including derived).
    bucket_id : company vertical — SAAS | LEND | ECOM | INSUR | OTH | UNKNOWN.

    Returns
    -------
    {
      "bucket":               str,
      "is_complete":          bool,
      "present_kpis":         [str],
      "missing_critical_kpis":[str],
      "display_message":      str,
    }
    """
    required = SECTOR_REQUIREMENTS.get(bucket_id, [])

    present_valid = {
        r["kpi_key"]
        for r in kpi_rows
        if r.get("is_valid") and r.get("numeric_value") is not None
    }

    missing = [kpi for kpi in required if kpi not in present_valid]
    is_complete = len(missing) == 0

    if not required:
        message = f"Sector '{bucket_id}' sin checklist definido — revisa SECTOR_REQUIREMENTS."
    elif is_complete:
        message = f"Reporte {bucket_id} completo. Todos los KPIs criticos presentes."
    else:
        missing_str = ", ".join(missing)
        sector_labels = {
            "SAAS": "SaaS", "LEND": "Lending", "ECOM": "E-Commerce",
            "INSUR": "Insurance", "OTH": "General",
        }
        label = sector_labels.get(bucket_id, bucket_id)
        message = f"Atencion: Reporte {label} incompleto. Faltan: {missing_str}."

    return {
        "bucket":                bucket_id,
        "is_complete":           is_complete,
        "present_kpis":          sorted(present_valid),
        "missing_critical_kpis": missing,
        "display_message":       message,
    }


# ── Public API ────────────────────────────────────────────────────────────────

def build_contract(
    gemini_json: dict,
    file_hash: str,
    company_id: str,
    founder_email: str,
    original_filename: str,
    portfolio_id: str = "",
) -> dict:
    """
    Build the canonical data contract from a parsed Gemini response.

    Parameters
    ----------
    gemini_json       : The dict returned by Gemini (already json.loads'd).
    file_hash         : SHA-256 prefix of the PDF — deduplication key (Rule 8).
    company_id        : Domain of the submitting company.
    founder_email     : Email address of the uploader.
    original_filename : Original PDF filename.

    Returns
    -------
    {
      "submission": {
          submission_id, file_hash, company_id, founder_email,
          original_filename, submitted_at, period_id,
          period_consistent, kpi_count_total, kpi_count_valid, status
      },
      "kpi_rows": [
          { submission_id, kpi_key, kpi_label, raw_value,
            numeric_value, unit, period_id, source_description, is_valid },
          ...
      ],
      "raw_gemini": { ...original dict... },
      "integrity": {
          "period_consistent": bool,
          "valid_ratio": float,
          "warnings": [str]
      }
    }
    """
    submission_id = str(uuid.uuid4())
    period_id     = infer_period_id(gemini_json)
    now           = datetime.now(timezone.utc).isoformat()

    # ── Currency & FX setup ────────────────────────────────────────────────
    currency    = detect_currency(gemini_json)
    report_year = _period_year(period_id)
    fx          = get_fx_provider()

    if currency != "USD":
        print(
            f"💱 [Contract] Non-USD document detected — "
            f"currency={currency}, year={report_year}. "
            f"normalized_value_usd will be computed for each KPI."
        )

    # ── Build kpi_rows ─────────────────────────────────────────────────────
    kpi_rows: list[dict] = []
    warnings: list[str]  = []

    for kpi_def in KPI_REGISTRY:
        node = _dig(gemini_json, kpi_def["path"])

        raw_value   = None
        description = None

        if isinstance(node, dict):
            raw_value   = node.get("value")
            description = node.get("description")
        elif node is not None:
            # Gemini returned a scalar instead of {value, description}
            raw_value = str(node)
            warnings.append(
                f"KPI '{kpi_def['kpi_key']}' node is not a dict: {type(node).__name__}"
            )

        # Rule 4: validate numeric
        numeric_value, unit = parse_numeric(raw_value)
        is_valid = numeric_value is not None

        if raw_value is not None and not is_valid:
            warnings.append(
                f"KPI '{kpi_def['kpi_key']}' value '{raw_value}' is not numeric — "
                "stored with is_valid=False"
            )

        # Confidence — read from the Gemini node; default 0.0 if absent
        confidence: Optional[float] = None
        if isinstance(node, dict):
            raw_conf = node.get("confidence")
            try:
                confidence = float(raw_conf) if raw_conf is not None else None
            except (TypeError, ValueError):
                confidence = None

        # ── FX normalization ───────────────────────────────────────────────
        # Three columns written to fact_kpi_values:
        #   numeric_value       — parsed float in the document's original currency
        #   original_currency   — ISO 4217 code (e.g. "MXN")
        #   fx_rate             — annual-average units-of-currency per 1 USD
        #   normalized_value_usd — numeric_value / fx_rate  (USD equivalent)
        #
        # For USD documents fx_rate is always 1.0 and normalized == numeric.
        # For non-USD, fx_rate comes from StaticFxProvider (or future live API).
        if numeric_value is not None:
            if currency == "USD":
                fx_rate_used:          Optional[float] = 1.0
                normalized_value_usd:  Optional[float] = numeric_value
            else:
                fx_rate_used = fx.get_rate(currency, report_year)
                if fx_rate_used is not None:
                    normalized_value_usd = round(numeric_value / fx_rate_used, 6)
                else:
                    normalized_value_usd = None
                    warnings.append(
                        f"KPI '{kpi_def['kpi_key']}': no FX rate for "
                        f"{currency}/{report_year} — normalized_value_usd is null. "
                        "Add the currency to RATE_TABLE in fx_service.py."
                    )
        else:
            fx_rate_used         = None
            normalized_value_usd = None

        # Normalize unit: map Gemini synonyms (usd, pct, …) to canonical symbols
        # ($, %) so audit_contract never fires a spurious unit_mismatch warning.
        raw_unit = unit or kpi_def["unit_type"]
        normalized_unit = _normalize_unit_synonym(raw_unit)

        kpi_rows.append({
            "submission_id":      submission_id,
            "kpi_key":            kpi_def["kpi_key"],
            "kpi_label":          kpi_def["kpi_label"],
            "raw_value":          str(raw_value) if raw_value is not None else None,
            "numeric_value":      numeric_value,
            "unit":               normalized_unit,
            "period_id":          period_id,
            "source_description": description,
            "is_valid":           is_valid,
            # Mejora A — FX normalization: original value + rate + USD equivalent
            "original_currency":    currency,
            "fx_rate":              fx_rate_used,
            "normalized_value_usd": normalized_value_usd,
            # Mejora C — Confidence from Gemini FASE 2
            "confidence":           confidence,
        })

    # ── Derivation engine ──────────────────────────────────────────────────
    derived_rows = calculate_derived_kpis(kpi_rows, submission_id, period_id, currency)
    kpi_rows.extend(derived_rows)

    # ── Integrity checks ───────────────────────────────────────────────────
    valid_count = sum(1 for r in kpi_rows if r["is_valid"])
    valid_ratio = round(valid_count / len(kpi_rows), 2) if kpi_rows else 0.0

    # Period consistency: all rows carry the same period_id (single-pass
    # logic guarantees this today; flag is a future-proof hook).
    distinct_periods = {r["period_id"] for r in kpi_rows}
    period_consistent = len(distinct_periods) <= 1

    if not period_consistent:
        warnings.append(
            f"Multiple period_ids detected: {distinct_periods}. "
            "Check that the document covers a single fiscal year."
        )

    if valid_count == 0:
        warnings.append(
            "No numeric KPI values were extracted. "
            "The document may not contain financial statements in a parseable format."
        )

    # ── Mejora C: Confidence threshold ────────────────────────────────────
    # If avg confidence of valid KPIs is below 0.85, flag for human review.
    CONFIDENCE_THRESHOLD = 0.85
    conf_scores = [r["confidence"] for r in kpi_rows if r["confidence"] is not None]
    avg_confidence: Optional[float] = round(sum(conf_scores) / len(conf_scores), 3) if conf_scores else None

    if avg_confidence is not None and avg_confidence < CONFIDENCE_THRESHOLD:
        status = "pending_human_review"
        warnings.append(
            f"Average confidence {avg_confidence:.2f} is below threshold "
            f"{CONFIDENCE_THRESHOLD}. Submission flagged for human review."
        )
    elif valid_count > 0:
        status = "processed"
    else:
        status = "empty"

    # ── Build submission ───────────────────────────────────────────────────
    submission = {
        "submission_id":     submission_id,
        "file_hash":         file_hash,        # Rule 8: deduplication key
        "company_id":        company_id,
        "founder_email":     founder_email,
        "original_filename": original_filename,
        "submitted_at":      now,
        "period_id":         period_id,
        "period_consistent": period_consistent,
        "kpi_count_total":   len(kpi_rows),
        "kpi_count_valid":   valid_count,
        "avg_confidence":    avg_confidence,
        "status":            status,
        "detected_currency": currency,
        "portfolio_id":      portfolio_id,
    }

    return {
        "submission": submission,
        "kpi_rows":   kpi_rows,
        "raw_gemini": gemini_json,
        "integrity": {
            "period_consistent": period_consistent,
            "valid_ratio":       valid_ratio,
            "warnings":          warnings,
        },
    }
