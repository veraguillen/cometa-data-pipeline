"use client";

import { useState, useRef, useCallback, useEffect } from "react";

interface DataLoaderState {
  isLoading: boolean;
  error: string | null;
  data: any[] | null;
}

interface DataLoaderOptions {
  url: string;
  onSuccess?: (data: any) => void;
  onError?: (error: string) => void;
  retryCount?: number;
}

export function useDataLoader({ url, onSuccess, onError, retryCount = 3 }: DataLoaderOptions) {
  const [state, setState] = useState<DataLoaderState>({
    isLoading: false,
    error: null,
    data: null
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const isProcessingRef = useRef(false);

  const loadData = useCallback(async () => {
    // Regla de Oro: Prevenir carga duplicada
    if (isProcessingRef.current) {
      console.log("[DataLoader] Ya hay una carga en progreso, ignorando solicitud duplicada");
      return;
    }

    // Solo cancelar si hay una petición previa REALMENTE en progreso
    if (abortControllerRef.current && !abortControllerRef.current.signal.aborted) {
      console.log("[DataLoader] Cancelando petición previa...");
      abortControllerRef.current.abort();
    }

    // Crear nuevo AbortController
    abortControllerRef.current = new AbortController();
    isProcessingRef.current = true;

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      let attempt = 0;
      let lastError: Error | null = null;

      while (attempt < retryCount) {
        try {
          const response = await fetch(url, {
            signal: abortControllerRef.current.signal,
            method: "GET",
            headers: {
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Pragma": "no-cache",
              "Expires": "0",
            },
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const data = await response.json();
          
          setState({
            isLoading: false,
            error: null,
            data: data
          });

          onSuccess?.(data);
          console.log("[DataLoader] Datos cargados exitosamente:", data);
          return;

        } catch (error) {
          // No tratar como error si es una cancelación intencionada
          if (error instanceof Error && error.name === 'AbortError') {
            console.log("[DataLoader] Petición cancelada intencionadamente");
            return;
          }
          
          lastError = error as Error;
          attempt++;
          
          if (attempt < retryCount) {
            console.log(`[DataLoader] Intento ${attempt + 1} fallido, reintentando...`);
            // Esperar antes de reintentar (backoff exponencial)
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
          }
        }
      }

      // Si todos los intentos fallaron (y no fue por cancelación)
      if (lastError && !(lastError instanceof Error && lastError.name === 'AbortError')) {
        throw lastError;
      }

    } catch (error) {
      // No tratar como error si es una cancelación
      if (error instanceof Error && error.name === 'AbortError') {
        console.log("[DataLoader] Petición cancelada, no se muestra error");
        return;
      }

      const errorMessage = error instanceof Error ? error.message : "Error desconocido";
      
      setState({
        isLoading: false,
        error: errorMessage,
        data: null
      });

      onError?.(errorMessage);
      console.error("[DataLoader] Error en carga:", errorMessage);

    } finally {
      isProcessingRef.current = false;
      abortControllerRef.current = null;
    }
  }, [url, onSuccess, onError, retryCount]);

  // Limpiar al desmontar
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    isProcessingRef.current = false;
    setState({
      isLoading: false,
      error: null,
      data: null
    });
  }, []);

  return {
    ...state,
    loadData,
    reset,
    isProcessing: isProcessingRef.current
  };
}
