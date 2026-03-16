"use client";

/**
 * FidelityAuditPanel — Reporte de Fidelidad de Datos (Rol Analista)
 *
 * Consume GET /api/audit/fidelity/{submission_id} y presenta:
 *   1. Identity Check  — empresa en dim_company + bucket correcto
 *   2. Calculator Audit — Gemini vs Python derivado, re-cálculo matemático
 *   3. Checklist Diagnosis — KPIs sectoriales presentes/faltantes
 */

import { useState } from "react";
import "@/styles/cometa-branding.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface IdentityCheck {
  company_id:        string;
  company_key:       string;
  in_dim_company:    boolean;
  bucket_expected:   string;
  bucket_in_db:      string | null;
  bucket_match:      boolean;
  portfolio_id:      string;
  is_latest_version: boolean;
  period_id:         string;
  status:            string;
  avg_confidence:    number | null;
  findings:          string[];
}

interface KpiAuditRow {
  kpi_key:            string;
  origin:             "gemini" | "calculated";
  raw_value:          string | null;
  numeric_value:      number | null;
  confidence:         number | null;
  is_valid:           boolean;
  recalculated_value: number | null;
  delta_pct_points:   number | null;
  calc_status:        "OK" | "WARN" | "ERROR" | "N/A";
}

interface CalculatorAudit {
  kpi_rows:      KpiAuditRow[];
  discrepancies: number;
  findings:      string[];
}

interface ChecklistDiagnosis {
  bucket:             string;
  required_kpis:      string[];
  present_valid_kpis: string[];
  missing_kpis:       string[];
  is_complete:        boolean;
  display_message:    string;
  findings:           string[];
}

export interface FidelityReport {
  submission_id:       string;
  audited_at:          string;
  overall_status:      "PASS" | "WARN" | "FAIL";
  identity_check:      IdentityCheck;
  calculator_audit:    CalculatorAudit;
  checklist_diagnosis: ChecklistDiagnosis;
  summary: {
    total_findings: number;
    errors:         number;
    warnings:       number;
  };
}

