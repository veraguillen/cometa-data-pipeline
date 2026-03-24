/**
 * services/founder.ts — API calls for FOUNDER role.
 * Upload uses apiFetch (multipart); other calls use apiGet/apiPost per R-F1.
 */

import { apiFetch, apiPost, apiGet } from "@/services/api-client";
import {
  uploadResponseSchema,
  finalizeResponseSchema,
  kpiMetadataResponseSchema,
  founderConfigSchema,
  type UploadResponse,
  type FinalizeResponse,
  type KpiMetadataItem,
  type FounderConfig,
} from "@/lib/schemas";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

// ── Document upload ───────────────────────────────────────────────────────────
/**
 * POST /upload — multipart form upload.
 * Returns parsed UploadResponse or throws on non-OK / schema mismatch.
 * 422 errors surface as AxiosError with data matching validationErrorSchema.
 */
export async function uploadDocument(
  file: File,
  founderEmail: string,
): Promise<UploadResponse> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await apiFetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: { "founder-email": founderEmail },
    body: formData,
  });

  const raw: unknown = await res.json();

  if (!res.ok) {
    // Throw so ValidationModal can catch and parse 422 detail
    const err = new Error(`Upload failed: ${res.status}`);
    (err as Error & { status: number; data: unknown }).status = res.status;
    (err as Error & { status: number; data: unknown }).data = raw;
    throw err;
  }

  return uploadResponseSchema.parse(raw);
}

// ── Finalize expediente ────────────────────────────────────────────────────────
/**
 * POST /api/founder/finalize — marks the submission set as complete,
 * sends a confirmation email, and returns a status message.
 */
export async function finalizeExpediente(body: {
  file_hashes:    string[];
  company_domain: string;
  file_names?:    string[];
  manual_kpis?:   Record<string, string>;
}): Promise<FinalizeResponse> {
  return apiPost("/api/founder/finalize", body, finalizeResponseSchema);
}

// ── KPI Metadata — dynamic KPI catalogue from dim_kpi_metadata ───────────────
/**
 * GET /api/kpi-metadata?vertical=SAAS
 * Returns KPIs for the given vertical plus GENERAL (core) KPIs.
 * Falls back to an empty array on network error so the UploadFlow degrades
 * gracefully without crashing.
 */
export async function fetchKpisByVertical(vertical: string): Promise<KpiMetadataItem[]> {
  try {
    const response = await apiGet(
      `/api/kpi-metadata?vertical=${encodeURIComponent(vertical)}`,
      kpiMetadataResponseSchema,
    );
    return response.kpis;
  } catch {
    return [];
  }
}

// ── Founder auto-config — company_id y vertical desde JWT ─────────────────────
/**
 * GET /api/founder/config — devuelve company_id y vertical auto-detectados.
 * Returns null on any error so UploadFlow falls back to manual selection.
 */
export async function fetchFounderConfig(): Promise<FounderConfig | null> {
  try {
    return await apiGet("/api/founder/config", founderConfigSchema);
  } catch {
    return null;
  }
}

// ── Upload notification (fire-and-forget) ─────────────────────────────────────
/**
 * POST /api/notify/upload — optimistic email confirmation trigger.
 * Silently fails if the backend endpoint doesn't exist yet.
 */
export async function notifyUploadComplete(
  founderEmail: string,
  fileHash: string,
  companyDomain?: string,
): Promise<void> {
  try {
    await apiFetch(`${API_BASE}/api/notify/upload`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        founder_email:  founderEmail,
        file_hash:      fileHash,
        company_domain: companyDomain ?? "",
      }),
    });
  } catch {
    // Best-effort — notification failure must never block the UI
  }
}
