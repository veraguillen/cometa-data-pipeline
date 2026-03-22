"use client";

import { useState, useEffect } from "react";
import { useUser } from "@/components/LayoutWrapper";
import { apiFetch } from "@/services/api-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
import { parseFinancialValue, getMetricColor, formatRelativeDate, truncateFilename } from "@/lib/financial-utils";

// No exportar el tipo para evitar importaciones circulares
type AnalysisResult = {
  id: string;
  data: any;  // Diccionario con los KPIs reales
  date: string;
  metadata: {
    file_hash: string;
    original_filename: string;
    founder_email: string;
    processed_at: string;
    gcs_path: string;
  };
};

type FinancialMetrics = {
  revenue_growth?: {
    value: string;
    description: string;
  };
  profit_margins?: {
    gross_profit_margin?: {
      value: string;
      description: string;
    };
    ebitda_margin?: {
      value: string;
      description: string;
    };
  };
  cash_flow_indicators?: {
    annual_cash_flow?: {
      value: string;
      description: string;
    };
    cash_in_bank_end_of_year?: {
      value: string;
      description: string;
    };
  };
  debt_ratios?: {
    working_capital_debt?: {
      value: string;
      description: string;
    };
    net_working_capital?: {
      value: string;
      description: string;
    };
  };
};

// Helper function para extraer KPIs principales
function extractKeyMetrics(data: any): {
  revenueGrowth?: string;
  grossMargin?: string;
  ebitdaMargin?: string;
  cashInBank?: string;
  annualCashFlow?: string;
  workingCapitalDebt?: string;
} {
  const metrics = data?.financial_metrics_2025 as FinancialMetrics;
  
  return {
    revenueGrowth: metrics?.revenue_growth?.value,
    grossMargin: metrics?.profit_margins?.gross_profit_margin?.value,
    ebitdaMargin: metrics?.profit_margins?.ebitda_margin?.value,
    cashInBank: metrics?.cash_flow_indicators?.cash_in_bank_end_of_year?.value,
    annualCashFlow: metrics?.cash_flow_indicators?.annual_cash_flow?.value,
    workingCapitalDebt: metrics?.debt_ratios?.working_capital_debt?.value,
  };
}

// Helper para limpiar nombre de archivo (eliminar hash inicial)
function cleanFilename(filename: string): string {
  return filename.replace(/^[a-f0-9]+_/, '');
}

// Tooltip component
function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [isVisible, setIsVisible] = useState(false);

  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        {children}
      </div>
      {isVisible && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-black/90 border border-white/20 rounded-lg text-white text-xs whitespace-nowrap z-10">
          <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 translate-y-1/2 rotate-45 w-2 h-2 bg-black/90 border-r border-b border-white/20"></div>
          {text}
        </div>
      )}
    </div>
  );
}

