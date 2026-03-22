"use client";

/**
 * /analyst/dashboard — The Analyst Cockpit.
 *
 * Layout (matches fron/AnalystDashboard):
 *   ┌─ AppHeader (full width, sticky z-40) ─────────────────────────────┐
 *   ├─ AnalystSidebar ─────┬─ Main column ───────────────────────────── ┤
 *   │   Fund selector      │  ┌ Filter bar (sticky, backdrop-blur) ─┐  │
 *   │   Nav links          │  │ PeriodFilterBar                     │  │
 *   │   Company search     │  └─────────────────────────────────────┘  │
 *   │   Recents            │  ExecutiveSummaryCard (kpi-card)           │
 *   │   Analyst footer     │  BentoGrid (5×2 stagger entry)            │
 *   └──────────────────────┘  BentoCharts (Recharts)                   │
 *                             AITerminal (fixed bottom z-40)            │
 *
 * Typography: Helvetica Now Display — titles weight 100, body 400. No all-caps.
 * Backend: useAnalystData → /api/results · validateSession → /api/me
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { validateSession, type UserInfo } from "@/services/api-client";
import AppHeader           from "@/components/analyst/AppHeader";
import AnalystSidebar, { type AnalystSidebarProps } from "@/components/analyst/AnalystSidebar";
import BentoGrid           from "@/components/analyst/BentoGrid";
import BentoCharts         from "@/components/analyst/BentoCharts";
import GeometricBackground from "@/components/analyst/GeometricBackground";
import AITerminal          from "@/components/analyst/AITerminal";
import InviteFounder       from "@/components/analyst/InviteFounder";
import PortfolioHeatmap    from "@/components/analyst/PortfolioHeatmap";
import PeriodFilterBar     from "@/components/PeriodFilterBar";
import { useAnalystData }  from "@/hooks/useAnalystData";
import { usePeriodFilter } from "@/hooks/usePeriodFilter";
import { buildExecutiveSummary } from "@/components/analyst/ExecutiveSummaryText";
import { extractKPISources, extractKPIs } from "@/services/analyst";
import { formatVaultDate } from "@/lib/utils";
import { AlertCircle, RefreshCw, Download } from "lucide-react";

type Fund = NonNullable<AnalystSidebarProps["selectedFund"]>;

// ── Export helpers ──────────────────────────────────────────────────────────

function exportKpisAsCsv(companyId: string, kpis: Record<string, string>) {
  const rows = [["metric", "value"], ...Object.entries(kpis)];
  const csv  = rows.map((r) => r.map((v) => `"${v}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url,
    download: `${companyId}_kpis.csv`,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportResultAsJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function AnalystDashboardPage() {
  const [user,              setUser]              = useState<UserInfo | null>(null);
  const [hydrated,          setHydrated]          = useState(false);
  const [activeTab,         setActiveTab]         = useState("dashboard");
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedFund,      setSelectedFund]      = useState<Fund | null>(null);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [inviteMode,        setInviteMode]        = useState(false);
  const [inviteModalOpen,   setInviteModalOpen]   = useState(false);

  const { results, loading, error, refresh } =
    useAnalystData(selectedCompanyId);

  const periodFilter    = usePeriodFilter();

  // ── 1. Filter by selected year / quarter ────────────────────────────────────
  const filteredResults = periodFilter.filterByPeriod(
    results,
    (r) => r.metadata?.processed_at,
  );

  // ── 2. Active result — last period in the filtered set WITH real KPI data ───
  //    filteredResults may include empty periods (no BQ data for that quarter).
  //    activeResult skips those so KPI cards show the most recent real values.
  const activeResult = useMemo(() => {
    for (let i = filteredResults.length - 1; i >= 0; i--) {
      const fm = (filteredResults[i].data as Record<string, unknown>)
        ?.financial_metrics_2025 as Record<string, unknown> | undefined;
      if (fm && Object.keys(fm).length > 0) return filteredResults[i];
    }
    return null;
  }, [filteredResults]);

  // ── KPIs: snapshot from activeResult when available, empty object otherwise ─
  const kpisFiltered = useMemo(
    () => (activeResult ? extractKPIs([activeResult]) : extractKPIs(filteredResults)),
    [activeResult, filteredResults],
  );

  // ── 3. Years available in this company's dataset → dynamic filter pills ─────
  const availableYears = useMemo(() => {
    if (!results.length) return undefined;
    const yearSet = new Set<number>();
    results.forEach((r) => {
      const m = (r.metadata?.processed_at ?? "").match(/P?(20\d{2})/);
      if (m) yearSet.add(parseInt(m[1], 10));
    });
    return yearSet.size > 0 ? [...yearSet].sort() : undefined;
  }, [results]);

  // ── 4. Auto-select most recent year when company data first loads ───────────
  //    Uses a ref to run only once per company (not on every results update).
  const autoYearRef = useRef<string | null>(null);
  useEffect(() => {
    if (!results.length || autoYearRef.current === selectedCompanyId) return;
    const years = results
      .map((r) => {
        const m = (r.metadata?.processed_at ?? "").match(/P?(20\d{2})/);
        return m ? parseInt(m[1], 10) : null;
      })
      .filter((y): y is number => y !== null);
    if (years.length > 0) {
      periodFilter.setYear(Math.max(...years));
      autoYearRef.current = selectedCompanyId;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results]);

  // ── isLegacy: true when data comes from BigQuery (not an uploaded PDF) ──────
  const isLegacy = useMemo(() => {
    const src = activeResult
      ? (activeResult.data as Record<string, unknown>)?._source
      : results.find(
          (r) => (r.data as Record<string, unknown>)?._source === "bigquery_legacy",
        )?.data?._source;
    return src === "bigquery_legacy";
  }, [activeResult, results]);

  const kpiSources      = extractKPISources(results);
  const lastProcessedAt =
    activeResult?.metadata?.processed_at
    ?? filteredResults.at(-1)?.metadata?.processed_at
    ?? results.at(-1)?.metadata?.processed_at;

  const periodLabel      = formatVaultDate(lastProcessedAt);
  const executiveSummary = buildExecutiveSummary(kpisFiltered, isLegacy, periodLabel);

  useEffect(() => {
    validateSession().then((u) => { setUser(u); setHydrated(true); });
  }, []);

  if (!hydrated) return null;

  return (
    <div
      className="flex h-screen flex-col overflow-hidden"
      style={{ background: "var(--cometa-bg)" }}
    >
      {/* ── Full-width app header ── */}
      <AppHeader
        user={user}
        onMobileMenuOpen={() => setMobileSidebarOpen(true)}
        selectedCompanyId={selectedCompanyId}
        selectedFund={selectedFund}
      />

      {/* ── Body row: sidebar + main ── */}
      <div className="relative flex flex-1 overflow-hidden">

        {/* Animated geometric background — behind everything */}
        <GeometricBackground />

        {/* Sidebar */}
        <AnalystSidebar
          selectedCompanyId={selectedCompanyId}
          onCompanySelect={(id) => {
            setSelectedCompanyId(id);
            setActiveTab("dashboard");
            setMobileSidebarOpen(false);
            // Reset filter + auto-year guard so the new company gets its own defaults
            periodFilter.reset();
            autoYearRef.current = null;
          }}
          selectedFund={selectedFund}
          onFundSelect={(f) => setSelectedFund(f as Fund)}
          mobileOpen={mobileSidebarOpen}
          onMobileClose={() => setMobileSidebarOpen(false)}
          onInviteClick={() => setInviteModalOpen(true)}
        />

        {/* Main content column */}
        <div className="relative z-10 flex flex-1 flex-col overflow-hidden min-w-0">

          {/* ── Sticky filter bar ── */}
          <div
            className="sticky top-0 z-30 shrink-0 border-b px-4 sm:px-6 py-3 flex items-center gap-4 flex-wrap"
            style={{
              borderColor:    "var(--cometa-card-border)",
              background:     "color-mix(in srgb, var(--cometa-bg) 70%, transparent)",
              backdropFilter: "blur(12px)",
            }}
          >
            {/* Tab pills */}
            <div className="flex gap-1 shrink-0">
              {(["dashboard", "reports", "coverage"] as const).map((tab) => {
                const active = activeTab === tab;
                const label  = tab === "dashboard" ? "Dashboard"
                             : tab === "reports"   ? "Reportes"
                             :                       "Cobertura";
                return (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className="px-3 py-1 rounded-md text-xs transition-all duration-200"
                    style={active ? {
                      background: "color-mix(in srgb, var(--cometa-accent) 15%, transparent)",
                      color:      "var(--cometa-accent)",
                      border:     "1px solid color-mix(in srgb, var(--cometa-accent) 25%, transparent)",
                    } : {
                      color:  "var(--cometa-fg-muted)",
                      border: "1px solid transparent",
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            {/* Period filter — hidden on coverage tab (heatmap owns its time axis) */}
            {activeTab !== "coverage" && (
              <>
                <div className="w-px h-5 shrink-0" style={{ background: "var(--cometa-card-border)" }} />
                <PeriodFilterBar
                  filter={periodFilter.filter}
                  onYear={periodFilter.setYear}
                  onPeriod={periodFilter.setPeriod}
                  onReset={periodFilter.reset}
                  availableYears={availableYears}
                />
              </>
            )}
            {/* Right-side actions */}
            <div className="ml-auto flex items-center gap-1">
              {/* Export KPIs CSV */}
              {selectedCompanyId && Object.keys(kpisFiltered).length > 0 && (
                <button
                  onClick={() => exportKpisAsCsv(selectedCompanyId, kpisFiltered)}
                  className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] transition-opacity hover:opacity-70"
                  style={{
                    color:      "var(--cometa-fg-muted)",
                    border:     "1px solid var(--cometa-card-border)",
                    background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
                  }}
                  title="Exportar KPIs como CSV"
                >
                  <Download size={11} />
                  CSV
                </button>
              )}
              {/* Refresh */}
              <button
                onClick={refresh}
                disabled={loading}
                className="rounded-lg p-1.5 transition-opacity disabled:opacity-40 hover:opacity-70"
                style={{ color: "var(--cometa-fg-muted)" }}
                title="Refrescar datos"
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          {/* ── Scrollable content ── */}
          <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6 pb-28 space-y-5">

            {/* Error banner */}
            {error && (
              <div
                className="flex items-center gap-3 rounded-xl px-4 py-3 text-[12px]"
                style={{
                  background: "color-mix(in srgb, #f87171 10%, transparent)",
                  border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
                  color:      "#f87171",
                }}
              >
                <AlertCircle size={14} />
                {error}
              </div>
            )}

            {/* ── Dashboard tab ── */}
            {activeTab === "dashboard" && (
              <>
                {/* Empty state */}
                {!selectedCompanyId && !loading && (
                  <div
                    className="flex flex-col items-center justify-center rounded-2xl py-24 text-center"
                    style={{ border: "1px dashed var(--cometa-card-border)" }}
                  >
                    <p className="text-3xl" style={{ color: "var(--cometa-fg)", fontWeight: 100 }}>
                      Selecciona una empresa
                    </p>
                    <p className="mt-3 text-[13px]" style={{ color: "var(--cometa-fg-muted)", fontWeight: 400 }}>
                      Escribe un dominio en el sidebar y presiona Enter
                    </p>
                    <p className="mt-1 text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.45 }}>
                      Ejemplo: solvento.com
                    </p>
                  </div>
                )}

                {/* Executive summary card */}
                <AnimatePresence>
                  {(selectedCompanyId || loading) && (
                    <motion.div
                      key={selectedCompanyId ?? "loading"}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{    opacity: 0 }}
                      transition={{ duration: 0.4 }}
                      className="kpi-card"
                    >
                      <div
                        className="mb-2 text-[10px] uppercase tracking-widest"
                        style={{ color: "var(--cometa-fg-muted)" }}
                      >
                        Resumen ejecutivo
                        {selectedCompanyId && ` · ${selectedCompanyId}`}
                        {periodFilter.isActive && selectedCompanyId && (
                          <span style={{ color: "var(--cometa-accent)" }}>
                            {" · "}
                            {periodFilter.filter.selectedYear}
                            {periodFilter.filter.selectedPeriod ? ` ${periodFilter.filter.selectedPeriod}` : ""}
                          </span>
                        )}
                      </div>
                      {loading ? (
                        <div className="space-y-2">
                          {[48, 72, 40].map((w) => (
                            <div
                              key={w}
                              className="animate-pulse rounded-full h-2"
                              style={{
                                width:      `${w}%`,
                                background: "color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                              }}
                            />
                          ))}
                        </div>
                      ) : (
                        <p
                          className="text-sm leading-relaxed font-light"
                          style={{ color: "var(--cometa-fg)", opacity: 0.8 }}
                        >
                          {executiveSummary
                            ? executiveSummary
                            : selectedCompanyId
                              ? `${selectedCompanyId} — sin métricas disponibles en el período seleccionado.`
                              : "Cargando análisis…"}
                        </p>
                      )}

                      {/* Footer: subtle meta badges */}
                      {results.length > 0 && (
                        <div className="mt-4 flex items-center gap-2 flex-wrap">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] tracking-wide"
                            style={{
                              color:      "var(--cometa-fg-muted)",
                              background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
                              border:     "1px solid color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                            }}
                          >
                            {filteredResults.length === results.length
                              ? `${results.length} ${results.length !== 1 ? "registros" : "registro"}`
                              : `${filteredResults.length} / ${results.length} registros`}
                          </span>
                          {lastProcessedAt && (
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] tracking-wide"
                              style={{
                                color:      "var(--cometa-fg-muted)",
                                background: "color-mix(in srgb, var(--cometa-fg) 6%, transparent)",
                                border:     "1px solid color-mix(in srgb, var(--cometa-fg) 8%, transparent)",
                              }}
                            >
                              {periodLabel}
                            </span>
                          )}
                        </div>
                      )}
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* BentoGrid 2×5 */}
                {(selectedCompanyId || loading) && (
                  <BentoGrid
                    kpis={kpisFiltered}
                    totalDocs={filteredResults.length}
                    loading={loading}
                    kpiSources={kpiSources}
                    lastUpdate={lastProcessedAt}
                    submissionId={filteredResults.at(-1)?.metadata?.file_hash}
                  />
                )}

                {/* BentoCharts */}
                {(selectedCompanyId || loading) && (
                  <BentoCharts
                    kpis={kpisFiltered}
                    results={filteredResults}
                    loading={loading}
                  />
                )}
              </>
            )}

            {/* ── Reports tab ── */}
            {activeTab === "reports" && (
              <section className="space-y-2">
                {!selectedCompanyId && (
                  <div className="py-12 text-center text-[12px]" style={{ color: "var(--cometa-fg-muted)" }}>
                    Selecciona una empresa en el sidebar.
                  </div>
                )}
                {filteredResults.length === 0 && selectedCompanyId && !loading && (
                  <div className="py-12 text-center text-[12px]" style={{ color: "var(--cometa-fg-muted)" }}>
                    {periodFilter.isActive
                      ? "Sin reportes en el período seleccionado."
                      : "No hay reportes para esta empresa."}
                  </div>
                )}
                {filteredResults.map((r) => (
                  <div
                    key={r.id}
                    className="theme-card rounded-xl px-4 py-3 flex items-center justify-between gap-4"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px]" style={{ color: "var(--cometa-fg)", fontWeight: 400 }}>
                        {r.metadata.original_filename.replace(/^[a-f0-9]+_/, "")}
                      </p>
                      <p className="mt-0.5 text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        {r.metadata.founder_email}
                        {" · "}
                        {new Date(r.metadata.processed_at).toLocaleDateString("es-ES")}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[9px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        {r.metadata.file_hash.slice(0, 8)}…
                      </span>
                      <button
                        onClick={() =>
                          exportResultAsJson(
                            `${r.metadata.original_filename.replace(/^[a-f0-9]+_/, "")}.json`,
                            r,
                          )
                        }
                        className="rounded p-1 transition-opacity hover:opacity-70"
                        style={{ color: "var(--cometa-fg-muted)" }}
                        title="Descargar JSON"
                      >
                        <Download size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </section>
            )}

            {/* ── Coverage tab ── */}
            {activeTab === "coverage" && (
              <PortfolioHeatmap />
            )}

          </main>
        </div>
      </div>

      {/* ── AI Terminal — fixed bottom z-40 ── */}
      <AITerminal
        companyId={selectedCompanyId}
        executiveSummary={executiveSummary}
        inviteMode={inviteMode}
        onInviteDone={() => setInviteMode(false)}
      />

      {/* ── Invite Founder modal ── */}
      <InviteFounder
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
      />
    </div>
  );
}
