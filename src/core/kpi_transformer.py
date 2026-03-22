"""
kpi_transformer.py
──────────────────
ETL integration layer: raw KPI extraction → canonical BigQuery contract.

Integrates three quality rules in a single pass:
  R3  canonical_metric_map()  →  metric_id (K-ID) + bucket_id resolution
  R4  StaticFxProvider        →  amount_usd conversion (divisor convention)
  R5  normalize_period()      →  period_id in PYYYYQxMyy format

Input:
  RawKpiExtraction — a dict produced by the document parser (Excel / PDF).
  See RawKpiExtraction for the expected shape.

Output:
  TransformResult — {submission: {...}, kpis: [...]}
  Suitable for streaming insert into BigQuery or persisting as JSON/CSV.

Usage:
  from src.core.kpi_transformer import transform, export_audit_csv

  result = transform(raw_extraction)
  export_audit_csv(result, path="audit/simetrik_P2025Q1M03.csv")
"""

from __future__ import annotations

import csv
import hashlib
import re
import unicodedata
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# ── Internal imports (no FastAPI dependency) ──────────────────────────────────
from src.core.metric_catalog import canonical_metric_map, MetricMatch
from src.core.fx_service import get_fx_provider, RATE_TABLE
from src.core.data_contract import parse_numeric
from src.core.db_writer import PORTFOLIO_MAP, COMPANY_BUCKET


# ── Pipeline version (bump when the output schema changes) ────────────────────
PIPELINE_VERSION = "1.2.0"

# Fund code mapping (canonical portfolio_id → analyst-facing fund code)
_FUND_CODE: dict[str, str] = {
    "VII":  "F001",
    "CIII": "F002",
}


# =============================================================================
# INPUT TYPES
# =============================================================================

@dataclass
class RawKpiRow:
    """A single metric row as it comes from the document parser."""
    metric_name: str                  # "Ventas Totales", "MRR", "Churn Rate", ...
    value:       str                  # Raw string: "10.5M", "36%", "-$2.1M"
    currency:    str  = ""            # ISO 4217 override — empty → inherit RawKpiExtraction.currency
    notes:       str  = ""            # Optional: extraction notes or source cell ref


@dataclass
class RawKpiExtraction:
    """
    Top-level envelope produced by the document parser.
    All fields required unless marked Optional.
    """
    company:     str                        # "Simetrik", "simetrik.com", "COMP_SIMETRIK"
    period:      str                        # "Q1 2025", "FY2025", "March 2025", etc.
    currency:    str                        # Document-level default currency (ISO 4217)
    kpis:        list[RawKpiRow]            # List of extracted KPI rows
    source_file: str          = ""          # Original filename (for audit)
    fund_hint:   Optional[str] = None       # Optional: "VII" | "CIII" (skip catalog lookup)
    extraction_id: Optional[str] = None    # Set externally if idempotency is needed


# =============================================================================
# OUTPUT TYPES
# =============================================================================

@dataclass
class KpiRow:
    """One canonical KPI row, ready for BigQuery insertion."""
    kpi_row_id:    str                  # UUID (stable if extraction_id is given)
    metric_id:     str                  # "K001"–"K016" | "K_UNKNOWN"
    kpi_key:       str                  # snake_case: "revenue", "mrr", ...
    kpi_label:     str                  # "Total Revenue", "Monthly Recurring Revenue"
    bucket_id:     str                  # "ALL" | "SAAS" | "LEND" | "ECOM" | "INSUR" | "UNKNOWN"
    raw_value:     str                  # Original string from source document
    numeric_value: Optional[float]      # Parsed number (None if not parseable)
    unit:          Optional[str]        # "%", "$", "$M", "$K", "$B"
    unit_type:     str                  # "pct" | "usd" | "unknown"
    amount_usd:    Optional[float]      # USD-converted value (None for % or unknown FX)
    fx_rate_used:  Optional[float]      # Rate applied (None if identity or not monetary)
    fx_source:     str                  # "identity"|"exact"|"carry_forward"|"not_monetary"|"unknown_currency"
    value_status:  str                  # "ok" | "needs_review" | "error"
    value_errors:  list[str]            # Human-readable list of quality issues
    notes:         str                  # Pass-through from RawKpiRow


