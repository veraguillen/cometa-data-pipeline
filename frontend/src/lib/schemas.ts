/**
 * schemas.ts — Zod schemas for Cometa Pipeline API responses.
 *
 * Fuente única de verdad para la forma de los datos en el frontend.
 * Espeja exactamente los modelos Pydantic del backend (src/schemas.py).
 *
 * Reglas:
 *  - Toda entidad recibida del backend se valida con .parse() antes de usarla.
 *  - Los tipos TypeScript se derivan con z.infer<> — nunca declarados a mano.
 *  - Cada nueva entidad de API necesita su schema aquí antes de ser consumida.
 *
 * Mapa de espejo Backend → Frontend:
 *   UserPublic        → userInfoSchema
 *   LoginApiResponse  → loginResponseSchema
 *   MeApiResponse     → meResponseSchema
 *   LoginRequest      → loginRequestSchema   (validación del formulario)
 */

import { z } from "zod";

// ── Primitivos reutilizables ──────────────────────────────────────────────────

/**
 * ID Híbrido: ANA-XXXXXX (analista @cometa.*) o FND-XXXXXX (founder externo).
 * Espeja: HYBRID_ID_PATTERN en src/schemas.py
 */
export const hybridIdSchema = z
  .string()
  .regex(
    /^(ANA|FND)-[A-Za-z0-9]{6}$/,
    "user_id debe tener formato ANA-XXXXXX o FND-XXXXXX"
  );

/**
 * Roles de usuario.
 * Espeja: UserRole = Literal["ANALISTA", "FOUNDER", "SOCIO"] en src/schemas.py
 */
export const userRoleSchema = z.enum(["ANALISTA", "FOUNDER", "SOCIO"]);

// ── UserInfo — datos públicos del usuario autenticado ─────────────────────────
// Espeja: class UserPublic(BaseModel) en src/schemas.py

export const userInfoSchema = z.object({
  user_id:    hybridIdSchema,
  email:      z.string().email("email inválido"),
  name:       z.string().default(""),
  role:       userRoleSchema,
  company_id: z.string().default(""),
});

export type UserInfo = z.infer<typeof userInfoSchema>;

// ── LoginRequest — body de POST /api/login ────────────────────────────────────
// Espeja: class LoginRequest(BaseModel) en src/api.py
// Uso: validación del formulario en LoginScreen antes de enviar al servidor.

