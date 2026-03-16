"use client";

/**
 * Root page — Cometa Vault SPA shell.
 * Handles session lifecycle (localStorage) and routes by role:
 *   – No session  → LoginScreen
 *   – SOCIO       → SocioView
 *   – ANALISTA    → AnalistaDashboard
 */

import { useState, useEffect } from "react";
import "@/styles/cometa-branding.css";
import LoginScreen from "@/components/LoginScreen";
import SocioView from "@/components/SocioView";
import AnalistaDashboard from "@/components/AnalistaDashboard";

type Role = "SOCIO" | "ANALISTA";

interface UserSession {
  email: string;
  role: Role;
  companyDomain: string;
}

const SESSION_KEY = "cometa_user_session";

export default function Home() {
  const [session, setSession] = useState<UserSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Restore persisted session on mount (SSR-safe)
  useEffect(() => {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as UserSession;
        if (parsed.role === "SOCIO" || parsed.role === "ANALISTA") {
          setSession(parsed);
        } else {
          localStorage.removeItem(SESSION_KEY);
        }
      } catch {
        localStorage.removeItem(SESSION_KEY);
      }
    }
    setHydrated(true);
  }, []);

  function handleSessionStart(s: UserSession) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    setSession(s);
  }

  function handleLogout() {
    localStorage.removeItem(SESSION_KEY);
    setSession(null);
  }

  // Avoid flash of wrong content during SSR hydration
  if (!hydrated) return null;

  // ── No session → Login ─────────────────────────────────────────────────────
  if (!session) {
    return <LoginScreen onSessionStart={handleSessionStart} />;
  }

  // ── Session active → Role-based view ──────────────────────────────────────
  if (session.role === "SOCIO") {
    return <SocioView companyDomain={session.companyDomain} onLogout={handleLogout} />;
  }

  return <AnalistaDashboard companyDomain={session.companyDomain} onLogout={handleLogout} />;
}
