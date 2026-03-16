"use client";

import { useState, useEffect } from "react";

interface UserSession {
  email: string;
  role: 'PARTNER' | 'FOUNDER';
  companyDomain: string;
}

interface SessionManagerProps {
  currentSession: UserSession | null;
  onSessionChange: (session: UserSession | null) => void;
  children: React.ReactNode;
}

export default function SessionManager({ currentSession, onSessionChange, children }: SessionManagerProps) {
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  const handleLogout = () => {
    // Limpiar localStorage
    localStorage.removeItem('cometa_user_session');
    
    // Notificar al componente padre
    onSessionChange(null);
    
    // Cerrar confirmación
    setShowLogoutConfirm(false);
  };

  const handleRoleSwitch = () => {
    // Limpiar sesión actual
    localStorage.removeItem('cometa_user_session');
    
    // Notificar al componente padre para mostrar login
    onSessionChange(null);
  };

  // Solo mostrar si hay sesión activa
  if (!currentSession) {
    return <>{children}</>;
  }

  return (
    <div className="min-h-screen bg-black">
      {/* Header con información de sesión y controles */}
      <div className="border-b border-blue-900/20 bg-black/95 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-white text-black px-4 py-2 rounded font-bold text-sm tracking-wider">
                COMETA
              </div>
              <div>
                <div className="font-helvetica-regular text-white text-lg">
                  {currentSession.role === 'PARTNER' ? 'Portal de Socios' : 'Dashboard Founder'}
                </div>
                <div className="font-helvetica-extralight text-white/60 text-sm">
                  {currentSession.email} • {currentSession.companyDomain}
                </div>
              </div>
            </div>
            
            {/* Controles de sesión */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleRoleSwitch}
                className="border border-blue-500/30 bg-gradient-to-r from-blue-900/20 to-blue-800/20 text-blue-400 px-4 py-2 rounded-lg font-helvetica-regular text-sm hover:border-blue-400/50 transition-colors"
              >
                Cambiar Rol
              </button>
              
              <button
                onClick={() => setShowLogoutConfirm(true)}
                className="border border-red-500/30 bg-gradient-to-r from-red-900/20 to-red-800/20 text-red-400 px-4 py-2 rounded-lg font-helvetica-regular text-sm hover:border-red-400/50 transition-colors"
              >
                Cerrar Sesión
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Contenido principal */}
      <div className="relative">
        {children}
      </div>

      {/* Modal de confirmación de logout */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-black border border-blue-500/30 rounded-xl p-8 max-w-md w-full mx-4">
            <div className="text-center">
              <div className="text-4xl mb-4">👋</div>
              <h3 className="font-helvetica-regular text-white text-xl mb-4">
                Cerrar Sesión
              </h3>
              <p className="font-helvetica-extralight text-white/70 mb-8">
                ¿Estás seguro de que deseas cerrar tu sesión actual?
              </p>
              
              <div className="flex gap-4 justify-center">
                <button
                  onClick={() => setShowLogoutConfirm(false)}
                  className="border border-blue-500/30 bg-gradient-to-r from-blue-900/20 to-blue-800/20 text-blue-400 px-6 py-3 rounded-lg font-helvetica-regular hover:border-blue-400/50 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  onClick={handleLogout}
                  className="bg-red-600 text-white px-6 py-3 rounded-lg font-helvetica-regular hover:bg-red-700 transition-colors"
                >
                  Cerrar Sesión
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