@dataclass
class SubmissionMeta:
    """Metadata block written to BigQuery submissions table."""
    submission_id:    str
    company_id:       str       # "COMP_SIMETRIK"
    company_raw:      str       # Original company string from extraction
    portfolio_id:     str       # "VII" | "CIII" | "UNKNOWN"
    fund_id:          str       # "F001" | "F002" | "UNKNOWN"
    bucket_id:        str       # Company vertical: "SAAS" | "LEND" | ...
    period_id:        str       # Canonical: "P2025Q1M03"
    period_raw:       str       # Original period string
    period_ok:        bool      # False → period could not be parsed
    currency:         str       # Document-level currency
    source_file:      str
    processed_at:     str       # ISO 8601 UTC timestamp
    pipeline_version: str


@dataclass
class TransformResult:
    """Final output of the transformer — ready for BQ or CSV export."""
    submission: SubmissionMeta
    kpis:       list[KpiRow]

    @property
    def ok_count(self) -> int:
        return sum(1 for k in self.kpis if k.value_status == "ok")

    @property
    def error_count(self) -> int:
        return sum(1 for k in self.kpis if k.value_status == "error")

    @property
    def review_count(self) -> int:
        return sum(1 for k in self.kpis if k.value_status == "needs_review")

    def summary(self) -> dict:
        return {
            "submission_id": self.submission.submission_id,
            "company_id":    self.submission.company_id,
            "period_id":     self.submission.period_id,
            "total_kpis":    len(self.kpis),
            "ok":            self.ok_count,
            "needs_review":  self.review_count,
            "errors":        self.error_count,
        }


# =============================================================================
# INTERNAL: period normalization
# =============================================================================
# NOTE: This mirrors normalize_period() from src/api.py.
# TODO: Move both to src/core/utils.py so all consumers share one implementation.

_MONTH_MAP: dict[str, str] = {
    "january":"01","february":"02","march":"03","april":"04",
    "may":"05","june":"06","july":"07","august":"08",
    "september":"09","october":"10","november":"11","december":"12",
    "enero":"01","febrero":"02","marzo":"03","abril":"04",
    "mayo":"05","junio":"06","julio":"07","agosto":"08",
    "septiembre":"09","octubre":"10","noviembre":"11","diciembre":"12",
    "jan":"01","feb":"02","mar":"03","apr":"04","jun":"06",
    "jul":"07","aug":"08","sep":"09","oct":"10","nov":"11","dec":"12",
}
_QUARTER_FIRST: dict[str, str] = {"1":"01","2":"04","3":"07","4":"10"}
_HALF_CLOSE:    dict[str, str] = {"1":"06","2":"12"}
_HALF_QUARTER:  dict[str, str] = {"1":"Q2","2":"Q4"}
_M2Q:           dict[str, str] = {
    "01":"Q1","02":"Q1","03":"Q1","04":"Q2","05":"Q2","06":"Q2",
    "07":"Q3","08":"Q3","09":"Q3","10":"Q4","11":"Q4","12":"Q4",
}
_CANONICAL_RE = re.compile(r"^P(20\d{2})Q([1-4])M(\d{2})$")


