"use client";

/**
 * SmartChecklistFounder — Guía sectorial interactiva para el founder
 * ─────────────────────────────────────────────────────────────────────
 * Lógica:
 *   1. Recibe el bucket_id de la empresa (SAAS/LEND/ECOM/INSUR/OTH).
 *   2. Cruza los KPIs extraídos por Gemini contra los requerimientos del sector.
 *   3. Muestra semáforo: Verde (ok) · Amarillo (baja confianza) · Rojo (faltante).
 *   4. Formulario inline para que el founder complete los KPIs faltantes.
 *   5. CTA "Confirmar Reporte" — activo solo cuando el checklist está completo.
 */

import { useState, useMemo } from "react";
import ConfirmSubmitButton from "@/components/ConfirmSubmitButton";
import "@/styles/cometa-branding.css";

// ─── Shared types (re-exported for parent components) ─────────────────────────

export interface ChecklistStatus {
  bucket:                string;
  is_complete:           boolean;
  present_kpis:          string[];
  missing_critical_kpis: string[];
  display_message:       string;
}

export interface KpiRow {
  kpi_key:        string;
  raw_value:      string | null;
  numeric_value:  number | null;
  confidence:     number | null;
  is_valid:       boolean;
  source_description?: string | null;
}

interface SmartChecklistFounderProps {
  /** SAAS | LEND | ECOM | INSUR | OTH */
  bucketId:        string;
  checklistStatus: ChecklistStatus;
  /** Individual KPI rows with confidence — from /upload response kpi_rows field */
  kpiRows?:        KpiRow[];
  companyId?:      string;
  submissionId?:   string;
  portfolioId?:    string;
  periodId?:       string;
  founderEmail?:   string;
  /** Called when founder clicks "Confirmar Reporte" */
  onConfirm?:      () => void;
}

// ─── Sector data ──────────────────────────────────────────────────────────────

const SECTOR_META: Record<string, { label: string; description: string; color: string }> = {
  SAAS:  { label: "SaaS",         description: "Software as a Service — modelo de ingresos recurrentes",  color: "#7C3AED" },
  LEND:  { label: "Lending",      description: "Fintech de crédito — cartera y calidad de cartera",        color: "#0EA5E9" },
  ECOM:  { label: "E-Commerce",   description: "Comercio electrónico — volumen y adquisición de clientes", color: "#F59E0B" },
  INSUR: { label: "Insurtech",    description: "Seguros digitales — siniestralidad y adquisición",         color: "#10B981" },
  OTH:   { label: "General",      description: "Modelo de negocio diversificado",                          color: "#64CAE4" },
};

const KPI_META: Record<string, { label: string; hint: string; unit: "pct" | "usd" | "num"; example: string; why: string }> = {
  revenue:        { label: "Revenue Total",       hint: "Ingresos totales del período",           unit: "usd", example: "$4.2M",    why: "Base para todos los ratios de rentabilidad" },
  ebitda:         { label: "EBITDA",              hint: "Ganancia antes de intereses, impuestos", unit: "usd", example: "-$0.8M",  why: "Proxy de rentabilidad operativa" },
  cogs:           { label: "Costo de Ventas",     hint: "Costo directo de producción/servicio",  unit: "usd", example: "$1.3M",   why: "Necesario para calcular margen bruto" },
  revenue_growth: { label: "Crecimiento Revenue", hint: "Crecimiento YoY",                       unit: "pct", example: "36%",     why: "Indicador clave de tracción" },
  gross_profit_margin: { label: "Margen Bruto",   hint: "Eficiencia de producción",              unit: "pct", example: "68%",     why: "Calidad del modelo de negocio" },
  ebitda_margin:  { label: "Margen EBITDA",       hint: "Rentabilidad operativa",                unit: "pct", example: "-12%",    why: "Eficiencia operacional" },
  mrr:            { label: "MRR",                 hint: "Monthly Recurring Revenue",             unit: "usd", example: "$350K",   why: "Pilar del modelo SaaS — predecibilidad de ingresos" },
  churn_rate:     { label: "Churn Rate",          hint: "Tasa mensual de cancelación",           unit: "pct", example: "2.1%",   why: "Salud de la retención de clientes" },
  cac:            { label: "CAC",                 hint: "Costo de adquisición por cliente",      unit: "usd", example: "$120",    why: "Eficiencia del canal de ventas" },
  portfolio_size: { label: "Cartera de Créditos", hint: "Cartera total activa",                  unit: "usd", example: "$25M",    why: "Tamaño del libro de crédito" },
  npl_ratio:      { label: "NPL Ratio",           hint: "Non-Performing Loans / Cartera total",  unit: "pct", example: "3.4%",   why: "Calidad crediticia de la cartera" },
  gmv:            { label: "GMV",                 hint: "Gross Merchandise Value procesado",     unit: "usd", example: "$8.5M",  why: "Volumen total de transacciones" },
  loss_ratio:     { label: "Loss Ratio",          hint: "Siniestralidad / Primas devengadas",    unit: "pct", example: "62%",    why: "Rentabilidad técnica del seguro" },
  cash_in_bank_end_of_year: { label: "Caja Final", hint: "Efectivo al cierre del período",      unit: "usd", example: "$9.7M",  why: "Liquidez y runway" },
  annual_cash_flow: { label: "Flujo de Caja",     hint: "Cash Flow anual neto",                  unit: "usd", example: "-$3.2M", why: "Capacidad de autofinanciamiento" },
  working_capital_debt: { label: "Deuda Trabajo",  hint: "Deuda de capital de trabajo",          unit: "usd", example: "$1.1M",  why: "Estructura de financiamiento de corto plazo" },
};

