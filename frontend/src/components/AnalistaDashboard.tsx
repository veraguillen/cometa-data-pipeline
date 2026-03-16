"use client";

/**
 * AnalistaDashboard — "The Intelligence Dashboard"
 * Full financial analysis view for the Analista role.
 * Gradient-border cards · fade-in entrance · executive AI summary
 * Mobile-first responsive layout.
 */

import { useState, useEffect, useRef } from "react";
import FinancialCharts from "@/components/charts/FinancialCharts";
import MobileNav from "@/components/MobileNav";
import { KPICard, KPICardSkeleton } from "@/components/kpi-card";
import { EmptyState } from "@/components/empty-state";
import FidelityAuditPanel from "@/components/FidelityAuditPanel";
import { cn } from "@/lib/utils";
import { BarChart3, Building2, ShieldCheck, ChevronRight } from "lucide-react";
import "@/styles/cometa-branding.css";

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalyticsSeries = {
  month:               string;
  company_id:          string;
  portfolio_id:        string;
  submission_count:    number;
  // Core financials
  revenue_growth:           number | null;
  gross_profit_margin:      number | null;
  ebitda_margin:            number | null;
  cash_in_bank_end_of_year: number | null;
  annual_cash_flow:         number | null;
  working_capital_debt:     number | null;
  // Base metrics (inputs for derivation engine)
  revenue:                  number | null;
  ebitda:                   number | null;
  cogs:                     number | null;
  // Sector metrics
  mrr:                      number | null;
  churn_rate:               number | null;
  cac:                      number | null;
  portfolio_size:           number | null;
  npl_ratio:                number | null;
  gmv:                      number | null;
  loss_ratio:               number | null;
};

type AnalyticsData = {
  series:  AnalyticsSeries[];
  summary: {
    total_submissions: number;
    companies_count:   number;
    companies:         string[];
    date_range:        { min: string | null; max: string | null };
  };
};

type AnalysisResult = {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  date: string;
  metadata: {
    original_filename: string;
    founder_email: string;
    file_hash: string;
    processed_at: string;
    gcs_path: string;
    /** BigQuery submission UUID — present on freshly uploaded results */
    submission_id?: string;
    portfolio_id?: string;
  };
};

// ─── Metric cards config ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Getter     = (d: any) => string | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ConfGetter = (d: any) => number | undefined;

interface MetricDef {
  label:      string;
  /** kpi_key as stored in BigQuery fact_kpi_values — used by PUT /api/kpi-update */
  kpiKey:     string;
  value:      Getter;
  confidence: ConfGetter;
  /** Deep path to the value field — used by the editor to patch data */
  valuePath:  string[];
  /** True for currency-denominated KPIs (cash, debt). False for ratios/percentages. */
  isMonetary: boolean;
}

const METRIC_DEFS: MetricDef[] = [
  {
    label:      "Revenue Growth",
    kpiKey:     "revenue_growth",
    value:      (d) => d?.financial_metrics_2025?.revenue_growth?.value,
    confidence: (d) => d?.financial_metrics_2025?.revenue_growth?.confidence,
    valuePath:  ["financial_metrics_2025", "revenue_growth", "value"],
    isMonetary: false,
  },
  {
    label:      "Gross Margin",
    kpiKey:     "gross_profit_margin",
    value:      (d) => d?.financial_metrics_2025?.profit_margins?.gross_profit_margin?.value,
    confidence: (d) => d?.financial_metrics_2025?.profit_margins?.gross_profit_margin?.confidence,
    valuePath:  ["financial_metrics_2025", "profit_margins", "gross_profit_margin", "value"],
    isMonetary: false,
  },
  {
    label:      "EBITDA Margin",
    kpiKey:     "ebitda_margin",
    value:      (d) => d?.financial_metrics_2025?.profit_margins?.ebitda_margin?.value,
    confidence: (d) => d?.financial_metrics_2025?.profit_margins?.ebitda_margin?.confidence,
    valuePath:  ["financial_metrics_2025", "profit_margins", "ebitda_margin", "value"],
    isMonetary: false,
  },
  {
    label:      "Cash in Bank",
    kpiKey:     "cash_in_bank_end_of_year",
    value:      (d) => d?.financial_metrics_2025?.cash_flow_indicators?.cash_in_bank_end_of_year?.value,
    confidence: (d) => d?.financial_metrics_2025?.cash_flow_indicators?.cash_in_bank_end_of_year?.confidence,
    valuePath:  ["financial_metrics_2025", "cash_flow_indicators", "cash_in_bank_end_of_year", "value"],
    isMonetary: true,
  },
  {
    label:      "Annual Cash Flow",
    kpiKey:     "annual_cash_flow",
    value:      (d) => d?.financial_metrics_2025?.cash_flow_indicators?.annual_cash_flow?.value,
    confidence: (d) => d?.financial_metrics_2025?.cash_flow_indicators?.annual_cash_flow?.confidence,
    valuePath:  ["financial_metrics_2025", "cash_flow_indicators", "annual_cash_flow", "value"],
    isMonetary: true,
  },
  {
    label:      "Working Capital Debt",
    kpiKey:     "working_capital_debt",
    value:      (d) => d?.financial_metrics_2025?.debt_ratios?.working_capital_debt?.value,
    confidence: (d) => d?.financial_metrics_2025?.debt_ratios?.working_capital_debt?.confidence,
    valuePath:  ["financial_metrics_2025", "debt_ratios", "working_capital_debt", "value"],
    isMonetary: true,
  },
  // ── Base metrics ────────────────────────────────────────────────────────────
  {
    label:      "Revenue",
    kpiKey:     "revenue",
    value:      (d) => d?.financial_metrics_2025?.base_metrics?.revenue?.value,
    confidence: (d) => d?.financial_metrics_2025?.base_metrics?.revenue?.confidence,
    valuePath:  ["financial_metrics_2025", "base_metrics", "revenue", "value"],
    isMonetary: true,
  },
  {
    label:      "EBITDA",
    kpiKey:     "ebitda",
    value:      (d) => d?.financial_metrics_2025?.base_metrics?.ebitda?.value,
    confidence: (d) => d?.financial_metrics_2025?.base_metrics?.ebitda?.confidence,
    valuePath:  ["financial_metrics_2025", "base_metrics", "ebitda", "value"],
    isMonetary: true,
  },
  {
    label:      "COGS",
    kpiKey:     "cogs",
    value:      (d) => d?.financial_metrics_2025?.base_metrics?.cogs?.value,
    confidence: (d) => d?.financial_metrics_2025?.base_metrics?.cogs?.confidence,
    valuePath:  ["financial_metrics_2025", "base_metrics", "cogs", "value"],
    isMonetary: true,
  },
  // ── Sector metrics ───────────────────────────────────────────────────────────
  {
    label:      "MRR",
    kpiKey:     "mrr",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.mrr?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.mrr?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "mrr", "value"],
    isMonetary: true,
  },
  {
    label:      "Churn Rate",
    kpiKey:     "churn_rate",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.churn_rate?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.churn_rate?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "churn_rate", "value"],
    isMonetary: false,
  },
  {
    label:      "CAC",
    kpiKey:     "cac",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.cac?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.cac?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "cac", "value"],
    isMonetary: true,
  },
  {
    label:      "Portfolio (Cartera)",
    kpiKey:     "portfolio_size",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.portfolio_size?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.portfolio_size?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "portfolio_size", "value"],
    isMonetary: true,
  },
  {
    label:      "NPL Ratio",
    kpiKey:     "npl_ratio",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.npl_ratio?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.npl_ratio?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "npl_ratio", "value"],
    isMonetary: false,
  },
  {
    label:      "GMV",
    kpiKey:     "gmv",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.gmv?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.gmv?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "gmv", "value"],
    isMonetary: true,
  },
  {
    label:      "Loss Ratio",
    kpiKey:     "loss_ratio",
    value:      (d) => d?.financial_metrics_2025?.sector_metrics?.loss_ratio?.value,
    confidence: (d) => d?.financial_metrics_2025?.sector_metrics?.loss_ratio?.confidence,
    valuePath:  ["financial_metrics_2025", "sector_metrics", "loss_ratio", "value"],
    isMonetary: false,
  },
];

