"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Role = "SOCIO" | "ANALISTA";

interface LoginScreenProps {
  onSessionStart: (session: { email: string; role: Role; companyDomain: string }) => void;
}

export default function LoginScreen({ onSessionStart }: LoginScreenProps) {
  const [email, setEmail]     = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const isValidEmail   = email.includes("@") && email.includes(".");
  const isInternalEmail = email.toLowerCase().endsWith("@cometa.vc");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail || isLoading) return;
    setIsLoading(true);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const companyDomain = email.split("@")[1] || "startup.com";
    const role: Role    = isInternalEmail ? "ANALISTA" : "SOCIO";
    onSessionStart({ email, role, companyDomain });
    setIsLoading(false);
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center">

      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#00237F] to-black" />

      {/* Subtle grid overlay */}
      <div
        className="absolute inset-0 opacity-[0.02]"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)`,
          backgroundSize: "60px 60px",
        }}
      />

      {/* Content */}
      <div className="relative z-10 mx-auto w-full max-w-sm px-6">

        {/* Logo */}
        <div className="mb-16 flex justify-center">
          <img
            src="/COMETALOGO.png"
            alt="Cometa"
            className="h-10 w-auto object-contain invert"
          />
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-8">

          {/* Email */}
          <div className="space-y-3">
            <label
              htmlFor="email"
              className="block text-[11px] font-medium uppercase tracking-[0.2em] text-white/40"
            >
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@empresa.com"
              required
              className="h-14 rounded-none border-0 border-b border-white/20 bg-transparent px-0
                         text-lg font-light text-white placeholder:text-white/30
                         focus:border-white/50 focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
          </div>

          {/* Hint — cambia según dominio */}
          {isValidEmail && (
            <p className="text-[11px] tracking-wide text-white/30">
              {isInternalEmail
                ? "→ Acceso como Analista Cometa"
                : "→ Acceso como Socio / Founder"}
            </p>
          )}

          {/* Submit */}
          <Button
            type="submit"
            disabled={!isValidEmail || isLoading}
            className="group h-14 w-full rounded-none bg-white text-black transition-all duration-300
                       hover:bg-white/90 disabled:bg-white/10 disabled:text-white/30"
          >
            {isLoading ? (
              <div className="flex items-center justify-center gap-3">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-black/20 border-t-black" />
                <span className="font-light tracking-wide">Iniciando…</span>
              </div>
            ) : (
              <div className="flex items-center justify-center gap-3">
                <span className="font-light tracking-wide">Continuar</span>
                <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-1" />
              </div>
            )}
          </Button>
        </form>

        {/* Footer */}
        <p className="mt-12 text-center text-[10px] uppercase tracking-[0.2em] text-white/20">
          Acceso seguro · Sesión cifrada
        </p>
      </div>
    </div>
  );
}
