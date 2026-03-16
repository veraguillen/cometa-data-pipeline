"use client";

import { useState, useEffect } from "react";
import { useUser } from "./LayoutWrapper";
import UploadPanel from "@/app/dashboard/ui/upload-panel";
import ResultsPanel from "@/app/dashboard/ui/results-panel";
import FinancialCharts from "@/components/charts/FinancialCharts";

// Definir el tipo localmente para evitar importaciones circulares
type AnalysisResult = {
  id: string;
  data: any;
  date: string;
  metadata: {
    original_filename: string;
    founder_email: string;
    file_hash: string;
    processed_at: string;
    gcs_path: string;
  };
};

// Componente de tarjetas dinámicas
function MetricsPanel({ result }: { result: AnalysisResult }) {
  const financialData = result.data?.financial_metrics_2025;
  
  if (!financialData) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="border border-blue-500/20 bg-gradient-to-br from-blue-900/10 to-blue-800/10 p-6 rounded-lg">
            <div className="font-helvetica-extralight text-white/50 text-sm">Cargando métricas...</div>
          </div>
        ))}
      </div>
    );
  }

  // Extraer métricas clave con valores reales
  const revenueGrowth = financialData?.revenue_growth?.value || "---";
  const grossMargin = financialData?.profit_margins?.gross_profit_margin?.value || "---";
  const ebitdaMargin = financialData?.profit_margins?.ebitda_margin?.value || "---";
  const cashInBank = financialData?.cash_flow_indicators?.cash_in_bank_end_of_year?.value || "---";

  const metrics = [
    {
      title: "Rule of 40",
      value: revenueGrowth,
      description: financialData?.revenue_growth?.description,
      color: revenueGrowth !== "---" ? (parseFloat(revenueGrowth.replace('%', '')) >= 40 ? 'text-green-400' : 'text-yellow-400') : 'text-gray-400'
    },
    {
      title: "Margen Bruto",
      value: grossMargin,
      description: financialData?.profit_margins?.gross_profit_margin?.description,
      color: grossMargin !== "---" ? (parseFloat(grossMargin.replace('%', '')) >= 50 ? 'text-green-400' : 'text-yellow-400') : 'text-gray-400'
    },
    {
      title: "Margen EBITDA",
      value: ebitdaMargin,
      description: financialData?.profit_margins?.ebitda_margin?.description,
      color: ebitdaMargin !== "---" ? (parseFloat(ebitdaMargin.replace('%', '')) >= 15 ? 'text-green-400' : 'text-yellow-400') : 'text-gray-400'
    },
    {
      title: "Cash in Bank",
      value: cashInBank,
      description: financialData?.cash_flow_indicators?.cash_in_bank_end_of_year?.description,
      color: cashInBank !== "---" ? 'text-cyan-400' : 'text-gray-400'
    }
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {metrics.map((metric, index) => (
        <div key={index} className="border border-blue-500/20 bg-gradient-to-br from-blue-900/10 to-blue-800/10 p-6 rounded-lg hover:border-blue-400/30 transition-colors">
          <div className="font-helvetica-extralight text-white/50 text-sm mb-2">{metric.title}</div>
          <div className={`text-2xl font-helvetica-regular ${metric.color}`}>
            {metric.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// Función para generar resumen ejecutivo
function generateExecutiveSummary(result: AnalysisResult): string {
  const financialData = result.data?.financial_metrics_2025;
  
  if (!financialData) {
    return "No hay datos financieros disponibles para generar un resumen ejecutivo.";
  }

  const revenueGrowth = financialData?.revenue_growth?.value;
  const grossMargin = financialData?.profit_margins?.gross_profit_margin?.value;
  const ebitdaMargin = financialData?.profit_margins?.ebitda_margin?.value;
  const cashInBank = financialData?.cash_flow_indicators?.cash_in_bank_end_of_year?.value;

  const insights = [];
  
  if (revenueGrowth) {
    const growth = parseFloat(revenueGrowth.replace('%', ''));
    if (growth >= 40) {
      insights.push(`crecimiento excepcional del ${revenueGrowth}`);
    } else if (growth >= 20) {
      insights.push(`crecimiento sólido del ${revenueGrowth}`);
    } else if (growth > 0) {
      insights.push(`crecimiento moderado del ${revenueGrowth}`);
    } else {
      insights.push(`contracción del ${revenueGrowth}`);
    }
  }

  if (grossMargin && parseFloat(grossMargin.replace('%', '')) >= 50) {
    insights.push(`márgenes saludables con ${grossMargin} de margen bruto`);
  }

  if (ebitdaMargin && parseFloat(ebitdaMargin.replace('%', '')) >= 15) {
    insights.push(`rentabilidad operativa fuerte con ${ebitdaMargin} de margen EBITDA`);
  }

  if (cashInBank && cashInBank !== "---") {
    insights.push(`posición de caja sólida con ${cashInBank} en banco`);
  }

  if (insights.length === 0) {
    return "El análisis financiero muestra una empresa estable pero con oportunidades de mejora en rentabilidad y crecimiento.";
  }

  return `La empresa muestra ${insights.join(', ')}. Los indicadores sugieren una base financiera sólida con potencial para optimización operativa.`;
}

export default function FounderDashboard() {
  const { companyDomain } = useUser();
  const [selectedResult, setSelectedResult] = useState<AnalysisResult | null>(null);
  const [allResults, setAllResults] = useState<AnalysisResult[]>([]);

  const handleResultSelect = (result: AnalysisResult) => {
    console.log("🎯 Seleccionando resultado:", result.metadata.original_filename);
    setSelectedResult(result);
  };

  const handleResultsLoaded = (results: AnalysisResult[]) => {
    console.log("📋 Resultados cargados:", results.length, "análisis");
    setAllResults(results);
    
    // Auto-seleccionar el primer resultado si no hay ninguno seleccionado y hay resultados disponibles
    if (!selectedResult && results.length > 0) {
      console.log("🔄 Auto-seleccionando primer resultado:", results[0].metadata.original_filename);
      setSelectedResult(results[0]);
    }
  };

  const handleAnalysisDetected = (hash: string, result: any) => {
    console.log("📡 Análisis detectado en UploadPanel:", hash);
    
    // Buscar en los resultados existentes o crear un resultado temporal
    const existingResult = allResults.find(r => r.metadata.file_hash === hash);
    
    if (existingResult) {
      setSelectedResult(existingResult);
    } else {
      // Crear resultado temporal
      const tempResult = {
        id: hash,
        data: result,
        date: new Date().toISOString(),
        metadata: {
          original_filename: result.original_filename || 'Documento temporal',
          founder_email: 'test@cometa.vc',
          file_hash: hash,
          processed_at: new Date().toISOString(),
          gcs_path: ''
        }
      };
      
      setAllResults(prev => [...prev, tempResult]);
      setSelectedResult(tempResult);
    }
  };

  // Fetch resultados para el company del founder
  useEffect(() => {
    const fetchResults = async () => {
      try {
        if (!companyDomain) {
          console.warn("[FounderDashboard] companyDomain no disponible, esperando...");
          return;
        }
        
        let url = `http://localhost:8000/api/results?company_id=${encodeURIComponent(companyDomain)}`;
        
        console.log("🔄 Fetching resultados desde:", url);
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.status === 'success') {
          handleResultsLoaded(data.results || []);
        } else {
          console.error("Error fetching resultados:", data);
        }
      } catch (error) {
        console.error("Error en fetchResults:", error);
      }
    };

    fetchResults();
  }, [companyDomain]);

  return (
    <div className="min-h-screen bg-black">
      {/* Header con logo */}
      <div className="border-b border-blue-900/20 bg-black/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-white text-black px-4 py-2 rounded font-bold text-sm tracking-wider">
                COMETA
              </div>
              <div>
                <h1 className="font-helvetica-regular text-white text-xl">
                  Dashboard Financiero
                </h1>
                <p className="font-helvetica-extralight text-white/60 text-sm">
                  {companyDomain}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Contenido principal */}
      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Panel de Subida - Solo se muestra si no hay análisis */}
        {!selectedResult && (
          <UploadPanel founderEmail="test@cometa.vc" onAnalysisDetected={handleAnalysisDetected} />
        )}
        
        {/* Dashboard Principal - Solo se muestra si hay datos */}
        {selectedResult && (
          <div className="space-y-8">
            {/* Resumen Ejecutivo */}
            <div className="border border-blue-500/20 bg-gradient-to-br from-blue-900/10 to-blue-800/10 p-6 rounded-lg">
              <h2 className="font-helvetica-regular text-white text-2xl mb-4">
                Resumen de Auditoría
              </h2>
              <p className="font-helvetica-extralight text-white/80 leading-relaxed">
                {generateExecutiveSummary(selectedResult)}
              </p>
            </div>
            
            {/* Tarjetas Dinámicas Únicas */}
            <MetricsPanel result={selectedResult} />
            
            {/* Gráficos y Análisis Detallados */}
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8">
              {/* Gráficos Principales */}
              <div className="space-y-8">
                <FinancialCharts 
                  selectedResult={selectedResult} 
                  allResults={allResults} 
                />
              </div>
              
              {/* Sidebar con Historial */}
              <div>
                <ResultsPanel 
                  onResultSelect={handleResultSelect} 
                  onResultsLoaded={handleResultsLoaded}
                  hideOtherReports={true}
                />
              </div>
            </div>
          </div>
        )}
        
        {/* Mensaje elegante cuando no hay resultados */}
        {!selectedResult && allResults.length === 0 && (
          <div className="border border-blue-500/20 bg-gradient-to-br from-blue-900/10 to-blue-800/10 p-12 rounded-lg text-center">
            <div className="text-white/70">
              <div className="text-6xl font-helvetica-extralight mb-6 opacity-50">📊</div>
              <h3 className="font-helvetica-regular text-white text-2xl mb-4">
                Esperando primer reporte
              </h3>
              <p className="font-helvetica-extralight text-white/50 max-w-md mx-auto">
                Sube tu primer PDF para comenzar a visualizar análisis detallados
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