def _normalize_period(raw: str) -> tuple[str, bool]:
    """Returns (canonical_period_id, is_valid). Mirrors api.normalize_period()."""
    if not raw or not isinstance(raw, str):
        return f"P{datetime.now(timezone.utc).year}Q4M12", False

    s = raw.strip()
    if _CANONICAL_RE.match(s):
        return s, True

    sl = s.lower()

    # "March 2025" / "2025 Marzo"
    for name, num in _MONTH_MAP.items():
        m = re.search(rf"\b{re.escape(name)}\b\s*(20\d{{2}})", sl) or \
            re.search(rf"(20\d{{2}})\s*\b{re.escape(name)}\b", sl)
        if m:
            year = next((g for g in m.groups() if g and g.startswith("20")), None)
            if year:
                return f"P{year}{_M2Q[num]}M{num}", True

    # "Q1 2025" / "2025-Q2"
    m = re.search(r"q([1-4])[\s\-/]*(20\d{2})", sl)
    if m:
        qnum, year = m.group(1), m.group(2)
        return f"P{year}Q{qnum}M{_QUARTER_FIRST[qnum]}", True
    m = re.search(r"(20\d{2})[\s\-/]*q([1-4])", sl)
    if m:
        year, qnum = m.group(1), m.group(2)
        return f"P{year}Q{qnum}M{_QUARTER_FIRST[qnum]}", True

    # "H1 2025" / "2024-H2"
    m = re.search(r"h([12])[\s\-]*(20\d{2})", sl)
    if m:
        half, year = m.group(1), m.group(2)
        return f"P{year}{_HALF_QUARTER[half]}M{_HALF_CLOSE[half]}", True
    m = re.search(r"(20\d{2})[\s\-]*h([12])", sl)
    if m:
        year, half = m.group(1), m.group(2)
        return f"P{year}{_HALF_QUARTER[half]}M{_HALF_CLOSE[half]}", True

    # "FY2025" / "fiscal year 2025"
    m = re.search(r"fy\s*(20\d{2})", sl) or re.search(r"fiscal\s+year\s*(20\d{2})", sl)
    if m:
        return f"P{m.group(1)}Q4M12", True

    # Bare year "2025"
    m = re.search(r"(20\d{2})", sl)
    if m:
        return f"P{m.group(1)}Q4M12", True

    return f"P{datetime.now(timezone.utc).year}Q4M12", False


def _period_to_year_month(period_id: str) -> tuple[int, int]:
    """Extract (year, month) from canonical PYYYYQxMyy. Returns (current_year, 12) on failure."""
    m = _CANONICAL_RE.match(period_id)
    if m:
        return int(m.group(1)), int(m.group(3))
    year_m = re.search(r"(20\d{2})", period_id)
    return (int(year_m.group(1)) if year_m else datetime.now(timezone.utc).year), 12


# =============================================================================
# INTERNAL: company resolution (no FastAPI dependency)
# =============================================================================

def _resolve_company(raw: str, fund_hint: Optional[str]) -> tuple[str, str, str, str]:
    """
    Returns (company_id, portfolio_id, fund_id, bucket_id).
    Uses PORTFOLIO_MAP + COMPANY_BUCKET from db_writer.py.
    fund_hint bypasses catalog lookup for cases where the fund is already known.
    """
    # Normalize the raw company string
    base = raw.lower().strip()
    base = re.sub(r"^comp_", "", base)          # strip COMP_ prefix if present
    base = base.split(".")[0]                   # strip TLD
    base = re.sub(r"\s+", " ", base)

    # Match against PORTFOLIO_MAP (sorted longest-first to avoid substring collisions)
    keys_sorted = sorted(PORTFOLIO_MAP.keys(), key=len, reverse=True)

    matched_key: Optional[str] = None
    for key in keys_sorted:
        stripped_key = re.sub(r"[-_\s]", "", key)
        stripped_base = re.sub(r"[-_\s]", "", base)
        if base == key or stripped_base == stripped_key:
            matched_key = key
            break
        if base.startswith(key + "-") or base.startswith(key + "_"):
            matched_key = key
            break
    if matched_key is None:
        for key in keys_sorted:
            if key in base:
                matched_key = key
                break

    if matched_key:
        portfolio_id = PORTFOLIO_MAP[matched_key]["portfolio_id"]
        bucket_id    = COMPANY_BUCKET.get(matched_key, "OTH")
        safe_key     = matched_key.upper().replace("-", "_")
        company_id   = f"COMP_{safe_key}"
    else:
        portfolio_id = fund_hint or "UNKNOWN"
        bucket_id    = "OTH"
        suffix       = hashlib.sha1(raw.encode()).hexdigest()[:8].upper()
        company_id   = f"COMP_UNKNOWN_{suffix}"

    fund_id = _FUND_CODE.get(portfolio_id, "UNKNOWN")
    return company_id, portfolio_id, fund_id, bucket_id


