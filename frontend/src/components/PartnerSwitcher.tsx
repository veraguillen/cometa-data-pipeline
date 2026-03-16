"use client";

import { useState, useEffect } from "react";
import { useUser } from "./LayoutWrapper";

export default function PartnerSwitcher() {
  const { role, companyDomain, selectedCompany, setSelectedCompany } = useUser();
  const [companies, setCompanies] = useState<string[]>([]);
  const [customCompanyId, setCustomCompanyId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);

  // Solo mostrar para ANALISTAS
  if (role !== 'ANALISTA') {
    return null;
  }

  // Cargar lista de compañías disponibles
  useEffect(() => {
    const fetchCompanies = async () => {
      try {
        setIsLoading(true);
        
        // En producción, esto vendría de una API
        // Por ahora, simulamos algunas compañías de ejemplo
        const mockCompanies = [
          'company1.com',
          'company2.com', 
          'company3.com',
          'skydropx.com',
          'startup.tech',
          'enterprise.io'
        ];
        
        setCompanies(mockCompanies);
        console.log("🏢 Compañías cargadas:", mockCompanies);
      } catch (error) {
        console.error("Error cargando compañías:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchCompanies();
  }, []);

  const handleCompanyChange = async (newCompanyId: string) => {
    console.log("🔄 Cambiando a compañía:", newCompanyId);
    setSelectedCompany(newCompanyId);
    
    // Limpiar datos actuales del dashboard
    // Esto forzará un nuevo fetch con el company_id correcto
    window.location.reload();
  };

  const handleCustomCompanySubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (customCompanyId.trim()) {
      handleCompanyChange(customCompanyId.trim());
      setCustomCompanyId('');
    }
  };

  return (
    <div className="cometa-glass-bg px-6 py-4 border-b border-white/10">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-3">
          <div className="cometa-logo">
            COMETA
          </div>
          <div>
            <h3 className="cometa-heading text-white text-lg">Modo Socio</h3>
            <p className="cometa-body text-white/70 text-sm">Selecciona una empresa para analizar</p>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          <select
            value={selectedCompany}
            onChange={(e) => handleCompanyChange(e.target.value)}
            disabled={isLoading}
            className="cometa-glass-bg border border-white/20 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-400 disabled:opacity-50 min-w-[200px] cometa-focus"
          >
            <option value="">
              Seleccionar empresa...
            </option>
            {companies.map(company => (
              <option key={company} value={company}>
                {company}
              </option>
            ))}
          </select>
          
          <div className="text-white/50 text-xs">
            ({companies.length} disponibles)
          </div>
        </div>
      </div>

      {/* Input personalizado para compañías no listadas */}
      <form onSubmit={handleCustomCompanySubmit} className="flex items-center gap-2">
        <input
          type="text"
          value={customCompanyId}
          onChange={(e) => setCustomCompanyId(e.target.value)}
          placeholder="O escribir empresa..."
          className="cometa-glass-bg border border-white/20 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-cyan-400 placeholder:text-white/40 w-[200px] cometa-focus"
        />
        <button
          type="submit"
          disabled={!customCompanyId.trim() || isLoading}
          className="cometa-btn-primary disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium transition-colors"
        >
          {isLoading ? 'Cargando...' : 'Ir'}
        </button>
      </form>

      {/* Indicador de estado */}
      <div className="flex items-center gap-2 text-xs text-white/50">
        {selectedCompany && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-green-400 rounded-full"></div>
            <span>Viendo: {selectedCompany}</span>
          </div>
        )}
        {!selectedCompany && (
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 bg-yellow-400 rounded-full"></div>
            <span>Selecciona una empresa</span>
          </div>
        )}
      </div>
    </div>
  );
}