export const loginRequestSchema = z.object({
  email:    z.string().email("Introduce un email válido"),
  password: z.string().min(1, "La contraseña no puede estar vacía"),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ── LoginResponse — respuesta de POST /api/login ──────────────────────────────
// Espeja: class LoginApiResponse(BaseModel) en src/schemas.py

export const loginResponseSchema = z.object({
  access_token: z.string().min(1, "access_token no puede estar vacío"),
  token_type:   z.string(),
  user:         userInfoSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

// ── MeResponse — respuesta de GET /api/me ─────────────────────────────────────
// Espeja: class MeApiResponse(BaseModel) en src/schemas.py

export const meResponseSchema = z.object({
  user_id:    hybridIdSchema,
  email:      z.string().email("email inválido"),
  name:       z.string().default(""),
  role:       userRoleSchema,
  company_id: z.string().default(""),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

// ── ValidationError — respuesta de error 422 del backend ─────────────────────
// Espeja: _format_validation_errors() en src/api.py

export const validationErrorItemSchema = z.object({
  loc:  z.array(z.union([z.string(), z.number()])),
  msg:  z.string(),
  type: z.string(),
});

export const validationErrorSchema = z.object({
  detail: z.array(validationErrorItemSchema),
});

export type ValidationErrorResponse = z.infer<typeof validationErrorSchema>;

// ── ChecklistStatus — sector KPI validation from POST /upload ─────────────────
// Espeja: build_checklist_status() en src/core/data_contract.py

export const checklistStatusSchema = z.object({
  bucket:                z.string(),
  is_complete:           z.boolean(),
  present_kpis:          z.array(z.string()),
  missing_critical_kpis: z.array(z.string()),
  display_message:       z.string(),
  // Per-KPI confidence scores extracted from Gemini (0–100 integer scale)
  confidence_scores:     z.record(z.string(), z.number()).optional(),
});

export type ChecklistStatus = z.infer<typeof checklistStatusSchema>;

// ── UploadResponse — respuesta de POST /upload ────────────────────────────────
// Espeja: la respuesta del endpoint de ingesta de documentos en api.py

export const uploadResponseSchema = z.object({
  duplicate:             z.boolean().optional(),
  file_hash:             z.string().optional(),
  result:                z.unknown().optional(),
  error:                 z.string().optional(),
  message:               z.string().optional(),
  checklist_status:      checklistStatusSchema.optional(),
  company_domain:        z.string().optional(),
  // Per-KPI confidence scores extracted from Gemini (0–100 integer scale)
  kpi_confidence_scores: z.record(z.string(), z.number()).optional(),
});

export type UploadResponse = z.infer<typeof uploadResponseSchema>;

// ── AnalysisResult — item en GET /api/results ────────────────────────────────
// Espeja: el modelo de resultado de análisis financiero

export const analysisMetadataSchema = z.object({
  file_hash:         z.string().default(""),
  original_filename: z.string().default(""),
  founder_email:     z.string().default(""),
  processed_at:      z.string().default(""),
  gcs_path:          z.string().default(""),
  // BQ-sourced results include these extra fields
  company_domain:    z.string().optional(),
  portfolio_id:      z.string().optional(),
});

export const analysisResultSchema = z.object({
  id:           z.string(),
  data:         z.record(z.string(), z.unknown()),
  date:         z.string().default(""),
  metadata:     analysisMetadataSchema,
  value_status: z.string().optional(),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const resultsResponseSchema = z.object({
  status:  z.string(),
  results: z.array(analysisResultSchema),
});

export type ResultsResponse = z.infer<typeof resultsResponseSchema>;

// ── Company — item en GET /api/companies ──────────────────────────────────────
export const companySchema = z.object({
  id:     z.string(),
  name:   z.string(),
  domain: z.string().optional(),
  sector: z.string().optional(),
});

export type Company = z.infer<typeof companySchema>;

export const companiesResponseSchema = z.object({
  companies: z.array(companySchema),
});

export type CompaniesResponse = z.infer<typeof companiesResponseSchema>;

// ── PortfolioCompanies — GET /api/portfolio-companies ─────────────────────────
// Espeja la respuesta real del backend (no requiere auth)

export const portfolioCompanyEntrySchema = z.object({
  key:         z.string(),
  label:       z.string(),
  is_overview: z.boolean().default(false),
  has_data:    z.boolean().default(false),
});

export type PortfolioCompanyEntry = z.infer<typeof portfolioCompanyEntrySchema>;

export const portfolioEntrySchema = z.object({
  portfolio_id:   z.string(),
  portfolio_name: z.string(),
  companies:      z.array(portfolioCompanyEntrySchema),
});

export const portfolioCompaniesResponseSchema = z.object({
  status:     z.string(),
  portfolios: z.array(portfolioEntrySchema),
});

export type PortfolioEntry            = z.infer<typeof portfolioEntrySchema>;
export type PortfolioCompaniesResponse = z.infer<typeof portfolioCompaniesResponseSchema>;

// ── ManualUpdateResponse — respuesta de POST /api/founder/manual-update ───────
// Espeja: el endpoint de corrección manual de KPIs en api.py

export const manualUpdateResponseSchema = z.object({
  status:         z.string(),
  updated_fields: z.array(z.string()),
});

export type ManualUpdateResponse = z.infer<typeof manualUpdateResponseSchema>;

// ── SetupPasswordResponse — respuesta de POST /api/auth/setup-password ──────────
// Espeja la misma forma que loginResponseSchema (auto-login tras activación)

export const setupPasswordResponseSchema = loginResponseSchema;
export type SetupPasswordResponse = LoginResponse;

// ── InvitationsResponse — respuesta de GET /api/admin/invitations ─────────────
// Espeja: admin_invitations() en api.py

export const invitationSchema = z.object({
  email:      z.string(),
  name:       z.string().default(""),
  company_id: z.string().default(""),
  status:     z.string(),   // "ACTIVE" | "PENDING_INVITE"
});

export const invitationsResponseSchema = z.object({
  invitations: z.array(invitationSchema),
});

export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationsResponse = z.infer<typeof invitationsResponseSchema>;

// ── KpiUpdateResponse — respuesta de PUT /api/kpi-update ─────────────────────
// Espeja: kpi_update() en api.py → update_kpi_value() en db_writer.py

export const kpiUpdateResponseSchema = z.object({
  status:        z.string(),
  message:       z.string(),
  submission_id: z.string().optional(),
  kpi_key:       z.string().optional(),
  raw_value:     z.string().optional(),
  numeric_value: z.number().nullable().optional(),
  unit:          z.string().optional(),
  is_valid:      z.boolean().optional(),
});

export type KpiUpdateResponse = z.infer<typeof kpiUpdateResponseSchema>;

// ── AdminInviteResponse — respuesta de POST /api/admin/invite ─────────────────
// Espeja: admin_invite() en api.py

export const adminInviteResponseSchema = z.object({
  status:       z.string(),
  email:        z.string(),
  company_name: z.string(),
  setup_url:    z.string(),
  email_sent:   z.boolean(),
  email_error:  z.string().default(""),
});

export type AdminInviteResponse = z.infer<typeof adminInviteResponseSchema>;

// ── KpiMetadata — respuesta de GET /api/kpi-metadata ─────────────────────────
// Espeja: dim_kpi_metadata en BigQuery + query_kpi_metadata() en db_writer.py

export const kpiMetadataItemSchema = z.object({
  kpi_key:             z.string(),
  display_name:        z.string(),
  vertical:            z.string(),  // 'GENERAL' | 'SAAS' | 'FINTECH' | 'MARKETPLACE' | 'INSURTECH'
  description:         z.string().nullable().optional(),
  unit:                z.string().nullable().optional(),
  min_historical_year: z.number().nullable().optional(),
  is_required:         z.boolean().default(false),
  example_value:       z.string().nullable().optional(),
});

export type KpiMetadataItem = z.infer<typeof kpiMetadataItemSchema>;

export const kpiMetadataResponseSchema = z.object({
  status:   z.string(),
  kpis:     z.array(kpiMetadataItemSchema),
  vertical: z.string().nullable().optional(),
});

export type KpiMetadataResponse = z.infer<typeof kpiMetadataResponseSchema>;

// ── CoverageHeatmap — respuesta de GET /api/analyst/coverage ─────────────────
// Espeja: query_coverage() en src/core/db_writer.py

export const coverageCellSchema = z.object({
  company:        z.string(),
  period:         z.string(),
  status:         z.enum(["verified", "legacy", "missing"]),
  kpi_count:      z.number(),
  verified_count: z.number(),
  legacy_count:   z.number(),
});

export const coverageCompanySchema = z.object({
  key:          z.string(),
  display:      z.string(),
  portfolio_id: z.string().optional(),
});

export const coverageResponseSchema = z.object({
  status:    z.string(),
  companies: z.array(coverageCompanySchema),
  periods:   z.array(z.string()),
  cells:     z.array(coverageCellSchema),
});

export type CoverageCell     = z.infer<typeof coverageCellSchema>;
export type CoverageCompany  = z.infer<typeof coverageCompanySchema>;
export type CoverageResponse = z.infer<typeof coverageResponseSchema>;

// ── FinalizeResponse — respuesta de POST /api/founder/finalize ────────────────
// Espeja: founder_finalize() en api.py

export const finalizeResponseSchema = z.object({
  status:     z.string(),
  message:    z.string(),
  sent_to:    z.string().optional(),
  // SHA-256 Vault Seal — ID de transacción de integridad del expediente
  vault_seal: z.string().optional(),
});

export type FinalizeResponse = z.infer<typeof finalizeResponseSchema>;
