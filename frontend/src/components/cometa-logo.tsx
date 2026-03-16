"use client";

import { cn } from "@/lib/utils";

interface CometaLogoProps {
  className?: string;
  size?: "sm" | "md" | "lg";
  withGlow?: boolean;
}

export function CometaLogo({
  className,
  size = "md",
  withGlow = false,
}: CometaLogoProps) {
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-12 w-12",
    lg: "h-24 w-24",
  };

  return (
    <div
      className={cn(
        "relative flex items-center justify-center",
        sizeClasses[size],
        withGlow && "glow",
        className
      )}
    >
      <svg
        viewBox="0 0 100 100"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-full"
      >
        {/* Comet trail */}
        <defs>
          <linearGradient
            id="cometGradient"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
          >
            <stop offset="0%" stopColor="#64CAE4" stopOpacity="0" />
            <stop offset="50%" stopColor="#64CAE4" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#64CAE4" stopOpacity="1" />
          </linearGradient>
          <filter id="glow">
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Comet trail arc */}
        <path
          d="M15 85 Q 30 60, 50 50 Q 70 40, 85 15"
          stroke="url(#cometGradient)"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          filter="url(#glow)"
        />

        {/* Comet head */}
        <circle
          cx="85"
          cy="15"
          r="8"
          fill="#64CAE4"
          filter="url(#glow)"
          className="animate-pulse"
        />

        {/* Inner glow */}
        <circle cx="85" cy="15" r="4" fill="white" opacity="0.8" />

        {/* Secondary trail particles */}
        <circle cx="70" cy="30" r="2" fill="#64CAE4" opacity="0.6" />
        <circle cx="55" cy="42" r="1.5" fill="#64CAE4" opacity="0.4" />
        <circle cx="40" cy="54" r="1" fill="#64CAE4" opacity="0.3" />
      </svg>
    </div>
  );
}

export function CometaWordmark({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <CometaLogo size="md" withGlow />
      <span className="text-2xl font-light tracking-wider text-foreground">
        COMETA
      </span>
    </div>
  );
}
