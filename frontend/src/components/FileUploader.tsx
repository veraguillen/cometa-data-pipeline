"use client";

import { useState, useRef } from "react";
import "@/styles/cometa-branding.css";
import CometaLoader from "@/components/CometaLoader";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

interface FileUploaderProps {
  companyDomain: string;
  onUploadSuccess?: () => void;
  onUploadError?: (error: string) => void;
  onDuplicateDetected?: () => void;
}

export default function FileUploader({ companyDomain, onUploadSuccess, onUploadError, onDuplicateDetected }: FileUploaderProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const file = event.target.files?.[0];
    if (!file || isUploading) return;

    // Cancelar subida previa si existe
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Crear nuevo AbortController
    abortControllerRef.current = new AbortController();
    setIsUploading(true);
    setUploadedFile(file);
    setUploadProgress(0);

    try {
      // Crear FormData para la subida
      const formData = new FormData();
      formData.append('file', file);
      formData.append('founder_email', 'test@startup.com');
      
      // No enviar company_id aquí, el backend lo extrae del email

      // Subir archivo al backend
      const xhr = new XMLHttpRequest();
      
      // Configurar XHR con AbortController
      if (abortControllerRef.current) {
        (xhr as any).signal = abortControllerRef.current.signal;
      }

      // Configurar evento de progreso
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) {
          const progress = Math.round((event.loaded / event.total) * 100);
          setUploadProgress(progress);
          console.log(`[FileUploader] Progreso de subida: ${progress}%`);
        }
      });

      // Configurar eventos
      xhr.open('POST', `${API_BASE}/upload`, true);
      
      // Enviar headers personalizados
      xhr.setRequestHeader('founder-email', 'test@startup.com');
      xhr.setRequestHeader('company-id', companyDomain);
      
      console.log('[FileUploader] Enviando FormData:', {
        'founder-email': 'test@startup.com',
        'company-id': companyDomain,
        'file': file.name
      });
      
      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            const response = JSON.parse(xhr.responseText);
            console.log('[FileUploader] Respuesta exitosa del backend:', response);
            
            if (response.status === 'success') {
              if (response.duplicate) {
                // Duplicado detectado - mostrar mensaje específico
                console.log('[FileUploader] Duplicado detectado:', response.message);
                setUploadedFile(file);
                setUploadProgress(100);
                
                setTimeout(() => {
                  setIsUploading(false);
                  setUploadedFile(null);
                  setUploadProgress(0);
                  onDuplicateDetected?.();
                }, 1000);
              } else {
                // Subida exitosa normal
                console.log('[FileUploader] Archivo subido exitosamente:', file.name);
                setUploadedFile(file);
                setUploadProgress(100);
                
                setTimeout(() => {
                  setIsUploading(false);
                  setUploadedFile(null);
                  setUploadProgress(0);
                  onUploadSuccess?.();
                }, 1000);
              }
            }
          } catch (error) {
            console.error('[FileUploader] Error parseando respuesta:', error);
            throw new Error('Error en la respuesta del servidor');
          }
        } else {
          throw new Error(`Error ${xhr.status}: ${xhr.statusText}`);
        }
      };

      xhr.onerror = () => {
        throw new Error('Error de red al subir archivo');
      };

      xhr.onabort = () => {
        console.log('[FileUploader] Subida cancelada');
        setIsUploading(false);
        setUploadedFile(null);
        setUploadProgress(0);
      };

      // Enviar FormData
      xhr.send(formData);

    } catch (error) {
      console.error('[FileUploader] Error en subida:', error);
      setIsUploading(false);
      setUploadedFile(null);
      setUploadProgress(0);
      onUploadError?.(error instanceof Error ? error.message : 'Error desconocido');
    } finally {
      abortControllerRef.current = null;
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const file = event.dataTransfer.files?.[0];
    if (!file || isUploading) return;

    // Crear un evento de cambio sintético para el input
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    
    const syntheticEvent = {
      target: { files: dataTransfer.files }
    } as React.ChangeEvent<HTMLInputElement>;

    handleFileUpload(syntheticEvent);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const cancelUpload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsUploading(false);
    setUploadedFile(null);
    setUploadProgress(0);
  };

  return (
    <div className="cometa-card">
      <div className="text-center">
        <h2 className="font-cometa-regular text-white text-2xl mb-6">
          {isUploading ? 'Subiendo Archivo' : 'Subir Análisis Financiero'}
        </h2>
        <p className="font-cometa-extralight text-white/70 mb-8">
          {companyDomain} • {isUploading ? 'Procesando tu archivo...' : 'Arrastra tu archivo PDF aquí'}
        </p>
        
        {/* Área de Drag & Drop */}
        <div
          className={`relative border-2 border-dashed rounded-xl p-8 transition-all duration-300 ${
            isUploading 
              ? 'border-gray-600 bg-gray-900/20' 
              : 'border-cometa-light-blue/50 bg-cometa-subtle-gradient hover:border-cometa-light-blue hover:bg-cometa-subtle-gradient'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.xlsx,.csv"
            onChange={handleFileUpload}
            disabled={isUploading}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
          />
          
          <div className="text-center">
            {uploadedFile ? (
              <div className="flex items-center justify-center gap-3">
                <div className="text-green-400 text-2xl">📄</div>
                <div>
                  <div className="font-cometa-regular text-white">{uploadedFile.name}</div>
                  <div className="font-cometa-extralight text-white/60 text-sm">
                    {uploadProgress > 0 && uploadProgress < 100 
                      ? `Subiendo... ${uploadProgress}%` 
                      : 'Procesando archivo...'
                    }
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div className={`text-4xl mb-4 ${isUploading ? 'animate-pulse' : ''}`}>
                  {isUploading ? '⏳' : '📄'}
                </div>
                <div>
                  <div className="font-cometa-regular mb-1">
                    {isUploading ? 'Subiendo...' : 'Selecciona o arrastra archivo'}
                  </div>
                  <div className="font-cometa-extralight text-white/60 text-sm">
                    Formatos soportados: PDF, XLSX, CSV
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Barra de progreso */}
          {isUploading && uploadProgress > 0 && (
            <div className="mt-4">
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-cometa-light-blue to-cometa-cyan transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <div className="text-center mt-2">
                <span className="font-cometa-extralight text-white/70 text-sm">
                  {uploadProgress}% completado
                </span>
              </div>
            </div>
          )}

          {/* Botón de cancelar */}
          {isUploading && (
            <div className="mt-4">
              <button
                onClick={cancelUpload}
                className="cometa-btn-secondary text-sm"
              >
                Cancelar Subida
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
