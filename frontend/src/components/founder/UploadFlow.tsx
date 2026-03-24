"use client";

/**
 * UploadFlow — Founder document upload with sector validation.
 *
 * State machine:
 *   idle → dragging → uploading → missing (checklist incomplete)
 *                              ↘ success (checklist complete OR missing fields filled)
 *                              ↘ error
 *
 * Multi-source support (up to 5 files):
 *   - uploadedFiles tracks { name, hash } of every successfully processed document.
 *   - mergedChecklist consolidates checklist_status across all uploads using an
 *     additive merge: KPIs already in present_kpis are NEVER removed by a later upload.
 *   - "Subir otro documento" only appears when uploadedFiles.length < 5 and the
 *     current state is success or error.
 *   - MissingDataPanel receives mergedChecklist rather than the single-upload checklist.
 */

import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, AlertCircle, FileText, CheckCircle, Loader2 } from "lucide-react";
import { uploadDocument, notifyUploadComplete, finalizeExpediente, fetchKpisByVertical, fetchFounderConfig } from "@/services/founder";
import ValidationModal from "@/components/founder/ValidationModal";
import MissingDataPanel from "@/components/founder/MissingDataPanel";
import type { UploadResponse, ChecklistStatus, KpiMetadataItem, FounderConfig } from "@/lib/schemas";

type UploadState = "idle" | "dragging" | "uploading" | "missing" | "success" | "error";
type Vertical    = "SAAS" | "FINTECH" | "MARKETPLACE" | "GENERAL" | "INSURTECH";

const VERTICAL_META: Record<Vertical, { label: string; icon: string }> = {
  SAAS:        { label: "SaaS",           icon: "⚡" },
  FINTECH:     { label: "Fintech",        icon: "💳" },
  MARKETPLACE: { label: "Marketplace",    icon: "🛒" },
  INSURTECH:   { label: "Insurtech",      icon: "🛡️" },
  GENERAL:     { label: "General",        icon: "📊" },
};

