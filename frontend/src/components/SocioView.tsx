"use client";

/**
 * SocioView — "The Vault Portal"
 * Upload a financial report → animated KPI checklist → Smart Completion Form
 * for any metric that is missing or has confidence < 0.70.
 */

import { useRef, useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import MobileNav from "@/components/MobileNav";
import SmartChecklistFounder, { type ChecklistStatus, type KpiRow } from "@/components/SmartChecklistFounder";
import "@/styles/cometa-branding.css";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ─── File-type icon (per-format, luxury minimal SVGs) ────────────────────────

const ACCEPTED_TYPES = ".pdf,.csv,.xlsx,.xls,.parquet,.docx,.doc";

function FileTypeIcon({ ext, className }: { ext: string; className?: string }) {
  const s = { stroke: "#64CAE4", strokeWidth: "1.5", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (ext === ".pdf") return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className={className}>
      <rect x="5" y="2" width="16" height="22" rx="2" stroke="#64CAE4" strokeWidth="1.5"/>
      <path d="M5 23h16" {...s}/>
      <path d="M10 10h8M10 14h6" {...s}/>
      <path d="M17 2v6h4" {...s}/>
    </svg>
  );
  if ([".xlsx", ".xls", ".csv"].includes(ext)) return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className={className}>
      <rect x="4" y="7" width="24" height="18" rx="2" stroke="#64CAE4" strokeWidth="1.5"/>
      <path d="M4 13h24M12 13v12M20 13v12" {...s}/>
      <path d="M9 7V5a2 2 0 012-2h10a2 2 0 012 2v2" {...s}/>
    </svg>
  );
  if (ext === ".parquet") return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className={className}>
      <rect x="4" y="4" width="10" height="10" rx="1.5" stroke="#64CAE4" strokeWidth="1.5"/>
      <rect x="18" y="4" width="10" height="10" rx="1.5" stroke="#64CAE4" strokeWidth="1.5"/>
      <rect x="4" y="18" width="10" height="10" rx="1.5" stroke="#64CAE4" strokeWidth="1.5"/>
      <rect x="18" y="18" width="10" height="10" rx="1.5" stroke="#64CAE4" strokeWidth="1.5"/>
    </svg>
  );
  if ([".docx", ".doc"].includes(ext)) return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className={className}>
      <rect x="5" y="2" width="16" height="22" rx="2" stroke="#64CAE4" strokeWidth="1.5"/>
      <path d="M10 10h8M10 14h8M10 18h5" {...s}/>
      <path d="M17 2v6h4" {...s}/>
    </svg>
  );
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" className={className}>
      <path d="M16 6v18M16 6L9 13M16 6l7 7" {...s}/>
      <path d="M5 28h22" {...s}/>
    </svg>
  );
}

// ─── Metric checklist definition ─────────────────────────────────────────────

interface MetricDef {
  key:      string;
  label:    string;
  /** Path into result.financial_metrics_2025 → value */
  path:     string[];
  /** Path into result.financial_metrics_2025 → confidence (number) */
  confPath: string[];
  /** Field name in POST /api/manual-entry body */
  apiField: string;
  placeholder: string;
}

