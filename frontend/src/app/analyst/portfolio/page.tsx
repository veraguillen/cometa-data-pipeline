"use client";

/**
 * /analyst/portfolio — Portfolio KPI Comparison Table.
 *
 * Fetches GET /api/results/all, groups results by company_domain,
 * extracts top 3 KPIs (Revenue Growth, Gross Margin, EBITDA Margin)
 * for each, and renders a searchable minimal table.
 *
 * Typography: Helvetica Now Display — titles weight 100, body 400.
 * Themes: inherits ThemeProvider from /analyst layout.
 */

import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter } from "next/navigation";
import { ArrowLeft, Search, RefreshCw, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { validateSession } from "@/services/api-client";
import { apiGet } from "@/services/api-client";
import { z } from "zod";
import AppHeader from "@/components/analyst/AppHeader";
import GeometricBackground from "@/components/analyst/GeometricBackground";
import type { UserInfo } from "@/services/api-client";

// ── Inline schema for /api/results/all (extends resultsResponseSchema) ────────
const allResultsSchema = z.object({
  status:  z.string(),
  results: z.array(
    z.object({
      id:   z.string(),
      data: z.record(z.string(), z.unknown()),
      date: z.string(),
      metadata: z.object({
        original_filename: z.string(),
        founder_email:     z.string(),
        file_hash:         z.string(),
        processed_at:      z.string(),
        gcs_path:          z.string().default(""),
        company_domain:    z.string().optional(),
        portfolio_id:      z.string().optional(),
      }),
    })
  ),
  total: z.number().optional(),
});

/** Format a period_id like P2025Q4M12 → "Q4 2025", or a date string nicely. */
function formatPeriod(raw: string): string {
  // BQ legacy: P2025Q4M12
  const m = raw.match(/^P(\d{4})Q(\d)M\d{2}$/);
  if (m) return `Q${m[2]} ${m[1]}`;
  // ISO date
  try {
    return new Date(raw).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return raw;
  }
}

// ── KPI extraction (mirrors analyst.ts extractKPIs logic) ─────────────────────
function extractTopKpis(data: Record<string, unknown>): {
  revenueGrowth: string;
  grossMargin:   string;
  ebitdaMargin:  string;
} {
  const fm = (data as Record<string, unknown>)?.financial_metrics_2025 as
    Record<string, unknown> | undefined;
  if (!fm) return { revenueGrowth: "—", grossMargin: "—", ebitdaMargin: "—" };

  function val(path: string[]): string {
    let node: unknown = fm;
    for (const key of path) {
      if (!node || typeof node !== "object") return "—";
      node = (node as Record<string, unknown>)[key];
    }
    const obj = node as Record<string, unknown> | undefined;
    return String(obj?.value ?? "—");
  }

  return {
    revenueGrowth: val(["revenue_growth", "value"]),
    grossMargin:   val(["profit_margins", "gross_profit_margin", "value"]),
    ebitdaMargin:  val(["profit_margins", "ebitda_margin", "value"]),
  };
}

function parseNum(v: string): number | null {
  if (!v || v === "—") return null;
  const n = parseFloat(v.replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}

function TrendIcon({ value }: { value: string }) {
  const n = parseNum(value);
  if (n === null) return <Minus size={11} style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }} />;
  if (n > 0)      return <TrendingUp size={11} className="text-kpi-positive" />;
  return               <TrendingDown size={11} className="text-kpi-negative" />;
}

interface CompanyRow {
  domain:        string;
  lastDate:      string;
  revenueGrowth: string;
  grossMargin:   string;
  ebitdaMargin:  string;
  isLegacy:      boolean;
}

