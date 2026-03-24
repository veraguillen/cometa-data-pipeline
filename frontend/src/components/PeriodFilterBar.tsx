"use client";

import type { PeriodFilterState } from "@/hooks/usePeriodFilter";

const FALLBACK_YEARS = [2022, 2023, 2024, 2025, 2026];

const QUARTERS: Array<{ value: string; label: string }> = [
  { value: "Q1", label: "Q1" },
  { value: "Q2", label: "Q2" },
  { value: "Q3", label: "Q3" },
  { value: "Q4", label: "Q4" },
];


interface PeriodFilterBarProps {
  filter:         PeriodFilterState;
  onYear:         (year: number | null) => void;
  onPeriod:       (period: string | null) => void;
  onReset:        () => void;
  /** Years derived from the loaded dataset. Falls back to a static list when absent. */
  availableYears?: number[];
}

export default function PeriodFilterBar({
  filter,
  onYear,
  onPeriod,
  onReset,
  availableYears,
}: PeriodFilterBarProps) {
  const { selectedYear, selectedPeriod } = filter;
  const years = availableYears && availableYears.length > 0 ? availableYears : FALLBACK_YEARS;
  const periodOptions = QUARTERS;

  return (
    <div className="flex items-center gap-2 flex-wrap">

      {/* Year pills */}
      <div className="flex gap-1">
        {years.map((y) => {
          const active = selectedYear === y;
          return (
            <button
              key={y}
              onClick={() => onYear(active ? null : y)}
              className="px-2.5 py-1 rounded-md text-[10px] transition-all duration-150"
              style={{
                fontWeight:  active ? 500 : 400,
                color:       active ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
                background:  active ? "var(--cometa-accent)" : "transparent",
                border:      `1px solid ${active ? "var(--cometa-accent)" : "transparent"}`,
              }}
            >
              {y}
            </button>
          );
        })}
      </div>

      {/* Divider */}
      {selectedYear !== null && (
        <div
          className="w-px h-4 shrink-0"
          style={{ background: "var(--cometa-card-border)" }}
        />
      )}

      {/* Period pills — visible only when year selected */}
      {selectedYear !== null && (
        <div className="flex gap-1 flex-wrap">
          {periodOptions.map(({ value, label }) => {
            const active = selectedPeriod === value;
            return (
              <button
                key={value}
                onClick={() => onPeriod(active ? null : value)}
                className="px-2.5 py-1 rounded-md text-[10px] transition-all duration-150"
                style={{
                  fontWeight:  active ? 500 : 400,
                  color:       active ? "var(--cometa-accent-fg)" : "var(--cometa-fg-muted)",
                  background:  active ? "var(--cometa-accent)" : "transparent",
                  border:      `1px solid ${active ? "var(--cometa-accent)" : "transparent"}`,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* Reset — only when active */}
      {selectedYear !== null && (
        <button
          onClick={onReset}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] transition-colors"
          style={{ color: "var(--cometa-fg-muted)" }}
          title="Limpiar filtro"
        >
          <svg width="7" height="7" viewBox="0 0 10 10" fill="none">
            <path
              d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          Limpiar
        </button>
      )}
    </div>
  );
}
