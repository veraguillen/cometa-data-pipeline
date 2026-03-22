"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useRouter, useSearchParams } from "next/navigation";
import { clearSession } from "@/services/api-client";
import ResetTheme from "@/components/ResetTheme";
import { CheckCircle2, Shield, Copy, Check } from "lucide-react";

// ── Confetti particle ────────────────────────────────────────────────────────
const CONFETTI_COLORS = ["#00A86B", "#3EB489", "#FFFFFF", "#D1FAE5", "#6EE7B7"];

interface Particle {
  id:    number;
  x:     number;
  color: string;
  size:  number;
  delay: number;
  duration: number;
  rotate: number;
}

function Confetti() {
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    const items: Particle[] = Array.from({ length: 55 }, (_, i) => ({
      id:       i,
      x:        Math.random() * 100,
      color:    CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      size:     Math.random() * 6 + 4,
      delay:    Math.random() * 1.2,
      duration: Math.random() * 2 + 2.5,
      rotate:   Math.random() * 720 - 360,
    }));
    setParticles(items);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 overflow-hidden z-50">
      {particles.map((p) => (
        <motion.div
          key={p.id}
          style={{
            position:        "absolute",
            left:            `${p.x}%`,
            top:             "-16px",
            width:           p.size,
            height:          p.size,
            borderRadius:    Math.random() > 0.5 ? "50%" : "2px",
            backgroundColor: p.color,
          }}
          initial={{ y: -20, opacity: 1, rotate: 0 }}
          animate={{
            y:       "110vh",
            opacity: [1, 1, 0],
            rotate:  p.rotate,
          }}
          transition={{
            duration: p.duration,
            delay:    p.delay,
            ease:     "easeIn",
          }}
        />
      ))}
    </div>
  );
}

// ── Animated comet brand symbol ──────────────────────────────────────────────
function CometSymbol({ size = 56 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none"
         xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <motion.circle cx="22" cy="10" r="4.5"
        fill="var(--cometa-accent)" opacity={0.95}
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 0.95 }}
        transition={{ type: "spring", stiffness: 380, damping: 20, delay: 0.1 }}
      />
      <motion.line x1="19" y1="13" x2="4" y2="28"
        stroke="var(--cometa-accent)" strokeWidth="2" strokeLinecap="round" opacity={0.7}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.7 }}
        transition={{ duration: 0.5, delay: 0.3, ease: "easeOut" }}
      />
      <motion.line x1="18" y1="14" x2="5" y2="26"
        stroke="var(--cometa-accent)" strokeWidth="1.2" strokeLinecap="round" opacity={0.35}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.35 }}
        transition={{ duration: 0.45, delay: 0.38, ease: "easeOut" }}
      />
      <motion.line x1="17" y1="13" x2="6" y2="24"
        stroke="var(--cometa-accent)" strokeWidth="0.7" strokeLinecap="round" opacity={0.15}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 0.15 }}
        transition={{ duration: 0.4, delay: 0.44, ease: "easeOut" }}
      />
    </svg>
  );
}

// ── Checklist items ──────────────────────────────────────────────────────────
const CHECKLIST_ITEMS = [
  "Documento recibido y autenticado",
  "KPIs extraídos con IA y validados",
  "Datos cifrados en la Bóveda Cometa",
  "Recibo digital generado y enviado",
];

function ChecklistRow({ label, delay }: { label: string; delay: number }) {
  return (
    <motion.div
      className="flex items-center gap-3"
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
    >
      <motion.div
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 28, delay: delay + 0.05 }}
      >
        <CheckCircle2 size={15} className="text-emerald-400 shrink-0" />
      </motion.div>
      <span className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
        {label}
      </span>
    </motion.div>
  );
}

// ── Vault Seal card ──────────────────────────────────────────────────────────
function VaultSealCard({ seal }: { seal: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(seal).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <motion.div
      className="w-full rounded-2xl px-5 py-4"
      style={{
        background: "color-mix(in srgb, var(--cometa-accent) 8%, transparent)",
        border:     "1px solid color-mix(in srgb, var(--cometa-accent) 22%, transparent)",
      }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 1.1 }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Shield size={13} style={{ color: "var(--cometa-accent)" }} />
        <p className="text-[9px] font-semibold uppercase tracking-[0.2em]"
           style={{ color: "var(--cometa-accent)" }}>
          ID de Transacción · Sello de Bóveda SHA-256
        </p>
      </div>
      <p className="text-[10px] font-light mb-3 leading-relaxed"
         style={{ color: "var(--cometa-fg-muted)" }}>
        Este código garantiza que tus datos han sido cifrados y guardados en la Bóveda
        sin alteraciones. Guárdalo como referencia de integridad.
      </p>
      <div
        className="rounded-xl px-4 py-3 flex items-center justify-between gap-3"
        style={{
          background: "color-mix(in srgb, var(--cometa-card-border) 60%, transparent)",
          border: "1px solid color-mix(in srgb, var(--cometa-accent) 18%, transparent)",
        }}
      >
        <p className="font-mono text-[10px] break-all leading-relaxed"
           style={{ color: "var(--cometa-accent)" }}>
          {seal}
        </p>
        <button
          onClick={handleCopy}
          className="shrink-0 rounded-lg p-1.5 transition-colors"
          style={{ color: "var(--cometa-accent)" }}
          title="Copiar sello"
        >
          <AnimatePresence mode="wait">
            {copied
              ? <motion.span key="check" initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <Check size={14} />
                </motion.span>
              : <motion.span key="copy"  initial={{ scale: 0 }} animate={{ scale: 1 }}>
                  <Copy size={14} />
                </motion.span>
            }
          </AnimatePresence>
        </button>
      </div>
    </motion.div>
  );
}