interface FidelityAuditPanelProps {
  submissionId: string;
  companyId?:   string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const KPI_LABEL: Record<string, string> = {
  revenue:           "Revenue",      ebitda:            "EBITDA",
  cogs:              "COGS",         revenue_growth:    "Revenue Growth",
  gross_profit_margin: "Gross Margin", ebitda_margin:  "EBITDA Margin",
  cash_in_bank_end_of_year: "Cash in Bank",
  annual_cash_flow:  "Cash Flow",    working_capital_debt: "WC Debt",
  mrr:               "MRR",          churn_rate:        "Churn Rate",
  cac:               "CAC",          portfolio_size:    "Portfolio",
  npl_ratio:         "NPL Ratio",    gmv:               "GMV",
  loss_ratio:        "Loss Ratio",
};

function kl(key: string) {
  return KPI_LABEL[key] ?? key.replace(/_/g, " ");
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function OverallBadge({ status }: { status: "PASS" | "WARN" | "FAIL" }) {
  const cfg = {
    PASS: { bg: "rgba(74,222,128,0.10)", border: "rgba(74,222,128,0.25)", color: "#4ade80", label: "PASS" },
    WARN: { bg: "rgba(251,191,36,0.10)", border: "rgba(251,191,36,0.25)", color: "#fbbf24", label: "WARN" },
    FAIL: { bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.25)", color: "#f87171", label: "FAIL" },
  }[status];
  return (
    <span
      className="font-cometa-regular text-xs tracking-[0.16em] uppercase px-3 py-1.5 rounded-full"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}`, color: cfg.color }}
    >
      {cfg.label}
    </span>
  );
}

// ─── Collapsible section ──────────────────────────────────────────────────────

function Section({
  title,
  badge,
  children,
  defaultOpen = false,
}: {
  title:        string;
  badge?:       React.ReactNode;
  children:     React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{ border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}
    >
      <button
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between px-5 py-4 hover:bg-white/[0.02] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="font-cometa-extralight text-white/50 text-xs tracking-[0.14em] uppercase">{title}</span>
          {badge}
        </div>
        <svg
          width="14" height="14" viewBox="0 0 14 14" fill="none"
          className="transition-transform duration-200"
          style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
        >
          <path d="M2.5 5L7 9.5L11.5 5" stroke="rgba(255,255,255,0.3)" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="px-5 pb-5 cometa-fade-in" style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Finding row ──────────────────────────────────────────────────────────────

function FindingRow({ text }: { text: string }) {
  const isOk    = text.startsWith("OK");
  const isError = text.startsWith("ERROR");
  const isWarn  = text.startsWith("WARN");
  const color   = isError ? "#f87171" : isWarn ? "#fbbf24" : isOk ? "#4ade80" : "rgba(255,255,255,0.35)";
  return (
    <div className="flex items-start gap-2.5 py-2">
      <span className="mt-1 block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <p className="font-cometa-extralight text-[11px] leading-relaxed" style={{ color }}>
        {text}
      </p>
    </div>
  );
}

// ─── Calculator KPI table ─────────────────────────────────────────────────────

function CalcTable({ rows }: { rows: KpiAuditRow[] }) {
  const significant = rows.filter((r) => r.is_valid || r.recalculated_value !== null);
  if (!significant.length) return null;

  const statusColor = {
    OK:    "#4ade80",
    WARN:  "#fbbf24",
    ERROR: "#f87171",
    "N/A": "rgba(255,255,255,0.2)",
  };

  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-[11px]" style={{ borderCollapse: "separate", borderSpacing: "0 4px" }}>
        <thead>
          <tr>
            {["KPI", "Origen", "Valor Almacenado", "Recalculado", "Delta (pp)", "Estado"].map((h) => (
              <th
                key={h}
                className="font-cometa-extralight tracking-[0.1em] uppercase text-left pb-2 px-2"
                style={{ color: "rgba(255,255,255,0.2)", fontSize: "10px" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {significant.map((r) => (
            <tr
              key={r.kpi_key}
              style={{
                background:
                  r.calc_status === "ERROR" ? "rgba(248,113,113,0.05)" :
                  r.calc_status === "WARN"  ? "rgba(251,191,36,0.04)"  :
                  "rgba(255,255,255,0.015)",
              }}
            >
              <td className="px-2 py-2 font-cometa-regular text-white/60 rounded-l-lg">
                {kl(r.kpi_key)}
              </td>
              <td className="px-2 py-2">
                <span
                  className="font-cometa-extralight text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full"
                  style={{
                    color:      r.origin === "calculated" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.4)",
                    background: r.origin === "calculated" ? "rgba(100,202,228,0.08)" : "rgba(255,255,255,0.04)",
                  }}
                >
                  {r.origin === "calculated" ? "Python" : "Gemini"}
                </span>
              </td>
              <td className="px-2 py-2 font-cometa-extralight text-white/45 tabular-nums">
                {r.raw_value ?? "—"}
              </td>
              <td className="px-2 py-2 font-cometa-extralight text-white/45 tabular-nums">
                {r.recalculated_value !== null
                  ? `${(r.recalculated_value * 100).toFixed(2)}%`
                  : "—"}
              </td>
              <td className="px-2 py-2 font-cometa-extralight tabular-nums">
                {r.delta_pct_points !== null ? (
                  <span style={{ color: r.delta_pct_points > 2 ? "#f87171" : r.delta_pct_points > 0.5 ? "#fbbf24" : "rgba(255,255,255,0.3)" }}>
                    {r.delta_pct_points.toFixed(2)} pp
                  </span>
                ) : "—"}
              </td>
              <td className="px-2 py-2 font-cometa-regular text-[10px] uppercase tracking-wider rounded-r-lg"
                style={{ color: statusColor[r.calc_status] }}>
                {r.calc_status}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FidelityAuditPanel({ submissionId, companyId }: FidelityAuditPanelProps) {
  const [report, setReport]   = useState<FidelityReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [open, setOpen]       = useState(false);

  async function runAudit() {
    if (loading) return;
    setLoading(true);
    setError(null);
    setOpen(true);
    try {
      const res = await fetch(`${API_BASE}/api/audit/fidelity/${submissionId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.detail ?? `HTTP ${res.status}`);
        return;
      }
      const data = await res.json();
      setReport(data as FidelityReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error de conexión");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2">
      {/* Trigger button */}
      <button
        onClick={runAudit}
        disabled={loading}
        className="flex items-center gap-2 font-cometa-extralight text-[11px] tracking-[0.14em] uppercase transition-colors"
        style={{
          color: loading ? "rgba(255,255,255,0.2)" : "rgba(100,202,228,0.6)",
        }}
      >
        {loading ? (
          <>
            <span
              className="inline-block w-3 h-3 rounded-full border border-[#64CAE4]/30"
              style={{ borderTopColor: "#64CAE4", animation: "cometa-spin 0.9s linear infinite" }}
            />
            Auditando…
          </>
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" strokeWidth="1" />
              <path d="M4 6.5L6 8.5L9 5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Auditoría de Fidelidad
          </>
        )}
      </button>

      {/* Error */}
      {error && open && (
        <div className="mt-3 px-4 py-3 rounded-lg cometa-fade-in"
          style={{ background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.18)" }}>
          <p className="font-cometa-extralight text-red-400/70 text-xs">{error}</p>
        </div>
      )}

      {/* Report panel */}
      {report && open && (
        <div className="mt-4 space-y-3 cometa-fade-in">

          {/* Header */}
          <div className="flex items-center justify-between px-1">
            <div>
              <p className="font-cometa-regular text-white/60 text-xs">
                {companyId ?? report.identity_check.company_id}
              </p>
              <p className="font-cometa-extralight text-white/25 text-[10px] mt-0.5">
                {report.identity_check.period_id} · Auditado {new Date(report.audited_at).toLocaleString("es-MX")}
              </p>
            </div>
            <OverallBadge status={report.overall_status} />
          </div>

          {/* Summary chips */}
          <div className="flex gap-2 flex-wrap">
            {[
              { label: `${report.summary.errors} errores`,       color: "#f87171",  show: report.summary.errors > 0 },
              { label: `${report.summary.warnings} advertencias`, color: "#fbbf24",  show: report.summary.warnings > 0 },
              { label: "Sin hallazgos",                           color: "#4ade80",  show: report.summary.total_findings === 0 },
            ].filter((c) => c.show).map((c) => (
              <span
                key={c.label}
                className="font-cometa-extralight text-[10px] tracking-wider uppercase px-2.5 py-1 rounded-full"
                style={{ color: c.color, background: `${c.color}14`, border: `1px solid ${c.color}30` }}
              >
                {c.label}
              </span>
            ))}
          </div>

          {/* 1. Identity Check */}
          <Section
            title="1 · Verificación de Identidad"
            defaultOpen={!report.identity_check.in_dim_company || !report.identity_check.bucket_match}
            badge={
              <span className="text-[10px] font-cometa-extralight uppercase tracking-wider"
                style={{ color: report.identity_check.in_dim_company && report.identity_check.bucket_match ? "#4ade80" : "#f87171" }}>
                {report.identity_check.in_dim_company && report.identity_check.bucket_match ? "OK" : "ERROR"}
              </span>
            }
          >
            <div className="mt-4 grid grid-cols-2 gap-3">
              {[
                { label: "Empresa",      value: report.identity_check.company_id },
                { label: "Bucket DB",    value: report.identity_check.bucket_in_db ?? "—" },
                { label: "Bucket Reg.",  value: report.identity_check.bucket_expected },
                { label: "Portfolio",    value: report.identity_check.portfolio_id },
                { label: "Período",      value: report.identity_check.period_id },
                { label: "Estado",       value: report.identity_check.status },
                {
                  label: "Confianza avg",
                  value: report.identity_check.avg_confidence !== null
                    ? `${(report.identity_check.avg_confidence * 100).toFixed(1)}%`
                    : "—",
                },
                { label: "Versión",      value: report.identity_check.is_latest_version ? "Última" : "Histórica" },
              ].map(({ label, value }) => (
                <div key={label} className="px-3 py-2.5 rounded-lg" style={{ background: "rgba(255,255,255,0.025)" }}>
                  <span className="font-cometa-extralight text-white/25 text-[10px] uppercase tracking-wider block">{label}</span>
                  <span className="font-cometa-regular text-white/60 text-xs mt-0.5 block">{value}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-0.5">
              {report.identity_check.findings.map((f, i) => <FindingRow key={i} text={f} />)}
            </div>
          </Section>

          {/* 2. Calculator Audit */}
          <Section
            title="2 · Auditoría Matemática"
            defaultOpen={report.calculator_audit.discrepancies > 0}
            badge={
              report.calculator_audit.discrepancies > 0
                ? <span className="text-[10px] font-cometa-extralight text-yellow-400/70 uppercase tracking-wider">
                    {report.calculator_audit.discrepancies} discrepancia{report.calculator_audit.discrepancies > 1 ? "s" : ""}
                  </span>
                : undefined
            }
          >
            <div className="mt-4 space-y-1">
              {report.calculator_audit.findings.map((f, i) => <FindingRow key={i} text={f} />)}
            </div>
            <CalcTable rows={report.calculator_audit.kpi_rows} />
          </Section>

          {/* 3. Checklist Diagnosis */}
          <Section
            title="3 · Diagnóstico de Checklist"
            defaultOpen={!report.checklist_diagnosis.is_complete}
            badge={
              <span className="text-[10px] font-cometa-extralight uppercase tracking-wider"
                style={{ color: report.checklist_diagnosis.is_complete ? "#4ade80" : "#fbbf24" }}>
                {report.checklist_diagnosis.is_complete ? "Completo" : `${report.checklist_diagnosis.missing_kpis.length} faltante(s)`}
              </span>
            }
          >
            <div className="mt-4 space-y-1">
              {report.checklist_diagnosis.findings.map((f, i) => <FindingRow key={i} text={f} />)}
            </div>
            {report.checklist_diagnosis.missing_kpis.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {report.checklist_diagnosis.missing_kpis.map((k) => (
                  <span
                    key={k}
                    className="font-cometa-extralight text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full"
                    style={{ color: "#f87171", background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.18)" }}
                  >
                    {kl(k)}
                  </span>
                ))}
              </div>
            )}
          </Section>

          {/* Close */}
          <div className="text-right pt-1">
            <button
              onClick={() => setOpen(false)}
              className="font-cometa-extralight text-white/20 text-[10px] hover:text-white/40 transition-colors tracking-wider"
            >
              Cerrar reporte
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
