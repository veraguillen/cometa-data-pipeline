"use client";

/**
 * ConfirmSubmitButton — CTA de confirmación final del reporte
 * ─────────────────────────────────────────────────────────────
 * - Activo solo cuando is_complete = true (todos los KPIs críticos presentes)
 * - Deshabilitado con Tooltip que lista los KPIs faltantes
 * - Loading spinner mientras el padre procesa la confirmación
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const KPI_LABELS: Record<string, string> = {
  revenue:               "Revenue Total",
  ebitda:                "EBITDA",
  cogs:                  "Costo de Ventas",
  revenue_growth:        "Crecimiento Revenue",
  gross_profit_margin:   "Margen Bruto",
  ebitda_margin:         "Margen EBITDA",
  mrr:                   "MRR",
  churn_rate:            "Churn Rate",
  cac:                   "CAC",
  portfolio_size:        "Cartera de Créditos",
  npl_ratio:             "NPL Ratio",
  gmv:                   "GMV",
  loss_ratio:            "Loss Ratio",
  cash_in_bank_end_of_year: "Caja Final",
  annual_cash_flow:      "Flujo de Caja",
  working_capital_debt:  "Deuda Trabajo",
};

interface ConfirmSubmitButtonProps {
  isComplete:  boolean;
  missingKpis: string[];
  isLoading:   boolean;
  onClick:     () => void;
}

export default function ConfirmSubmitButton({
  isComplete,
  missingKpis,
  isLoading,
  onClick,
}: ConfirmSubmitButtonProps) {
  const disabled = !isComplete || isLoading;

  const button = (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-disabled={disabled}
      className="w-full py-4 rounded-xl font-cometa-regular text-sm tracking-[0.08em] transition-all duration-300"
      style={
        !disabled
          ? {
              background: "linear-gradient(135deg, #00237F 0%, #64CAE4 100%)",
              color:      "white",
              boxShadow:  "0 0 24px rgba(100,202,228,0.15)",
            }
          : {
              background: "rgba(255,255,255,0.04)",
              color:      "rgba(255,255,255,0.2)",
              cursor:     "not-allowed",
              opacity:    0.4,
            }
      }
    >
      {isLoading ? (
        <span className="inline-flex items-center justify-center gap-2">
          <span
            className="w-4 h-4 rounded-full border border-white/30 inline-block"
            style={{
              borderTopColor: "transparent",
              animation: "cometa-spin 0.9s linear infinite",
            }}
          />
          Guardando en Bóveda…
        </span>
      ) : (
        "Confirmar Envío"
      )}
    </button>
  );

  if (!isComplete && missingKpis.length > 0) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* wrapper div so Tooltip works on a disabled button */}
            <div className="w-full">{button}</div>
          </TooltipTrigger>
          <TooltipContent
            side="top"
            className="max-w-[220px] space-y-1 rounded-xl px-4 py-3 text-xs"
            style={{
              background: "rgba(10,10,18,0.95)",
              border:     "1px solid rgba(100,202,228,0.18)",
              color:      "rgba(255,255,255,0.6)",
            }}
          >
            <p className="font-cometa-regular text-white/70 mb-1.5">
              KPIs pendientes:
            </p>
            {missingKpis.map((k) => (
              <p key={k} className="font-cometa-extralight flex items-center gap-1.5">
                <span className="w-1 h-1 rounded-full bg-amber-400/60 inline-block flex-shrink-0" />
                Falta {KPI_LABELS[k] ?? k}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}