// ── Inner page (needs useSearchParams, must be inside Suspense) ──────────────
function SuccessContent() {
  const router      = useRouter();
  const params      = useSearchParams();
  const seal        = params.get("seal") ?? "";
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 60);
    return () => clearTimeout(t);
  }, []);

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  return (
    <div
      className="relative min-h-screen flex flex-col items-center justify-center px-6 text-center"
      style={{ background: "var(--cometa-bg)" }}
    >
      <ResetTheme theme="pearl" />

      {/* Confetti burst on mount */}
      {ready && <Confetti />}

      <motion.div
        className="flex flex-col items-center gap-6 w-full max-w-sm"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: ready ? 1 : 0, y: ready ? 0 : 20 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Brand comet */}
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1,   opacity: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 22, delay: 0.05 }}
        >
          <CometSymbol size={64} />
        </motion.div>

        {/* Heading */}
        <motion.h1
          className="text-2xl sm:text-3xl"
          style={{ color: "var(--cometa-fg)", fontWeight: 100, letterSpacing: "0.04em" }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.35 }}
        >
          ¡Carga Exitosa!
        </motion.h1>

        <motion.p
          className="text-sm leading-relaxed"
          style={{ color: "var(--cometa-fg-muted)", fontWeight: 300 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.5 }}
        >
          Tus métricas han sido registradas en la Bóveda de Cometa.
          <br />
          Se ha enviado tu recibo digital al correo.
        </motion.p>

        {/* Progress bar — 100% */}
        <motion.div
          className="w-full"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.6 }}
        >
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-[9px] uppercase tracking-[0.18em]"
               style={{ color: "var(--cometa-fg-muted)" }}>
              Checklist del expediente
            </p>
            <p className="text-[9px] font-semibold" style={{ color: "#34d399" }}>
              100%
            </p>
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden"
               style={{ background: "var(--cometa-card-border)" }}>
            <motion.div
              className="h-full rounded-full"
              style={{ background: "#34d399" }}
              initial={{ width: "0%" }}
              animate={{ width: "100%" }}
              transition={{ duration: 0.8, delay: 0.7, ease: "easeOut" }}
            />
          </div>
        </motion.div>

        {/* Checklist items */}
        <div className="w-full space-y-3 text-left">
          {CHECKLIST_ITEMS.map((label, i) => (
            <ChecklistRow key={label} label={label} delay={0.75 + i * 0.12} />
          ))}
        </div>

        {/* Vault Seal (only when available) */}
        {seal && <VaultSealCard seal={seal} />}

        {/* Divider */}
        <motion.div
          className="w-12 h-px"
          style={{ background: "var(--cometa-card-border)" }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.4, delay: seal ? 1.5 : 1.3 }}
        />

        {/* Actions */}
        <motion.div
          className="flex flex-col items-center gap-3 w-full"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1,  y: 0 }}
          transition={{ duration: 0.45, delay: seal ? 1.6 : 1.4 }}
        >
          <button
            onClick={() => router.push("/founder/onboarding")}
            className="w-full rounded-xl px-6 py-3 text-sm tracking-wide transition-opacity hover:opacity-80"
            style={{ background: "var(--cometa-accent)", color: "var(--cometa-accent-fg)", fontWeight: 400 }}
          >
            Subir otro documento
          </button>

          <button
            onClick={handleLogout}
            className="text-[11px] uppercase tracking-widest transition-opacity hover:opacity-70"
            style={{ color: "var(--cometa-fg-muted)" }}
          >
            Cerrar sesión
          </button>
        </motion.div>
      </motion.div>

      {/* Watermark */}
      <div className="absolute bottom-8 opacity-15 pointer-events-none">
        <img src="/COMETALOGO.png" alt="Cometa"
             className="h-5 w-auto object-contain"
             style={{ filter: "brightness(0) invert(1)" }} />
      </div>
    </div>
  );
}

// ── Page wrapper — required by Next.js for useSearchParams ──────────────────
export default function SuccessPage() {
  return (
    <Suspense>
      <SuccessContent />
    </Suspense>
  );
}
