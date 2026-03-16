"use client";

/**
 * SectorChecklist — "El Semáforo Sectorial"
 *
 * Visualiza el estado del checklist de KPIs sectoriales devuelto por /upload.
 * Diseño: glassmorphism + señales de colores por estado de KPI.
 *
 * Semáforo:
 *   Verde  — KPI presente y válido
 *   Amarillo — KPI presente pero con baja confianza
 *   Rojo   — KPI crítico faltante
 */

import "@/styles/cometa-branding.css";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChecklistStatus {
  bucket:                string;
  is_complete:           boolean;
  present_kpis:          string[];
  missing_critical_kpis: string[];
  display_message:       string;
}

interface SectorChecklistProps {
  checklistStatus:  ChecklistStatus;
  /** Optional confidence map keyed by kpi_key (0.0–1.0) */
  confidenceMap?:   Record<string, number>;
  className?:       string;
}

// ─── Label registry ───────────────────────────────────────────────────────────

const KPI_LABELS: Record<string, string> = {
  revenue:           "Revenue Total",
  ebitda:            "EBITDA",
  cogs:              "Costo de Ventas",
  revenue_growth:    "Crecimiento de Revenue",
  gross_profit_margin: "Margen Bruto",
  ebitda_margin:     "Margen EBITDA",
  cash_in_bank_end_of_year: "Caja Final",
  annual_cash_flow:  "Flujo de Caja Anual",
  working_capital_debt: "Deuda Capital Trabajo",
  mrr:               "MRR",
  churn_rate:        "Churn Rate",
  cac:               "CAC",
  portfolio_size:    "Cartera de Créditos",
  npl_ratio:         "NPL Ratio",
  gmv:               "GMV",
  loss_ratio:        "Loss Ratio",
};

const BUCKET_LABELS: Record<string, string> = {
  SAAS:  "SaaS",
  LEND:  "Lending",
  ECOM:  "E-Commerce",
  INSUR: "Insurtech",
  OTH:   "General",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function kpiLabel(key: string): string {
  return KPI_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type KpiStatus = "ok" | "warn" | "missing";

function getKpiStatus(
  kpiKey:        string,
  presentKpis:   string[],
  missingKpis:   string[],
  confidenceMap?: Record<string, number>,
): KpiStatus {
  if (missingKpis.includes(kpiKey)) return "missing";
  if (!presentKpis.includes(kpiKey)) return "missing";
  const conf = confidenceMap?.[kpiKey];
  if (conf !== undefined && conf < 0.70) return "warn";
  return "ok";
}

// ─── Dot indicator ────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: KpiStatus }) {
  const cfg = {
    ok:      { color: "#4ade80", shadow: "rgba(74,222,128,0.35)", label: "OK" },
    warn:    { color: "#fbbf24", shadow: "rgba(251,191,36,0.35)",  label: "Baja confianza" },
    missing: { color: "#f87171", shadow: "rgba(248,113,113,0.35)", label: "Faltante" },
  }[status];

  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{
        background:    cfg.color,
        boxShadow:     `0 0 6px 1px ${cfg.shadow}`,
      }}
      aria-label={cfg.label}
    />
  );
}

// ─── Icon: check / warn / x ───────────────────────────────────────────────────