// ── Vertical Selector — step 0 antes de subir el archivo ────────────────────
function VerticalSelector({
  selected,
  onSelect,
  kpis,
  kpisLoading,
}: {
  selected:     Vertical | null;
  onSelect:     (v: Vertical) => void;
  kpis:         KpiMetadataItem[];
  kpisLoading:  boolean;
}) {
  return (
    <div className="w-full max-w-md">
      <p className="mb-3 text-[9px] font-semibold uppercase tracking-[0.2em]"
         style={{ color: "var(--cometa-fg-muted)" }}>
        ¿Cuál es el modelo de negocio?
      </p>
      <div className="grid grid-cols-2 gap-2 mb-5">
        {(Object.keys(VERTICAL_META) as Vertical[]).map((v) => {
          const isActive = selected === v;
          return (
            <button
              key={v}
              onClick={() => onSelect(v)}
              className="flex items-center gap-2 rounded-2xl px-4 py-3 text-left text-[12px] font-light transition-all"
              style={{
                background: isActive
                  ? "color-mix(in srgb, var(--cometa-accent) 14%, transparent)"
                  : "var(--cometa-card-bg)",
                border: isActive
                  ? "1px solid color-mix(in srgb, var(--cometa-accent) 45%, transparent)"
                  : "1px solid var(--cometa-card-border)",
                color: isActive ? "var(--cometa-accent)" : "var(--cometa-fg-muted)",
              }}
            >
              <span>{VERTICAL_META[v].icon}</span>
              <span>{VERTICAL_META[v].label}</span>
            </button>
          );
        })}
      </div>

      {selected && (
        <motion.div
          key={selected}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl px-4 py-3 mb-4"
          style={{
            background: "color-mix(in srgb, var(--cometa-fg) 4%, transparent)",
            border:     "1px solid var(--cometa-card-border)",
          }}
        >
          <div className="flex items-center justify-between mb-2">
            <p className="text-[9px] uppercase tracking-[0.16em]"
               style={{ color: "var(--cometa-fg-muted)" }}>
              KPIs que el sistema buscará
            </p>
            {kpisLoading && (
              <Loader2 size={10} className="animate-spin" style={{ color: "var(--cometa-fg-muted)" }} />
            )}
          </div>
          {kpisLoading ? (
            <p className="text-[10px] opacity-50" style={{ color: "var(--cometa-fg-muted)" }}>
              Cargando catálogo…
            </p>
          ) : kpis.length === 0 ? (
            <p className="text-[10px] opacity-50" style={{ color: "var(--cometa-fg-muted)" }}>
              Selecciona un vertical para ver las métricas
            </p>
          ) : (
            <div className="space-y-1.5">
              {kpis.map((kpi) => (
                <div key={kpi.kpi_key} className="flex items-center justify-between">
                  <span className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
                    {kpi.is_required ? "✓" : "○"} {kpi.display_name}
                  </span>
                  <span className="font-mono text-[10px] opacity-50"
                        style={{ color: "var(--cometa-fg-muted)" }}>
                    {kpi.example_value ?? kpi.unit ?? ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  );
}

interface UploadFlowProps {
  founderEmail: string;
  onSuccess?:   (result: UploadResponse) => void;
}

/**
 * Merge two ChecklistStatus objects without dropping any KPI that is already present.
 * The merged checklist's present_kpis is the union of both; missing_critical_kpis is
 * the set of KPIs in `incoming.missing_critical_kpis` that are NOT already present.
 * confidence_scores are merged by taking the higher score when both exist.
 */
function mergeChecklists(
  base: ChecklistStatus,
  incoming: ChecklistStatus,
): ChecklistStatus {
  const presentSet = new Set([...base.present_kpis, ...incoming.present_kpis]);

  const missingSet = new Set(
    incoming.missing_critical_kpis.filter((k) => !presentSet.has(k)),
  );
  // Also keep existing missing KPIs that haven't been resolved
  for (const k of base.missing_critical_kpis) {
    if (!presentSet.has(k)) missingSet.add(k);
  }

  // Merge confidence scores: higher wins
  const mergedScores: Record<string, number> = { ...(base.confidence_scores ?? {}) };
  for (const [k, v] of Object.entries(incoming.confidence_scores ?? {})) {
    mergedScores[k] = Math.max(mergedScores[k] ?? 0, v);
  }

  return {
    bucket:                incoming.bucket,
    is_complete:           missingSet.size === 0,
    present_kpis:          Array.from(presentSet),
    missing_critical_kpis: Array.from(missingSet),
    display_message:       incoming.display_message,
    confidence_scores:     Object.keys(mergedScores).length > 0 ? mergedScores : undefined,
  };
}

const MAX_FILES = 5;

export default function UploadFlow({ founderEmail, onSuccess }: UploadFlowProps) {
  const router                               = useRouter();
  const fileInputRef                         = useRef<HTMLInputElement>(null);
  const [uploadState,     setUploadState]     = useState<UploadState>("idle");
  const [statusMsg,       setStatusMsg]       = useState("");
  const [fileHash,        setFileHash]        = useState<string | null>(null);
  const [fileName,        setFileName]        = useState<string | null>(null);
  const [checklistStatus, setChecklistStatus] = useState<ChecklistStatus | null>(null);
  const [uploadResult,    setUploadResult]    = useState<UploadResponse | null>(null);
  const [validationError, setValidationError] = useState<unknown>(null);

  // Multi-file state
  const [uploadedFiles,   setUploadedFiles]   = useState<{ name: string; hash: string }[]>([]);
  const [mergedChecklist, setMergedChecklist] = useState<ChecklistStatus | null>(null);

  // Auto-detected config from /api/founder/config
  const [autoConfig,       setAutoConfig]       = useState<FounderConfig | null>(null);
  const [configLoading,    setConfigLoading]    = useState(true);

  // Vertical selector (step 0) + dynamic KPI catalogue from dim_kpi_metadata
  const [selectedVertical, setSelectedVertical] = useState<Vertical | null>(null);
  const [verticalKpis,     setVerticalKpis]     = useState<KpiMetadataItem[]>([]);
  const [kpisLoading,      setKpisLoading]      = useState(false);

  // Fetch auto-config on mount — silently falls back to manual selector on failure
  useEffect(() => {
    fetchFounderConfig().then((cfg) => {
      setAutoConfig(cfg);
      if (cfg?.vertical && (Object.keys(VERTICAL_META) as Vertical[]).includes(cfg.vertical as Vertical)) {
        setSelectedVertical(cfg.vertical as Vertical);
      }
      setConfigLoading(false);
    });
  }, []);

  // Fetch KPIs from the API whenever the vertical changes
  useEffect(() => {
    if (!selectedVertical) return;
    setKpisLoading(true);
    fetchKpisByVertical(selectedVertical)
      .then(setVerticalKpis)
      .finally(() => setKpisLoading(false));
  }, [selectedVertical]);

  // Finalize state
  const [finalizing, setFinalizing] = useState(false);
  const [lastManualKpis, setLastManualKpis] = useState<Record<string, string>>({});

  const handleFile = useCallback(async (file: File) => {
    if (uploadState === "uploading") return;

    setFileName(file.name);
    setUploadState("uploading");
    setStatusMsg("Analizando documento…");
    setValidationError(null);
    setChecklistStatus(null);

    try {
      const result = await uploadDocument(file, founderEmail);
      const hash   = result.file_hash ?? null;
      setFileHash(hash);
      setUploadResult(result);

      // Update uploaded files list
      if (hash) {
        setUploadedFiles((prev) => [
          ...prev,
          { name: file.name, hash },
        ]);
      }

      // Check sector checklist
      const cs = result.checklist_status;
      if (cs) {
        // Additive merge with previous uploads
        setMergedChecklist((prev) => prev ? mergeChecklists(prev, cs) : cs);

        if (!cs.is_complete && cs.missing_critical_kpis.length > 0) {
          setChecklistStatus(cs);
          setUploadState("missing");
          return;
        }
      }

      setStatusMsg(
        result.duplicate
          ? "Documento ya registrado — auditoría recuperada."
          : result.message ?? "Reporte procesado correctamente.",
      );
      setUploadState("success");
      onSuccess?.(result);
      void notifyUploadComplete(founderEmail, hash ?? "", result.company_domain);
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 422) {
        setValidationError((err as { data?: unknown }).data);
        setUploadState("idle");
      } else {
        setStatusMsg("Error al procesar el documento. Intenta de nuevo.");
        setUploadState("error");
      }
    }
  }, [uploadState, founderEmail, onSuccess]);

  function handleMissingComplete(values: Record<string, string>) {
    // Merge manually entered KPIs so finalize can include them in the email
    setLastManualKpis((prev) => ({ ...prev, ...values }));
    // Update mergedChecklist to reflect completion
    setMergedChecklist((prev) => prev ? { ...prev, is_complete: true, missing_critical_kpis: [] } : null);
    setStatusMsg(
      uploadResult?.message ?? "Datos complementados. Reporte registrado correctamente.",
    );
    setUploadState("success");
    if (uploadResult) onSuccess?.(uploadResult);
    void notifyUploadComplete(founderEmail, fileHash ?? "", uploadResult?.company_domain);
  }

  async function handleFinalize() {
    if (finalizing || uploadedFiles.length === 0) return;
    setFinalizing(true);
    try {
      const companyDomain =
        autoConfig?.company_id ||
        uploadResult?.company_domain ||
        (founderEmail.includes("@") ? founderEmail.split("@")[1] : "");
      const response = await finalizeExpediente({
        file_hashes:    uploadedFiles.map((f) => f.hash),
        company_domain: companyDomain,
        file_names:     uploadedFiles.map((f) => f.name),
        manual_kpis:    Object.keys(lastManualKpis).length > 0 ? lastManualKpis : undefined,
      });
      // Pasar vault_seal a la página de éxito para el Recibo Digital
      const seal   = response.vault_seal ?? "";
      const params = seal ? `?seal=${encodeURIComponent(seal)}` : "";
      router.push(`/success${params}`);
    } catch {
      setFinalizing(false);
    }
  }

  const dropZoneClass = useMemo(() => {
    const state: Record<UploadState, string> = {
      idle:     "border-white/15 hover:border-[var(--cometa-accent)]/50",
      dragging: "border-[var(--cometa-accent)] scale-[1.02]",
      uploading:"border-white/10",
      missing:  "border-amber-400/30",
      success:  "border-emerald-400/40",
      error:    "border-red-400/40",
    };
    return `relative flex h-64 w-full max-w-md flex-col items-center justify-center gap-3
      rounded-3xl border-2 border-dashed transition-all duration-200 cursor-pointer
      ${state[uploadState]}`;
  }, [uploadState]);

  function resetForNextFile() {
    setUploadState("idle");
    setStatusMsg("");
    setFileHash(null);
    setFileName(null);
    setChecklistStatus(null);
    setUploadResult(null);
  }

  const canUploadMore = uploadedFiles.length < MAX_FILES;
  const showDropZone  = uploadState !== "missing";
  const showUploadAnother =
    canUploadMore && (uploadState === "success" || uploadState === "error");

  // Show "Finalizar" when at least one upload succeeded, state is success,
  // and the checklist is complete (either originally or after manual completion)
  const showFinalize =
    uploadedFiles.length > 0 &&
    uploadState === "success" &&
    (mergedChecklist === null || mergedChecklist.is_complete === true);

  // Force completion: at MAX_FILES, checklist still incomplete, not already in missing state
  const showForceComplete =
    !canUploadMore &&
    mergedChecklist !== null &&
    mergedChecklist.is_complete === false &&
    uploadState !== "missing" &&
    uploadState !== "uploading";

  // Drop zone habilitado cuando hay vertical seleccionado o fue auto-detectado
  const verticalReady = selectedVertical !== null || (autoConfig?.is_known === true);

  return (
    <>
      <div className="flex w-full max-w-md flex-col items-center gap-5">

        {/* ── Step 0: Auto-config pill or Vertical selector ── */}
        {uploadedFiles.length === 0 && uploadState === "idle" && (
          configLoading ? (
            <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
              <Loader2 size={12} className="animate-spin shrink-0" />
              Detectando perfil…
            </div>
          ) : autoConfig?.is_known ? (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-md rounded-2xl px-4 py-3 flex items-center justify-between"
              style={{
                background: "color-mix(in srgb, var(--cometa-accent) 10%, transparent)",
                border:     "1px solid color-mix(in srgb, var(--cometa-accent) 28%, transparent)",
              }}
            >
              <div>
                <p className="text-[9px] uppercase tracking-[0.18em] mb-0.5" style={{ color: "var(--cometa-accent)" }}>
                  Empresa detectada
                </p>
                <p className="text-[12px] font-light" style={{ color: "var(--cometa-fg)" }}>
                  {autoConfig.company_id} · {VERTICAL_META[autoConfig.vertical as Vertical]?.label ?? autoConfig.vertical}
                </p>
              </div>
              <span className="text-lg">{VERTICAL_META[autoConfig.vertical as Vertical]?.icon ?? "📊"}</span>
            </motion.div>
          ) : (
            <VerticalSelector
              selected={selectedVertical}
              onSelect={setSelectedVertical}
              kpis={verticalKpis}
              kpisLoading={kpisLoading}
            />
          )
        )}

        {/* ── Processed files list ── */}
        {uploadedFiles.length > 0 && (
          <div className="w-full space-y-1.5">
            {uploadedFiles.map((f, i) => (
              <div
                key={f.hash}
                className="flex items-center gap-2 rounded-xl px-3 py-2 text-[11px]"
                style={{
                  background: "color-mix(in srgb, #34d399 6%, transparent)",
                  border:     "1px solid color-mix(in srgb, #34d399 15%, transparent)",
                }}
              >
                <CheckCircle size={11} className="shrink-0 text-emerald-400" />
                <span className="flex-1 truncate" style={{ color: "var(--cometa-fg-muted)" }}>
                  {f.name}
                </span>
                <span className="font-mono text-[9px] opacity-50">
                  {i + 1}/{MAX_FILES}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── Drop zone (hidden while filling missing data) ── */}
        <AnimatePresence>
          {showDropZone && (
            <motion.div
              initial={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }}
              className="w-full"
            >
              <div
                className={dropZoneClass}
                style={{
                  background: "var(--cometa-card-bg)",
                  opacity: !verticalReady && uploadedFiles.length === 0 ? 0.45 : 1,
                  pointerEvents: !verticalReady && uploadedFiles.length === 0 ? "none" : undefined,
                }}
                onDragEnter={(e) => { e.preventDefault(); if (uploadState === "idle" && verticalReady) setUploadState("dragging"); }}
                onDragOver={(e)  => { e.preventDefault(); }}
                onDragLeave={(e) => { e.preventDefault(); if (uploadState === "dragging") setUploadState("idle"); }}
                onDrop={async (e) => {
                  e.preventDefault();
                  if (!verticalReady && uploadedFiles.length === 0) return;
                  const file = e.dataTransfer.files[0];
                  if (file) await handleFile(file);
                }}
                onClick={() => {
                  if (!verticalReady && uploadedFiles.length === 0) return;
                  if (uploadState !== "uploading") fileInputRef.current?.click();
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*/*"
                  disabled={uploadState === "uploading"}
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      await handleFile(file);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }
                  }}
                  className="absolute inset-0 opacity-0 pointer-events-none"
                />

                <AnimatePresence mode="wait">
                  {/* Uploading */}
                  {uploadState === "uploading" && (
                    <motion.div key="up"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <motion.div
                        className="h-10 w-10 rounded-full border-2 border-t-transparent"
                        style={{ borderColor: "var(--cometa-accent)", borderTopColor: "transparent" }}
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                      />
                      <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                        {statusMsg}
                      </p>
                    </motion.div>
                  )}

                  {/* Success */}
                  {uploadState === "success" && (
                    <motion.div key="ok"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none text-center"
                    >
                      {/* Checkmark animado */}
                      <motion.div
                        initial={{ scale: 0, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                      >
                        <svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden>
                          <motion.circle
                            cx="26" cy="26" r="22"
                            stroke="#22c55e" strokeWidth="2"
                            fill="rgba(34,197,94,0.08)"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.5, ease: "easeOut" }}
                          />
                          <motion.path
                            d="M15 26 L22 33 L37 19"
                            stroke="#22c55e" strokeWidth="3"
                            strokeLinecap="round" strokeLinejoin="round"
                            fill="none"
                            initial={{ pathLength: 0 }}
                            animate={{ pathLength: 1 }}
                            transition={{ duration: 0.4, delay: 0.35, ease: "easeOut" }}
                          />
                        </svg>
                      </motion.div>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "#22c55e" }}>
                          Documento entregado
                        </p>
                        <p className="mt-1 text-[12px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                          {statusMsg}
                        </p>
                      </div>
                      {fileHash && (
                        <p className="font-mono text-[9px]" style={{ color: "var(--cometa-fg-muted)" }}>
                          {fileHash.slice(0, 16)}…
                        </p>
                      )}
                    </motion.div>
                  )}

                  {/* Error */}
                  {uploadState === "error" && (
                    <motion.div key="err"
                      initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <AlertCircle size={32} className="text-red-400" />
                      <p className="text-[12px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        {statusMsg}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--cometa-fg-muted)" }}>
                        Haz clic para intentar de nuevo
                      </p>
                    </motion.div>
                  )}

                  {/* Idle / Dragging */}
                  {(uploadState === "idle" || uploadState === "dragging") && (
                    <motion.div key="idle"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center gap-3 pointer-events-none"
                    >
                      <div
                        className="rounded-2xl p-4"
                        style={{ border: "1px solid var(--cometa-card-border)", background: "var(--cometa-card-bg)" }}
                      >
                        {uploadState === "dragging"
                          ? <FileText size={28} style={{ color: "var(--cometa-accent)" }} />
                          : <Upload size={28} style={{ color: "var(--cometa-fg-muted)" }} />
                        }
                      </div>
                      <div className="text-center">
                        <p className="text-[13px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                          {!verticalReady && uploadedFiles.length === 0
                            ? "Selecciona el modelo de negocio primero"
                            : uploadState === "dragging" ? "Suelta el archivo"
                            : "Arrastra tu reporte financiero"}
                        </p>
                        <p className="mt-1 text-[11px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.6 }}>
                          PDF, Excel, CSV · máx. 50 MB
                        </p>
                        {uploadedFiles.length > 0 && (
                          <p className="mt-1 text-[10px]" style={{ color: "var(--cometa-fg-muted)", opacity: 0.5 }}>
                            {uploadedFiles.length}/{MAX_FILES} documentos cargados
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* File name hint */}
        {fileName && uploadState !== "idle" && uploadState !== "missing" && (
          <p className="text-[11px]" style={{ color: "var(--cometa-fg-muted)" }}>
            {fileName}
          </p>
        )}

        {/* ── Missing data panel (uses merged checklist) ── */}
        <AnimatePresence>
          {uploadState === "missing" && (mergedChecklist ?? checklistStatus) && (
            <motion.div
              key="missing"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="w-full"
            >
              <div className="mb-4 text-center">
                <p className="text-[11px] font-light" style={{ color: "var(--cometa-fg-muted)" }}>
                  {fileName}
                </p>
              </div>
              <MissingDataPanel
                checklist={mergedChecklist ?? checklistStatus!}
                fileHash={fileHash ?? undefined}
                onComplete={handleMissingComplete}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* "Subir otro documento" — only when < 5 files and state is terminal */}
        {showUploadAnother && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={resetForNextFile}
            className="w-full rounded-2xl px-5 py-3 text-[13px] font-medium tracking-wide transition-all hover:opacity-90 flex items-center justify-center gap-2"
            style={{
              background: "color-mix(in srgb, var(--cometa-accent) 12%, transparent)",
              border:     "1px solid color-mix(in srgb, var(--cometa-accent) 40%, transparent)",
              color:      "var(--cometa-accent)",
            }}
          >
            <Upload size={14} className="shrink-0" />
            Subir otro documento
            <span
              className="ml-1 rounded-full px-2 py-0.5 text-[10px]"
              style={{
                background: "color-mix(in srgb, var(--cometa-accent) 18%, transparent)",
              }}
            >
              {uploadedFiles.length}/{MAX_FILES}
            </span>
          </motion.button>
        )}

        {/* Limit reached message — only when checklist is complete */}
        {!canUploadMore && (mergedChecklist === null || mergedChecklist.is_complete) && (
          <p className="text-[10px] uppercase tracking-widest opacity-50"
             style={{ color: "var(--cometa-fg-muted)" }}>
            Límite de {MAX_FILES} documentos alcanzado
          </p>
        )}

        {/* Force-complete: at MAX_FILES but checklist still has missing fields */}
        {showForceComplete && (
          <motion.button
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => setUploadState("missing")}
            className="w-full rounded-2xl px-5 py-3 text-[13px] font-light tracking-wide
                       transition-opacity hover:opacity-80"
            style={{
              background: "color-mix(in srgb, #f59e0b 12%, transparent)",
              border:     "1px solid color-mix(in srgb, #f59e0b 25%, transparent)",
              color:      "#fbbf24",
            }}
          >
            Completar datos faltantes ({mergedChecklist.missing_critical_kpis.length} campos)
          </motion.button>
        )}

        {/* Finalizar Expediente CTA */}
        {showFinalize && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            onClick={handleFinalize}
            disabled={finalizing}
            className="w-full rounded-2xl px-5 py-3.5 text-[13px] font-light tracking-wide
                       transition-all disabled:opacity-50 hover:opacity-85 flex items-center justify-center gap-2"
            style={{
              background: "var(--cometa-accent)",
              color:      "var(--cometa-accent-fg)",
            }}
          >
            {finalizing
              ? <><Loader2 size={14} className="animate-spin shrink-0" />Enviando…</>
              : "Finalizar Expediente"}
          </motion.button>
        )}
      </div>

      {/* 422 Validation modal (blocks progress) */}
      {validationError !== null && (
        <ValidationModal
          error={validationError}
          onClose={() => setValidationError(null)}
        />
      )}
    </>
  );
}