// ─── Sector grouping ──────────────────────────────────────────────────────────

/** KPIs visible for every bucket — financial fundamentals */
const BASE_KPI_KEYS: readonly string[] = [
  "revenue", "ebitda", "cogs",
  "revenue_growth", "gross_profit_margin", "ebitda_margin",
  "cash_in_bank_end_of_year", "annual_cash_flow", "working_capital_debt",
];

/** KPIs shown ONLY when the company belongs to the matching vertical */
const SECTOR_KPI_MAP: Record<string, readonly string[]> = {
  SAAS:  ["mrr", "churn_rate", "cac"],
  ECOM:  ["gmv", "cac"],
  LEND:  ["portfolio_size", "npl_ratio"],
  INSUR: ["loss_ratio", "cac"],
  OTH:   [],
};

// ─── Status types ─────────────────────────────────────────────────────────────

type KpiStatus = "ok" | "calculated" | "low_conf" | "missing";

interface KpiStatusInfo {
  status:     KpiStatus;
  rawValue:   string | null;
  confidence: number | null;
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconCheck() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="8" stroke="#4ade80" strokeWidth="1" />
      <path d="M5.5 9L7.5 11L12.5 6" stroke="#4ade80" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCalc() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="8" stroke="#60a5fa" strokeWidth="1" />
      <path d="M6 9h6M9 6v6" stroke="#60a5fa" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconWarn() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="8" stroke="#fbbf24" strokeWidth="1" />
      <path d="M9 5.5v5M9 12.5v.3" stroke="#fbbf24" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconMissing() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="8" stroke="rgba(248,113,113,0.5)" strokeWidth="1" />
      <path d="M6 6l6 6M12 6l-6 6" stroke="#f87171" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// ─── Confidence bar ───────────────────────────────────────────────────────────

function ConfBar({ value }: { value: number }) {
  const pct   = Math.round(value * 100);
  const color = value >= 0.85 ? "#4ade80" : value >= 0.70 ? "#fbbf24" : "#f87171";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-[3px] rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="font-cometa-extralight text-[10px] tabular-nums" style={{ color }}>{pct}%</span>
    </div>
  );
}

// ─── Sector header ────────────────────────────────────────────────────────────