const CHECKLIST: MetricDef[] = [
  {
    key:         "revenue_growth",
    label:       "Revenue Growth",
    path:        ["revenue_growth", "value"],
    confPath:    ["revenue_growth", "confidence"],
    apiField:    "revenue_growth",
    placeholder: "ej. 42% o 0.42",
  },
  {
    key:         "ebitda_margin",
    label:       "EBITDA Margin",
    path:        ["profit_margins", "ebitda_margin", "value"],
    confPath:    ["profit_margins", "ebitda_margin", "confidence"],
    apiField:    "ebitda_margin",
    placeholder: "ej. 18% o 0.18",
  },
  {
    key:         "gross_margin",
    label:       "Gross Profit Margin",
    path:        ["profit_margins", "gross_profit_margin", "value"],
    confPath:    ["profit_margins", "gross_profit_margin", "confidence"],
    apiField:    "gross_profit_margin",
    placeholder: "ej. 65% o 0.65",
  },
  {
    key:         "cash_in_bank",
    label:       "Cash in Bank",
    path:        ["cash_flow_indicators", "cash_in_bank_end_of_year", "value"],
    confPath:    ["cash_flow_indicators", "cash_in_bank_end_of_year", "confidence"],
    apiField:    "cash_in_bank_end_of_year",
    placeholder: "ej. $2,400,000",
  },
  {
    key:         "annual_cf",
    label:       "Annual Cash Flow",
    path:        ["cash_flow_indicators", "annual_cash_flow", "value"],
    confPath:    ["cash_flow_indicators", "annual_cash_flow", "confidence"],
    apiField:    "annual_cash_flow",
    placeholder: "ej. $800,000",
  },
  {
    key:         "working_capital",
    label:       "Working Capital",
    path:        ["debt_ratios", "working_capital_debt", "value"],
    confPath:    ["debt_ratios", "working_capital_debt", "confidence"],
    apiField:    "working_capital_debt",
    placeholder: "ej. $1,200,000",
  },
];

