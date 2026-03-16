"use client";

import "@/styles/cometa-branding.css";

interface CometaLoaderProps {
  message?: string;
  size?: "sm" | "md" | "lg";
  overlay?: boolean;
}

export default function CometaLoader({ 
  message = "Cargando datos...", 
  size = "md",
  overlay = false 
}: CometaLoaderProps) {
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-8 h-8", 
    lg: "w-12 h-12"
  };

  const textSizes = {
    sm: "text-sm",
    md: "text-base",
    lg: "text-lg"
  };

  const LoaderContent = () => (
    <div className="flex flex-col items-center gap-3">
      {/* Spinner COMETA */}
      <div className="relative">
        <div className={`${sizeClasses[size]} border-2 border-cometa-light-blue border-t-transparent rounded-full animate-spin`}></div>
        <div className={`absolute inset-0 ${sizeClasses[size]} border-2 border-transparent border-t-cometa-light-blue rounded-full animate-pulse`}></div>
      </div>
      
      {/* Mensaje con tipografía COMETA */}
      <div className="text-center">
        <p className={`font-cometa-extralight text-white/80 ${textSizes[size]}`}>
          {message}
        </p>
      </div>
    </div>
  );

  if (overlay) {
    return (
      <div className="fixed inset-0 cometa-black-bg/90 backdrop-blur-md flex items-center justify-center z-50">
        <div className="cometa-card p-8 max-w-sm w-full mx-4">
          <LoaderContent />
        </div>
      </div>
    );
  }

  return <LoaderContent />;
}
