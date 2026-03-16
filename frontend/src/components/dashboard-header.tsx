"use client";

import { LogOut, User } from "lucide-react";

interface DashboardHeaderProps {
  email?: string;
  roleLabel?: string;
  onLogout: () => void;
}

export function DashboardHeader({ email, roleLabel = "Analista", onLogout }: DashboardHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-white/[0.06] px-8 py-5">
      <img src="/COMETALOGO.png" alt="Cometa" className="h-8 w-auto object-contain invert" />

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 border border-white/12">
            <User className="h-4 w-4 text-white/60" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-light text-white/80 truncate max-w-[160px]">
              {email ?? "—"}
            </span>
            <span className="text-[11px] text-white/40 uppercase tracking-wider">
              {roleLabel}
            </span>
          </div>
        </div>

        <button
          onClick={onLogout}
          className="flex items-center gap-2 rounded-lg bg-white/5 border border-white/10 px-4 py-2 text-sm text-white/60 transition-all hover:bg-white/10 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          <span>Salir</span>
        </button>
      </div>
    </header>
  );
}