function SectorHeader({ bucketId, totalRequired, totalPresent }: {
  bucketId:      string;
  totalRequired: number;
  totalPresent:  number;
}) {
  const meta      = SECTOR_META[bucketId] ?? SECTOR_META.OTH;
  const pct       = totalRequired > 0 ? Math.round((totalPresent / totalRequired) * 100) : 0;
  const isComplete = totalPresent >= totalRequired;

  return (
    <div className="mb-6">
      {/* Sector badge */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <span
            className="font-cometa-regular text-[10px] tracking-[0.18em] uppercase px-3 py-1.5 rounded-full"
            style={{
              color:      meta.color,
              background: `${meta.color}14`,
              border:     `1px solid ${meta.color}30`,
            }}
          >
            {meta.label}
          </span>
          <span className="font-cometa-extralight text-white/25 text-xs hidden sm:block">
            {meta.description}
          </span>
        </div>
        <span
          className="font-cometa-regular text-sm tabular-nums"
          style={{ color: isComplete ? "#4ade80" : totalPresent > 0 ? "#fbbf24" : "#f87171" }}
        >
          {totalPresent}<span className="text-white/20 font-cometa-extralight">/{totalRequired}</span>
        </span>
      </div>

      {/* Progress bar */}
      <div className="space-y-1.5">
        <div className="h-[3px] w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{
              width:      `${pct}%`,
              background: isComplete ? "#4ade80" : totalPresent > 0 ? "#fbbf24" : "#f87171",
              boxShadow:  `0 0 8px ${isComplete ? "#4ade8040" : "#fbbf2440"}`,
            }}
          />
        </div>
        <p className="font-cometa-extralight text-white/20 text-[10px] tracking-wide">
          {isComplete
            ? "Todos los KPIs críticos del sector están presentes"
            : `Faltan ${totalRequired - totalPresent} KPI${totalRequired - totalPresent > 1 ? "s" : ""} requeridos para este sector`}
        </p>
      </div>
    </div>
  );
}

// ─── KPI row ──────────────────────────────────────────────────────────────────