// ─── Executive summary generator ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function generateSummary(data: any): string {
  const fm = data?.financial_metrics_2025;
  if (!fm) return "No hay suficientes datos para generar un resumen ejecutivo.";

  const parts: string[] = [];

  const rg: string | undefined = fm?.revenue_growth?.value;
  if (rg) {
    const n = parseFloat(rg.replace(/[^-\d.]/g, ""));
    parts.push(
      n >= 40 ? `crecimiento excepcional del ${rg}` :
      n >= 20 ? `crecimiento sólido del ${rg}` :
      n > 0   ? `crecimiento del ${rg}` :
               `contracción del ${rg}`
    );
  }

  const gm: string | undefined = fm?.profit_margins?.gross_profit_margin?.value;
  if (gm) parts.push(`margen bruto de ${gm}`);

  const em: string | undefined = fm?.profit_margins?.ebitda_margin?.value;
  if (em) parts.push(`EBITDA de ${em}`);

  const cash: string | undefined = fm?.cash_flow_indicators?.cash_in_bank_end_of_year?.value;
  if (cash) parts.push(`posición de caja de ${cash}`);

  const acf: string | undefined = fm?.cash_flow_indicators?.annual_cash_flow?.value;
  if (acf) parts.push(`flujo de caja anual de ${acf}`);

  const wcd: string | undefined = fm?.debt_ratios?.working_capital_debt?.value;
  if (wcd) parts.push(`deuda de capital de trabajo de ${wcd}`);

  if (!parts.length)
    return "El análisis procesado no encontró métricas suficientes. Verifica el documento subido.";

  return (
    `La empresa reporta ${parts.join(", ")}. ` +
    "Los indicadores financieros presentan una base consolidada para el proceso de debida diligencia."
  );
}

function cleanFilename(name: string) {
  return name.replace(/^[a-f0-9]+_/, "");
}

// ─── Portfolio registry (mirrors PORTFOLIO_MAP in db_writer.py) ──────────────

type PortfolioId = "VII" | "CIII";

interface CompanyEntry { name: string; portfolioId: PortfolioId }

const PORTFOLIO_COMPANIES: CompanyEntry[] = [
  // Fondo VII
  { name: "Conekta",    portfolioId: "VII"  },
  { name: "Kueski",     portfolioId: "VII"  },
  { name: "Mpower",     portfolioId: "VII"  },
  { name: "YT",         portfolioId: "VII"  },
  { name: "PB",         portfolioId: "VII"  },
  { name: "Next",       portfolioId: "VII"  },
  { name: "iVoy",       portfolioId: "VII"  },
  { name: "Gaia",       portfolioId: "VII"  },
  { name: "Bewe",       portfolioId: "VII"  },
  { name: "Skydropx",   portfolioId: "VII"  },
  { name: "Bitso",      portfolioId: "VII"  },
  { name: "Cabify",     portfolioId: "VII"  },
  // Fondo CIII
  { name: "Simetrik",   portfolioId: "CIII" },
  { name: "Guros",      portfolioId: "CIII" },
  { name: "Quinio",     portfolioId: "CIII" },
  { name: "Hackmetrix", portfolioId: "CIII" },
  { name: "Hunty",      portfolioId: "CIII" },
  { name: "Cluvi",      portfolioId: "CIII" },
  { name: "Kuona",      portfolioId: "CIII" },
  { name: "Prometeo",   portfolioId: "CIII" },
  { name: "Territorium",portfolioId: "CIII" },
  { name: "M1",         portfolioId: "CIII" },
  { name: "Duppla",     portfolioId: "CIII" },
  { name: "Kala",       portfolioId: "CIII" },
  { name: "Pulsar",     portfolioId: "CIII" },
  { name: "Solvento",   portfolioId: "CIII" },
  { name: "Numia",      portfolioId: "CIII" },
  { name: "R2",         portfolioId: "CIII" },
  { name: "Atani",      portfolioId: "CIII" },
];

/** Matches a company_id string to its portfolio using substring matching. */
function lookupPortfolio(companyId: string): PortfolioId | null {
  const normalized = companyId.toLowerCase().replace(/[.\-_]/g, "");
  for (const c of PORTFOLIO_COMPANIES) {
    if (normalized.includes(c.name.toLowerCase())) {
      return c.portfolioId;
    }
  }
  return null;
}

// ─── FX helpers (mirrors fx_service.py — for client-side USD display) ─────────

const FX_RATES: Record<string, Record<number, number>> = {
  MXN: { 2019: 19.26, 2020: 21.49, 2021: 20.27, 2022: 20.12, 2023: 17.18, 2024: 17.15, 2025: 17.80 },
  BRL: { 2019:  3.94, 2020:  5.39, 2021:  5.40, 2022:  5.17, 2023:  4.99, 2024:  5.10, 2025:  5.25 },
  COP: { 2019: 3281,  2020: 3694,  2021: 3743,  2022: 4255,  2023: 4325,  2024: 4150,  2025: 4350  },
  ARS: { 2019:   48.2, 2020:   70.5, 2021:   95.1, 2022:  130.8, 2023:  350.0, 2024:  900.0, 2025: 1100.0 },
  CLP: { 2019:  703,  2020:  792,  2021:  759,  2022:  874,  2023:  840,  2024:  920,  2025:  960  },
  PEN: { 2019: 3.34, 2020: 3.49, 2021: 3.88, 2022: 3.84, 2023: 3.74, 2024: 3.80, 2025: 3.85 },
  EUR: { 2019: 0.893, 2020: 0.877, 2021: 0.846, 2022: 0.951, 2023: 0.924, 2024: 0.925, 2025: 0.910 },
  GBP: { 2019: 0.784, 2020: 0.780, 2021: 0.727, 2022: 0.812, 2023: 0.804, 2024: 0.790, 2025: 0.785 },
  CAD: { 2019: 1.327, 2020: 1.341, 2021: 1.254, 2022: 1.301, 2023: 1.350, 2024: 1.360, 2025: 1.380 },
  JPY: { 2019: 109.0, 2020: 106.8, 2021: 109.8, 2022: 131.5, 2023: 140.5, 2024: 149.7, 2025: 152.0 },
};

function parseFE(raw: string): number | null {
  if (!raw) return null;
  let s = raw.trim();
  const neg = s.startsWith("-");
  s = s.replace(/^[+-]/, "").replace(/\$/g, "").replace(/%/g, "").replace(/,/g, "");
  let mul = 1;
  const u = s.toUpperCase();
  if      (u.endsWith("B")) { mul = 1e9; s = s.slice(0, -1); }
  else if (u.endsWith("M")) { mul = 1e6; s = s.slice(0, -1); }
  else if (u.endsWith("K")) { mul = 1e3; s = s.slice(0, -1); }
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return (neg ? -n : n) * mul;
}