function StatusIcon({ status }: { status: KpiStatus }) {
  if (status === "ok") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="cometa-check-appear flex-shrink-0">
        <circle cx="9" cy="9" r="8" stroke="#4ade80" strokeWidth="1" />
        <path d="M5.5 9L7.5 11L12.5 6.5" stroke="#4ade80" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (status === "warn") {
    return (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="cometa-check-appear flex-shrink-0">
        <circle cx="9" cy="9" r="8" stroke="rgba(251,191,36,0.7)" strokeWidth="1" />
        <path d="M9 5.5v4.5M9 12v.5" stroke="#fbbf24" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" className="flex-shrink-0">
      <circle cx="9" cy="9" r="8" stroke="rgba(248,113,113,0.4)" strokeWidth="1" />
      <path d="M6 6l6 6M12 6l-6 6" stroke="rgba(248,113,113,0.7)" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function CompletionBar({
  total,
  present,
  missing,
}: {
  total:   number;
  present: number;
  missing: number;
}) {
  const pct = total > 0 ? Math.round((present / total) * 100) : 0;
  const barColor =
    missing === 0  ? "#4ade80" :
    missing <= 1   ? "#fbbf24" :
                     "#f87171";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.14em] uppercase">
          Completitud
        </span>
        <span
          className="font-cometa-regular text-xs tabular-nums"
          style={{ color: barColor }}
        >
          {present}/{total}
        </span>
      </div>
      <div className="h-[3px] w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: barColor, boxShadow: `0 0 6px 1px ${barColor}40` }}
        />
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function SectorChecklist({
  checklistStatus,
  confidenceMap,
  className = "",
}: SectorChecklistProps) {
  const { bucket, is_complete, present_kpis, missing_critical_kpis, display_message } =
    checklistStatus;

  const bucketLabel   = BUCKET_LABELS[bucket] ?? bucket;
  const allRequired   = [...new Set([...present_kpis, ...missing_critical_kpis])];
  // Sort: present first, then missing
  const sortedKpis    = [
    ...present_kpis,
    ...missing_critical_kpis.filter((k) => !present_kpis.includes(k)),
  ];
  const totalRequired = allRequired.length;
  const presentCount  = present_kpis.length;

  // Header accent
  const headerAccent = is_complete
    ? "rgba(74,222,128,0.12)"
    : missing_critical_kpis.length > 1
    ? "rgba(248,113,113,0.08)"
    : "rgba(251,191,36,0.08)";

  const accentBorder = is_complete
    ? "rgba(74,222,128,0.18)"
    : missing_critical_kpis.length > 1
    ? "rgba(248,113,113,0.18)"
    : "rgba(251,191,36,0.18)";

  return (
    <div
      className={`cometa-fade-in rounded-xl overflow-hidden ${className}`}
      style={{ border: `1px solid ${accentBorder}`, background: "rgba(255,255,255,0.025)" }}
    >
      {/* Header */}
      <div
        className="px-5 py-4 flex items-center justify-between"
        style={{ background: headerAccent, borderBottom: `1px solid ${accentBorder}` }}
      >
        <div className="flex items-center gap-2.5">
          <StatusDot status={is_complete ? "ok" : missing_critical_kpis.length > 0 ? "missing" : "warn"} />
          <div>
            <span className="font-cometa-regular text-white/70 text-xs tracking-wide block">
              Checklist Sectorial — {bucketLabel}
            </span>
            <span className="font-cometa-extralight text-white/30 text-[10px] tracking-[0.12em] uppercase">
              {is_complete ? "Reporte completo" : "Datos faltantes"}
            </span>
          </div>
        </div>

        {/* Bucket badge */}
        <span
          className="font-cometa-extralight text-[10px] tracking-[0.16em] uppercase px-2.5 py-1 rounded-full"
          style={{
            color:      is_complete ? "#4ade80" : "#fbbf24",
            background: is_complete ? "rgba(74,222,128,0.08)" : "rgba(251,191,36,0.08)",
            border:     `1px solid ${is_complete ? "rgba(74,222,128,0.2)" : "rgba(251,191,36,0.2)"}`,
          }}
        >
          {bucket}
        </span>
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">

        {/* Progress bar */}
        <CompletionBar
          total={totalRequired}
          present={presentCount}
          missing={missing_critical_kpis.length}
        />

        {/* KPI list */}
        {sortedKpis.length > 0 && (
          <div className="space-y-2">
            {sortedKpis.map((kpiKey) => {
              const status = getKpiStatus(kpiKey, present_kpis, missing_critical_kpis, confidenceMap);
              const conf   = confidenceMap?.[kpiKey];

              return (
                <div
                  key={kpiKey}
                  className="flex items-center justify-between px-3 py-2.5 rounded-lg"
                  style={{
                    background: status === "ok"
                      ? "rgba(74,222,128,0.03)"
                      : status === "warn"
                      ? "rgba(251,191,36,0.04)"
                      : "rgba(248,113,113,0.04)",
                    border: `1px solid ${
                      status === "ok"    ? "rgba(74,222,128,0.08)" :
                      status === "warn"  ? "rgba(251,191,36,0.08)" :
                                          "rgba(248,113,113,0.08)"
                    }`,
                  }}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <StatusIcon status={status} />
                    <div className="min-w-0">
                      <span className="font-cometa-extralight text-white/55 text-xs block truncate">
                        {kpiLabel(kpiKey)}
                      </span>
                      {status === "warn" && conf !== undefined && (
                        <span className="font-cometa-extralight text-[10px]" style={{ color: "rgba(251,191,36,0.6)" }}>
                          Confianza: {(conf * 100).toFixed(0)}%
                        </span>
                      )}
                      {status === "missing" && (
                        <span className="font-cometa-extralight text-[10px] text-red-400/50">
                          No encontrado en el documento
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Status label */}
                  <span
                    className="font-cometa-extralight text-[10px] tracking-[0.12em] uppercase flex-shrink-0 ml-3"
                    style={{
                      color:
                        status === "ok"    ? "rgba(74,222,128,0.6)"  :
                        status === "warn"  ? "rgba(251,191,36,0.6)"  :
                                            "rgba(248,113,113,0.6)",
                    }}
                  >
                    {status === "ok" ? "OK" : status === "warn" ? "Revisar" : "Faltante"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Display message */}
        <div
          className="px-4 py-3 rounded-lg"
          style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}
        >
          <p className="font-cometa-extralight text-white/30 text-[11px] leading-relaxed tracking-wide">
            {display_message}
          </p>
        </div>
      </div>
    </div>
  );
}
