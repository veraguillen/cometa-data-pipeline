"use client";

/**
 * MissingDataPanel — shown after upload when checklist_status.is_complete === false.
 *
 * Displays each missing critical KPI as a labeled input.
 * The "Completar y Enviar" button is disabled until every field is filled.
 * On submit, calls onComplete(values) so UploadFlow transitions to success.
 *
 * Confidence scoring:
 *   - If a KPI's confidence_score < 90 (or absent): label in amber + amber border.
 *   - If confidence_score >= 90: normal styling.
 */

import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight } from "lucide-react";
import type { ChecklistStatus } from "@/lib/schemas";

// Human-readable labels for KPI keys
const KPI_LABELS: Record<string, string> = {
  mrr:                "MRR (Monthly Recurring Revenue)",
  arr:                "ARR (Annual Recurring Revenue)",
  churn_rate:         "Tasa de Churn (%)",
  revenue_growth:     "Crecimiento de Ingresos (%)",
  gross_margin:       "Margen Bruto (%)",
  ebitda:             "EBITDA",
  ebitda_margin:      "Margen EBITDA (%)",
  net_income:         "Resultado Neto",
  cash_in_bank:       "Efectivo en Caja",
  burn_rate:          "Burn Rate Mensual",
  cac:                "CAC (Costo Adquisición Cliente)",
  ltv:                "LTV (Lifetime Value)",
  total_revenue:      "Ingresos Totales",
  operating_expenses: "Gastos Operativos",
  npl_rate:           "Tasa de Morosidad (NPL %)",
  loan_book:          "Cartera de Crédito",
  gmv:                "GMV (Gross Merchandise Value)",
  take_rate:          "Take Rate (%)",
  claims_ratio:       "Ratio de Siniestralidad (%)",
  premium_volume:     "Volumen de Primas",
};

function kpiLabel(key: string): string {
  return KPI_LABELS[key]
    ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface MissingDataPanelProps {
  checklist:  ChecklistStatus;
  fileHash?:  string;
  onComplete: (values: Record<string, string>) => void;
}

export default function MissingDataPanel({
  checklist,
  fileHash,
  onComplete,
}: MissingDataPanelProps) {
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(checklist.missing_critical_kpis.map((k) => [k, ""])),
  );

  const allFilled = useMemo(
    () => checklist.missing_critical_kpis.every((k) => values[k]?.trim() !== ""),
    [values, checklist.missing_critical_kpis],
  );

  const bucketLabel: Record<string, string> = {
    SAAS:  "SaaS",
    LEND:  "Lending / Fintech",
    ECOM:  "E-commerce",
    INSUR: "Insurtech",
    OTH:   "General",
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md"
    >
      {/* Sector pill + warning */}
      <div
        className="mb-5 flex items-start gap-3 rounded-2xl px-4 py-3"
        style={{
          background: "color-mix(in srgb, #f59e0b 8%, transparent)",
          border:     "1px solid color-mix(in srgb, #f59e0b 18%, transparent)",
        }}
      >
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0">
          <p className="text-[11px] font-medium" style={{ color: "#f59e0b" }}>
            Sector: {bucketLabel[checklist.bucket] ?? checklist.bucket}
          </p>
          <p className="mt-0.5 text-[11px] font-light leading-relaxed"
             style={{ color: "var(--cometa-fg-muted)" }}>
            {checklist.display_message}
          </p>
        </div>
      </div>

      {/* Present KPIs recap (muted) */}
      {checklist.present_kpis.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {checklist.present_kpis.map((k) => (
            <span
              key={k}
              className="rounded-full px-2.5 py-0.5 text-[9px] uppercase tracking-wider"
              style={{
                background: "color-mix(in srgb, #34d399 10%, transparent)",
                color:      "#34d399",
              }}
            >
              ✓ {k.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      {/* Missing KPI inputs */}
      <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em]"
         style={{ color: "var(--cometa-fg-muted)" }}>
        Campos requeridos faltantes
      </p>

      <div className="space-y-3">
        {checklist.missing_critical_kpis.map((key) => {
          const filled      = values[key]?.trim() !== "";
          // confidence_scores are 0–100; treat absent as low confidence
          const rawScore    = checklist.confidence_scores?.[key];
          const isLowConf   = rawScore === undefined || rawScore < 90;

          return (
            <div key={key}>
              <label
                htmlFor={`kpi-${key}`}
                className={`mb-1 block text-[10px] font-medium uppercase tracking-[0.12em] ${isLowConf ? "text-kpi-neutral" : ""}`}
                style={isLowConf ? { color: "#fbbf24" } : { color: "var(--cometa-fg-muted)" }}
              >
                {kpiLabel(key)}
                {isLowConf && rawScore !== undefined && (
                  <span className="ml-1 text-[9px] normal-case tracking-normal opacity-70">
                    ({rawScore}% confianza)
                  </span>
                )}
              </label>
              <input
                id={`kpi-${key}`}
                type="text"
                value={values[key]}
                onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder="Introduce el valor…"
                className="w-full rounded-xl px-4 py-2.5 text-[13px] font-light outline-none transition-all"
                style={{
                  background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                  border: filled
                    ? `1px solid color-mix(in srgb, var(--cometa-accent) 45%, transparent)`
                    : isLowConf
                      ? "1px solid #fbbf24"
                      : "1px solid var(--cometa-card-border)",
                  color: "var(--cometa-fg)",
                }}
              />
            </div>
          );
        })}
      </div>

      {/* Submit — complete and send */}
      <button
        disabled={!allFilled}
        onClick={() => { if (allFilled) onComplete(values); }}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl py-3 text-[13px] font-medium tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-30"
        style={{
          background: allFilled ? "var(--cometa-accent)" : "color-mix(in srgb, var(--cometa-accent) 15%, transparent)",
          color:      allFilled ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
        }}
      >
        Completar y Enviar
        <ArrowRight size={14} />
      </button>
    </motion.div>
  );
}