# =============================================================================
# INTERNAL: FX conversion
# =============================================================================

_FX = get_fx_provider()   # StaticFxProvider (singleton for module lifetime)


def _convert_to_usd(
    numeric_value: Optional[float],
    unit_type: str,
    currency: str,
    year: int,
) -> tuple[Optional[float], Optional[float], str]:
    """
    Returns (amount_usd, fx_rate_used, fx_source).

    Rules (mirrors v_kpi_usd SQL view, §3 in fx_conversion.sql):
      R1. unit_type = 'pct'  → no conversion (fx_source = 'not_monetary')
      R2. currency = 'USD'   → identity      (fx_source = 'identity')
      R3. rate found         → amount / rate  (fx_source = 'exact')
      R4. nearest-year used  → amount / rate  (fx_source = 'carry_forward')
      R5. unknown currency   → NULL           (fx_source = 'unknown_currency')
    """
    if numeric_value is None:
        return None, None, "no_value"

    if unit_type == "pct":
        return numeric_value, None, "not_monetary"

    iso = currency.strip().upper()

    if iso == "USD":
        return round(numeric_value, 2), 1.0, "identity"

    if iso not in RATE_TABLE:
        return None, None, "unknown_currency"

    year_map = RATE_TABLE[iso]
    if year in year_map:
        rate   = year_map[year]
        source = "exact"
    else:
        nearest = min(year_map.keys(), key=lambda y: abs(y - year))
        rate    = year_map[nearest]
        source  = "carry_forward"

    if rate <= 0:
        return None, rate, "rate_invalid"

    return round(numeric_value / rate, 2), rate, source


# =============================================================================
# INTERNAL: determine unit_type from unit symbol
# =============================================================================

def _unit_type_from_symbol(unit: Optional[str]) -> str:
    if not unit:
        return "unknown"
    base = unit.replace("M", "").replace("K", "").replace("B", "").strip()
    if base == "%":
        return "pct"
    if base == "$":
        return "usd"
    return "unknown"


# =============================================================================
# INTERNAL: deterministic UUID from (extraction_id, metric_index)
# =============================================================================

def _make_row_id(extraction_id: Optional[str], idx: int) -> str:
    if extraction_id:
        seed = f"{extraction_id}:{idx}"
        return str(uuid.uuid5(uuid.NAMESPACE_OID, seed))
    return str(uuid.uuid4())


# =============================================================================
# PUBLIC API — transform()
# =============================================================================

