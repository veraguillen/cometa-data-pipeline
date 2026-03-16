"use client";

/**
 * MobileNav — Hamburger menu for xs/sm screens.
 * Desktop header items are hidden on mobile; this component
 * provides an accessible slide-in drawer instead.
 *
 * Drawer: full-height, black background, gradient left border
 * (Dark Blue #00237F → Light Blue #64CAE4).
 */

import { useState } from "react";
import "@/styles/cometa-branding.css";

interface MobileNavProps {
  roleLabel: string;
  companyDomain: string;
  onLogout: () => void;
}

export default function MobileNav({ roleLabel, companyDomain, onLogout }: MobileNavProps) {
  const [open, setOpen] = useState(false);

  const close = () => setOpen(false);

  return (
    <>
      {/* ── Hamburger trigger (mobile only) ── */}
      <button
        onClick={() => setOpen(true)}
        aria-label="Abrir menú"
        className="md:hidden flex flex-col justify-center items-end gap-[5px] w-9 h-9 flex-shrink-0"
      >
        <span className="cometa-ham-line w-5" />
        <span className="cometa-ham-line w-5" />
        <span className="cometa-ham-line w-3.5" />
      </button>

      {/* ── Backdrop ── */}
      {open && (
        <div
          className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-[2px] md:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}

      {/* ── Drawer ── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Menú de navegación"
        className={`
          fixed top-0 right-0 bottom-0 z-[70] w-[17rem] md:hidden
          bg-black flex flex-col
          transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]
          ${open ? "translate-x-0" : "translate-x-full"}
        `}
      >
        {/* Gradient left border — 1px wide div */}
        <div
          aria-hidden="true"
          className="absolute top-0 left-0 bottom-0 w-px"
          style={{ background: "linear-gradient(180deg, #00237F 0%, #64CAE4 100%)" }}
        />

        {/* Inner content */}
        <div className="flex flex-col h-full px-7 pt-7 pb-8">

          {/* Top row: logo + close */}
          <div className="flex items-center justify-between mb-10">
            <img src="/COMETALOGO.png" alt="Cometa" className="h-7 w-auto object-contain invert" />
            <button
              onClick={close}
              aria-label="Cerrar menú"
              className="text-white/30 hover:text-white/70 transition-colors p-1"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M2 2L14 14M14 2L2 14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {/* Nav items */}
          <div className="flex-1 space-y-7">

            <div>
              <p className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.18em] uppercase mb-1.5">
                Rol
              </p>
              <p className="font-cometa-regular text-white text-sm tracking-[0.1em]">
                {roleLabel}
              </p>
            </div>

            <div className="h-px bg-white/[0.05]" />

            <div>
              <p className="font-cometa-extralight text-white/25 text-[10px] tracking-[0.18em] uppercase mb-1.5">
                Empresa
              </p>
              <p className="font-cometa-extralight text-white/55 text-sm truncate">
                {companyDomain}
              </p>
            </div>

            <div className="h-px bg-white/[0.05]" />

          </div>

          {/* Logout */}
          <button
            onClick={() => { close(); onLogout(); }}
            className="font-cometa-extralight text-white/30 text-[11px] tracking-[0.15em] uppercase hover:text-white/60 transition-colors text-left"
          >
            Cerrar sesión
          </button>
        </div>
      </div>
    </>
  );
}
