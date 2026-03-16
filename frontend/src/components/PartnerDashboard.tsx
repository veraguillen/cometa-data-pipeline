"use client";

import { useState, useEffect } from "react";
import LandingPage from "./LandingPage";

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

interface PartnerDashboardProps {
  selectedCompany: string;
  onCompanySelect: (companyId: string) => void;
}

export default function PartnerDashboard({ selectedCompany, onCompanySelect }: PartnerDashboardProps) {
  // Vista de Socio: Landing page con lista de empresas
  if (!selectedCompany) {
    return <LandingPage onCompanySelect={onCompanySelect} />;
  }

  // Vista de Dashboard específico para la empresa seleccionada
  return (
    <div className="min-h-screen bg-black">
      {/* Header con logo y navegación */}
      <div className="border-b border-blue-900/20 bg-black/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-white text-black px-4 py-2 rounded font-bold text-sm tracking-wider">
                COMETA
              </div>
              <div>
                <h1 className="font-helvetica-regular text-white text-xl">
                  Análisis de {selectedCompany}
                </h1>
                <p className="font-helvetica-extralight text-white/60 text-sm">
                  Dashboard financiero detallado
                </p>
              </div>
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="border border-blue-500/30 bg-gradient-to-r from-blue-900/20 to-blue-800/20 text-blue-400 px-4 py-2 rounded font-helvetica-regular text-sm hover:border-blue-400/50 transition-colors"
            >
              Cambiar Empresa
            </button>
          </div>
        </div>
      </div>

      {/* Contenido principal */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="text-center py-16">
          <div className="text-6xl font-helvetica-extralight text-white/20 mb-4">
            📊
          </div>
          <h2 className="font-helvetica-regular text-white text-2xl mb-2">
            Dashboard de {selectedCompany}
          </h2>
          <p className="font-helvetica-extralight text-white/50 max-w-md mx-auto">
            Cargando análisis financieros para esta empresa...
          </p>
        </div>
      </div>
    </div>
  );
}