def transform(raw: RawKpiExtraction) -> TransformResult:
    """
    Transform a raw KPI extraction into the canonical BigQuery contract.

    Quality rules applied per row, in order:
      1. Metric resolution  (R3) — canonical_metric_map()
      2. Numeric parsing    (R4) — parse_numeric() from data_contract.py
      3. FX conversion      (R4) — StaticFxProvider.to_usd()
      4. Period normalization(R5) — _normalize_period()
      5. Status assignment       — "ok" | "needs_review" | "error"

    Args:
        raw: A RawKpiExtraction produced by any document parser.

    Returns:
        TransformResult with populated submission metadata and kpi rows.
    """
    now_utc  = datetime.now(timezone.utc).isoformat()
    extr_id  = raw.extraction_id or str(uuid.uuid4())

    # ── R5: Period normalization ──────────────────────────────────────────────
    period_id, period_ok = _normalize_period(raw.period)
    period_year, _       = _period_to_year_month(period_id)

    # ── Company resolution ────────────────────────────────────────────────────
    company_id, portfolio_id, fund_id, company_bucket = _resolve_company(
        raw.company, raw.fund_hint,
    )

    # ── Submission metadata ───────────────────────────────────────────────────
    submission = SubmissionMeta(
        submission_id    = extr_id,
        company_id       = company_id,
        company_raw      = raw.company,
        portfolio_id     = portfolio_id,
        fund_id          = fund_id,
        bucket_id        = company_bucket,
        period_id        = period_id,
        period_raw       = raw.period,
        period_ok        = period_ok,
        currency         = raw.currency.strip().upper(),
        source_file      = raw.source_file,
        processed_at     = now_utc,
        pipeline_version = PIPELINE_VERSION,
    )

    # ── KPI rows ──────────────────────────────────────────────────────────────
    kpi_rows: list[KpiRow] = []

    for idx, raw_row in enumerate(raw.kpis):
        errors: list[str] = []

        # ── R3: Metric resolution ─────────────────────────────────────────────
        match: MetricMatch = canonical_metric_map(raw_row.metric_name)
        if not match.is_known:
            errors.append(
                f"Metric '{raw_row.metric_name}' not in catalog "
                f"(normalized: '{match.normalized}'). Assign a K-ID manually."
            )

        # ── R4a: Numeric parsing ──────────────────────────────────────────────
        numeric_value, unit = parse_numeric(raw_row.value)
        if numeric_value is None and raw_row.value.strip() not in ("", "null", "n/a", "---"):
            errors.append(
                f"Could not parse numeric value from '{raw_row.value}'. "
                f"Expected formats: '10.5M', '-36%', '$1.2B'."
            )

        # ── Unit type derivation ──────────────────────────────────────────────
        # Prefer catalog unit_type; fall back to parsed unit symbol.
        if match.is_known and match.unit_type in ("pct", "usd"):
            unit_type = match.unit_type
        else:
            unit_type = _unit_type_from_symbol(unit)
            if unit_type == "unknown" and numeric_value is not None:
                errors.append(
                    f"Unit '{unit}' could not be classified as 'pct' or 'usd'. "
                    f"FX conversion skipped."
                )

        # ── R4b: FX conversion ────────────────────────────────────────────────
        # Row-level currency overrides doc-level only when explicitly set (non-empty).
        # Empty string → inherit from the document envelope.
        # Note: the '$' symbol in raw values (e.g. "$10.5M") is a formatting
        # marker only; it does NOT imply USD when the document currency is MXN.
        effective_currency = (
            raw_row.currency.strip().upper()
            if raw_row.currency.strip()
            else raw.currency.strip().upper()
        )

        amount_usd, fx_rate, fx_source = _convert_to_usd(
            numeric_value, unit_type, effective_currency, period_year,
        )

        if unit_type == "usd" and amount_usd is None and numeric_value is not None:
            errors.append(
                f"FX conversion failed for currency '{effective_currency}' "
                f"(fx_source='{fx_source}'). Add rate to RATE_TABLE in fx_service.py."
            )

        # ── Status assignment ─────────────────────────────────────────────────
        # "error"        — metric unknown OR numeric unparseable
        # "needs_review" — metric known but period/FX has issues
        # "ok"           — all rules passed
        if not match.is_known or (numeric_value is None and raw_row.value.strip() not in ("", "null", "n/a", "---")):
            status = "error"
        elif not period_ok or fx_source in ("carry_forward", "unknown_currency", "rate_invalid"):
            status = "needs_review"
        else:
            status = "ok"

        # ── Bucket cross-check ────────────────────────────────────────────────
        # Warn if the metric's bucket doesn't match the company's bucket.
        if (match.is_known
                and match.bucket_id != "ALL"
                and company_bucket not in ("UNKNOWN", "OTH")
                and match.bucket_id != company_bucket):
            errors.append(
                f"Bucket mismatch: metric '{match.kpi_key}' belongs to "
                f"bucket '{match.bucket_id}' but company is '{company_bucket}'. "
                f"Check sector assignment."
            )
            if status == "ok":
                status = "needs_review"

        kpi_rows.append(KpiRow(
            kpi_row_id    = _make_row_id(extr_id, idx),
            metric_id     = match.metric_id,
            kpi_key       = match.kpi_key,
            kpi_label     = match.label,
            bucket_id     = match.bucket_id,
            raw_value     = raw_row.value,
            numeric_value = numeric_value,
            unit          = unit,
            unit_type     = unit_type,
            amount_usd    = amount_usd,
            fx_rate_used  = fx_rate,
            fx_source     = fx_source,
            value_status  = status,
            value_errors  = errors,
            notes         = raw_row.notes,
        ))

    return TransformResult(submission=submission, kpis=kpi_rows)


