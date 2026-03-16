"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import "@/styles/cometa-branding.css";

export default function SuccessPage() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  // Trigger fade-in after mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="cometa-container cometa-aerial-texture min-h-screen flex flex-col items-center justify-center px-6"
      style={{
        transition: "opacity 0.6s ease",
        opacity:    visible ? 1 : 0,
      }}
    >
      {/* Check SVG */}
      <div className="mb-8">
        <svg
          width="88"
          height="88"
          viewBox="0 0 88 88"
          fill="none"
          style={{
            filter:    "drop-shadow(0 0 24px rgba(74,222,128,0.25))",
            animation: visible ? "cometa-fade-in 0.7s ease forwards" : "none",
          }}
        >
          <circle
            cx="44"
            cy="44"
            r="40"
            stroke="#4ade80"
            strokeWidth="1.5"
            strokeDasharray="251"
            strokeDashoffset="0"
            style={{ animation: "cometa-spin 0s linear 0s 0 normal none running" }}
          />
          <path
            d="M26 44L38 56L62 30"
            stroke="#4ade80"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* Heading */}
      <h1
        className="font-cometa-regular text-white text-2xl md:text-3xl tracking-[0.06em] mb-3"
        style={{ textShadow: "0 0 40px rgba(100,202,228,0.12)" }}
      >
        Datos Cargados
      </h1>

      {/* Subtitle */}
      <p className="font-cometa-extralight text-white/35 text-sm tracking-wide text-center max-w-xs mb-12">
        Tu reporte ha sido registrado en la Bóveda de Cometa
      </p>

      {/* Return button */}
      <button
        onClick={() => router.push("/dashboard")}
        className="px-8 py-3.5 rounded-xl font-cometa-regular text-sm tracking-[0.08em] transition-all duration-300 hover:opacity-80"
        style={{
          background: "linear-gradient(135deg, #00237F 0%, #64CAE4 100%)",
          color:      "white",
          boxShadow:  "0 0 28px rgba(100,202,228,0.12)",
        }}
      >
        Volver al Dashboard
      </button>

      {/* Cometa logo watermark */}
      <div className="absolute bottom-8 opacity-20">
        <img src="/COMETALOGO.png" alt="Cometa" className="h-5 w-auto object-contain invert" />
      </div>
    </div>
  );
}