function formatUSD(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function toUSD(raw: string, currency: string, year: number): string | null {
  const rates = FX_RATES[currency.toUpperCase()];
  if (!rates) return null;
  const numVal = parseFE(raw);
  if (numVal === null) return null;
  const availYears = Object.keys(rates).map(Number);
  const nearest = availYears.reduce((a, b) => Math.abs(b - year) < Math.abs(a - year) ? b : a);
  const rate = rates[nearest];
  return formatUSD(numVal / rate);
}

// Deep-sets a value at `path` inside a nested object (immutably)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepSet(obj: any, path: string[], val: string): any {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  return {
    ...obj,
    [head]: rest.length === 0 ? val : deepSet(obj?.[head] ?? {}, rest, val),
  };
}

// ─── Mock / Simulation Data ───────────────────────────────────────────────────
// Used when BigQuery / GCS is unreachable or empty so the UI always looks alive.

const _mockFinancials = (rg: string, gm: string, eb: string, cash: string, acf: string, wcd: string) => ({
  _document_context: { currency: "USD", period: "FY2025" },
  financial_metrics_2025: {
    revenue_growth:  { value: rg,   confidence: 0.95 },
    profit_margins:  { gross_profit_margin: { value: gm, confidence: 0.93 }, ebitda_margin: { value: eb, confidence: 0.91 } },
    cash_flow_indicators: { cash_in_bank_end_of_year: { value: cash, confidence: 0.97 }, annual_cash_flow: { value: acf, confidence: 0.92 } },
    debt_ratios: { working_capital_debt: { value: wcd, confidence: 0.89 } },
  },
});

const MOCK_RESULTS: Record<PortfolioId, AnalysisResult> = {
  CIII: {
    id: "sim_simetrik_fy2025",
    date: new Date().toISOString(),
    data: _mockFinancials("42%", "71%", "-8%", "$14.2M", "-$3.8M", "$2.1M"),
    metadata: {
      original_filename: "Simetrik_FY2025_Financial_Report.pdf",
      founder_email: "cfo@simetrik.com",
      file_hash: "sim0001",
      processed_at: new Date().toISOString(),
      gcs_path: "vault/simetrik/sim0001.json",
      portfolio_id: "CIII",
    },
  },
  VII: {
    id: "sim_kueski_fy2025",
    date: new Date().toISOString(),
    data: _mockFinancials("31%", "48%", "12%", "$38.0M", "$9.4M", "$15.0M"),
    metadata: {
      original_filename: "Kueski_FY2025_Financial_Report.pdf",
      founder_email: "cfo@kueski.com",
      file_hash: "sim0002",
      processed_at: new Date().toISOString(),
      gcs_path: "vault/kueski/sim0002.json",
      portfolio_id: "VII",
    },
  },
};

function _mockSeries(company: string, pid: PortfolioId, rg: number, gm: number, eb: number, cash: number, acf: number, wcd: number): AnalyticsSeries {
  return {
    month: "2025-01", company_id: company, portfolio_id: pid, submission_count: 1,
    revenue_growth: rg, gross_profit_margin: gm, ebitda_margin: eb,
    cash_in_bank_end_of_year: cash, annual_cash_flow: acf, working_capital_debt: wcd,
    revenue: null, ebitda: null, cogs: null,
    mrr: null, churn_rate: null, cac: null,
    portfolio_size: null, npl_ratio: null, gmv: null, loss_ratio: null,
  };
}