# =============================================================================
# PUBLIC API — export_audit_csv()
# =============================================================================

_CSV_SUBMISSION_FIELDS = [
    "submission_id", "company_id", "company_raw", "portfolio_id",
    "fund_id", "bucket_id", "period_id", "period_raw", "period_ok",
    "currency", "source_file", "processed_at", "pipeline_version",
]

_CSV_KPI_FIELDS = [
    "kpi_row_id", "metric_id", "kpi_key", "kpi_label", "bucket_id",
    "raw_value", "numeric_value", "unit", "unit_type",
    "amount_usd", "fx_rate_used", "fx_source",
    "value_status", "value_errors", "notes",
]


def export_audit_csv(result: TransformResult, path: str | Path) -> Path:
    """
    Export TransformResult to a flat CSV audit file before the final BQ load.

    The CSV contains one row per KPI, with submission metadata repeated on
    every row for easy filtering in Excel or a BI tool without JOINs.

    Args:
        result: Output of transform().
        path:   Destination file path (.csv). Parent directories are created.

    Returns:
        Resolved Path of the written file.
    """
    out = Path(path).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    sub_dict = asdict(result.submission)

    headers = _CSV_SUBMISSION_FIELDS + _CSV_KPI_FIELDS

    with out.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()

        for kpi in result.kpis:
            kpi_dict = asdict(kpi)
            # Flatten value_errors list to a pipe-delimited string
            kpi_dict["value_errors"] = " | ".join(kpi_dict["value_errors"]) if kpi_dict["value_errors"] else ""

            row = {f: sub_dict.get(f) for f in _CSV_SUBMISSION_FIELDS}
            row.update({f: kpi_dict.get(f) for f in _CSV_KPI_FIELDS})
            writer.writerow(row)

    return out


# =============================================================================
# SELF-TEST
# =============================================================================

