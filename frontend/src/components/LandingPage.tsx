"use client";

import { useState, useEffect } from "react";

interface Company {
  id: string;
  name: string;
  lastAnalysis: string;
  totalReports: number;
}

interface LandingPageProps {
  onCompanySelect: (companyId: string) => void;
}

export default function LandingPage({ onCompanySelect }: LandingPageProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchCompanies = async () => {
      try {
        setIsLoading(true);
        
        // Simular datos de compañías
        const mockCompanies: Company[] = [
          {
            id: 'company1.com',
            name: 'Company 1',
            lastAnalysis: 'Hace 2 días',
            totalReports: 5
          },
          {
            id: 'company2.com',
            name: 'Company 2', 
            lastAnalysis: 'Hace 1 semana',
            totalReports: 3
          },
          {
            id: 'skydropx.com',
            name: 'Skydropx',
            lastAnalysis: 'Ayer',
            totalReports: 12
          },
          {
            id: 'startup.tech',
            name: 'Startup Tech',
            lastAnalysis: 'Hace 3 horas',
            totalReports: 8
          },
          {
            id: 'enterprise.io',
            name: 'Enterprise IO',
            lastAnalysis: 'Hace 5 días',
            totalReports: 2
          }
        ];
        
        setCompanies(mockCompanies);
      } catch (error) {
        console.error("Error cargando compañías:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCompanies();
  }, []);

  const handleCompanySelect = (companyId: string) => {
    console.log("🏢 Seleccionando compañía:", companyId);
    onCompanySelect(companyId);
  };

  if (isLoading) {
    return (
      <div className="min-h-screen cometa-aerial-bg flex items-center justify-center">
        <div className="cometa-glass-bg p-8 rounded-2xl">
          <div className="flex flex-col items-center gap-4">
            <div className="cometa-logo w-24 h-8 mb-4">
              COMETA
            </div>
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-t-2 border-r-2 border-l-2 border-white"></div>
            <p className="cometa-body text-white/70">Cargando empresas...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen cometa-aerial-bg">
      {/* Header con logo */}
      <div className="cometa-glass-bg border-b border-white/10">
        <div className="max-w-7xl mx-auto px-6 py-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="cometa-logo">
                COMETA
              </div>
              <div>
                <h1 className="cometa-heading text-white text-2xl">Portal de Socios</h1>
                <p className="cometa-body text-white/70 text-sm">Selecciona una empresa para analizar</p>
              </div>
            </div>
            <div className="text-white/50 text-sm">
              {companies.length} empresas activas
            </div>
          </div>
        </div>
      </div>

      {/* Lista de compañías */}
      <div className="max-w-7xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {companies.map((company) => (
            <div
              key={company.id}
              onClick={() => handleCompanySelect(company.id)}
              className="cometa-card p-6 cursor-pointer cometa-slide-in hover:scale-105"
            >
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="cometa-heading text-white text-lg mb-1">
                    {company.name}
                  </h3>
                  <p className="cometa-body text-white/60 text-sm">
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
              
              <div className="flex items-center gap-4 text-sm">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                  <span className="text-white/70">Activa</span>
                </div>
                <button className="cometa-btn-secondary text-xs">
                  Ver Dashboard
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="cometa-glass-bg border-t border-white/10 mt-12">
        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="cometa-body text-white/50 text-sm">
              © 2024 Cometa. Todos los derechos reservados.
            </div>
            <div className="flex items-center gap-6">
              <a href="#" className="cometa-body text-white/70 text-sm hover:text-white transition-colors">
                Ayuda
              </a>
              <a href="#" className="cometa-body text-white/70 text-sm hover:text-white transition-colors">
                Configuración
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
