"use client";

import { useRef, useState } from "react";
import { sha256Hex } from "@/lib/sha256";
import { apiFetch } from "@/services/api-client";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface UploadResponse {
  duplicate?: boolean;
  file_hash?: string;
  result?: any;
  error?: string;
  message?: string;
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242" />
      <path d="M12 12v9" />
      <path d="m8 17 4-5 4 5" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      className={className}
      style={{ animation: "spin 1s linear infinite" }}
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

export default function UploadPanel({
  founderEmail,
  onAnalysisDetected
}: {
  founderEmail: string;
  onAnalysisDetected?: (hash: string, result: any) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);
  const [isError, setIsError] = useState(false);

  async function upload(file: File) {
    setIsUploading(true);
    setIsDone(false);
    setIsError(false);
    setStatusMessage("Calculando huella orbital...");
    setHash(null);

    try {
      const digest = await sha256Hex(file);
      setHash(digest);

      const formData = new FormData();
      formData.append("file", file);

      setStatusMessage("Enviando reporte a Cometa...");

      const res = await apiFetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { "founder-email": founderEmail },
        body: formData,
      });

      let data: UploadResponse | null = null;
      try {
        data = (await res.json()) as UploadResponse;
      } catch (parseErr) {
        console.error("[upload] No se pudo parsear JSON de respuesta", parseErr);
      }

      if (!res.ok) {
        console.error("[upload] Respuesta no OK", { status: res.status, data });
        setStatusMessage(data?.error ?? data?.message ?? "Error procesando el reporte");
        setIsError(true);
        return;
      }

      if (data?.duplicate) {
        setStatusMessage("Reporte detectado en órbita. Recuperando auditoría...");
        if (data?.file_hash && data?.result) {
          onAnalysisDetected?.(data.file_hash, data.result);
        }
      } else {
        setStatusMessage(data?.message ?? "Reporte procesado");
      }

      if (!data?.duplicate && data?.file_hash && data?.result) {
        onAnalysisDetected?.(data.file_hash, data.result);
      }

      setIsDone(true);
    } catch (err) {
      console.error("[upload] Falló el fetch", err);
      setStatusMessage("No se pudo subir el reporte");
      setIsError(true);
    } finally {
      setIsUploading(false);
    }
  }

  const borderColor = isDragging
    ? "border-white/40"
    : isDone
    ? "border-white/25"
    : isError
    ? "border-red-500/40"
    : "border-white/10";

  const bgColor = isDragging ? "bg-white/[0.04]" : "bg-[#0f0f0f]";

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_1fr]">
      {/* Drop zone */}
      <div
        className={`relative flex h-[300px] w-full cursor-pointer flex-col items-center justify-center gap-5 rounded-2xl border transition-all duration-200 ${borderColor} ${bgColor}`}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); }}
        onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); }}
        onDrop={async (e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
          if (isUploading) return;
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) await upload(files[0] as File);
        }}
        onClick={() => {
          if (isUploading) return;
          fileInputRef.current?.click();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          disabled={isUploading}
          onChange={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isUploading) return;
            const files = e.target.files;
            if (files && files.length > 0) {
              await upload(files[0]);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }
          }}
          className="absolute inset-0 h-full w-full opacity-0 pointer-events-none"
        />

        <div className="pointer-events-none flex flex-col items-center gap-4">
          {/* Icon */}
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-colors duration-200 ${
              isDone
                ? "border-white/20 bg-white/[0.06]"
                : isError
                ? "border-red-500/30 bg-red-500/[0.06]"
                : isDragging
                ? "border-white/25 bg-white/[0.07]"
                : "border-white/10 bg-white/[0.04]"
            }`}
          >
            {isUploading ? (
              <Spinner className="h-6 w-6 text-white/50" />
            ) : isDone ? (
              <CheckIcon className="h-6 w-6 text-white/70" />
            ) : (
              <UploadIcon
                className={`h-6 w-6 transition-colors duration-200 ${
                  isDragging ? "text-white/80" : "text-white/40"
                }`}
              />
            )}
          </div>

          {/* Label */}
          <div className="flex flex-col items-center gap-1 text-center">
            {isUploading ? (
              <>
                <p className="text-sm font-medium text-white/70">{statusMessage}</p>
                {hash && (
                  <p className="font-mono text-[11px] text-white/25">
                    {hash.slice(0, 16)}…
                  </p>
                )}
              </>
            ) : isDone ? (
              <>
                <p className="text-sm font-medium text-white/80">Análisis completado</p>
                {hash && (
                  <p className="font-mono text-[11px] text-white/30">
                    {hash.slice(0, 16)}…
                  </p>
                )}
              </>
            ) : (
              <>
                <p className={`text-sm font-medium transition-colors ${isDragging ? "text-white/90" : "text-white/55"}`}>
                  {isDragging ? "Suelta el archivo" : "Arrastra tu reporte aquí"}
                </p>
                <p className="text-xs text-white/25">o haz clic para seleccionar</p>
                <p className="mt-1 rounded-full border border-white/8 bg-white/[0.03] px-3 py-0.5 text-[11px] text-white/20">
                  PDF
                </p>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Status message */}
      {statusMessage && (
        <div
          className={`flex flex-col justify-center gap-3 rounded-2xl border px-6 py-5 transition-all duration-300 ${
            isError
              ? "border-red-500/20 bg-red-500/[0.04]"
              : "border-white/8 bg-white/[0.02]"
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                isUploading
                  ? "bg-white/40"
                  : isError
                  ? "bg-red-400/70"
                  : "bg-white/50"
              }`}
              style={isUploading ? { animation: "pulse 1.5s ease-in-out infinite" } : {}}
            />
            <p className={`text-sm ${isError ? "text-red-300/80" : "text-white/70"}`}>
              {statusMessage}
            </p>
          </div>
          {hash && !isError && (
            <div className="rounded-lg border border-white/6 bg-black/20 px-3 py-2">
              <p className="mb-0.5 text-[10px] uppercase tracking-widest text-white/20">SHA-256</p>
              <p className="break-all font-mono text-[11px] text-white/35">{hash}</p>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      `}</style>
    </section>
  );
}