const MOCK_ANALYTICS: Record<PortfolioId, AnalyticsData> = {
  CIII: {
    series: [
      _mockSeries("simetrik",   "CIII",  42,  71,  -8,  14200000, -3800000, 2100000),
      _mockSeries("guros",      "CIII",  28,  58,   4,   6500000,  1200000,  800000),
      _mockSeries("quinio",     "CIII",  65,  62, -18,   4200000, -5100000, 3400000),
      _mockSeries("hunty",      "CIII", 120,  55, -35,   2900000, -7200000, 1500000),
      _mockSeries("hackmetrix", "CIII",  55,  68,  -6,   3100000, -1800000,  950000),
    ],
    summary: { total_submissions: 5, companies_count: 5, companies: ["guros","hackmetrix","hunty","quinio","simetrik"], date_range: { min: "2025-01", max: "2025-01" } },
  },
  VII: {
    series: [
      _mockSeries("kueski",  "VII",  31,  48,  12,  38000000,  9400000, 15000000),
      _mockSeries("conekta", "VII",  22,  64,   8,  22000000,  4200000,  5800000),
      _mockSeries("bitso",   "VII",  88,  72, -12,  95000000,-18000000, 25000000),
      _mockSeries("cabify",  "VII",  15,  38,   6,  48000000,  7800000, 12000000),
      _mockSeries("iVoy",    "VII",  47,  55,  -3,   5200000, -2100000,  1400000),
    ],
    summary: { total_submissions: 5, companies_count: 5, companies: ["bitso","cabify","conekta","iVoy","kueski"], date_range: { min: "2025-01", max: "2025-01" } },
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

interface AnalistaDashboardProps {
  companyDomain: string;
  onLogout: () => void;
}

export default function AnalistaDashboard({ companyDomain, onLogout }: AnalistaDashboardProps) {
  const [selectedResult, setSelectedResult] = useState<AnalysisResult | null>(null);
  const [allResults, setAllResults]         = useState<AnalysisResult[]>([]);
  const [mounted, setMounted]               = useState(false);
  const [editOpen, setEditOpen]             = useState(false);
  const [editValues, setEditValues]         = useState<Record<string, string>>({});
  const [savedMetrics, setSavedMetrics]     = useState<Set<string>>(new Set());
  const [showValidated, setShowValidated]   = useState(false);
  const [showUSD, setShowUSD]               = useState(false);
  const [isLoadingResults, setIsLoadingResults] = useState(true);
  const [activePortfolio, setActivePortfolio]   = useState<PortfolioId>("CIII");
  const [portfolioFlash, setPortfolioFlash]     = useState(false);
  const [activeTab, setActiveTab]               = useState<"supervision" | "manual" | "audit">("supervision");
  // ── Entrada Manual state ──────────────────────────────────────────────────
  const [manualCompany, setManualCompany]       = useState("");
  const [manualPortfolio, setManualPortfolio]   = useState<PortfolioId>("CIII");
  const [manualPeriod, setManualPeriod]         = useState("FY2025");
  const [manualFields, setManualFields]         = useState<Record<string, string>>({});
  const [manualSaving, setManualSaving]         = useState(false);
  const [manualSaved, setManualSaved]           = useState(false);
  const [auditDeleting, setAuditDeleting]       = useState<Set<string>>(new Set());
  const [analyticsData, setAnalyticsData]       = useState<AnalyticsData | null>(null);
  const [isLoadingAnalytics, setIsLoadingAnalytics] = useState(false);
  const [isMockMode, setIsMockMode]             = useState(false);
  const savedTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portfolioTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Currency context derived from the selected document
  const detectedCurrency: string | undefined =
    selectedResult?.data?._document_context?.currency;
  const periodStr: string =
    selectedResult?.data?._document_context?.period ?? "";
  const reportYear: number = (() => {
    const m = periodStr.match(/(20\d{2})/);
    return m ? parseInt(m[1]) : new Date().getFullYear();
  })();
  // Toggle is meaningful only when doc uses a non-USD currency we can convert
  const showToggle =
    !!detectedCurrency &&
    detectedCurrency !== "USD" &&
    !!FX_RATES[detectedCurrency.toUpperCase()];

  // Portfolio filtering — results that explicitly match, OR have no recognized portfolio
  // (unknown / null), show under whichever tab is active so they're never hidden.
  const filteredResults = allResults.filter((r) => {
    const pid =
      (r.metadata as Record<string, string>).portfolio_id ??
      lookupPortfolio(r.metadata.founder_email);
    const isKnownPortfolio = pid === "VII" || pid === "CIII";
    return pid === activePortfolio || !isKnownPortfolio;
  });

  function switchPortfolio(pid: PortfolioId) {
    if (pid === activePortfolio) return;
    setActivePortfolio(pid);
    // Glow flash: add class, remove after animation (600 ms)
    if (portfolioTimerRef.current) clearTimeout(portfolioTimerRef.current);
    setPortfolioFlash(true);
    portfolioTimerRef.current = setTimeout(() => setPortfolioFlash(false), 650);
    // Select first result of the new portfolio (if any)
    if (isMockMode) {
      // In simulation mode, swap both the displayed result and the allResults list
      const mock = MOCK_RESULTS[pid];
      setAllResults([mock]);
      setSelectedResult(mock);
      return;
    }
    const first = allResults.find((r) => {
      const p =
        (r.metadata as Record<string, string>).portfolio_id ??
        lookupPortfolio(r.metadata.founder_email);
      return p === pid;
    });
    if (first) setSelectedResult(first);
    else setSelectedResult(null);
  }

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    setIsLoadingResults(true);
    fetch("http://localhost:8000/api/results/all")
      .then((r) => r.json())
      .then((data) => {
        if (data.status === "success") {
          const results: AnalysisResult[] = data.results ?? [];
          if (results.length > 0) {
            setAllResults(results);
            setIsMockMode(false);
            // Auto-select: prefer a result from the active portfolio, else take any first
            const preferred = results.find(
              (r) => (r.metadata as Record<string, string>).portfolio_id === activePortfolio
            );
            const first = preferred ?? results[0];
            setSelectedResult(first);
            const detectedPid = (first.metadata as Record<string, string>).portfolio_id;
            if ((detectedPid === "VII" || detectedPid === "CIII") && detectedPid !== activePortfolio) {
              setActivePortfolio(detectedPid as PortfolioId);
            }
          } else {
            // GCS vault is empty — enter simulation mode
            const mock = MOCK_RESULTS[activePortfolio];
            setAllResults([mock]);
            setSelectedResult(mock);
            setIsMockMode(true);
          }
        }
      })
      .catch(() => {
        // API unreachable — enter simulation mode
        const mock = MOCK_RESULTS[activePortfolio];
        setAllResults([mock]);
        setSelectedResult(mock);
        setIsMockMode(true);
      })
      .finally(() => setIsLoadingResults(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch BigQuery portfolio analytics whenever the active portfolio tab changes
  useEffect(() => {
    setIsLoadingAnalytics(true);
    setAnalyticsData(null);
    fetch(`http://localhost:8000/api/analytics/portfolio?portfolio_id=${activePortfolio}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.status === "success" && (data.series ?? []).length > 0) {
          setAnalyticsData({ series: data.series, summary: data.summary });
        } else {
          setAnalyticsData(MOCK_ANALYTICS[activePortfolio]);
          setIsMockMode(true);
        }
      })
      .catch(() => {
        setAnalyticsData(MOCK_ANALYTICS[activePortfolio]);
        setIsMockMode(true);
      })
      .finally(() => setIsLoadingAnalytics(false));
  }, [activePortfolio]);

  async function handleDeleteSubmission(fileHash: string, companyId: string) {
    setAuditDeleting((prev) => new Set([...prev, fileHash]));
    try {
      await fetch(
        `http://localhost:8000/api/submission?file_hash=${encodeURIComponent(fileHash)}&company_id=${encodeURIComponent(companyId)}`,
        { method: "DELETE" }
      );
      setAllResults((prev) => prev.filter((r) => r.metadata.file_hash !== fileHash));
      if (selectedResult?.metadata.file_hash === fileHash) setSelectedResult(null);
    } catch (err) {
      console.error("[delete-submission]", err);
    } finally {
      setAuditDeleting((prev) => {
        const next = new Set(prev);
        next.delete(fileHash);
        return next;
      });
    }
  }

  async function handleManualSave() {
    if (!manualCompany) return;
    setManualSaving(true);
    try {
      await fetch("http://localhost:8000/api/manual-entry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          company_id:   manualCompany,
          portfolio_id: manualPortfolio,
          period_id:    manualPeriod,
          ...manualFields,
        }),
      });
      setManualSaved(true);
      setManualFields({});
      setTimeout(() => setManualSaved(false), 2400);
    } catch (err) {
      console.error("[manual-entry]", err);
    } finally {
      setManualSaving(false);
    }
  }

  function openEdit() {
    const vals: Record<string, string> = {};
    METRIC_DEFS.forEach((m) => { vals[m.label] = m.value(selectedResult?.data) ?? ""; });
    setEditValues(vals);
    setEditOpen(true);
  }

  function handleSave() {
    if (!selectedResult) return;

    // Detect which metrics actually changed (label → new value differs from current)
    const changed = METRIC_DEFS.filter(
      (m) => editValues[m.label] !== (m.value(selectedResult.data) ?? "")
    );

    // ── 1. Optimistic local update — charts refresh instantly ──────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let updated: any = selectedResult.data;
    METRIC_DEFS.forEach((m) => {
      if (editValues[m.label] !== undefined) {
        updated = deepSet(updated, m.valuePath, editValues[m.label]);
      }
    });
    const updatedResult = { ...selectedResult, data: updated };
    setSelectedResult(updatedResult);
    setAllResults((prev) => prev.map((r) => (r.id === updatedResult.id ? updatedResult : r)));
    setEditOpen(false);

    if (changed.length === 0) return;

    // ── 2. Micro-interactions ─────────────────────────────────────────────
    // Cancel any in-progress glow from a previous rapid save
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);

    setSavedMetrics(new Set(changed.map((m) => m.label)));
    setShowValidated(true);

    // Duration matches the CSS animation (2.4s) — clear state after animation ends
    savedTimerRef.current = setTimeout(() => {
      setSavedMetrics(new Set());
      setShowValidated(false);
    }, 2400);

    // ── 3. Persist to BigQuery (fire-and-forget, best-effort) ─────────────
    // submission_id is available when the result came from a fresh upload.
    const submissionId = selectedResult.metadata.submission_id;
    if (submissionId) {
      changed.forEach((m) => {
        fetch("http://localhost:8000/api/kpi-update", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            submission_id: submissionId,
            metric_id:     m.kpiKey,
            value:         editValues[m.label],
          }),
        }).catch((err) =>
          console.warn(`[kpi-update] ${m.kpiKey} failed (non-fatal):`, err)
        );
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  // Fund stats for sidebar (derived from filteredResults)
  const fundSubmissionCount = filteredResults.length;

  return (
    <div className="flex min-h-screen bg-transparent">

      {/* ── Sidebar (desktop) ───────────────────────────────────────────────── */}
      <aside className="fixed left-0 top-0 z-40 hidden md:flex h-screen w-64 flex-col border-r border-white/10 bg-black/60 backdrop-blur-xl">

        {/* Logo */}
        <div className="flex h-16 items-center border-b border-white/10 px-6 gap-3">
          <img src="/COMETALOGO.png" alt="Cometa" className="h-8 w-auto object-contain invert" />
          <span className="text-base font-light tracking-widest text-white">COMETA</span>
          <span className="text-xs text-primary ml-auto">VC</span>
        </div>

        {/* Fund Selector */}
        <div className="border-b border-white/10 p-4">
          <span className="mb-3 block text-[10px] font-medium uppercase tracking-widest text-white/40">
            Fondos
          </span>
          <div className="space-y-2">
            {(["VII", "CIII"] as PortfolioId[]).map((pid) => (
              <button
                key={pid}
                onClick={() => switchPortfolio(pid)}
                className={cn(
                  "flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition-all",
                  activePortfolio === pid
                    ? "bg-primary/15 text-primary border border-primary/25"
                    : "bg-white/5 text-white/60 border border-transparent hover:bg-white/8 hover:text-white/80"
                )}
              >
                <div>
                  <span className="block text-sm font-light">Fondo {pid}</span>
                </div>
                <ChevronRight className={cn("h-4 w-4 transition-transform opacity-50", activePortfolio === pid && "rotate-90 opacity-100")} />
              </button>
            ))}
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-4">
          <span className="mb-3 block text-[10px] font-medium uppercase tracking-widest text-white/40">
            Navegación
          </span>
          <div className="space-y-1">
            {([
              { id: "supervision" as const, label: "Supervisión",    icon: BarChart3  },
              { id: "manual"      as const, label: "Entrada Manual", icon: Building2  },
              { id: "audit"       as const, label: "Auditoría",      icon: ShieldCheck},
            ]).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left transition-all",
                  activeTab === id
                    ? "bg-white/10 text-white"
                    : "text-white/40 hover:bg-white/5 hover:text-white/70"
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="text-sm font-light">{label}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* Currency toggle (non-USD docs) */}
        {showToggle && (
          <div className="px-4 pb-3">
            <div className="flex items-center rounded-lg border border-white/10 overflow-hidden">
              <button onClick={() => setShowUSD(false)} className={cn("flex-1 py-2 text-[10px] tracking-widest uppercase transition-all", !showUSD ? "bg-white/10 text-white/80" : "text-white/30 hover:text-white/50")}>
                {detectedCurrency}
              </button>
              <button onClick={() => setShowUSD(true)} className={cn("flex-1 py-2 text-[10px] tracking-widest uppercase transition-all", showUSD ? "bg-primary/15 text-primary" : "text-white/30 hover:text-white/50")}>
                USD
              </button>
            </div>
          </div>
        )}

        {/* Submissions count + Logout */}
        <div className="border-t border-white/10 p-4 space-y-3">
          <div className="rounded-xl bg-white/5 p-4">
            <span className="text-[10px] text-white/40 uppercase tracking-widest">Fondo {activePortfolio}</span>
            <p className="mt-1 text-2xl font-light text-white">{fundSubmissionCount}</p>
            <span className="text-xs text-white/30">submissions</span>
          </div>
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 rounded-xl bg-white/5 border border-white/10 py-2.5 text-xs text-white/40 hover:text-white/70 transition-colors tracking-wider"
          >
            Salir
          </button>
        </div>
      </aside>

      {/* ── Mobile header (hamburger only) ─────────────────────────────────── */}
      <div className="fixed top-0 left-0 right-0 z-50 md:hidden flex items-center justify-between px-4 py-4 border-b border-white/[0.04] bg-black/80 backdrop-blur-sm">
        <div className="flex items-center gap-2">
          <img src="/COMETALOGO.png" alt="Cometa" className="h-8 w-auto object-contain invert" />
          <span className="text-sm font-light tracking-widest text-white">COMETA</span>
        </div>
        <MobileNav roleLabel="ANALISTA" companyDomain={companyDomain} onLogout={onLogout} />
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <main className="ml-0 md:ml-64 flex-1 min-h-screen pt-16 md:pt-0 px-4 md:px-8 pb-16">

        {/* ── Entrada Manual tab ── */}
        {activeTab === "manual" && (
          <div className={`transition-opacity duration-500 ${mounted ? "opacity-100" : "opacity-0"}`}>
            <div className="cometa-card-gradient p-6 md:p-8 max-w-2xl">
              <div className="cometa-label text-white mb-6">Auditoría · Entrada Manual</div>

              {/* Company + Portfolio row */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
                <div>
                  <label className="cometa-label text-white/30 mb-1.5 block">Startup</label>
                  <div className="relative">
                    <select
                      value={manualCompany}
                      onChange={(e) => {
                        setManualCompany(e.target.value);
                        // auto-set portfolio from selection
                        const c = PORTFOLIO_COMPANIES.find(
                          (x) => x.name.toLowerCase() === e.target.value
                        );
                        if (c) setManualPortfolio(c.portfolioId);
                      }}
                      className="w-full rounded-xl px-4 py-3 pr-8 font-cometa-extralight text-white/70 text-sm bg-white/[0.03] border border-white/[0.08] focus:border-[#64CAE4]/40 focus:outline-none transition-colors appearance-none"
                    >
                      <option value="" className="bg-black">Seleccionar…</option>
                      {(["VII","CIII"] as PortfolioId[]).map((pid) => (
                        <optgroup key={pid} label={`Fondo ${pid}`} className="bg-black">
                          {PORTFOLIO_COMPANIES.filter((c) => c.portfolioId === pid).map((c) => (
                            <option key={c.name} value={c.name.toLowerCase()} className="bg-black text-white/70">
                              {c.name}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="opacity-25">
                        <path d="M2 4.5L6 8.5L10 4.5" stroke="#64CAE4" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                    </div>
                  </div>
                </div>
                <div>
                  <label className="cometa-label text-white/30 mb-1.5 block">Período</label>
                  <input
                    type="text"
                    value={manualPeriod}
                    onChange={(e) => setManualPeriod(e.target.value)}
                    placeholder="FY2025"
                    className="w-full rounded-xl px-4 py-3 font-cometa-extralight text-white/70 text-sm bg-white/[0.03] border border-white/[0.08] focus:border-[#64CAE4]/40 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              {/* KPI fields table */}
              <div className="space-y-3 mb-7">
                {[
                  { key: "revenue_growth",           label: "Revenue Growth",      hint: "36%" },
                  { key: "gross_profit_margin",       label: "Gross Profit Margin", hint: "68%" },
                  { key: "ebitda_margin",             label: "EBITDA Margin",       hint: "-12%" },
                  { key: "cash_in_bank_end_of_year",  label: "Cash in Bank",        hint: "$9.7M" },
                  { key: "annual_cash_flow",          label: "Annual Cash Flow",    hint: "-$3.2M" },
                  { key: "working_capital_debt",      label: "Working Capital Debt",hint: "$1.1M" },
                ].map(({ key, label, hint }) => (
                  <div key={key} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
                    <span className="font-cometa-extralight text-white/35 text-[11px] tracking-[0.12em] uppercase sm:w-44 sm:flex-shrink-0">
                      {label}
                    </span>
                    <input
                      type="text"
                      value={manualFields[key] ?? ""}
                      onChange={(e) => setManualFields((p) => ({ ...p, [key]: e.target.value }))}
                      placeholder={hint}
                      className="flex-1 rounded-xl px-4 py-2.5 font-cometa-extralight text-white/70 text-sm bg-white/[0.03] border border-white/[0.06] focus:border-[#64CAE4]/40 focus:outline-none transition-colors placeholder:text-white/15"
                    />
                  </div>
                ))}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between pt-5 border-t border-white/[0.05]">
                {manualSaved ? (
                  <span className="cometa-validated-badge flex items-center gap-2">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
                      <circle cx="6.5" cy="6.5" r="5.5" stroke="#64CAE4" strokeWidth="1"/>
                      <path d="M4 6.5L5.8 8.3L9 5" stroke="#64CAE4" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="font-cometa-extralight text-white/80 text-[10px] tracking-[0.16em] uppercase">
                      Datos guardados
                    </span>
                  </span>
                ) : <span />}
                <button
                  onClick={handleManualSave}
                  disabled={!manualCompany || manualSaving}
                  className="px-5 py-2 rounded-xl border border-[#64CAE4]/30 font-cometa-extralight text-white/80 text-[11px] tracking-[0.12em] uppercase hover:border-[#64CAE4]/65 hover:text-white transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {manualSaving ? "Guardando…" : "Guardar en BigQuery"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Auditoría tab ── */}
        {activeTab === "audit" && (
          <div className={`transition-opacity duration-500 ${mounted ? "opacity-100" : "opacity-0"}`}>
            <div className="cometa-card-gradient p-6 md:p-8">

              {/* Header */}
              <div className="flex items-center gap-3 mb-7">
                <span className="block w-0.5 h-5 bg-gradient-to-b from-[#00237F] to-[#64CAE4] rounded-full flex-shrink-0" />
                <span className="cometa-label text-white/45">Auditoría de Duplicados</span>
              </div>

              {allResults.length === 0 ? (
                <div className="font-cometa-extralight text-white/20 text-sm text-center py-10">
                  Sin documentos en el archivo
                </div>
              ) : (
                <div className="cometa-table-scroll">
                  <table className="w-full min-w-[540px]">
                    <thead>
                      <tr className="border-b border-white/[0.05]">
                        <th className="text-left cometa-label text-white/20 pb-3 pr-4 font-normal">Documento</th>
                        <th className="text-left cometa-label text-white/20 pb-3 pr-4 font-normal">Hash</th>
                        <th className="text-left cometa-label text-white/20 pb-3 pr-4 font-normal">Fecha</th>
                        <th className="text-left cometa-label text-white/20 pb-3 pr-4 font-normal">Fondo</th>
                        <th className="text-left cometa-label text-white/20 pb-3 pr-4 font-normal">Fidelidad</th>
                        <th className="pb-3" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {(() => {
                        // detect duplicate normalized filenames
                        const nameCount: Record<string, number> = {};
                        allResults.forEach((r) => {
                          const n = cleanFilename(r.metadata.original_filename);
                          nameCount[n] = (nameCount[n] ?? 0) + 1;
                        });
                        return allResults.map((r) => {
                          const cleanName  = cleanFilename(r.metadata.original_filename);
                          const isDuplicate = nameCount[cleanName] > 1;
                          const pid = (r.metadata as Record<string, string>).portfolio_id
                            ?? lookupPortfolio(r.metadata.founder_email);
                          const isDeleting = auditDeleting.has(r.metadata.file_hash);
                          const submissionId = (r.metadata as Record<string, string>).submission_id ?? null;
                          return (
                            <tr key={r.id} className={isDuplicate ? "bg-amber-400/[0.025]" : ""}>
                              <td className="py-3 pr-4">
                                <div className="flex items-center gap-2">
                                  {isDuplicate && (
                                    <span className="block w-1.5 h-1.5 rounded-full bg-amber-400/70 flex-shrink-0" />
                                  )}
                                  <span className="font-cometa-extralight text-white/55 text-xs truncate max-w-[200px]">
                                    {cleanName}
                                  </span>
                                </div>
                              </td>
                              <td className="py-3 pr-4">
                                <span className="font-mono font-cometa-extralight text-white/20 text-[10px] tracking-wider">
                                  {r.metadata.file_hash?.slice(0, 8) ?? "—"}
                                </span>
                              </td>
                              <td className="py-3 pr-4">
                                <span className="font-cometa-extralight text-white/30 text-xs">
                                  {new Date(r.metadata.processed_at).toLocaleDateString("es", {
                                    day: "2-digit", month: "short", year: "numeric",
                                  })}
                                </span>
                              </td>
                              <td className="py-3 pr-4">
                                {pid && (
                                  <span className="font-cometa-extralight text-[9px] tracking-[0.14em] uppercase px-2 py-0.5 rounded border border-[#64CAE4]/15 text-white/40">
                                    {pid}
                                  </span>
                                )}
                              </td>
                              {/* ── Fidelity Audit column ── */}
                              <td className="py-3 pr-4">
                                {submissionId ? (
                                  <FidelityAuditPanel
                                    submissionId={submissionId}
                                    companyId={r.metadata.founder_email}
                                  />
                                ) : (
                                  <span className="font-cometa-extralight text-white/15 text-[10px]">sin ID</span>
                                )}
                              </td>
                              <td className="py-3 text-right">
                                <button
                                  onClick={() => handleDeleteSubmission(r.metadata.file_hash, r.metadata.founder_email)}
                                  disabled={isDeleting}
                                  className="font-cometa-extralight text-[10px] tracking-[0.12em] uppercase text-red-400/35 hover:text-red-400/75 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
                                >
                                  {isDeleting ? "…" : "Eliminar"}
                                </button>
                              </td>
                            </tr>
                          );
                        });
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Supervisión tab: loading / empty state ── */}
        {activeTab === "supervision" && !selectedResult && (
          <div className={`transition-opacity duration-700 ${mounted ? "opacity-100" : "opacity-0"}`}>
            {isLoadingResults ? (
              /* Skeleton grid — mirrors the real supervision layout */
              <div className="space-y-5 md:space-y-6 mt-6 md:mt-8">
                {/* Section header skeleton */}
                <div className="flex items-center gap-3">
                  <span className="block w-0.5 h-5 bg-white/10 rounded-full flex-shrink-0" />
                  <div className="h-5 w-52 rounded bg-white/[0.07] animate-pulse" />
                </div>
                {/* Executive summary skeleton */}
                <div className="cometa-card-gradient p-5 md:p-7 space-y-2 animate-pulse">
                  <div className="h-3 w-28 rounded bg-white/[0.07]" />
                  <div className="h-3 w-full rounded bg-white/[0.05] mt-3" />
                  <div className="h-3 w-4/5 rounded bg-white/[0.05]" />
                  <div className="h-3 w-3/5 rounded bg-white/[0.05]" />
                </div>
                {/* KPI card skeletons — 6 matching METRIC_DEFS */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <KPICardSkeleton key={i} />
                  ))}
                </div>
              </div>
            ) : (
              /* Truly empty — no documents exist */
              <div className="flex flex-col items-center justify-center py-24 gap-6">
                <img
                  src="/COMETALOGO.png"
                  alt=""
                  className="w-28 object-contain select-none opacity-20 invert"
                  style={{ opacity: 0.12 }}
                />
                <div className="w-px h-8 bg-gradient-to-b from-transparent via-white/10 to-transparent" />
                <div className="text-center space-y-2">
                  <p className="font-cometa-extralight text-white/30 text-sm tracking-wide">
                    Bóveda sincronizada.
                  </p>
                  <p className="font-cometa-extralight text-white/15 text-xs tracking-[0.12em]">
                    Sin reportes pendientes.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Dashboard ── */}
        {activeTab === "supervision" && selectedResult && (
          <div className={[
            "space-y-5 md:space-y-6 mt-6 md:mt-8 transition-opacity duration-500",
            mounted ? "opacity-100" : "opacity-0",
            portfolioFlash ? "cometa-portfolio-flash" : "",
          ].join(" ")}>

            {/* Section header + edit trigger */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="block w-0.5 h-5 md:h-6 bg-gradient-to-b from-[#00237F] to-[#64CAE4] rounded-full flex-shrink-0" />
                <h1 className="cometa-title">Intelligence Dashboard</h1>
                {isMockMode && (
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-400/25 bg-amber-400/[0.06]">
                    <span className="block w-1.5 h-1.5 rounded-full bg-amber-400/70 animate-pulse flex-shrink-0" />
                    <span className="font-cometa-extralight text-amber-400/70 text-[9px] tracking-[0.18em] uppercase whitespace-nowrap">
                      Modo Simulación
                    </span>
                  </span>
                )}
              </div>
              {/* "Datos Validados" badge — appears and self-fades after save */}
              {showValidated && (
                <div className="cometa-validated-badge flex items-center gap-2">
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <circle cx="6.5" cy="6.5" r="5.5" stroke="#64CAE4" strokeWidth="1" />
                    <path
                      d="M4 6.5L5.8 8.3L9 5"
                      stroke="#64CAE4"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span className="font-cometa-extralight text-white/80 text-[10px] tracking-[0.16em] uppercase whitespace-nowrap">
                    Datos Validados
                  </span>
                </div>
              )}

              <button
                onClick={openEdit}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#64CAE4]/20 hover:border-[#64CAE4]/45 transition-colors flex-shrink-0"
              >
                {/* Pencil icon */}
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                  <path
                    d="M8.5 1.5L10.5 3.5L4 10H2V8L8.5 1.5Z"
                    stroke="#64CAE4"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span className="font-cometa-extralight text-white/70 text-[10px] tracking-[0.14em] uppercase">
                  Editar Datos
                </span>
              </button>
            </div>

            {/* Executive Summary */}
            <div className="cometa-card-gradient p-5 md:p-7 cometa-fade-in-delay-1">
              <div className="cometa-label text-white mb-3">
                Resumen Ejecutivo IA
              </div>
              <p className="font-cometa-extralight text-white/65 text-sm leading-relaxed">
                {generateSummary(selectedResult.data)}
              </p>
            </div>

            {/* ── Metric cards ──
                Mobile (< md):   1 column
                Tablet (md):     2 columns
                Desktop (lg+):   4 columns               */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
              {METRIC_DEFS.map((m, i) => {
                const raw     = m.value(selectedResult.data);
                const conf    = m.confidence(selectedResult.data);
                const lowConf = conf !== undefined && conf < 0.85;

                // USD conversion — only for monetary KPIs on non-USD documents
                const usdValue =
                  showUSD && m.isMonetary && raw && showToggle
                    ? toUSD(raw, detectedCurrency!, reportYear)
                    : null;
                const displayValue = usdValue ?? raw;

                const num    = displayValue ? parseFloat(displayValue.replace(/[^-\d.]/g, "")) : NaN;
                const accent = !isNaN(num) && num > 0;

                return (
                  <div
                    key={m.label}
                    className={[
                      "cometa-card-gradient p-4 md:p-5 cometa-fade-in",
                      lowConf ? "ring-1 ring-amber-400/15" : "",
                      savedMetrics.has(m.label) ? "cometa-card-saved" : "",
                    ].join(" ").trim()}
                    style={{
                      animationDelay: `${(i + 2) * 0.1}s`,
                      opacity: 0,
                      animationFillMode: "forwards",
                    }}
                  >
                    {/* Label row: metric name + low-confidence badge */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="cometa-metric-label">{m.label}</div>
                      {lowConf && (
                        <div className="flex items-center gap-1 flex-shrink-0 mt-px">
                          <span className="block w-1.5 h-1.5 rounded-full bg-amber-400/70 flex-shrink-0" />
                          <span className="font-cometa-extralight text-amber-400/60 text-[9px] tracking-wider leading-none">
                            {Math.round((conf ?? 0) * 100)}%
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Metric value — transitions smoothly between original / USD */}
                    <div
                      className="cometa-metric-fluid transition-all duration-500"
                      style={{
                        color: displayValue
                          ? "rgba(255,255,255,0.90)"
                          : "rgba(255,255,255,0.2)",
                      }}
                    >
                      {displayValue ?? "—"}
                    </div>

                    {/* USD mode: subtle "≈ USD" label for converted monetary values */}
                    {usdValue && (
                      <div className="mt-1 font-cometa-extralight text-white/35 text-[9px] tracking-[0.14em] uppercase transition-all duration-500">
                        ≈ USD
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* ── Charts + Sidebar ──
                Mobile:  stacked (charts first, history below)
                Desktop: side by side                          */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] xl:grid-cols-[1fr_320px] gap-4 md:gap-5">

              {/* Charts — horizontal scroll on mobile so layout never breaks */}
              <div
                className="cometa-card-gradient p-4 md:p-6 cometa-fade-in"
                style={{ animationDelay: "0.55s", opacity: 0, animationFillMode: "forwards" }}
              >
                <div className="cometa-table-scroll">
                  <FinancialCharts
                    selectedResult={selectedResult}
                    allResults={allResults}
                    showUSD={showUSD}
                  />
                </div>
              </div>

              {/* History sidebar */}
              <div
                className="cometa-card-gradient p-4 md:p-5 cometa-fade-in"
                style={{ animationDelay: "0.65s", opacity: 0, animationFillMode: "forwards" }}
              >
                <div className="cometa-label text-white/30 mb-4">
                  Historial de Análisis
                </div>

                {/* On mobile: horizontal pill strip. On desktop: vertical list */}
                <div className="flex flex-row lg:flex-col gap-2 overflow-x-auto lg:overflow-x-visible pb-1 lg:pb-0 cometa-table-scroll lg:space-y-1.5">
                  {(filteredResults.length > 0 ? filteredResults : allResults).slice(0, 10).map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedResult(r)}
                      className={`
                        flex-shrink-0 lg:flex-shrink text-left
                        px-3 py-2.5 rounded-xl transition-all duration-200
                        min-w-[140px] lg:min-w-0 lg:w-full
                        ${selectedResult.id === r.id
                          ? "bg-white/[0.07] border border-[#64CAE4]/20"
                          : "hover:bg-white/[0.03] border border-transparent"
                        }
                      `}
                    >
                      <div className="font-cometa-extralight text-white/60 text-[12px] truncate">
                        {cleanFilename(r.metadata.original_filename)}
                      </div>
                      <div className="font-cometa-extralight text-white/25 text-[11px] mt-0.5">
                        {new Date(r.metadata.processed_at).toLocaleDateString("es", {
                          day: "2-digit",
                          month: "short",
                          year: "numeric",
                        })}
                      </div>
                    </button>
                  ))}

                  {allResults.length === 0 && (
                    <div className="font-cometa-extralight text-white/20 text-[12px] text-center py-5 w-full">
                      Sin análisis previos
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Portfolio Analytics (BigQuery) ── */}
            <div
              className="cometa-card-gradient p-4 md:p-6 cometa-fade-in"
              style={{ animationDelay: "0.75s", opacity: 0, animationFillMode: "forwards" }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                  <span className="block w-0.5 h-5 bg-gradient-to-b from-[#00237F] to-[#64CAE4] rounded-full flex-shrink-0" />
                  <span className="cometa-label text-white/45">Analytics · Fondo {activePortfolio}</span>
                </div>
                {analyticsData && (
                  <div className="flex items-center gap-4">
                    <span className="font-cometa-extralight text-white/20 text-[10px] tracking-widest">
                      {analyticsData.summary.companies_count} empresas · {analyticsData.summary.total_submissions} submissions
                    </span>
                    {analyticsData.summary.date_range.min && (
                      <span className="font-cometa-extralight text-white/15 text-[10px]">
                        {analyticsData.summary.date_range.min} → {analyticsData.summary.date_range.max}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Loading */}
              {isLoadingAnalytics && (
                <div className="flex items-center justify-center py-12 gap-3">
                  <div className="w-5 h-5 rounded-full border-2 border-[#64CAE4]/20 border-t-[#64CAE4] animate-spin" />
                  <span className="font-cometa-extralight text-white/25 text-xs tracking-widest">
                    Consultando BigQuery…
                  </span>
                </div>
              )}

              {/* No data */}
              {!isLoadingAnalytics && (!analyticsData || analyticsData.series.length === 0) && (
                <p className="font-cometa-extralight text-white/20 text-sm text-center py-10">
                  Sin datos en BigQuery para Fondo {activePortfolio}
                </p>
              )}

              {/* Per-company KPI bar chart */}
              {!isLoadingAnalytics && analyticsData && analyticsData.series.length > 0 && (() => {
                type CompanyAgg = { revenue_growth: number[]; gross_profit_margin: number[]; ebitda_margin: number[] };
                const agg: Record<string, CompanyAgg> = {};
                analyticsData.series.forEach((s) => {
                  if (!agg[s.company_id]) agg[s.company_id] = { revenue_growth: [], gross_profit_margin: [], ebitda_margin: [] };
                  if (s.revenue_growth      != null) agg[s.company_id].revenue_growth.push(s.revenue_growth);
                  if (s.gross_profit_margin != null) agg[s.company_id].gross_profit_margin.push(s.gross_profit_margin);
                  if (s.ebitda_margin       != null) agg[s.company_id].ebitda_margin.push(s.ebitda_margin);
                });
                const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
                const companies = Object.keys(agg).sort();
                const chartMetrics: { key: keyof CompanyAgg; label: string; color: string }[] = [
                  { key: "revenue_growth",      label: "Rev. Growth",  color: "#64CAE4" },
                  { key: "gross_profit_margin", label: "Gross Margin", color: "#00237F" },
                  { key: "ebitda_margin",        label: "EBITDA",       color: "#4A90D9" },
                ];
                let maxVal = 1;
                companies.forEach((c) => chartMetrics.forEach(({ key }) => {
                  const v = avg(agg[c][key]);
                  if (v !== null) maxVal = Math.max(maxVal, Math.abs(v));
                }));
                return (
                  <div className="space-y-5">
                    {/* Legend */}
                    <div className="flex items-center gap-5">
                      {chartMetrics.map(({ label, color }) => (
                        <div key={label} className="flex items-center gap-1.5">
                          <span className="block w-2 h-2 rounded-sm flex-shrink-0" style={{ background: color, opacity: 0.65 }} />
                          <span className="font-cometa-extralight text-white/30 text-[10px] tracking-widest uppercase">{label}</span>
                        </div>
                      ))}
                    </div>
                    {/* Rows */}
                    <div className="space-y-4 overflow-x-auto cometa-table-scroll">
                      {companies.map((company) => (
                        <div key={company} className="min-w-[340px]">
                          <div className="font-cometa-extralight text-white/40 text-[11px] tracking-widest mb-1.5 capitalize">{company}</div>
                          <div className="space-y-1.5">
                            {chartMetrics.map(({ key, label, color }) => {
                              const val = avg(agg[company][key]);
                              if (val === null) return (
                                <div key={label} className="flex items-center gap-2 h-4">
                                  <div className="w-20 font-cometa-extralight text-white/15 text-[9px] tracking-widest text-right flex-shrink-0">{label}</div>
                                  <div className="flex-1 h-1 bg-white/[0.03] rounded-full" />
                                  <div className="w-10 font-cometa-extralight text-white/15 text-[9px]">—</div>
                                </div>
                              );
                              const pct = Math.min(Math.abs(val) / maxVal, 1) * 100;
                              const isNeg = val < 0;
                              return (
                                <div key={label} className="flex items-center gap-2 h-4">
                                  <div className="w-20 font-cometa-extralight text-white/25 text-[9px] tracking-widest text-right flex-shrink-0">{label}</div>
                                  <div className="flex-1 relative h-1.5 bg-white/[0.04] rounded-full overflow-hidden">
                                    <div
                                      className="absolute top-0 h-full rounded-full transition-all duration-700"
                                      style={{
                                        width: `${pct}%`,
                                        background: isNeg ? "rgba(251,191,36,0.45)" : color,
                                        opacity: 0.75,
                                      }}
                                    />
                                  </div>
                                  <div
                                    className="w-12 font-cometa-extralight text-[10px] text-right flex-shrink-0"
                                    style={{ color: isNeg ? "rgba(251,191,36,0.6)" : `${color}99` }}
                                  >
                                    {val.toFixed(1)}%
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

          </div>
        )}
      </main>

      {/* ── Edit Modal ────────────────────────────────────────────────────────── */}
      {editOpen && selectedResult && (
        <div className="fixed inset-0 z-[80] flex items-start md:items-center justify-center p-4 pt-20 md:pt-4">

          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/85 backdrop-blur-sm"
            onClick={() => setEditOpen(false)}
          />

          {/* Modal card */}
          <div className="relative cometa-card-gradient w-full max-w-lg p-6 md:p-8 max-h-[80vh] overflow-y-auto cometa-table-scroll">

            {/* Header */}
            <div className="flex items-start justify-between mb-7">
              <div>
                <div className="cometa-label text-white mb-1">Editar Análisis</div>
                <p className="font-cometa-extralight text-white/25 text-[11px] truncate max-w-[280px]">
                  {cleanFilename(selectedResult.metadata.original_filename)}
                </p>
              </div>
              <button
                onClick={() => setEditOpen(false)}
                className="text-white/30 hover:text-white/70 transition-colors p-1 flex-shrink-0 ml-4"
                aria-label="Cerrar"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2 2L14 14M14 2L2 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {/* Fields */}
            <div className="space-y-5">
              {METRIC_DEFS.map((m) => {
                const conf    = m.confidence(selectedResult.data);
                const lowConf = conf !== undefined && conf < 0.85;

                return (
                  <div key={m.label}>
                    {/* Field label + confidence badge */}
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="cometa-label text-white/40">{m.label}</label>
                      {lowConf && (
                        <div className="flex items-center gap-1.5">
                          <span className="block w-1.5 h-1.5 rounded-full bg-amber-400/70 flex-shrink-0" />
                          <span className="font-cometa-extralight text-amber-400/60 text-[10px] tracking-wider">
                            Baja confianza · {Math.round((conf ?? 0) * 100)}%
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Input */}
                    <input
                      type="text"
                      value={editValues[m.label] ?? ""}
                      onChange={(e) =>
                        setEditValues((prev) => ({ ...prev, [m.label]: e.target.value }))
                      }
                      placeholder="—"
                      className={[
                        "w-full rounded-xl px-4 py-3",
                        "font-cometa-extralight text-white/80 text-sm",
                        "border outline-none transition-colors",
                        "placeholder:text-white/15",
                        lowConf
                          ? "bg-amber-400/[0.03] border-amber-400/30 focus:border-amber-400/55"
                          : "bg-white/[0.03] border-white/[0.08] focus:border-[#64CAE4]/40",
                      ].join(" ")}
                    />
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 mt-8 pt-6 border-t border-white/[0.05]">
              <button
                onClick={() => setEditOpen(false)}
                className="font-cometa-extralight text-white/30 text-[11px] hover:text-white/60 tracking-wider transition-colors px-4 py-2"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                className="px-5 py-2 rounded-xl border border-[#64CAE4]/30 font-cometa-extralight text-white/80 text-[11px] tracking-[0.12em] uppercase hover:border-[#64CAE4]/65 hover:text-white transition-colors"
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
