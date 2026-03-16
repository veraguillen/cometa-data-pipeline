"use client";

import { useState } from "react";

interface PartnerViewProps {
  selectedCompany: string;
  onCompanySelect: (companyId: string) => void;
}

export default function PartnerView({ selectedCompany, onCompanySelect }: PartnerViewProps) {
  const [companies] = useState([
    {
      id: 'company1.com',
      name: 'Company 1',
      lastAnalysis: 'Hace 2 días',
      totalReports: 5,
      status: 'active'
    },
    {
      id: 'company2.com',
      name: 'Company 2',
      lastAnalysis: 'Hace 1 semana',
      totalReports: 3,
      status: 'active'
    },
    {
      id: 'skydropx.com',
      name: 'Skydropx',
      lastAnalysis: 'Ayer',
      totalReports: 12,
      status: 'active'
    },
    {
      id: 'startup.tech',
      name: 'Startup Tech',
      lastAnalysis: 'Hace 3 horas',
      totalReports: 8,
      status: 'active'
    },
    {
      id: 'enterprise.io',
      name: 'Enterprise IO',
      lastAnalysis: 'Hace 5 días',
      totalReports: 2,
      status: 'active'
    }
  ]);

  return (
    <div className="cometa-container cometa-aerial-texture">
      {/* Header COMETA */}
      <header className="absolute top-0 left-0 right-0 z-50 p-6">
        <div className="flex items-center justify-between">
          <div className="cometa-logo">
            COMETA
          </div>
          <div className="text-white/60 text-sm">
            Portal de Socios
          </div>
        </div>
      </header>

      {/* Contenido Principal */}
      <main className="cometa-main-layout min-h-screen flex items-center justify-center p-8">
        <div className="w-full max-w-6xl">
          <div className="text-center mb-12">
            <h1 className="font-cometa-regular text-white text-4xl mb-4">
              Selecciona Empresa
            </h1>
            <p className="font-cometa-extralight text-white/70 text-lg">
              Elige una empresa para ver su análisis financiero detallado
            </p>
          </div>

          {/* Grid de Empresas */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {companies.map((company) => (
              <div
                key={company.id}
                onClick={() => onCompanySelect(company.id)}
                className="cometa-card p-6 cursor-pointer transform transition-all duration-300 hover:scale-105"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="font-cometa-regular text-white text-lg mb-1">
                      {company.name}
                    </h3>
                    <p className="font-cometa-extralight text-white/60 text-sm">
                      {company.id}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-white/50 text-xs mb-1">
                      {company.totalReports} reportes
                    </div>
                    <div className="text-white/70 text-xs">
                      {company.lastAnalysis}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      company.status === 'active' ? 'bg-green-400' : 'bg-gray-400'
                    }`}></div>
                    <span className="font-cometa-extralight text-white/70 text-sm">
                      {company.status === 'active' ? 'Activa' : 'Inactiva'}
                    </span>
                  </div>
                  <button className="cometa-btn-secondary text-sm">
                    Ver Dashboard
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