function KpiStatusRow({
  kpiKey,
  statusInfo,
  isRequired,
  manualValue,
  onManualChange,
  showWhy,
  onToggleWhy,
}: {
  kpiKey:         string;
  statusInfo:     KpiStatusInfo;
  isRequired:     boolean;
  manualValue:    string;
  onManualChange: (v: string) => void;
  showWhy:        boolean;
  onToggleWhy:    () => void;
}) {
  const meta = KPI_META[kpiKey] ?? {
    label: kpiKey.replace(/_/g, " "), hint: "", unit: "usd" as const, example: "", why: "",
  };

  const { status, rawValue, confidence } = statusInfo;

  const rowBg = {
    ok:         "rgba(74,222,128,0.03)",
    calculated: "rgba(96,165,250,0.04)",
    low_conf:   "rgba(251,191,36,0.04)",
    missing:    "rgba(248,113,113,0.04)",
  }[status];

  const rowBorder = {
    ok:         "rgba(74,222,128,0.10)",
    calculated: "rgba(96,165,250,0.12)",
    low_conf:   "rgba(251,191,36,0.12)",
    missing:    "rgba(248,113,113,0.12)",
  }[status];

  const statusLabel = {
    ok:         "Detectado",
    calculated: "Calculado",
    low_conf:   "Revisar",
    missing:    "Faltante",
  }[status];

  const statusColor = {
    ok:         "#4ade80",
    calculated: "#60a5fa",
    low_conf:   "#fbbf24",
    missing:    "#f87171",
  }[status];

  return (
    <div
      className="rounded-xl overflow-hidden transition-all duration-200"
      style={{ background: rowBg, border: `1px solid ${rowBorder}` }}
    >
      {/* Main row */}
      <div className="flex items-center gap-3 px-4 py-3.5">
        {/* Icon */}
        <div className="flex-shrink-0">
          {status === "ok"         && <IconCheck />}
          {status === "calculated" && <IconCalc />}
          {status === "low_conf"   && <IconWarn />}
          {status === "missing"    && <IconMissing />}
        </div>

        {/* Label + value */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-cometa-extralight text-white/60 text-xs">
              {meta.label}
            </span>
            {isRequired && (
              <span className="font-cometa-extralight text-[9px] tracking-[0.12em] uppercase text-white/20">
                requerido
              </span>
            )}
          </div>
          {rawValue && status !== "missing" && (
            <span className="font-cometa-regular text-sm mt-0.5 block" style={{ color: statusColor }}>
              {rawValue}
            </span>
          )}
          {status === "low_conf" && confidence !== null && (
            <div className="mt-1">
              <ConfBar value={confidence} />
            </div>
          )}
        </div>

        {/* Right: status + why button */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <span
            className="font-cometa-extralight text-[10px] tracking-[0.12em] uppercase"
            style={{ color: statusColor }}
          >
            {statusLabel}
          </span>
          {meta.why && (
            <button
              onClick={onToggleWhy}
              className="text-white/15 hover:text-white/40 transition-colors"
              aria-label="Por qué se requiere este KPI"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="1" />
                <path d="M7 4.5v.5M7 6.5v3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Why tooltip */}
      {showWhy && meta.why && (
        <div
          className="px-4 pb-3 cometa-fade-in"
          style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
        >
          <p className="font-cometa-extralight text-white/30 text-[11px] leading-relaxed mt-2">
            {meta.why}
          </p>
        </div>
      )}

      {/* Manual input for missing KPIs */}
      {status === "missing" && (
        <div
          className="px-4 pb-4 cometa-fade-in"
          style={{ borderTop: "1px solid rgba(248,113,113,0.08)" }}
        >
          <label className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.14em] uppercase block mt-3 mb-2">
            Ingresar manualmente · {meta.hint}
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={manualValue}
              onChange={(e) => onManualChange(e.target.value)}
              placeholder={meta.example}
              className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5
                         font-cometa-extralight text-white text-sm
                         placeholder:text-white/15
                         focus:outline-none focus:border-[#64CAE4]/50
                         transition-all duration-200"
            />
            {manualValue.trim() && (
              <span className="flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="7" stroke="#4ade80" strokeWidth="1" />
                  <path d="M5 8L7 10L11 6" stroke="#4ade80" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────

function Legend() {
  const items: Array<{ color: string; label: string; desc: string }> = [
    { color: "#4ade80", label: "Detectado",  desc: "extraído del PDF" },
    { color: "#60a5fa", label: "Calculado",  desc: "derivado por la plataforma" },
    { color: "#fbbf24", label: "Revisar",    desc: "confianza baja — confirma el dato" },
    { color: "#f87171", label: "Faltante",   desc: "KPI crítico no encontrado" },
  ];
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 mb-6 px-1">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1.5">
          <span className="block w-2 h-2 rounded-full" style={{ background: i.color }} />
          <span className="font-cometa-extralight text-white/30 text-[10px]">
            <span style={{ color: i.color }}>{i.label}</span>
            <span className="hidden sm:inline"> — {i.desc}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── KPI group section ────────────────────────────────────────────────────────

function KpiGroupSection({
  title,
  accentColor = "rgba(100,202,228,0.6)",
  kpiKeys,
  kpiStatusMap,
  requiredSet,
  manualValues,
  whyOpen,
  onManualChange,
  onToggleWhy,
}: {
  title:          string;
  accentColor?:   string;
  kpiKeys:        string[];
  kpiStatusMap:   Record<string, KpiStatusInfo>;
  requiredSet:    Set<string>;
  manualValues:   Record<string, string>;
  whyOpen:        Record<string, boolean>;
  onManualChange: (key: string, value: string) => void;
  onToggleWhy:    (key: string) => void;
}) {
  if (kpiKeys.length === 0) return null;

  return (
    <div>
      {/* Group heading */}
      <div className="flex items-center gap-2.5 mb-3">
        <span
          className="block w-0.5 h-3.5 rounded-full flex-shrink-0"
          style={{ background: accentColor }}
        />
        <span
          className="font-cometa-extralight text-[10px] tracking-[0.18em] uppercase"
          style={{ color: accentColor }}
        >
          {title}
        </span>
        <span className="ml-auto font-cometa-extralight text-white/20 text-[10px] tabular-nums">
          {kpiKeys.length}
        </span>
      </div>

      {/* KPI rows */}
      <div className="space-y-2.5">
        {kpiKeys.map((kpiKey) => {
          const statusInfo = kpiStatusMap[kpiKey] ?? {
            status:     "missing" as KpiStatus,
            rawValue:   null,
            confidence: null,
          };
          return (
            <KpiStatusRow
              key={kpiKey}
              kpiKey={kpiKey}
              statusInfo={statusInfo}
              isRequired={requiredSet.has(kpiKey)}
              manualValue={manualValues[kpiKey] ?? ""}
              onManualChange={(v) => onManualChange(kpiKey, v)}
              showWhy={!!whyOpen[kpiKey]}
              onToggleWhy={() => onToggleWhy(kpiKey)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Strip currency/comma formatting and return a clean numeric string, or null. */
function sanitizeKpiValue(raw: string): string | null {
  const cleaned = raw.replace(/[$,%\s]/g, "").trim();
  if (cleaned === "" || cleaned === "-" || isNaN(Number(cleaned))) return null;
  return cleaned;
}

export default function SmartChecklistFounder({
  bucketId,
  checklistStatus,
  kpiRows = [],
  companyId,
  submissionId,
  portfolioId,
  periodId = "FY2025",
  founderEmail,
  onConfirm,
}: SmartChecklistFounderProps) {
  const [manualValues, setManualValues] = useState<Record<string, string>>({});
  const [whyOpen, setWhyOpen]           = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving]         = useState(false);
  const [savedKeys, setSavedKeys]       = useState<Set<string>>(new Set());
  const [saveError, setSaveError]       = useState<string | null>(null);
  const [confirmed, setConfirmed]       = useState(false);

  // Build KPI status map from kpiRows
  const kpiStatusMap = useMemo<Record<string, KpiStatusInfo>>(() => {
    const map: Record<string, KpiStatusInfo> = {};
    for (const r of kpiRows) {
      const isCalc = (r.source_description ?? "").includes("calculated");
      let status: KpiStatus;
      if (!r.is_valid || r.numeric_value === null)       status = "missing";
      else if (isCalc)                                    status = "calculated";
      else if (r.confidence !== null && r.confidence < 0.70) status = "low_conf";
      else                                                status = "ok";
      map[r.kpi_key] = { status, rawValue: r.raw_value, confidence: r.confidence };
    }
    return map;
  }, [kpiRows]);

  // Sector-aware KPI split — only keys belonging to this bucket's visible set
  const sectorKpiKeys: readonly string[] = SECTOR_KPI_MAP[bucketId] ?? SECTOR_KPI_MAP.OTH;

  const allKpiKeys = useMemo(() => {
    const bucketVisible = new Set([...BASE_KPI_KEYS, ...sectorKpiKeys]);
    const required = new Set(checklistStatus.missing_critical_kpis.concat(checklistStatus.present_kpis));
    const fromRows  = new Set(kpiRows.map((r) => r.kpi_key));
    return [...new Set([...required, ...fromRows])].filter(
      (k) => KPI_META[k] && bucketVisible.has(k),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checklistStatus, kpiRows, bucketId]);

  const baseGroup   = allKpiKeys.filter((k) => BASE_KPI_KEYS.includes(k));
  const sectorGroup = allKpiKeys.filter((k) => sectorKpiKeys.includes(k));

  const requiredSet  = new Set([
    ...checklistStatus.present_kpis,
    ...checklistStatus.missing_critical_kpis,
  ]);

  // Check if ready to confirm: all missing KPIs either filled or none missing
  const missingWithNoInput = checklistStatus.missing_critical_kpis.filter(
    (k) => !manualValues[k]?.trim()
  );
  const canConfirm = missingWithNoInput.length === 0;

  // Total present: from API + manually filled
  const manuallyFilled = checklistStatus.missing_critical_kpis.filter(
    (k) => !!manualValues[k]?.trim()
  );
  const totalPresent   = checklistStatus.present_kpis.length + manuallyFilled.length;
  const totalRequired  = checklistStatus.present_kpis.length + checklistStatus.missing_critical_kpis.length;

  async function handleConfirm() {
    if (!canConfirm || isSaving) return;

    // Sanitize: strip "$", "%", "," and convert to clean numeric strings
    const sanitizedEntries = Object.entries(manualValues)
      .map(([key, raw]): [string, string | null] => [key, sanitizeKpiValue(raw)])
      .filter((entry): entry is [string, string] => entry[1] !== null);

    if (sanitizedEntries.length > 0) {
      setIsSaving(true);
      setSaveError(null);
      try {
        const body: Record<string, string | null> = {
          company_id:    companyId    ?? "",
          portfolio_id:  portfolioId  ?? "unknown",
          period_id:     periodId     ?? "FY2025",
          founder_email: founderEmail ?? companyId ?? "",
          submission_id: submissionId ?? null,
        };
        sanitizedEntries.forEach(([key, val]) => { body[key] = val; });

        const res = await fetch(`${API_BASE}/api/manual-entry`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(body),
        });

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(errBody?.detail ?? `HTTP ${res.status}`);
        }

        setSavedKeys(new Set(sanitizedEntries.map(([k]) => k)));
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : "Error al guardar");
        setIsSaving(false);
        return;
      } finally {
        setIsSaving(false);
      }
    }

    setConfirmed(true);
    onConfirm?.();
  }

  // ── Confirmed state ──────────────────────────────────────────────────────
  if (confirmed) {
    return (
      <div
        className="cometa-fade-in rounded-xl px-6 py-8 text-center"
        style={{ border: "1px solid rgba(74,222,128,0.2)", background: "rgba(74,222,128,0.04)" }}
      >
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" className="mx-auto mb-4">
          <circle cx="20" cy="20" r="18" stroke="#4ade80" strokeWidth="1" />
          <path d="M12 20L17 25L28 14" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p className="font-cometa-regular text-white/70 text-sm tracking-wide">Reporte Confirmado</p>
        <p className="font-cometa-extralight text-white/25 text-xs mt-2">
          Los datos han sido sincronizados con la Bóveda de Cometa
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">

      {/* Sector header + progress */}
      <SectorHeader
        bucketId={bucketId}
        totalRequired={totalRequired}
        totalPresent={totalPresent}
      />

      {/* Legend */}
      <Legend />

      {/* API display_message */}
      <div
        className="flex items-start gap-3 px-4 py-3.5 rounded-xl"
        style={{
          background: canConfirm
            ? "rgba(74,222,128,0.05)"
            : "rgba(251,191,36,0.05)",
          border: `1px solid ${canConfirm ? "rgba(74,222,128,0.15)" : "rgba(251,191,36,0.15)"}`,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0 mt-0.5">
          <circle cx="8" cy="8" r="7" stroke={canConfirm ? "#4ade80" : "#fbbf24"} strokeWidth="1" />
          <path d="M8 4.5v.5M8 7v4.5" stroke={canConfirm ? "#4ade80" : "#fbbf24"} strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <p className="font-cometa-extralight text-white/40 text-xs leading-relaxed">
          {checklistStatus.display_message}
        </p>
      </div>

      {/* KPI rows — grouped by sector */}
      <div className="space-y-6">
        <KpiGroupSection
          title="Métricas Financieras Generales"
          accentColor="rgba(100,202,228,0.7)"
          kpiKeys={baseGroup}
          kpiStatusMap={kpiStatusMap}
          requiredSet={requiredSet}
          manualValues={manualValues}
          whyOpen={whyOpen}
          onManualChange={(key, v) => setManualValues((prev) => ({ ...prev, [key]: v }))}
          onToggleWhy={(key) => setWhyOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
        />

        {sectorGroup.length > 0 && (
          <KpiGroupSection
            title={`Métricas de Operación · ${SECTOR_META[bucketId]?.label ?? bucketId}`}
            accentColor={SECTOR_META[bucketId]?.color ?? "#64CAE4"}
            kpiKeys={sectorGroup}
            kpiStatusMap={kpiStatusMap}
            requiredSet={requiredSet}
            manualValues={manualValues}
            whyOpen={whyOpen}
            onManualChange={(key, v) => setManualValues((prev) => ({ ...prev, [key]: v }))}
            onToggleWhy={(key) => setWhyOpen((prev) => ({ ...prev, [key]: !prev[key] }))}
          />
        )}
      </div>

      {/* Save error */}
      {saveError && (
        <div className="cometa-fade-in px-4 py-3 rounded-xl"
          style={{ background: "rgba(248,113,113,0.07)", border: "1px solid rgba(248,113,113,0.18)" }}>
          <p className="font-cometa-extralight text-red-400/70 text-xs">{saveError}</p>
        </div>
      )}

      {/* CTA */}
      <div className="pt-3">
        <ConfirmSubmitButton
          isComplete={canConfirm}
          missingKpis={missingWithNoInput}
          isLoading={isSaving}
          onClick={handleConfirm}
        />
      </div>

      {/* Saved keys toast */}
      {savedKeys.size > 0 && (
        <div
          className="cometa-fade-in flex items-center gap-3 px-4 py-3.5 rounded-xl"
          style={{ background: "rgba(100,202,228,0.06)", border: "1px solid rgba(100,202,228,0.18)" }}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none" className="flex-shrink-0">
            <circle cx="7.5" cy="7.5" r="6.5" stroke="#64CAE4" strokeWidth="1" />
            <path d="M4.5 7.5L6.5 9.5L10.5 5.5" stroke="#64CAE4" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <p className="font-cometa-regular text-white/60 text-xs">Datos guardados en BigQuery</p>
            <p className="font-cometa-extralight text-white/25 text-[10px] mt-0.5">
              {savedKeys.size} KPI{savedKeys.size > 1 ? "s" : ""} sincronizados
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
