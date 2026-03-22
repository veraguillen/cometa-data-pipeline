"use client";

/**
 * /founder/onboarding — matches fron/FounderOnboarding visually.
 *
 * Layout:
 *   AppHeader (CometaLogo + user · email + logout — NO ThemeSwitcher)
 *   max-w-2xl centered container
 *     h1 font-extralight  "Carga de datos financieros"
 *     subtitle font-light muted
 *     UploadFlow (handles upload → missing → success with real backend)
 *
 * No theme switcher — theme is analyst-only.
 */

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { validateSession, clearSession, type UserInfo } from "@/services/api-client";
import UploadFlow from "@/components/founder/UploadFlow";
import ResetTheme from "@/components/ResetTheme";
import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import type { UploadResponse } from "@/lib/schemas";

export default function FounderOnboardingPage() {
  const [user,     setUser]     = useState<UserInfo | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [lastSuccess, setLastSuccess] = useState<UploadResponse | null>(null);
  const router = useRouter();

  useEffect(() => {
    validateSession().then((u) => { setUser(u); setHydrated(true); });
  }, []);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  if (!hydrated) return null;

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--cometa-bg)" }}
    >
      <ResetTheme theme="pearl" />
      {/* ── Header — matches fron/AppHeader ── */}
      <motion.header
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="sticky top-0 z-40 flex h-14 items-center justify-between border-b px-6"
        style={{
          borderColor:    "var(--cometa-card-border)",
          background:     "color-mix(in srgb, var(--cometa-bg) 88%, transparent)",
          backdropFilter: "blur(20px)",
        }}
      >
        {/* Logo */}
        <img
          src="/COMETALOGO.png"
          alt="Cometa"
          className="h-7 w-auto object-contain"
          style={{ filter: "brightness(0) invert(1)" }}
        />

        {/* User info + logout */}
        <div className="flex items-center gap-3">
          {user && (
            <span
              className="hidden sm:block border-l pl-3 text-xs"
              style={{
                color:       "var(--cometa-fg-muted)",
                borderColor: "var(--cometa-card-border)",
                fontWeight:  400,
              }}
            >
              Founder · {user.name || user.email}
            </span>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors"
            style={{
              color:   "var(--cometa-fg-muted)",
              border:  "1px solid var(--cometa-card-border)",
            }}
          >
            <LogOut size={14} />
            <span className="hidden sm:inline">Cerrar Sesión</span>
          </button>
        </div>
      </motion.header>

      {/* ── Body — centered, max-w-2xl ── */}
      <div className="max-w-2xl mx-auto px-6 py-16">
        <motion.div
          initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0,  filter: "blur(0px)" }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <h1
            className="text-3xl font-extralight mb-2"
            style={{ color: "var(--cometa-fg)" }}
          >
            Carga de datos financieros
          </h1>
          <p
            className="text-sm font-light mb-10"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            Sube tu archivo financiero (PDF, Excel, CSV) y el sistema extraerá los KPIs con IA.
          </p>

          {/* Upload flow — all states handled inside (upload → missing → success) */}
          <UploadFlow
            founderEmail={user?.email ?? ""}
            onSuccess={(result) => setLastSuccess(result)}
          />

          {/* Last processed recap */}
          {lastSuccess?.file_hash && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-8 kpi-card text-center"
            >
              <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "var(--cometa-fg-muted)" }}>
                Último documento procesado
              </p>
              <p className="font-mono text-[11px]" style={{ color: "var(--cometa-accent)" }}>
                {lastSuccess.file_hash.slice(0, 24)}…
              </p>
            </motion.div>
          )}

        </motion.div>
      </div>
    </div>
  );
}
