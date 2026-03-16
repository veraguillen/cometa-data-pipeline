"use client";

import { useState, useRef, useEffect } from "react";
import "@/styles/cometa-branding.css";
import { useDataLoader } from "@/hooks/useDataLoader";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
import CometaLoader from "@/components/CometaLoader";
import FileUploader from "@/components/FileUploader";

interface FounderViewProps {
  companyDomain: string;
}

export default function FounderView({ companyDomain }: FounderViewProps) {
  const [isProcessing, setIsProcessing] = useState(false);

  // Usar el hook de carga segura
  const { isLoading, error, data, loadData, reset } = useDataLoader({
    url: `${API_BASE}/api/results?company_id=${encodeURIComponent(companyDomain)}`,
    onSuccess: (data) => {
      console.log("[FounderView] Datos cargados exitosamente:", data);
    },
    onError: (error) => {
      console.error("[FounderView] Error cargando datos:", error);
    }
  });

  // Cargar datos al montar
  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleUploadSuccess = () => {
    console.log("[FounderView] Archivo subido exitosamente, recargando datos...");
    // Recargar datos después de subir exitosamente
    setTimeout(() => {
      reset();
      loadData();
    }, 500);
  };

  const handleUploadError = (error: string) => {
    console.error("[FounderView] Error en subida:", error);
    setIsProcessing(true); // Mantener loader activo para mostrar "Efecto Cometa"
    
    // Simular efecto Cometa por 3 segundos
    setTimeout(() => {
      setIsProcessing(false);
    }, 3000);
  };

  const handleDuplicateDetected = () => {
    console.log("[FounderView] Duplicado detectado, forzando recarga de datos...");
    setIsProcessing(true);
    
    // Forzar recarga inmediata de datos
    setTimeout(() => {
      reset();
      loadData();
      setTimeout(() => {
        setIsProcessing(false);
      }, 2000);
    }, 1000);
  };

  // Determinar si mostrar uploader o dashboard
  const hasData = (data as any) && (data as any).results && (data as any).results.length > 0;
  const showUploader = !hasData && !isProcessing;

  const metrics = [
    {
      label: "Revenue Growth",
      value: (data as any)?.results?.[0]?.data?.financial_metrics_2025?.revenue_growth?.value || "---",
      trend: "up",
      color: "text-green-400"
    },
    {
      label: "Gross Margin", 
      value: (data as any)?.results?.[0]?.data?.financial_metrics_2025?.profit_margins?.gross_profit_margin?.value || "---",
      trend: "stable",
      color: "text-blue-400"
    },
    {
      label: "EBITDA Margin",
      value: (data as any)?.results?.[0]?.data?.financial_metrics_2025?.profit_margins?.ebitda_margin?.value || "---",
      trend: "up", 
      color: "text-cyan-400"
    },
    {
      label: "Cash in Bank",
      value: (data as any)?.results?.[0]?.data?.financial_metrics_2025?.cash_flow_indicators?.cash_in_bank_end_of_year?.value || "---",
      trend: "stable",
      color: "text-white"
    }
  ];

  return (
    <div className="cometa-container cometa-aerial-texture">
      {/* Header COMETA */}
      <header className="absolute top-0 left-0 right-0 z-50 p-6">
        <div className="flex items-center justify-between">
          <div className="cometa-logo">
            COMETA
          </div>
          <div className="text-white/60 text-sm">
            Dashboard Founder
          </div>
        </div>
      </header>

      {/* Contenido Principal */}
      <main className="cometa-main-layout min-h-screen p-8">
        <div className="max-w-7xl mx-auto">
          {/* Estado de carga o error */}
          {isLoading && (
            <CometaLoader 
              message="Sincronizando datos financieros..." 
              size="lg"
              overlay={false}
            />
          )}

          {error && (
            <div className="cometa-card p-6 mb-8 cometa-error-state">
              <div className="flex items-center gap-3">
                <div className="text-2xl">⚠️</div>
                <div>
                  <h3 className="font-cometa-regular text-white mb-2">Error de Sincronización</h3>
                  <p className="font-cometa-extralight text-white/80">{error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Upload Section - Solo visible si no hay datos */}
          {showUploader && (
            <FileUploader 
              companyDomain={companyDomain}
              onUploadSuccess={handleUploadSuccess}
              onUploadError={handleUploadError}
              onDuplicateDetected={handleDuplicateDetected}
            />
          )}

          {/* Resumen de Auditoría IA - Solo visible si hay datos */}
          {hasData && !isProcessing && (
            <div className="cometa-card mb-8">
              <h3 className="font-cometa-regular text-white text-xl mb-6">
                Resumen de Auditoría IA
              </h3>
              <div className="font-cometa-extralight text-white/70 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-green-400 rounded-full"></div>
                  <span>Análisis completado con Vertex AI</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-blue-400 rounded-full"></div>
                  <span>Procesamiento financiero validado</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-3 h-3 bg-cyan-400 rounded-full"></div>
                  <span>Métricas extraídas automáticamente</span>
                </div>
              </div>
            </div>
          )}

          {/* Metrics Dashboard con transición suave */}
          {(data as any) && (data as any).results && (data as any).results.length > 0 && (
            <div className="space-y-8 animate-fade-in">
              <div className="cometa-card">
                <h3 className="font-cometa-regular text-white text-xl mb-6">
                  Métricas Financieras
                </h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  {metrics.map((metric, index) => (
                    <div key={index} className="cometa-metric-card">
                      <div className="cometa-metric-label mb-2">
                        {metric.label}
                      </div>
                      <div className={`cometa-metric-value ${metric.color}`}>
                        {metric.value}
                      </div>
                      {metric.trend && (
                        <div className="flex items-center gap-2 mt-2">
                          <div className={`w-1 h-1 rounded-full ${
                            metric.trend === 'up' ? 'bg-green-400' : 'bg-gray-400'
                          }`}></div>
                          <span className="font-cometa-extralight text-xs text-white/50">
                            {metric.trend === 'up' ? 'Tendencia alcista' : 'Estable'}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Análisis Recientes */}
              <div className="cometa-card">
                <h3 className="font-cometa-regular text-white text-xl mb-4">
                  Análisis Recientes
                </h3>
                <div className="space-y-3">
                  {(data as any).results.slice(0, 3).map((result: any, index: number) => (
                    <div key={result.id} className="flex items-center justify-between p-3 border-b border-white/10 last:border-b-0">
                      <div>
                        <div className="font-cometa-regular text-white">
                          {result.metadata?.original_filename || `Análisis ${index + 1}`}
                        </div>
                        <div className="font-cometa-extralight text-white/60 text-sm">
                          {new Date(result.date).toLocaleDateString()}
                        </div>
                      </div>
                      <button className="cometa-btn-secondary text-sm">
                        Ver Detalles
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Estado vacío elegante */}
          {(data as any) && (data as any).results && (data as any).results.length === 0 && (
            <div className="cometa-card p-12 text-center">
              <div className="text-white/70">
                <div className="text-6xl font-cometa-extralight mb-6 opacity-50">📊</div>
                <h3 className="font-cometa-regular text-white text-2xl mb-4">
                  Datos Sincronizados
                </h3>
                <p className="font-cometa-extralight text-white/50 max-w-md mx-auto">
                  No hay análisis financieros disponibles para {companyDomain}
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
