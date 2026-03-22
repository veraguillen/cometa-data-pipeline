#!/usr/bin/env python3
"""
audit_vault.py — Cometa Vault ETL Certification Audit
======================================================

Generates three terminal reports to certify that the 4,268 historical
records loaded into BigQuery are 100% faithful to the source Excel data.

Reports
-------
  A) TABLA DE CONTROL ANUAL  — sum of total revenue grouped by year + distinct company count
  B) REPORTE DE INTEGRIDAD   — row count by value_status (legacy / verified / missing_legacy)
  C) CHEQUEO DE DUPLICADOS   — (company_id, period_id, kpi_key) combinations that repeat

Usage
-----
  python audit_vault.py [--project GCP_PROJECT] [--dataset BQ_DATASET]

Credentials
-----------
  The script reads credentials from the environment via Application Default Credentials.
  Export GOOGLE_APPLICATION_CREDENTIALS or run:
      gcloud auth application-default login
"""

from __future__ import annotations

import argparse
import os
import sys
from typing import Any

# ── Default configuration ─────────────────────────────────────────────────────

DEFAULT_PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "cometa-429714")
DEFAULT_DATASET = os.getenv("BIGQUERY_DATASET",     "cometa_vault_test")

# ── Formatting helpers ────────────────────────────────────────────────────────

_SEP  = "─" * 68
_SEP2 = "═" * 68

def _usd(v: float | None) -> str:
    if v is None:
        return "—"
    if abs(v) >= 1_000_000:
        return f"${v / 1_000_000:>8.2f}M"
    if abs(v) >= 1_000:
        return f"${v / 1_000:>8.1f}K"
    return f"${v:>10.2f}"

def _bar(v: float, max_v: float, width: int = 24) -> str:
    if max_v <= 0:
        return "░" * width
    filled = round(v / max_v * width)
    return "█" * filled + "░" * (width - filled)

def _header(letter: str, title: str) -> None:
    print(f"\n{_SEP2}")
    print(f"  {letter})  {title}")
    print(_SEP2)

# ── BigQuery queries ──────────────────────────────────────────────────────────