export default function ResultsPanel({ 
  onResultSelect,
  onResultsLoaded,
  hideOtherReports = false 
}: { 
  onResultSelect: (result: AnalysisResult) => void;
  onResultsLoaded: (results: AnalysisResult[]) => void;
  hideOtherReports?: boolean;
}) {
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { selectedCompany, companyDomain } = useUser();
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedResults(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  useEffect(() => {
    const fetchResults = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Obtener company_id del hook de usuario
        const companyId = selectedCompany || companyDomain;
        
        if (!companyId) {
          console.warn("[ResultsPanel] No company_id disponible, esperando contexto...");
          return;
        }
        
        // Agregar cache-busting para asegurar datos frescos
        const timestamp = Date.now();
        const response = await apiFetch(`${API_BASE}/api/results?company_id=${encodeURIComponent(companyId)}&t=${timestamp}`, {
          method: "GET",
          headers: {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
          },
        });
        
        if (!response.ok) {
          throw new Error(`Error ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.status === "success") {
          setResults(data.results || []);
          onResultsLoaded?.(data.results || []);
          console.log("📋 Resultados cargados con cache-busting:", data.results?.length);
        } else {
          throw new Error(data.error || "Error al cargar resultados");
        }
      } catch (err) {
        console.error("[ResultsPanel] Error fetching results:", err);
        setError(err instanceof Error ? err.message : "Error desconocido");
      } finally {
        setLoading(false);
      }
    };

    fetchResults();
  }, []);

  if (loading) {
    return (
      <div className="rounded-[2.25rem] border border-white/10 bg-black/35 p-6 backdrop-blur">
        <h2 className="text-xl font-extralight tracking-tight text-white mb-4">
          Análisis Previos
        </h2>
        <div className="flex items-center justify-center py-8">
          <div className="text-sm font-normal text-white/70">Cargando análisis previos...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-[2.25rem] border border-white/10 bg-black/35 p-6 backdrop-blur">
        <h2 className="text-xl font-extralight tracking-tight text-white mb-4">
          Análisis Previos
        </h2>
        <div className="flex items-center justify-center py-8">
          <div className="text-sm font-normal text-red-400">Error: {error}</div>
        </div>
      </div>
    );
  }

  if (results.length === 0) {
    return (
      <div className="rounded-[2.25rem] border border-white/10 bg-black/35 p-6 backdrop-blur">
        <h2 className="text-xl font-extralight tracking-tight text-white mb-4">
          Historial de Análisis ({results.length})
        </h2>
        
        {/* Mensaje cuando no hay resultados */}
        <div className="text-center py-8">
          <div className="text-sm font-normal text-white/70">
            No hay análisis procesados aún.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[2.25rem] border border-white/10 bg-black/35 p-6 backdrop-blur">
      <h2 className="text-xl font-extralight tracking-tight text-white mb-6">
        Historial de Análisis ({results.length})
      </h2>
      
      <div className="space-y-3">
        {results.map((result) => {
          const metrics = extractKeyMetrics(result.data);
          const isExpanded = expandedResults.has(result.id);
          
          // Parsear valores para colores condicionales
          const revenueGrowthParsed = parseFinancialValue(metrics.revenueGrowth);
          const ebitdaMarginParsed = parseFinancialValue(metrics.ebitdaMargin);
          const grossMarginParsed = parseFinancialValue(metrics.grossMargin);
          const cashInBankParsed = parseFinancialValue(metrics.cashInBank);
          
          const isLegacy       = result.data?._value_status === "legacy";
          const fidelityPct    = result.data?._fidelity_pct ?? null;

          return (
            <div
              key={result.id}
              className="border border-white/5 rounded-xl p-4 bg-white/5 cursor-pointer transition-all duration-200 hover:bg-white/10 hover:border-white/20 hover:shadow-lg"
              onClick={() => onResultSelect?.(result)}
            >
              {isLegacy && (
                <div className="mb-3 px-3 py-2 bg-yellow-500/15 border border-yellow-500/35 rounded-lg text-yellow-300 text-xs flex items-center gap-2">
                  <span>⚠</span>
                  <span>
                    Datos históricos pendientes de verificación manual.
                    {fidelityPct !== null && (
                      <> Fidelidad actual: <strong>{fidelityPct}%</strong>.</>
                    )}
                  </span>
                </div>
              )}

              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <h3 className="text-sm font-medium text-white truncate">
                    {truncateFilename(cleanFilename(result.metadata.original_filename), 40)}
                  </h3>
                  <p className="text-xs text-white/50 mt-1">
                    {result.metadata.founder_email} • {formatRelativeDate(result.metadata.processed_at)}
                  </p>
                </div>
                <div className="text-xs text-white/40 font-mono ml-2">
                  {result.metadata.file_hash.slice(0, 8)}...
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
                <Tooltip 
                  text={result.data?.financial_metrics_2025?.revenue_growth?.description || 'Fuente no disponible'}
                >
                  <div className="text-center">
                    <div className="text-xs text-white/55">Revenue Growth</div>
                    <div className={`text-sm font-medium mt-1 ${getMetricColor(revenueGrowthParsed.value, 'revenueGrowth')}`}>
                      {metrics.revenueGrowth || "—"}
                    </div>
                  </div>
                </Tooltip>
                
                <Tooltip 
                  text={result.data?.financial_metrics_2025?.profit_margins?.ebitda_margin?.description || 'Fuente no disponible'}
                >
                  <div className="text-center">
                    <div className="text-xs text-white/55">EBITDA Margin</div>
                    <div className={`text-sm font-medium mt-1 ${getMetricColor(ebitdaMarginParsed.value, 'ebitdaMargin')}`}>
                      {metrics.ebitdaMargin || "—"}
                    </div>
                  </div>
                </Tooltip>
                
                <Tooltip 
                  text={result.data?.financial_metrics_2025?.cash_flow_indicators?.cash_in_bank_end_of_year?.description || 'Fuente no disponible'}
                >
                  <div className="text-center">
                    <div className="text-xs text-white/55">Cash in Bank</div>
                    <div className={`text-sm font-medium mt-1 ${getMetricColor(cashInBankParsed.value, 'cashInBank')}`}>
                      {metrics.cashInBank || "—"}
                    </div>
                  </div>
                </Tooltip>
                
                <Tooltip 
                  text={result.data?.financial_metrics_2025?.profit_margins?.gross_profit_margin?.description || 'Fuente no disponible'}
                >
                  <div className="text-center">
                    <div className="text-xs text-white/55">Gross Margin</div>
                    <div className={`text-sm font-medium mt-1 ${getMetricColor(grossMarginParsed.value, 'grossMargin')}`}>
                      {metrics.grossMargin || "—"}
                    </div>
                  </div>
                </Tooltip>
              </div>
              
              <div className="flex items-center justify-between">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(result.id);
                  }}
                  className="text-xs text-white/70 hover:text-white transition-colors py-1 px-2 border border-white/10 rounded hover:bg-white/5"
                >
                  {isExpanded ? "Ocultar detalles" : "Ver detalles"}
                </button>
                
                <div className="text-xs text-white/50">
                  Click para ver gráficos
                </div>
              </div>
              
              {isExpanded && (
                <div className="mt-4 pt-4 border-t border-white/10">
                  <div className="text-xs text-white/55 mb-2">Datos completos (JSON):</div>
                  <pre className="text-xs text-white/70 bg-black/30 p-3 rounded-lg overflow-x-auto max-h-64 overflow-y-auto">
                    {JSON.stringify(result.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
