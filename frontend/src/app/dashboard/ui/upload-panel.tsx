"use client";

import { useRef, useState, useMemo } from "react";
import { sha256Hex } from "@/lib/sha256";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface UploadResponse {
  duplicate?: boolean;
  file_hash?: string;
  result?: any;
  error?: string;
  message?: string;
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

  const dropClassName = useMemo(() => {
    const base =
      "relative flex h-[320px] w-[320px] items-center justify-center rounded-full border bg-black/35 backdrop-blur transition-colors";
    const border = isDragging
      ? "border-[rgba(100,202,228,0.85)]"
      : "border-white/15";
    return `${base} ${border}`;
  }, [isDragging]);

  async function upload(file: File) {
    setIsUploading(true);
    setStatusMessage("Calculando huella orbital...");
    setHash(null);

    try {
      const digest = await sha256Hex(file);
      setHash(digest);

      const formData = new FormData();
      formData.append("file", file);

      setStatusMessage("Enviando reporte a Cometa...");

      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: {
          "founder-email": founderEmail,
        },
        body: formData,
      });

      let data: UploadResponse | null = null;
      try {
        data = (await res.json()) as UploadResponse;
      } catch (parseErr) {
        console.error("[upload] No se pudo parsear JSON de respuesta", parseErr);
      }

      if (!res.ok) {
        console.error("[upload] Respuesta no OK", {
          status: res.status,
          statusText: res.statusText,
          data,
        });
        setStatusMessage(data?.error ?? data?.message ?? "Error procesando el reporte");
        return;
      }

      if (data?.duplicate) {
        setStatusMessage("Reporte detectado en órbita. Recuperando auditoría...");
        // Notificar al dashboard principal que se detectó un análisis
        if (data?.file_hash && data?.result) {
          console.log("📡 Notificando análisis detectado:", data.file_hash);
          onAnalysisDetected?.(data.file_hash, data.result);
        }
      } else {
        setStatusMessage(data?.message ?? "Reporte procesado");
      }

      // También notificar para análisis nuevos (no duplicados)
      if (!data?.duplicate && data?.file_hash && data?.result) {
        console.log("📡 Notificando nuevo análisis:", data.file_hash);
        onAnalysisDetected?.(data.file_hash, data.result);
      }
    } catch (err) {
      console.error("[upload] Falló el fetch", err);
      setStatusMessage("No se pudo subir el reporte");
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <section className="grid grid-cols-1 gap-10 lg:grid-cols-[360px_1fr]">
      <div className="flex flex-col items-center gap-4">
        <div
          className={dropClassName}
          onDragEnter={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
          }}
          onDrop={async (e) => {
            // Control de eventos - prevenir doble disparo
            e.preventDefault();
            e.stopPropagation();
            setIsDragging(false);
            
            // Estado de bloqueo - ignorar si ya está procesando
            if (isUploading) {
              console.log("🔒 UploadPanel bloqueado - ya está procesando (drag & drop)");
              return;
            }
            
            const files = Array.from(e.dataTransfer.files);
            if (files.length > 0) {
              console.log("📁 Archivo arrastrado:", files[0].name);
              await upload(files[0] as File);
            }
          }}
          onClick={() => {
            // Estado de bloqueo - ignorar si ya está procesando
            if (isUploading) {
              console.log("🔒 UploadPanel bloqueado - ya está procesando (click)");
              return;
            }
            fileInputRef.current?.click();
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            disabled={isUploading}
            onChange={async (e) => {
              // Control de eventos - prevenir doble disparo
              e.preventDefault();
              e.stopPropagation();
              
              // Estado de bloqueo - ignorar si ya está procesando
              if (isUploading) {
                console.log("🔒 UploadPanel bloqueado - ya está procesando");
                return;
              }
              
              const files = e.target.files;
              if (files && files.length > 0) {
                console.log("📁 Archivo seleccionado:", files[0].name);
                await upload(files[0]);
                
                // Limpieza de input - resetear valor para evitar doble disparo
                if (fileInputRef.current) {
                  fileInputRef.current.value = "";
                }
              }
            }}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
          <div className="flex flex-col items-center justify-center gap-2 pointer-events-none">
            {isUploading ? (
              <div className="text-white/70 text-sm">Procesando...</div>
            ) : (
              <>
                <div className="text-white/70 text-sm">
                  {hash ? `Reporte detectado en órbita` : "Arrastra o sube PDF"}
                </div>
                {hash && (
                  <div className="text-xs font-normal text-white/45 mt-2">
                    Hash: {hash.slice(0, 8)}...
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      
      {statusMessage ? (
        <div className="w-full rounded-[2.25rem] border border-white/10 bg-black/35 px-6 py-4 text-sm font-normal text-white/80">
            {statusMessage}
            {hash ? (
              <div className="mt-2 break-all text-xs text-white/50">{hash}</div>
            ) : null}
          </div>
      ) : null}
    </section>
  );
}
