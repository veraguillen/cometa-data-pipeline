"use client";

/**
 * FidelityAuditDetail — Vista completa de auditoría de fidelidad (Analista)
 * ──────────────────────────────────────────────────────────────────────────
 * Consume GET /api/audit/fidelity/{submission_id}
 *
 * Tres secciones:
 *   1. Identidad   — empresa en los 30 oficiales, bucket correcto
 *   2. Calculadora — Gemini vs Python, re-cálculo matemático, discrepancias
 *   3. Checklist   — completitud sectorial, KPIs faltantes
 */

import { useState, useEffect, useCallback } from "react";
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

interface FidelityAuditDetailProps {
  submissionId: string;
  /** Pre-fetched report — skip the fetch if already available */
  initialReport?: FidelityReport;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const KPI_LABEL: Record<string, string> = {
  revenue:           "Revenue",          ebitda:            "EBITDA",
  cogs:              "COGS",             revenue_growth:    "Revenue Growth",
  gross_profit_margin: "Gross Margin",   ebitda_margin:     "EBITDA Margin",
  cash_in_bank_end_of_year: "Cash in Bank",
  annual_cash_flow:  "Annual Cash Flow", working_capital_debt: "WC Debt",
  mrr:               "MRR",             churn_rate:        "Churn Rate",
  cac:               "CAC",             portfolio_size:    "Cartera",
  npl_ratio:         "NPL Ratio",       gmv:               "GMV",
  loss_ratio:        "Loss Ratio",
};

const BUCKET_LABEL: Record<string, string> = {
  SAAS:  "SaaS",     LEND:  "Lending",
  ECOM:  "E-Commerce", INSUR: "Insurtech", OTH: "General",
};

const BUCKET_COLOR: Record<string, string> = {
  SAAS:  "#7C3AED", LEND:  "#0EA5E9",
  ECOM:  "#F59E0B", INSUR: "#10B981", OTH: "#64CAE4",
};

// ─── Primitives ───────────────────────────────────────────────────────────────

function kl(key: string) {
  return KPI_LABEL[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function ConfidenceBar({ value, size = "md" }: { value: number; size?: "sm" | "md" }) {
  const pct    = Math.round(value * 100);
  const color  = value >= 0.85 ? "#4ade80" : value >= 0.70 ? "#fbbf24" : "#f87171";
  const height = size === "sm" ? "h-[2px]" : "h-[3px]";
  return (
    <div className="flex items-center gap-2">
      <div className={`${size === "sm" ? "w-12" : "w-20"} ${height} rounded-full overflow-hidden`}
        style={{ background: "rgba(255,255,255,0.07)" }}>
        <div className={`h-full rounded-full`} style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-cometa-extralight text-[10px] tabular-nums" style={{ color }}>{pct}%</span>
    </div>
  );
}

function Chip({
  label, color, bg, border,
}: { label: string; color: string; bg: string; border: string }) {
  return (
    <span
      className="inline-flex items-center font-cometa-extralight text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full"
      style={{ color, background: bg, border: `1px solid ${border}` }}
    >
      {label}
    </span>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      {[80, 60, 90, 50].map((w, i) => (
        <div key={i} className="h-3 rounded" style={{ width: `${w}%`, background: "rgba(255,255,255,0.06)" }} />
      ))}
    </div>
  );
}

// ─── Verdict banner ───────────────────────────────────────────────────────────

function VerdictBanner({ report }: { report: FidelityReport }) {
  const cfg = {
    PASS: {
      bg:     "rgba(74,222,128,0.06)",
      border: "rgba(74,222,128,0.2)",
      color:  "#4ade80",
      icon:   (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="9" stroke="#4ade80" strokeWidth="1" />
          <path d="M6.5 10L9 12.5L13.5 7.5" stroke="#4ade80" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
      title: "Auditoría Aprobada",
      desc:  "Los datos superaron todas las verificaciones de fidelidad",
    },
    WARN: {
      bg:     "rgba(251,191,36,0.06)",
      border: "rgba(251,191,36,0.2)",
      color:  "#fbbf24",
      icon:   (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="9" stroke="#fbbf24" strokeWidth="1" />
          <path d="M10 5.5v6M10 14v.5" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
      title: "Advertencias Detectadas",
      desc:  "El reporte es usable pero requiere revisión manual",
    },
    FAIL: {
      bg:     "rgba(248,113,113,0.06)",
      border: "rgba(248,113,113,0.2)",
      color:  "#f87171",
      icon:   (
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <circle cx="10" cy="10" r="9" stroke="#f87171" strokeWidth="1" />
          <path d="M7 7l6 6M13 7l-6 6" stroke="#f87171" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      ),
      title: "Errores Bloqueantes",
      desc:  "Se detectaron errores críticos que requieren corrección",
    },
  }[report.overall_status];

  return (
    <div
      className="flex items-center justify-between px-5 py-4 rounded-xl"
      style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
    >
      <div className="flex items-center gap-3">
        {cfg.icon}
        <div>
          <p className="font-cometa-regular text-white/80 text-sm">{cfg.title}</p>
          <p className="font-cometa-extralight text-white/30 text-xs mt-0.5">{cfg.desc}</p>
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 flex-shrink-0 ml-4">
        <span className="font-cometa-regular text-lg" style={{ color: cfg.color }}>
          {report.overall_status}
        </span>
        <div className="flex gap-2">
          {report.summary.errors > 0 && (
            <span className="font-cometa-extralight text-[10px] text-red-400/60">
              {report.summary.errors} error{report.summary.errors > 1 ? "es" : ""}
            </span>
          )}
          {report.summary.warnings > 0 && (
            <span className="font-cometa-extralight text-[10px] text-yellow-400/60">
              {report.summary.warnings} advertencia{report.summary.warnings > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── SECTION 1: Identity ──────────────────────────────────────────────────────

function IdentitySection({ ic }: { ic: IdentityCheck }) {
  const isVerified  = ic.in_dim_company && ic.bucket_match;
  const isNotFound  = !ic.in_dim_company;
  const isMismatch  = ic.in_dim_company && !ic.bucket_match;
  const bucket      = ic.bucket_in_db ?? ic.bucket_expected;

  const badgeCfg = isVerified
    ? { label: "Identidad Verificada", color: "#4ade80", bg: "rgba(74,222,128,0.08)", border: "rgba(74,222,128,0.2)" }
    : isNotFound
    ? { label: "Empresa No Encontrada", color: "#f87171", bg: "rgba(248,113,113,0.08)", border: "rgba(248,113,113,0.2)" }
    : { label: "Bucket Incorrecto", color: "#fbbf24", bg: "rgba(251,191,36,0.08)", border: "rgba(251,191,36,0.2)" };

  return (
    <div className="space-y-5">
      {/* Verification badge */}
      <div
        className="flex items-center justify-between px-4 py-3.5 rounded-xl"
        style={{ background: badgeCfg.bg, border: `1px solid ${badgeCfg.border}` }}
      >
        <span className="font-cometa-regular text-sm" style={{ color: badgeCfg.color }}>
          {badgeCfg.label}
        </span>
        {isVerified && (
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="8" stroke="#4ade80" strokeWidth="1" />
            <path d="M5.5 9L7.5 11L12.5 6.5" stroke="#4ade80" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: "Company ID",    value: ic.company_id },
          { label: "Company Key",   value: ic.company_key },
          { label: "Portfolio",     value: ic.portfolio_id || "—" },
          { label: "Período",       value: ic.period_id   || "—" },
          { label: "Estado",        value: ic.status },
          { label: "Versión",       value: ic.is_latest_version ? "Última (activa)" : "Histórica (archivada)" },
        ].map(({ label, value }) => (
          <div key={label} className="px-3 py-3 rounded-xl" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}>
            <span className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider block mb-1">{label}</span>
            <span className="font-cometa-regular text-white/60 text-xs">{value}</span>
          </div>
        ))}
      </div>

      {/* Bucket comparison */}
      <div
        className="px-4 py-4 rounded-xl space-y-3"
        style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}
      >
        <span className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider block">
          Verificación de Bucket / Vertical
        </span>
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <span className="font-cometa-extralight text-white/20 text-[10px] block mb-1">Registro Python</span>
            <Chip
              label={BUCKET_LABEL[ic.bucket_expected] ?? ic.bucket_expected}
              color={BUCKET_COLOR[ic.bucket_expected] ?? "#64CAE4"}
              bg={`${BUCKET_COLOR[ic.bucket_expected] ?? "#64CAE4"}14`}
              border={`${BUCKET_COLOR[ic.bucket_expected] ?? "#64CAE4"}30`}
            />
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="opacity-20">
            <path d="M4 8h8M10 5l3 3-3 3" stroke="white" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <span className="font-cometa-extralight text-white/20 text-[10px] block mb-1">BigQuery dim_company</span>
            {ic.bucket_in_db ? (
              <Chip
                label={BUCKET_LABEL[ic.bucket_in_db] ?? ic.bucket_in_db}
                color={ic.bucket_match ? "#4ade80" : "#f87171"}
                bg={ic.bucket_match ? "rgba(74,222,128,0.08)" : "rgba(248,113,113,0.08)"}
                border={ic.bucket_match ? "rgba(74,222,128,0.2)" : "rgba(248,113,113,0.2)"}
              />
            ) : (
              <span className="font-cometa-extralight text-white/20 text-xs">No encontrado en BQ</span>
            )}
          </div>
          {ic.bucket_match && (
            <span className="font-cometa-extralight text-[10px] text-green-400/50">✓ sincronizado</span>
          )}
        </div>
      </div>

      {/* Confidence */}
      {ic.avg_confidence !== null && (
        <div className="px-4 py-4 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="flex items-center justify-between mb-2">
            <span className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider">
              Confianza Promedio Gemini
            </span>
            <span className="font-cometa-regular text-xs" style={{
              color: ic.avg_confidence >= 0.85 ? "#4ade80" : ic.avg_confidence >= 0.70 ? "#fbbf24" : "#f87171"
            }}>
              {ic.status === "pending_human_review" ? "Requiere revisión humana" : "Automáticamente procesado"}
            </span>
          </div>
          <ConfidenceBar value={ic.avg_confidence} />
          <p className="font-cometa-extralight text-white/20 text-[10px] mt-2">
            Umbral de revisión automática: 85% · Umbral crítico: 70%
          </p>
        </div>
      )}

      {/* Findings */}
      <FindingsList findings={ic.findings} />
    </div>
  );
}

// ─── SECTION 2: Calculator ────────────────────────────────────────────────────

function CalculatorSection({ audit }: { audit: CalculatorAudit }) {
  const geminiRows = audit.kpi_rows.filter((r) => r.origin === "gemini"     && r.is_valid);
  const calcRows   = audit.kpi_rows.filter((r) => r.origin === "calculated");
  const mathRows   = audit.kpi_rows.filter((r) => r.recalculated_value !== null);

  return (
    <div className="space-y-6">

      {/* Discrepancy alert */}
      {audit.discrepancies > 0 && (
        <div
          className="flex items-start gap-3 px-4 py-4 rounded-xl cometa-fade-in"
          style={{ background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)" }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="flex-shrink-0 mt-0.5">
            <path d="M9 2L16.5 15H1.5L9 2z" stroke="#f87171" strokeWidth="1" strokeLinejoin="round" />
            <path d="M9 7v4M9 13v.5" stroke="#f87171" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <div>
            <p className="font-cometa-regular text-red-400/80 text-xs">
              {audit.discrepancies} discrepancia{audit.discrepancies > 1 ? "s" : ""} matemática{audit.discrepancies > 1 ? "s" : ""} detectada{audit.discrepancies > 1 ? "s" : ""}
            </p>
            <p className="font-cometa-extralight text-white/30 text-[11px] mt-1">
              Los valores reportados no coinciden con el re-cálculo desde las métricas base.
              Posible error en el reporte del founder.
            </p>
          </div>
        </div>
      )}

      {/* Two-column origin breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Gemini column */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="px-4 py-3 flex items-center gap-2" style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
            <span className="block w-2 h-2 rounded-full" style={{ background: "#a78bfa" }} />
            <span className="font-cometa-extralight text-white/35 text-[11px] tracking-wider uppercase">Extraído por Gemini</span>
            <span className="ml-auto font-cometa-extralight text-white/20 text-[10px]">{geminiRows.length} KPIs</span>
          </div>
          <div className="px-4 py-3 space-y-2.5">
            {geminiRows.length === 0 ? (
              <p className="font-cometa-extralight text-white/20 text-xs py-2">Sin KPIs extraídos directamente</p>
            ) : geminiRows.map((r) => (
              <div key={r.kpi_key} className="flex items-center justify-between">
                <span className="font-cometa-extralight text-white/45 text-xs">{kl(r.kpi_key)}</span>
                <div className="flex items-center gap-3">
                  <span className="font-cometa-regular text-white/70 text-xs tabular-nums">{r.raw_value ?? "—"}</span>
                  {r.confidence !== null && <ConfidenceBar value={r.confidence} size="sm" />}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Python column */}
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(96,165,250,0.15)" }}>
          <div className="px-4 py-3 flex items-center gap-2" style={{ background: "rgba(96,165,250,0.04)", borderBottom: "1px solid rgba(96,165,250,0.1)" }}>
            <span className="block w-2 h-2 rounded-full" style={{ background: "#60a5fa" }} />
            <span className="font-cometa-extralight text-[#60a5fa]/60 text-[11px] tracking-wider uppercase">Calculado por Python</span>
            <span className="ml-auto font-cometa-extralight text-white/20 text-[10px]">{calcRows.length} KPIs</span>
          </div>
          <div className="px-4 py-3 space-y-2.5">
            {calcRows.length === 0 ? (
              <p className="font-cometa-extralight text-white/20 text-xs py-2">Sin KPIs derivados (bases no disponibles)</p>
            ) : calcRows.map((r) => (
              <div key={r.kpi_key} className="flex items-center justify-between">
                <span className="font-cometa-extralight text-white/45 text-xs">{kl(r.kpi_key)}</span>
                <div className="flex items-center gap-2">
                  <span className="font-cometa-regular text-[#60a5fa]/70 text-xs tabular-nums">{r.raw_value ?? "—"}</span>
                  <span className="font-cometa-extralight text-[10px] text-[#60a5fa]/40 uppercase tracking-wider">calc</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Math re-verification table */}
      {mathRows.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="px-4 py-3" style={{ background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <span className="font-cometa-extralight text-white/30 text-[11px] tracking-wider uppercase">
              Re-verificación Matemática
            </span>
            <p className="font-cometa-extralight text-white/15 text-[10px] mt-0.5">
              Compara el valor almacenado contra el re-cálculo desde revenue + cogs/ebitda
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  {["KPI", "Fórmula", "Almacenado", "Re-calculado", "Delta", "Estado"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {mathRows.map((r) => {
                  const formula = r.kpi_key === "gross_profit_margin"
                    ? "(Revenue − COGS) ÷ Revenue"
                    : r.kpi_key === "ebitda_margin"
                    ? "EBITDA ÷ Revenue"
                    : "—";
                  const stColor = {
                    OK:    "#4ade80", WARN: "#fbbf24",
                    ERROR: "#f87171", "N/A": "rgba(255,255,255,0.2)",
                  }[r.calc_status];
                  const rowBg = r.calc_status === "ERROR"
                    ? "rgba(248,113,113,0.04)"
                    : r.calc_status === "WARN"
                    ? "rgba(251,191,36,0.03)"
                    : "transparent";
                  return (
                    <tr key={r.kpi_key} style={{ background: rowBg, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <td className="px-4 py-3 font-cometa-regular text-white/55 text-xs">{kl(r.kpi_key)}</td>
                      <td className="px-4 py-3 font-mono text-white/25 text-[10px]">{formula}</td>
                      <td className="px-4 py-3 font-cometa-extralight text-white/50 text-xs tabular-nums">{r.raw_value ?? "—"}</td>
                      <td className="px-4 py-3 font-cometa-extralight text-[#60a5fa]/60 text-xs tabular-nums">
                        {r.recalculated_value !== null
                          ? `${(r.recalculated_value * 100).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {r.delta_pct_points !== null ? (
                          <span className="font-cometa-extralight text-xs" style={{
                            color: r.delta_pct_points > 2 ? "#f87171" : r.delta_pct_points > 0.5 ? "#fbbf24" : "rgba(255,255,255,0.3)"
                          }}>
                            {r.delta_pct_points.toFixed(2)} pp
                          </span>
                        ) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className="font-cometa-regular text-[10px] uppercase tracking-wider" style={{ color: stColor }}>
                          {r.calc_status}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Findings */}
      <FindingsList findings={audit.findings} />
    </div>
  );
}

// ─── SECTION 3: Checklist ─────────────────────────────────────────────────────

function ChecklistSection({ diag }: { diag: ChecklistDiagnosis }) {
  const bucket      = diag.bucket;
  const color       = BUCKET_COLOR[bucket] ?? "#64CAE4";
  const totalReq    = diag.required_kpis.length;
  const totalOk     = diag.required_kpis.filter((k) => diag.present_valid_kpis.includes(k)).length;
  const pct         = totalReq > 0 ? Math.round((totalOk / totalReq) * 100) : 0;
  const extraKpis   = diag.present_valid_kpis.filter((k) => !diag.required_kpis.includes(k));

  return (
    <div className="space-y-5">

      {/* Bucket header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Chip
            label={BUCKET_LABEL[bucket] ?? bucket}
            color={color}
            bg={`${color}14`}
            border={`${color}30`}
          />
          <span className="font-cometa-extralight text-white/25 text-xs">
            {totalOk}/{totalReq} KPIs requeridos
          </span>
        </div>
        <span className="font-cometa-regular text-lg tabular-nums" style={{
          color: diag.is_complete ? "#4ade80" : totalOk > 0 ? "#fbbf24" : "#f87171"
        }}>
          {pct}%
        </span>
      </div>

      {/* Progress */}
      <div className="h-[4px] w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${pct}%`,
            background: diag.is_complete ? "#4ade80" : totalOk > 0 ? "#fbbf24" : "#f87171",
          }}
        />
      </div>

      {/* Required KPIs grid */}
      <div>
        <span className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider block mb-3">
          KPIs Requeridos para {BUCKET_LABEL[bucket] ?? bucket}
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {diag.required_kpis.map((kpiKey) => {
            const isPresent = diag.present_valid_kpis.includes(kpiKey);
            const isMissing = diag.missing_kpis.includes(kpiKey);
            const kColor    = isPresent ? "#4ade80" : "#f87171";
            return (
              <div
                key={kpiKey}
                className="flex items-center gap-2 px-3 py-2.5 rounded-lg"
                style={{
                  background: isPresent ? "rgba(74,222,128,0.04)" : "rgba(248,113,113,0.05)",
                  border:     `1px solid ${isPresent ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.15)"}`,
                }}
              >
                {isPresent ? (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="6" stroke="#4ade80" strokeWidth="1" />
                    <path d="M4 7L6 9L10 5.5" stroke="#4ade80" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="6" stroke="rgba(248,113,113,0.5)" strokeWidth="1" />
                    <path d="M5 5l4 4M9 5l-4 4" stroke="#f87171" strokeWidth="1.1" strokeLinecap="round" />
                  </svg>
                )}
                <span className="font-cometa-extralight text-xs" style={{ color: kColor }}>
                  {kl(kpiKey)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Missing KPIs highlight */}
      {diag.missing_kpis.length > 0 && (
        <div className="px-4 py-4 rounded-xl" style={{ background: "rgba(248,113,113,0.05)", border: "1px solid rgba(248,113,113,0.15)" }}>
          <p className="font-cometa-extralight text-red-400/60 text-[11px] mb-3">
            Los siguientes KPIs son críticos para el sector {BUCKET_LABEL[bucket] ?? bucket} y están ausentes:
          </p>
          <div className="flex flex-wrap gap-2">
            {diag.missing_kpis.map((k) => (
              <span
                key={k}
                className="font-cometa-regular text-[11px] px-3 py-1.5 rounded-full"
                style={{ color: "#f87171", background: "rgba(248,113,113,0.10)", border: "1px solid rgba(248,113,113,0.25)" }}
              >
                {kl(k)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Extra KPIs present (beyond required) */}
      {extraKpis.length > 0 && (
        <div>
          <span className="font-cometa-extralight text-white/15 text-[10px] uppercase tracking-wider block mb-2">
            KPIs adicionales detectados
          </span>
          <div className="flex flex-wrap gap-1.5">
            {extraKpis.map((k) => (
              <span
                key={k}
                className="font-cometa-extralight text-[10px] px-2.5 py-1 rounded-full"
                style={{ color: "rgba(100,202,228,0.5)", background: "rgba(100,202,228,0.06)", border: "1px solid rgba(100,202,228,0.12)" }}
              >
                {kl(k)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Display message */}
      <div className="px-4 py-3.5 rounded-xl" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
        <p className="font-cometa-extralight text-white/35 text-[11px] leading-relaxed">{diag.display_message}</p>
      </div>

      {/* Findings */}
      <FindingsList findings={diag.findings} />
    </div>
  );
}

// ─── Findings list ────────────────────────────────────────────────────────────

function FindingsList({ findings }: { findings: string[] }) {
  if (!findings.length) return null;
  return (
    <div className="space-y-1 pt-1">
      {findings.map((text, i) => {
        const isOk   = text.startsWith("OK");
        const isErr  = text.startsWith("ERROR");
        const isWarn = text.startsWith("WARN");
        const color  = isErr ? "#f87171" : isWarn ? "#fbbf24" : isOk ? "#4ade80" : "rgba(255,255,255,0.3)";
        return (
          <div key={i} className="flex items-start gap-2.5 py-1.5">
            <span className="mt-1.5 block w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
            <p className="font-cometa-extralight text-[11px] leading-relaxed" style={{ color }}>{text}</p>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tab navigation ───────────────────────────────────────────────────────────

type TabId = "identity" | "calculator" | "checklist";

function TabBar({
  active,
  onChange,
  report,
}: {
  active:   TabId;
  onChange: (t: TabId) => void;
  report:   FidelityReport;
}) {
  const tabs: Array<{ id: TabId; label: string; badge?: string; badgeColor?: string }> = [
    {
      id:    "identity",
      label: "1 · Identidad",
      badge: report.identity_check.in_dim_company && report.identity_check.bucket_match
        ? "OK" : "ERROR",
      badgeColor: report.identity_check.in_dim_company && report.identity_check.bucket_match
        ? "#4ade80" : "#f87171",
    },
    {
      id:    "calculator",
      label: "2 · Calculadora",
      badge: report.calculator_audit.discrepancies > 0
        ? `${report.calculator_audit.discrepancies} disc.` : undefined,
      badgeColor: "#fbbf24",
    },
    {
      id:    "checklist",
      label: "3 · Checklist",
      badge: report.checklist_diagnosis.is_complete ? undefined
        : `${report.checklist_diagnosis.missing_kpis.length} falt.`,
      badgeColor: "#f87171",
    },
  ];

  return (
    <div className="flex gap-1 p-1 rounded-xl" style={{ background: "rgba(255,255,255,0.03)" }}>
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg transition-all duration-200 text-xs font-cometa-extralight tracking-wide"
            style={{
              background: isActive ? "rgba(255,255,255,0.06)" : "transparent",
              color:      isActive ? "rgba(255,255,255,0.70)" : "rgba(255,255,255,0.25)",
            }}
          >
            <span>{tab.label}</span>
            {tab.badge && (
              <span
                className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full hidden sm:inline-flex"
                style={{ color: tab.badgeColor, background: `${tab.badgeColor}18`, border: `1px solid ${tab.badgeColor}30` }}
              >
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FidelityAuditDetail({ submissionId, initialReport }: FidelityAuditDetailProps) {
  const [report, setReport]   = useState<FidelityReport | null>(initialReport ?? null);
  const [loading, setLoading] = useState(!initialReport);
  const [error, setError]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("identity");

  const fetchReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/audit/fidelity/${submissionId}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.detail ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setReport(data as FidelityReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error desconocido");
    } finally {
      setLoading(false);
    }
  }, [submissionId]);

  useEffect(() => {
    if (!initialReport) fetchReport();
  }, [fetchReport, initialReport]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="cometa-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <span
            className="block w-4 h-4 rounded-full border border-[#64CAE4]/30"
            style={{ borderTopColor: "#64CAE4", animation: "cometa-spin 0.9s linear infinite" }}
          />
          <span className="font-cometa-extralight text-white/30 text-sm">Cargando auditoría de fidelidad…</span>
        </div>
        <Skeleton />
      </div>
    );
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (error || !report) {
    return (
      <div className="cometa-card p-6" style={{ borderColor: "rgba(248,113,113,0.15)" }}>
        <p className="font-cometa-extralight text-red-400/70 text-sm mb-4">
          {error ?? "No se pudo cargar el reporte"}
        </p>
        <button
          onClick={fetchReport}
          className="font-cometa-extralight text-white/60 text-[11px] uppercase tracking-wider hover:text-white transition-colors"
        >
          Reintentar
        </button>
      </div>
    );
  }

  // ── Report ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 cometa-fade-in">

      {/* Verdict banner */}
      <VerdictBanner report={report} />

      {/* Meta line */}
      <div className="flex items-center justify-between px-1">
        <p className="font-cometa-extralight text-white/20 text-[10px] tracking-wide">
          {report.identity_check.company_id} · {report.identity_check.period_id}
        </p>
        <p className="font-cometa-extralight text-white/15 text-[10px]">
          {new Date(report.audited_at).toLocaleString("es-MX", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit",
          })}
        </p>
      </div>

      {/* Tab bar */}
      <TabBar active={activeTab} onChange={setActiveTab} report={report} />

      {/* Tab content */}
      <div className="cometa-card p-5 md:p-6">
        {activeTab === "identity"    && <IdentitySection  ic={report.identity_check} />}
        {activeTab === "calculator"  && <CalculatorSection audit={report.calculator_audit} />}
        {activeTab === "checklist"   && <ChecklistSection  diag={report.checklist_diagnosis} />}
      </div>

      {/* Footer actions */}
      <div className="flex items-center justify-between px-1">
        <button
          onClick={fetchReport}
          className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider hover:text-white/40 transition-colors flex items-center gap-1.5"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M9.5 5.5A4 4 0 113.5 2M1.5 2h2v2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Actualizar
        </button>
        <button
          onClick={() => window.print()}
          className="font-cometa-extralight text-white/20 text-[10px] uppercase tracking-wider hover:text-white/40 transition-colors flex items-center gap-1.5"
        >
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect x="2" y="3.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1" />
            <path d="M3.5 3.5V2h4v1.5M3.5 8.5v1h4v-1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
          </svg>
          Exportar
        </button>
      </div>
    </div>
  );
}