if __name__ == "__main__":
    import sys

    # ── Fixture: simulated Excel extraction ───────────────────────────────────
    raw = RawKpiExtraction(
        company     = "simetrik.com",
        period      = "Q1 2025",
        currency    = "MXN",
        source_file = "Simetrik_Q1_2025_KPIs.xlsx",
        kpis=[
            RawKpiRow("Ventas Totales",          "$10.5M"),
            RawKpiRow("Margen Bruto",             "71%"),
            RawKpiRow("EBITDA",                   "-$1.2M"),
            RawKpiRow("Margen Operativo",         "-8%"),
            RawKpiRow("MRR",                      "$850K"),
            RawKpiRow("Tasa de Abandono",         "2.3%"),
            RawKpiRow("Costo de Adquisicion",     "$120"),
            RawKpiRow("Flujo de Caja",            "-$3.8M"),
            RawKpiRow("Caja y Bancos",            "$14.2M"),
            RawKpiRow("xyz_not_in_catalog",       "$999K"),   # should → K_UNKNOWN / error
            RawKpiRow("Revenue Growth",           "42%"),
            RawKpiRow("Facturación",              "n/a"),     # null value, should not crash
        ],
    )

    result = transform(raw)

    # ── Print summary ─────────────────────────────────────────────────────────
    s = result.submission
    print("=" * 68)
    print("  SUBMISSION")
    print("=" * 68)
    print(f"  submission_id  : {s.submission_id}")
    print(f"  company_id     : {s.company_id}  (raw: '{s.company_raw}')")
    print(f"  portfolio_id   : {s.portfolio_id}  fund_id: {s.fund_id}")
    print(f"  bucket_id      : {s.bucket_id}")
    print(f"  period_id      : {s.period_id}  (raw: '{s.period_raw}', ok={s.period_ok})")
    print(f"  currency       : {s.currency}")
    print(f"  pipeline_ver   : {s.pipeline_version}")

    print()
    print("=" * 68)
    print(f"  KPI ROWS  ({len(result.kpis)} total | "
          f"ok={result.ok_count} | review={result.review_count} | err={result.error_count})")
    print("=" * 68)
    print(f"  {'STATUS':<13} {'METRIC_ID':<11} {'KPI_KEY':<26} {'RAW':<14} "
          f"{'NUMERIC':>14} {'AMOUNT_USD':>12} {'FX_SRC'}")
    print(f"  {'-'*13} {'-'*11} {'-'*26} {'-'*14} {'-'*14} {'-'*12} {'-'*14}")

    for k in result.kpis:
        num_str = f"{k.numeric_value:>14,.2f}" if k.numeric_value is not None else f"{'None':>14}"
        usd_str = f"{k.amount_usd:>12,.2f}" if k.amount_usd is not None else f"{'None':>12}"
        print(f"  [{k.value_status:<11}] {k.metric_id:<11} {k.kpi_key:<26} "
              f"{k.raw_value:<14} {num_str} {usd_str}  {k.fx_source}")
        for err in k.value_errors:
            print(f"    [!] {err}")

    # ── Export CSV ────────────────────────────────────────────────────────────
    csv_path = export_audit_csv(result, "audit/simetrik_q1_2025_audit.csv")
    print()
    print(f"  Audit CSV: {csv_path}")
    print()

    # ── Assertions ────────────────────────────────────────────────────────────
    # Use raw_value to disambiguate rows with the same kpi_key
    def find(raw_val: str) -> KpiRow:
        return next(k for k in result.kpis if k.raw_value == raw_val)

    assert s.company_id   == "COMP_SIMETRIK",  f"company_id: {s.company_id}"
    assert s.period_id    == "P2025Q1M01",      f"period_id: {s.period_id}"
    assert s.fund_id      == "F002",            f"fund_id: {s.fund_id}"
    assert s.period_ok    is True
    assert s.portfolio_id == "CIII"

    # R3 + R4: "Ventas Totales" $10.5M MXN → K001, exact FX conversion
    rev = find("$10.5M")
    assert rev.metric_id    == "K001",                              f"metric_id: {rev.metric_id}"
    assert rev.unit_type    == "usd",                               f"unit_type: {rev.unit_type}"
    assert rev.fx_source    == "exact",                             f"fx_source: {rev.fx_source}"
    assert rev.amount_usd   == round(10_500_000 / 17.80, 2),       f"amount_usd: {rev.amount_usd}"
    assert rev.value_status == "ok"

    # R4 — % metrics are not converted
    gross = find("71%")
    assert gross.metric_id   == "K003"
    assert gross.unit_type   == "pct"
    assert gross.fx_source   == "not_monetary"
    assert gross.amount_usd  == 71.0       # passthrough, no FX applied
    assert gross.value_status == "ok"

    # R3 fallback — unknown metric → K_UNKNOWN + error status
    unknown = find("$999K")
    assert unknown.metric_id    == "K_UNKNOWN"
    assert unknown.value_status == "error"
    assert len(unknown.value_errors) >= 1

    # null value row — must not crash, numeric_value and amount_usd both None
    null_row = find("n/a")
    assert null_row.numeric_value is None
    assert null_row.amount_usd    is None

    print("  All assertions passed [OK]")
    print("=" * 68)