/** Traverse financial_metrics_2025 for a string value */
function dig(obj: unknown, path: string[]): string | undefined {
  let cur: unknown = (obj as Record<string, unknown>)?.financial_metrics_2025;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Traverse financial_metrics_2025 for a numeric confidence */
function digNum(obj: unknown, path: string[]): number | undefined {
  let cur: unknown = (obj as Record<string, unknown>)?.financial_metrics_2025;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "number" ? cur : undefined;
}

// ─── Upload response shape ────────────────────────────────────────────────────

interface UploadResponse {
  duplicate?:       boolean;
  file_hash?:       string;
  result?:          unknown;
  error?:           string;
  message?:         string;
  company_domain?:  string;
  submission?:      { portfolio_id: string; submission_id?: string };
  submission_id?:   string;
  /** Sector checklist status — present on successful non-duplicate uploads */
  checklist_status?: ChecklistStatus;
  /** Individual KPI rows with confidence — for SmartChecklistFounder */
  kpi_rows?: KpiRow[];
}

// ─── Component ────────────────────────────────────────────────────────────────

interface SocioViewProps {
  companyDomain: string;
  onLogout: () => void;
}

const CONFIDENCE_THRESHOLD = 0.70;
// Delay before form appears (ms) — gives checklist animation time to settle
const FORM_APPEAR_DELAY = CHECKLIST.length * 210 + 600;

export default function SocioView({ companyDomain, onLogout }: SocioViewProps) {
  const router       = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Upload flow
  const [isDragging, setIsDragging]           = useState(false);
  const [isUploading, setIsUploading]         = useState(false);
  const [uploadedData, setUploadedData]       = useState<unknown>(null);
  const [statusMsg, setStatusMsg]             = useState<string | null>(null);
  const [visibleChecks, setVisibleChecks]     = useState<Set<string>>(new Set());
  const [detectedCompany, setDetectedCompany] = useState<string | null>(null);
  const [portfolioId, setPortfolioId]         = useState<string>("unknown");
  const [hoveredFile, setHoveredFile]         = useState<string | null>(null);
  // New API fields
  const [checklistStatus, setChecklistStatus] = useState<ChecklistStatus | null>(null);
  const [submissionId, setSubmissionId]       = useState<string | null>(null);
  const [kpiRows, setKpiRows]                 = useState<KpiRow[]>([]);

  // Smart Completion Form
  const [formValues, setFormValues]         = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting]     = useState(false);
  const [savedToast, setSavedToast]         = useState(false);
  const [formVisible, setFormVisible]       = useState(false);

  // Compute which KPIs are missing or have low confidence
  const missingMetrics = useMemo<MetricDef[]>(() => {
    if (!uploadedData) return [];
    return CHECKLIST.filter((m) => {
      const val  = dig(uploadedData, m.path);
      if (val === undefined) return true;
      const conf = digNum(uploadedData, m.confPath);
      return conf !== undefined && conf < CONFIDENCE_THRESHOLD;
    });
  }, [uploadedData]);

  // Reveal form after checklist animations settle
  useEffect(() => {
    if (!uploadedData) { setFormVisible(false); return; }
    const t = setTimeout(() => setFormVisible(true), FORM_APPEAR_DELAY);
    return () => clearTimeout(t);
  }, [uploadedData]);

  // ── Upload logic ──────────────────────────────────────────────────────────

  function revealChecklist(resultData: unknown) {
    CHECKLIST.forEach((metric, i) => {
      if (dig(resultData, metric.path)) {
        setTimeout(() => {
          setVisibleChecks((prev) => new Set([...prev, metric.key]));
        }, i * 210 + 350);
      }
    });
  }

  async function handleUpload(file: File) {
    if (isUploading) return;
    setIsUploading(true);
    setStatusMsg("Reporte recibido. Identificando compañía…");
    setUploadedData(null);
    setVisibleChecks(new Set());
    setDetectedCompany(null);
    setPortfolioId("unknown");
    setChecklistStatus(null);
    setSubmissionId(null);
    setFormValues({});
    setFormVisible(false);

    try {
      const form = new FormData();
      form.append("file", file);

      const res = await fetch(`${API_BASE}/upload`, {
        method:  "POST",
        headers: { "founder-email": companyDomain },
        body:    form,
      });

      let data: UploadResponse | null = null;
      try { data = (await res.json()) as UploadResponse; } catch { /* ignore */ }

      if (!res.ok) {
        setStatusMsg(data?.error ?? "Error procesando el documento");
        return;
      }

      setStatusMsg(null);
      const resultData = data?.result ?? null;
      setUploadedData(resultData);
      setDetectedCompany(data?.company_domain ?? null);
      setPortfolioId(data?.submission?.portfolio_id ?? "unknown");
      // Capture new API fields
      setChecklistStatus(data?.checklist_status ?? null);
      setSubmissionId(
        data?.submission_id ?? data?.submission?.submission_id ?? null
      );
      setKpiRows(Array.isArray(data?.kpi_rows) ? (data.kpi_rows as KpiRow[]) : []);
      if (resultData) revealChecklist(resultData);
    } catch {
      setStatusMsg("No fue posible conectar con el servidor");
    } finally {
      setIsUploading(false);
    }
  }

  // ── Manual entry submit ───────────────────────────────────────────────────

  async function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isSubmitting) return;

    const filled = missingMetrics.filter((m) => formValues[m.key]?.trim());
    if (filled.length === 0) return;

    setIsSubmitting(true);
    try {
      const body: Record<string, string> = {
        company_id:   detectedCompany ?? companyDomain,
        portfolio_id: portfolioId,
        period_id:    "FY2025",
        founder_email: companyDomain,
      };
      filled.forEach((m) => { body[m.apiField] = formValues[m.key].trim(); });

      const res = await fetch(`${API_BASE}/api/manual-entry`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });

      if (res.ok) {
        setSavedToast(true);
        setFormValues({});
        setTimeout(() => setSavedToast(false), 3500);
      }
    } catch { /* silent — toast won't appear */ }
    finally { setIsSubmitting(false); }
  }

  function handleReset() {
    setUploadedData(null);
    setVisibleChecks(new Set());
    setStatusMsg(null);
    setDetectedCompany(null);
    setPortfolioId("unknown");
    setChecklistStatus(null);
    setSubmissionId(null);
    setKpiRows([]);
    setFormValues({});
    setFormVisible(false);
    setSavedToast(false);
  }

  const hasData = uploadedData !== null;

  return (
    <div className="cometa-container cometa-aerial-texture min-h-screen">

      {/* ── Header ── */}
      <header className="fixed top-0 left-0 right-0 z-50 px-4 md:px-8 py-4 md:py-5 flex items-center justify-between border-b border-white/[0.04] bg-black/70 backdrop-blur-sm">
        <div className="flex items-center gap-3 md:gap-5 min-w-0">
          <img src="/COMETALOGO.png" alt="Cometa" className="h-8 w-auto object-contain flex-shrink-0 invert" />
          <div className="hidden md:block min-w-0">
            <div className="font-cometa-extralight text-white/30 text-[11px] tracking-[0.18em] uppercase">
              The Vault
            </div>
            <div className="font-cometa-extralight text-white/25 text-[11px] mt-0.5 truncate">
              {companyDomain}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 md:gap-6">
          <span className="hidden md:block font-cometa-extralight text-white/30 text-[11px] tracking-[0.18em] uppercase">
            Socio
          </span>
          <button
            onClick={onLogout}
            className="hidden md:block font-cometa-extralight text-white/30 text-[11px] hover:text-white/60 transition-colors tracking-wider"
          >
            Salir
          </button>
          <MobileNav roleLabel="SOCIO" companyDomain={companyDomain} onLogout={onLogout} />
        </div>
      </header>

      {/* ── Main ── */}
      <main className="cometa-main-layout min-h-screen pt-[72px] md:pt-24 px-4 sm:px-6 lg:px-24 pb-16">
        <div className="w-full md:max-w-xl md:mx-auto">

          {/* Page heading */}
          <div className="mb-8 md:mb-10 mt-6 md:mt-4">
            <div className="flex items-center gap-3 mb-3">
              <span className="block w-0.5 h-5 md:h-6 bg-gradient-to-b from-[#00237F] to-[#64CAE4] rounded-full flex-shrink-0" />
              <h1 className="cometa-title">Portal de Carga</h1>
            </div>
            <p className="font-cometa-extralight text-white/30 text-sm tracking-wide pl-4">
              Sube el reporte financiero para que el equipo de análisis lo revise
            </p>
          </div>

          {/* ── Upload zone ── */}
          {!hasData && (
            <div
              className={`vault-drop-zone-gradient relative h-60 flex flex-col items-center justify-center mb-8 ${isDragging ? "dragging" : ""}`}
              onDragEnter={(e) => {
                e.preventDefault();
                setIsDragging(true);
                const items = Array.from(e.dataTransfer.items);
                if (items[0]?.kind === "file") setHoveredFile(e.dataTransfer.items[0]?.type ?? "");
              }}
              onDragOver={(e)  => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); setHoveredFile(null); }}
              onDrop={async (e) => {
                e.preventDefault();
                setIsDragging(false);
                setHoveredFile(null);
                const files = Array.from(e.dataTransfer.files);
                if (files.length > 0) await handleUpload(files[0]);
              }}
              onClick={() => !isUploading && fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPTED_TYPES}
                className="hidden"
                onChange={async (e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) {
                    await handleUpload(files[0]);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }
                }}
              />

              {isUploading ? (
                <div className="flex flex-col items-center gap-4 pointer-events-none">
                  <span
                    className="block w-7 h-7 rounded-full border border-[#64CAE4]/30"
                    style={{ borderTopColor: "#64CAE4", animation: "cometa-spin 0.9s linear infinite" }}
                  />
                  <span className="font-cometa-extralight text-white/40 text-sm tracking-wide">
                    {statusMsg ?? "Procesando…"}
                  </span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4 pointer-events-none">
                  <FileTypeIcon
                    ext={hoveredFile ? (
                      hoveredFile.includes("pdf") ? ".pdf"
                      : hoveredFile.includes("sheet") || hoveredFile.includes("excel") ? ".xlsx"
                      : hoveredFile.includes("csv") ? ".csv"
                      : hoveredFile.includes("word") || hoveredFile.includes("document") ? ".docx"
                      : ""
                    ) : ""}
                    className={`transition-all duration-300 ${isDragging ? "opacity-80 scale-110" : "opacity-25"}`}
                  />
                  <div className="text-center">
                    <span className="font-cometa-extralight text-white/35 text-sm tracking-wide block">
                      {isDragging ? "Suelta para analizar" : "Arrastra o haz click para seleccionar"}
                    </span>
                    <span className="font-cometa-extralight text-white/20 text-xs tracking-wider mt-1.5 block">
                      PDF · CSV · XLSX · PARQUET · DOCX
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Error message */}
          {statusMsg && !isUploading && (
            <div className="cometa-card p-4 mb-8" style={{ borderColor: "rgba(239,68,68,0.2)" }}>
              <p className="font-cometa-extralight text-red-400/70 text-sm">{statusMsg}</p>
            </div>
          )}

          {/* ── Checklist ── */}
          {hasData && (
            <div className="cometa-fade-in">

              {/* Status label */}
              <div className="flex items-center gap-3 mb-7">
                <span className="block w-1.5 h-1.5 rounded-full bg-[#64CAE4]" />
                <span className="font-cometa-extralight text-white/35 text-[11px] tracking-[0.18em] uppercase">
                  Reporte recibido —{" "}
                  {detectedCompany
                    ? detectedCompany.charAt(0).toUpperCase() + detectedCompany.slice(1)
                    : "Compañía identificada"}
                </span>
              </div>

              {/* ── Semáforo Sectorial — API checklist ── */}
              {checklistStatus && (
                <SmartChecklistFounder
                  bucketId={checklistStatus.bucket}
                  checklistStatus={checklistStatus}
                  kpiRows={kpiRows}
                  companyId={detectedCompany ?? companyDomain}
                  submissionId={submissionId ?? undefined}
                  portfolioId={portfolioId}
                  periodId="FY2025"
                  founderEmail={companyDomain}
                  onConfirm={() => router.push("/success")}
                />
              )}

              {/* Metric rows — KPIs extraídos del documento */}
              <div className="space-y-3">
                {CHECKLIST.map((metric) => {
                  const value     = dig(uploadedData, metric.path);
                  const conf      = digNum(uploadedData, metric.confPath);
                  const isVisible = visibleChecks.has(metric.key);
                  const isFound   = value !== undefined;
                  const isLowConf = isFound && conf !== undefined && conf < CONFIDENCE_THRESHOLD;

                  return (
                    <div
                      key={metric.key}
                      className="cometa-card-gradient flex items-center justify-between px-4 sm:px-6 py-4"
                    >
                      <div>
                        <span className="font-cometa-extralight text-white/45 text-[11px] tracking-[0.14em] uppercase block">
                          {metric.label}
                        </span>
                        {isVisible && isFound && (
                          <span
                            className="cometa-metric-fluid mt-1 block cometa-fade-in"
                            style={{
                              animationDuration: "0.35s",
                              color: isLowConf ? "rgba(251,191,36,0.8)" : "white",
                            }}
                          >
                            {value}
                            {isLowConf && (
                              <span className="font-cometa-extralight text-[10px] ml-2 opacity-60">
                                baja confianza
                              </span>
                            )}
                          </span>
                        )}
                      </div>

                      <div className="w-7 h-7 flex items-center justify-center flex-shrink-0">
                        {isVisible && isFound && !isLowConf ? (
                          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="cometa-check-appear">
                            <circle cx="11" cy="11" r="10" stroke="#64CAE4" strokeWidth="1" />
                            <path d="M7 11L10 14L15 8" stroke="#64CAE4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        ) : isVisible && isLowConf ? (
                          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="cometa-check-appear">
                            <circle cx="11" cy="11" r="10" stroke="rgba(251,191,36,0.6)" strokeWidth="1" />
                            <path d="M11 7v5M11 15v0.5" stroke="rgba(251,191,36,0.8)" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        ) : (
                          <span className="block w-4 h-4 rounded-full border border-white/10" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Smart Completion Form ── */}
              {formVisible && missingMetrics.length > 0 && (
                <div className="cometa-fade-in mt-8">

                  {/* Section header */}
                  <div className="flex items-center gap-3 mb-5">
                    <span className="block w-0.5 h-4 bg-gradient-to-b from-[#64CAE4]/60 to-transparent rounded-full flex-shrink-0" />
                    <span className="font-cometa-extralight text-white/30 text-[11px] tracking-[0.18em] uppercase">
                      Completar métricas faltantes
                    </span>
                  </div>
                  <p className="font-cometa-extralight text-white/20 text-xs tracking-wide mb-5 pl-4">
                    El sistema no detectó los siguientes datos con suficiente certeza. Puedes ingresarlos manualmente.
                  </p>

                  <form onSubmit={handleFormSubmit} className="space-y-3">
                    {missingMetrics.map((m) => (
                      <div key={m.key} className="cometa-card-gradient px-4 sm:px-6 py-4">
                        <label className="font-cometa-extralight text-white/35 text-[11px] tracking-[0.14em] uppercase block mb-2">
                          {m.label}
                        </label>
                        <input
                          type="text"
                          value={formValues[m.key] ?? ""}
                          onChange={(e) =>
                            setFormValues((prev) => ({ ...prev, [m.key]: e.target.value }))
                          }
                          placeholder={m.placeholder}
                          className="w-full bg-white/[0.05] border border-white/[0.08] rounded-lg px-4 py-3
                                     font-cometa-extralight text-white text-sm
                                     placeholder:text-white/20
                                     focus:outline-none focus:border-[#64CAE4]/60
                                     focus:shadow-[0_0_0_1px_rgba(100,202,228,0.15)]
                                     transition-all duration-200"
                        />
                      </div>
                    ))}

                    {/* Submit */}
                    <div className="pt-2">
                      <button
                        type="submit"
                        disabled={isSubmitting || missingMetrics.every((m) => !formValues[m.key]?.trim())}
                        className={`w-full py-3.5 rounded-lg font-cometa-regular text-sm tracking-[0.08em] transition-all duration-200 ${
                          isSubmitting || missingMetrics.every((m) => !formValues[m.key]?.trim())
                            ? "bg-white/[0.04] text-white/20 cursor-not-allowed"
                            : "bg-gradient-to-r from-[#00237F] to-[#64CAE4] text-white hover:opacity-90"
                        }`}
                      >
                        {isSubmitting ? (
                          <span className="inline-flex items-center justify-center gap-2">
                            <span
                              className="inline-block w-3.5 h-3.5 rounded-full border border-white/30"
                              style={{ borderTopColor: "transparent", animation: "cometa-spin 0.9s linear infinite" }}
                            />
                            Guardando…
                          </span>
                        ) : (
                          "Guardar en Bóveda"
                        )}
                      </button>
                    </div>
                  </form>

                  {/* Success toast */}
                  {savedToast && (
                    <div
                      className="cometa-fade-in mt-5 flex items-center gap-3 px-5 py-3.5 rounded-lg"
                      style={{
                        background: "rgba(100,202,228,0.06)",
                        border:     "1px solid rgba(100,202,228,0.2)",
                      }}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="flex-shrink-0">
                        <circle cx="8" cy="8" r="7" stroke="#64CAE4" strokeWidth="1"/>
                        <path d="M5 8L7 10L11 6" stroke="#64CAE4" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <div>
                        <p className="font-cometa-regular text-white/70 text-xs tracking-wide">
                          Bóveda Actualizada
                        </p>
                        <p className="font-cometa-extralight text-white/30 text-[11px] mt-0.5">
                          Datos sincronizados con BigQuery
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Reset */}
              <div className="mt-10 text-center">
                <button
                  onClick={handleReset}
                  className="font-cometa-extralight text-white/25 text-[11px] hover:text-white/50 transition-colors tracking-wider"
                >
                  Subir otro documento
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