def run_audit(project: str, dataset: str) -> int:
    """Run all three certification reports. Returns 0 on success, 1 on BQ error."""
    try:
        from google.cloud import bigquery
    except ImportError:
        print("\n[ERROR] google-cloud-bigquery not installed.")
        print("        pip install google-cloud-bigquery")
        return 1

    try:
        client = bigquery.Client(project=project)
    except Exception as exc:
        print(f"\n[ERROR] Cannot connect to BigQuery: {exc}")
        return 1

    tbl = f"`{project}.{dataset}.fact_kpi_values`"

    print(f"\n{_SEP2}")
    print(f"  COMETA VAULT — ETL CERTIFICATION AUDIT")
    print(f"  Project : {project}")
    print(f"  Dataset : {dataset}")
    print(_SEP2)

    # ─────────────────────────────────────────────────────────────────────────
    # A) TABLA DE CONTROL ANUAL
    # ─────────────────────────────────────────────────────────────────────────
    _header("A", "TABLA DE CONTROL ANUAL — Revenue total por año (2020–2025)")

    sql_a = f"""
        SELECT
            REGEXP_EXTRACT(period_id, r'P(20\\d{{2}})') AS year,
            SUM(COALESCE(normalized_value_usd, numeric_value))  AS total_revenue_usd,
            COUNT(DISTINCT company_id)                          AS companies,
            COUNT(*)                                            AS rows
        FROM {tbl}
        WHERE kpi_key IN ('revenue', 'mrr', 'arr')
          AND value_status IN ('legacy', 'verified')
          AND REGEXP_EXTRACT(period_id, r'P(20\\d{{2}})') IS NOT NULL
        GROUP BY year
        ORDER BY year
    """

    rows_a: list[Any] = list(client.query(sql_a).result())

    if not rows_a:
        print("\n  ⚠  Sin filas de revenue en la tabla. Verifica kpi_key y value_status.")
    else:
        max_rev = max(r.total_revenue_usd for r in rows_a if r.total_revenue_usd) or 1
        total_all = sum(r.total_revenue_usd or 0 for r in rows_a)

        print(f"\n  {'AÑO':<6}  {'REVENUE TOTAL USD':>18}  {'EMPRESAS':>9}  {'FILAS':>6}  {'BARRA'}")
        print(f"  {_SEP}")
        for r in rows_a:
            bar = _bar(r.total_revenue_usd or 0, max_rev)
            print(
                f"  {str(r.year):<6}  "
                f"{_usd(r.total_revenue_usd):>18}  "
                f"{str(r.companies) + ' cos':>9}  "
                f"{str(r.rows):>6}  "
                f"{bar}"
            )
        print(f"  {_SEP}")
        print(f"  {'TOTAL':<6}  {_usd(total_all):>18}  {'':>9}  {'':>6}")
        print(
            "\n  ► Compara la columna REVENUE TOTAL USD con tu Excel maestro."
            "\n  ► Si los totales coinciden por año: ETL certificado ✓"
        )

    # ─────────────────────────────────────────────────────────────────────────
    # B) REPORTE DE INTEGRIDAD
    # ─────────────────────────────────────────────────────────────────────────
    _header("B", "REPORTE DE INTEGRIDAD — Filas por value_status")

    sql_b = f"""
        SELECT
            value_status,
            COUNT(*)                AS rows,
            COUNT(DISTINCT company_id) AS companies,
            COUNT(DISTINCT kpi_key)    AS kpi_types
        FROM {tbl}
        GROUP BY value_status
        ORDER BY rows DESC
    """

    rows_b: list[Any] = list(client.query(sql_b).result())

    total_rows = sum(r.rows for r in rows_b)
    print(f"\n  {'STATUS':<20}  {'FILAS':>8}  {'%':>6}  {'EMPRESAS':>9}  {'KPI TYPES':>10}")
    print(f"  {_SEP}")

    for r in rows_b:
        pct = (r.rows / total_rows * 100) if total_rows else 0
        flag = ""
        if r.value_status == "missing_legacy":
            flag = "  ← falló el parse"
        print(
            f"  {str(r.value_status):<20}  "
            f"{str(r.rows):>8}  "
            f"{pct:>5.1f}%  "
            f"{str(r.companies):>9}  "
            f"{str(r.kpi_types):>10}"
            f"{flag}"
        )
    print(f"  {_SEP}")
    print(f"  {'TOTAL':<20}  {str(total_rows):>8}")

    missing_rows = next(
        (r.rows for r in rows_b if r.value_status == "missing_legacy"), 0
    )
    missing_pct = (missing_rows / total_rows * 100) if total_rows else 0
    print(
        f"\n  ► missing_legacy: {missing_rows} filas ({missing_pct:.1f}% del total)"
        f"\n  ► Estas filas no tienen valor numérico recuperable del origen."
    )
    if missing_pct > 5:
        print("  ⚠  Más del 5% de filas fallaron — revisar ETL antes de certificar.")
    else:
        print("  ✓  Tasa de pérdida dentro del umbral aceptable (<5%).")

    # ─────────────────────────────────────────────────────────────────────────
    # C) CHEQUEO DE DUPLICADOS
    # ─────────────────────────────────────────────────────────────────────────
    _header("C", "CHEQUEO DE DUPLICADOS — (company_id, period_id, kpi_key)")

    sql_c = f"""
        SELECT
            company_id,
            period_id,
            kpi_key,
            COUNT(*) AS occurrences
        FROM {tbl}
        GROUP BY company_id, period_id, kpi_key
        HAVING COUNT(*) > 1
        ORDER BY occurrences DESC, company_id, period_id, kpi_key
        LIMIT 50
    """

    rows_c: list[Any] = list(client.query(sql_c).result())

    if not rows_c:
        print("\n  ✓  Sin duplicados. Todas las combinaciones (company, period, kpi) son únicas.")
    else:
        total_dupes = sum(r.occurrences for r in rows_c)
        print(
            f"\n  ⚠  Se encontraron {len(rows_c)} combinaciones duplicadas "
            f"({total_dupes} filas en conflicto).\n"
        )
        print(f"  {'COMPANY':<28}  {'PERIOD':<14}  {'KPI KEY':<30}  {'VECES':>6}")
        print(f"  {_SEP}")
        for r in rows_c:
            print(
                f"  {str(r.company_id):<28}  "
                f"{str(r.period_id):<14}  "
                f"{str(r.kpi_key):<30}  "
                f"{str(r.occurrences):>6}"
            )
        print(
            "\n  ► Ejecuta el script de deduplicación antes de certificar el ETL."
        )

    # ─────────────────────────────────────────────────────────────────────────
    # Resumen final
    # ─────────────────────────────────────────────────────────────────────────
    print(f"\n{_SEP2}")
    print("  RESUMEN DE CERTIFICACIÓN")
    print(_SEP2)
    print(f"  Total filas analizadas : {total_rows:,}")
    print(f"  Duplicados encontrados : {len(rows_c)}")
    print(f"  Filas missing_legacy   : {missing_rows:,}  ({missing_pct:.1f}%)")

    passed = (len(rows_c) == 0) and (missing_pct <= 5)
    verdict = "✓  APTO PARA CERTIFICAR" if passed else "✗  REQUIERE CORRECCIÓN ANTES DE FIRMAR"
    print(f"\n  Veredicto: {verdict}")
    print(_SEP2 + "\n")

    return 0 if passed else 1


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Cometa Vault — ETL Certification Audit (3 reports)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--project", default=DEFAULT_PROJECT,
        help=f"GCP project ID (default: {DEFAULT_PROJECT})",
    )
    parser.add_argument(
        "--dataset", default=DEFAULT_DATASET,
        help=f"BigQuery dataset (default: {DEFAULT_DATASET})",
    )
    args = parser.parse_args()
    sys.exit(run_audit(project=args.project, dataset=args.dataset))
