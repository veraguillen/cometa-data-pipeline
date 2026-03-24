"use client";

/**
 * AppHeader — full-width sticky header for the Analyst Cockpit.
 * Matches fron/AppHeader: CometaLogo (concentric circles) + analyst info + ThemeSwitcher + logout.
 * Spans full viewport width at z-40, above both sidebar and main content.
 */

import { useState } from "react";
import { motion } from "framer-motion";
import { LogOut, Menu, Download, Loader2, BarChart2 } from "lucide-react";
import { clearSession, downloadCsv } from "@/services/api-client";
import { useRouter } from "next/navigation";
import ThemeSwitcher from "./ThemeSwitcher";
import { useTheme } from "@/contexts/ThemeContext";
import type { UserInfo } from "@/services/api-client";

interface AppHeaderProps {
  user:               UserInfo | null;
  onMobileMenuOpen?:  () => void;
  selectedCompanyId?: string | null;
  selectedFund?:      string | null;
}

export default function AppHeader({
  user,
  onMobileMenuOpen,
  selectedCompanyId,
  selectedFund,
}: AppHeaderProps) {
  const router = useRouter();
  const { theme } = useTheme();
  const [exporting, setExporting] = useState(false);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  async function handleExportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (selectedFund)      params.set("portfolio_id", selectedFund);
      if (selectedCompanyId) params.set("company_id",   selectedCompanyId);
      const scope    = selectedCompanyId ?? selectedFund ?? "portfolio";
      const filename = `cometa_kpis_${scope}_${new Date().toISOString().slice(0, 10)}.csv`;
      await downloadCsv(`/api/export/csv?${params.toString()}`, filename);
    } catch (err) {
      console.error("[export/csv]", err);
    } finally {
      setExporting(false);
    }
  }

  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-40 flex h-14 shrink-0 items-center justify-between border-b px-4 sm:px-6"
      style={{
        borderColor:    "var(--cometa-card-border)",
        background:     "color-mix(in srgb, var(--cometa-bg) 88%, transparent)",
        backdropFilter: "blur(20px)",
      }}
    >
      {/* Left — hamburger (mobile) + CometaLogo + analyst name */}
      <div className="flex items-center gap-3">
        {/* Mobile hamburger */}
        {onMobileMenuOpen && (
          <button
            onClick={onMobileMenuOpen}
            className="lg:hidden p-1.5 rounded-lg transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            <Menu size={16} />
          </button>
        )}

        {/* Logo */}
        <img
          src="/COMETALOGO.png"
          alt="Cometa"
          className="h-7 w-auto object-contain"
          style={{ filter: theme === "slate" ? "brightness(0)" : "brightness(0) invert(1)" }}
        />

        {/* Analyst role + name */}
        {user && (
          <span
            className="hidden sm:block border-l pl-3 ml-1 text-xs"
            style={{ color: "var(--cometa-fg-muted)", borderColor: "var(--cometa-card-border)", fontWeight: 400 }}
          >
            Analista · {user.name || user.email}
          </span>
        )}
      </div>

      {/* Right — Export CSV + ThemeSwitcher + logout */}
      <div className="flex items-center gap-2">
        {/* Export CSV — visible only when there is a selection context */}
        {(selectedCompanyId || selectedFund) && (
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px]
                       transition-opacity hover:opacity-70 disabled:opacity-40"
            style={{
              color:      "var(--cometa-accent-fg)",
              border:     "1px solid var(--cometa-accent)",
              fontWeight: 500,
              background: "var(--cometa-accent)",
            }}
            title="Exportar KPIs a CSV"
          >
            {exporting
              ? <Loader2 size={12} className="animate-spin" />
              : <Download size={12} />}
            <span className="hidden sm:inline">Exportar CSV</span>
          </button>
        )}
        {/* Portfolio comparison link */}
        <button
          onClick={() => router.push("/analyst/portfolio")}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70"
          style={{
            color:      "var(--cometa-accent-fg)",
            border:     "1px solid var(--cometa-accent)",
            fontWeight: 500,
            background: "var(--cometa-accent)",
          }}
          title="Comparativa de Portfolio"
        >
          <BarChart2 size={12} />
          <span className="hidden sm:inline">Portfolio</span>
        </button>
        <ThemeSwitcher />
        <button
          onClick={handleLogout}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] transition-opacity hover:opacity-70"
          style={{
            color:      "var(--cometa-accent-fg)",
            border:     "1px solid var(--cometa-accent)",
            fontWeight: 500,
            background: "var(--cometa-accent)",
          }}
        >
          <LogOut size={13} />
          <span className="hidden sm:inline">Cerrar sesión</span>
        </button>
      </div>
    </motion.header>
  );
}

