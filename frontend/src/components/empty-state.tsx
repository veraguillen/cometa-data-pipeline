"use client";

import { CometaLogo } from "./cometa-logo";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  title?: string;
  description?: string;
  className?: string;
}

export function EmptyState({
  title = "Vault Synchronized",
  description = "No data available",
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-16",
        className
      )}
    >
      <div className="opacity-20">
        <CometaLogo size="lg" />
      </div>
      <h3 className="mt-6 text-lg font-light text-foreground/60">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
