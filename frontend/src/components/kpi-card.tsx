"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Check, X, Pencil, ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { ReactNode, ElementType } from "react";

interface KPICardProps {
  title?: string;
  label?: string;
  value: string | number;
  confidence?: number;
  icon?: ReactNode | ElementType;
  editable?: boolean;
  onEdit?: (newValue: string) => void;
  className?: string;
  size?: "sm" | "md" | "lg";
  format?: "currency" | "percentage" | "number" | "multiplier";
  trend?: {
    value: number;
    direction: "up" | "down";
  };
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const getConfidenceLevel = () => {
    if (confidence >= 0.85) return "high";
    if (confidence >= 0.7) return "medium";
    return "low";
  };

  const level = getConfidenceLevel();

  const levelClasses = {
    high: "bg-confidence-high/20 text-confidence-high confidence-high",
    medium: "bg-confidence-medium/20 text-confidence-medium confidence-medium",
    low: "bg-confidence-low/20 text-confidence-low confidence-low",
  };

  const levelLabels = {
    high: "High",
    medium: "Med",
    low: "Low",
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        levelClasses[level]
      )}
    >
      <div
        className={cn("h-1.5 w-1.5 rounded-full", {
          "bg-confidence-high": level === "high",
          "bg-confidence-medium": level === "medium",
          "bg-confidence-low": level === "low",
        })}
      />
      {levelLabels[level]} {Math.round(confidence * 100)}%
    </div>
  );
}

function formatValue(value: string | number, format?: string): string {
  if (typeof value === "string") return value;
  
  switch (format) {
    case "currency":
      return new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "USD",
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(value);
    case "percentage":
      return `${value.toFixed(1)}%`;
    case "multiplier":
      return `${value.toFixed(2)}x`;
    default:
      return value.toLocaleString();
  }
}

export function KPICard({
  title,
  label,
  value,
  confidence,
  icon,
  editable = false,
  onEdit,
  className,
  size = "md",
  format,
  trend,
}: KPICardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value));
  const displayTitle = title || label;
  const displayValue = formatValue(value, format);

  const handleSave = () => {
    onEdit?.(editValue);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditValue(String(value));
    setIsEditing(false);
  };

  const sizeClasses = {
    sm: "p-4",
    md: "p-5",
    lg: "p-6",
  };

  const valueSizeClasses = {
    sm: "text-2xl",
    md: "text-3xl",
    lg: "text-4xl",
  };

  // Handle icon as either ReactNode or Component
  const renderIcon = () => {
    if (!icon) return null;
    // Check if it's a component (function or forwardRef object with $$typeof)
    if (typeof icon === "function" || (typeof icon === "object" && icon !== null && "$$typeof" in icon && "render" in icon)) {
      const IconComponent = icon as ElementType;
      return <IconComponent className="h-4 w-4" />;
    }
    return icon;
  };

  return (
    <div
      className={cn(
        "glass-card group relative rounded-xl transition-all duration-300 hover:border-primary/30",
        sizeClasses[size],
        editable && "cursor-pointer",
        className
      )}
      onClick={() => editable && !isEditing && setIsEditing(true)}
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {icon && (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {renderIcon()}
            </div>
          )}
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {displayTitle}
          </span>
        </div>

        {editable && !isEditing && (
          <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </div>

      {/* Value */}
      {isEditing ? (
        <div className="flex items-center gap-2">
          <Input
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="h-10 border-primary/50 bg-secondary/50 text-lg font-light"
            autoFocus
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleSave();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-confidence-high/20 text-confidence-high transition-colors hover:bg-confidence-high/30"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCancel();
            }}
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/20 text-destructive transition-colors hover:bg-destructive/30"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div
          className={cn(
            "kpi-value font-light text-foreground",
            valueSizeClasses[size]
          )}
        >
          {displayValue}
        </div>
      )}

      {/* Trend indicator */}
      {trend && !isEditing && (
        <div className="mt-3 flex items-center gap-1">
          {trend.direction === "up" ? (
            <ArrowUpRight className="h-4 w-4 text-green-400" />
          ) : (
            <ArrowDownRight className="h-4 w-4 text-red-400" />
          )}
          <span
            className={cn(
              "text-xs font-medium",
              trend.direction === "up" ? "text-green-400" : "text-red-400"
            )}
          >
            {trend.value}%
          </span>
        </div>
      )}

      {/* Confidence badge */}
      {confidence !== undefined && !isEditing && (
        <div className="mt-3">
          <ConfidenceBadge confidence={confidence} />
        </div>
      )}

      {/* Subtle glow effect on hover */}
      <div className="absolute inset-0 -z-10 rounded-xl bg-primary/5 opacity-0 blur-xl transition-opacity group-hover:opacity-100" />
    </div>
  );
}

// Skeleton loader for KPI cards
export function KPICardSkeleton() {
  return (
    <div className="glass-card animate-pulse rounded-xl p-5">
      <div className="mb-3 flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-white/10" />
        <div className="h-3 w-24 rounded bg-white/10" />
      </div>
      <div className="h-9 w-32 rounded bg-white/10" />
      <div className="mt-3 h-4 w-16 rounded bg-white/10" />
    </div>
  );
}

// Grid wrapper for KPI cards
export function KPIGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3",
        className
      )}
    >
      {children}
    </div>
  );
}