export default function PortfolioPage() {
  const router                                = useRouter();
  const [user,     setUser]                  = useState<UserInfo | null>(null);
  const [hydrated, setHydrated]              = useState(false);
  const [rows,     setRows]                  = useState<CompanyRow[]>([]);
  const [loading,  setLoading]               = useState(true);
  const [error,    setError]                 = useState("");
  const [search,   setSearch]                = useState("");

  async function fetchData() {
    setLoading(true);
    setError("");
    try {
      const res = await apiGet("/api/results/all", allResultsSchema);

      // Group by company_domain — keep latest result per company
      const byCompany = new Map<string, { date: string; data: Record<string, unknown> }>();
      for (const r of res.results) {
        const domain = r.metadata.company_domain ?? r.id ?? "unknown";
        const existing = byCompany.get(domain);
        if (!existing || r.date > existing.date) {
          byCompany.set(domain, { date: r.date, data: r.data });
        }
      }

      const built: CompanyRow[] = [];
      byCompany.forEach(({ date, data }, domain) => {
        const kpis     = extractTopKpis(data);
        const isLegacy = (data as Record<string, unknown>)._source === "bigquery_legacy";
        built.push({ domain, lastDate: date, ...kpis, isLegacy });
      });

      // Sort alphabetically
      built.sort((a, b) => a.domain.localeCompare(b.domain));
      setRows(built);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error cargando datos");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    validateSession().then((u) => { setUser(u); setHydrated(true); });
    fetchData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.domain.toLowerCase().includes(q));
  }, [rows, search]);

  if (!hydrated) return null;

  return (
    <div className="flex h-screen flex-col overflow-hidden" style={{ background: "var(--cometa-bg)" }}>
      <AppHeader user={user} />

      <div className="relative flex flex-1 flex-col overflow-hidden">
        <GeometricBackground />

        <div className="relative z-10 flex flex-1 flex-col overflow-hidden">

          {/* ── Sticky bar ── */}
          <div
            className="sticky top-0 z-30 shrink-0 border-b px-4 sm:px-6 py-3 flex items-center gap-4 flex-wrap"
            style={{
              borderColor:    "var(--cometa-card-border)",
              background:     "color-mix(in srgb, var(--cometa-bg) 70%, transparent)",
              backdropFilter: "blur(12px)",
            }}
          >
            <button
              onClick={() => router.push("/analyst/dashboard")}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] transition-opacity hover:opacity-70"
              style={{
                color:      "var(--cometa-fg-muted)",
                border:     "1px solid var(--cometa-card-border)",
                background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
              }}
            >
              <ArrowLeft size={12} />
              Dashboard
            </button>

            <h1
              className="text-[14px]"
              style={{ color: "var(--cometa-fg)", fontWeight: 100, letterSpacing: "0.04em" }}
            >
              Comparativa de Portfolio
            </h1>

            {/* Search */}
            <div className="relative ml-auto w-48">
              <Search
                size={11}
                className="absolute left-2.5 top-1/2 -translate-y-1/2"
                style={{ color: "var(--cometa-fg-muted)" }}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar startup…"
                className="w-full rounded-lg pl-7 pr-3 py-1.5 text-[12px] outline-none"
                style={{
                  background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)",
                  border:     "1px solid var(--cometa-card-border)",
                  color:      "var(--cometa-fg)",
                  fontWeight: 400,
                }}
              />
            </div>

            {/* Refresh */}
            <button
              onClick={fetchData}
              disabled={loading}
              className="rounded-lg p-1.5 transition-opacity disabled:opacity-40 hover:opacity-70"
              style={{ color: "var(--cometa-fg-muted)" }}
              title="Refrescar"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>

          {/* ── Main content ── */}
          <main className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">

            {error && (
              <div
                className="mb-4 rounded-xl px-4 py-3 text-[12px]"
                style={{
                  background: "color-mix(in srgb, #f87171 10%, transparent)",
                  border:     "1px solid color-mix(in srgb, #f87171 20%, transparent)",
                  color:      "#f87171",
                }}
              >
                {error}
              </div>
            )}

            {/* Table skeleton */}
            {loading && (
              <div className="space-y-1.5">
                {[1, 2, 3, 4, 5].map((i) => (
                  <div
                    key={i}
                    className="h-11 rounded-xl animate-pulse"
                    style={{ background: "color-mix(in srgb, var(--cometa-fg) 5%, transparent)" }}
                  />
                ))}
              </div>
            )}

            {!loading && (
              <div
                className="rounded-2xl overflow-hidden"
                style={{ border: "1px solid var(--cometa-card-border)" }}
              >
                {/* Table header */}
                <div
                  className="grid gap-4 px-5 py-2.5 text-[9px] uppercase tracking-widest"
                  style={{
                    gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
                    color:        "var(--cometa-fg-muted)",
                    borderBottom: "1px solid var(--cometa-card-border)",
                    background:   "color-mix(in srgb, var(--cometa-fg) 3%, transparent)",
                  }}
                >
                  <span>Empresa</span>
                  <span>Rev. Growth</span>
                  <span>Gross Margin</span>
                  <span>EBITDA Margin</span>
                  <span>Último periodo</span>
                </div>

                {/* Rows */}
                <AnimatePresence>
                  {filtered.length === 0 ? (
                    <div
                      className="py-14 text-center text-[13px]"
                      style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }}
                    >
                      {search ? `Sin resultados para "${search}"` : "Sin datos disponibles"}
                    </div>
                  ) : (
                    filtered.map((row, idx) => (
                      <motion.div
                        key={row.domain}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.25, delay: idx * 0.03 }}
                        className="grid gap-4 px-5 py-3 transition-colors hover:bg-[color-mix(in_srgb,var(--cometa-fg)_3%,transparent)] cursor-pointer"
                        style={{
                          gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr",
                          borderBottom: idx < filtered.length - 1
                            ? "1px solid var(--cometa-card-border)"
                            : "none",
                        }}
                        onClick={() => router.push(`/analyst/dashboard?company=${row.domain}`)}
                      >
                        {/* Company name + Legacy badge */}
                        <span className="flex items-center gap-2 min-w-0">
                          <span
                            className="text-[13px] font-light truncate"
                            style={{ color: "var(--cometa-fg)" }}
                          >
                            {row.domain}
                          </span>
                          {row.isLegacy && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[8px] uppercase tracking-widest"
                              style={{
                                background: "color-mix(in srgb, var(--cometa-fg-muted) 10%, transparent)",
                                color:      "var(--cometa-fg-muted)",
                                border:     "1px solid color-mix(in srgb, var(--cometa-fg-muted) 18%, transparent)",
                              }}
                            >
                              Legacy
                            </span>
                          )}
                        </span>

                        {/* Revenue Growth */}
                        <span className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
                          <TrendIcon value={row.revenueGrowth} />
                          {row.revenueGrowth}
                        </span>

                        {/* Gross Margin */}
                        <span className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
                          <TrendIcon value={row.grossMargin} />
                          {row.grossMargin}
                        </span>

                        {/* EBITDA Margin */}
                        <span className="flex items-center gap-1.5 text-[13px]" style={{ color: "var(--cometa-fg)", fontWeight: 300 }}>
                          <TrendIcon value={row.ebitdaMargin} />
                          {row.ebitdaMargin}
                        </span>

                        {/* Last period */}
                        <span className="text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.55 }}>
                          {row.lastDate && row.lastDate !== "unknown" ? formatPeriod(row.lastDate) : "—"}
                        </span>
                      </motion.div>
                    ))
                  )}
                </AnimatePresence>
              </div>
            )}

            {/* Summary footer */}
            {!loading && filtered.length > 0 && (
              <p className="mt-4 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.4 }}>
                {filtered.length} empresa{filtered.length !== 1 ? "s" : ""}{search ? ` · filtrado por "${search}"` : ` en portfolio`}
              </p>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
