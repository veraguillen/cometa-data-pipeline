"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";
import { Upload, FileText, X, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const ACCEPTED_TYPES = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [
    ".xlsx",
  ],
  "text/csv": [".csv"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
    ".docx",
  ],
  "application/octet-stream": [".parquet"],
};

const ACCEPTED_EXTENSIONS = [".pdf", ".xlsx", ".csv", ".docx", ".parquet"];

interface FileDropzoneProps {
  onFileSelect: (file: File) => void;
  isUploading?: boolean;
  uploadProgress?: number;
  uploadStatus?: "idle" | "uploading" | "success" | "error";
  errorMessage?: string;
  className?: string;
}

export function FileDropzone({
  onFileSelect,
  isUploading = false,
  uploadProgress = 0,
  uploadStatus = "idle",
  errorMessage,
  className,
}: FileDropzoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const validateFile = (file: File): boolean => {
    const extension = `.${file.name.split(".").pop()?.toLowerCase()}`;
    return ACCEPTED_EXTENSIONS.includes(extension);
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);

      const file = e.dataTransfer.files[0];
      if (file && validateFile(file)) {
        setSelectedFile(file);
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && validateFile(file)) {
        setSelectedFile(file);
        onFileSelect(file);
      }
    },
    [onFileSelect]
  );

  const clearFile = () => {
    setSelectedFile(null);
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className={cn("w-full", className)}>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "glass-card relative flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 transition-all duration-300",
          isDragOver && "border-primary bg-primary/5",
          uploadStatus === "success" && "border-confidence-high/50",
          uploadStatus === "error" && "border-destructive/50",
          !isDragOver &&
            uploadStatus === "idle" &&
            "border-border hover:border-primary/50"
        )}
      >
        {!selectedFile ? (
          <>
            <div
              className={cn(
                "mb-4 flex h-16 w-16 items-center justify-center rounded-full transition-colors",
                isDragOver ? "bg-primary/20 text-primary" : "bg-secondary/50 text-muted-foreground"
              )}
            >
              <Upload className="h-8 w-8" />
            </div>

            <h3 className="mb-2 text-lg font-light text-foreground">
              {isDragOver ? "Drop file here" : "Upload Financial Documents"}
            </h3>

            <p className="mb-4 text-center text-sm text-muted-foreground">
              Drag and drop or click to browse
            </p>

            <label>
              <input
                type="file"
                accept={ACCEPTED_EXTENSIONS.join(",")}
                onChange={handleFileInput}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                className="border-primary/50 text-primary hover:bg-primary/10"
                onClick={(e) => {
                  e.preventDefault();
                  (
                    e.currentTarget.previousElementSibling as HTMLInputElement
                  )?.click();
                }}
              >
                Select File
              </Button>
            </label>

            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {ACCEPTED_EXTENSIONS.map((ext) => (
                <span
                  key={ext}
                  className="rounded-md bg-secondary/50 px-2 py-1 text-xs text-muted-foreground"
                >
                  {ext.toUpperCase().replace(".", "")}
                </span>
              ))}
            </div>
          </>
        ) : (
          <div className="w-full">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileText className="h-6 w-6" />
              </div>

              <div className="flex-1 min-w-0">
                <p className="truncate font-medium text-foreground">
                  {selectedFile.name}
                </p>
                <p className="text-sm text-muted-foreground">
                  {formatFileSize(selectedFile.size)}
                </p>
              </div>

              {uploadStatus === "idle" && (
                <button
                  onClick={clearFile}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
                >
                  <X className="h-4 w-4" />
                </button>
              )}

              {uploadStatus === "success" && (
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-confidence-high/20 text-confidence-high">
                  <Check className="h-4 w-4" />
                </div>
              )}

              {uploadStatus === "error" && (
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/20 text-destructive">
                  <AlertCircle className="h-4 w-4" />
                </div>
              )}
            </div>

            {isUploading && (
              <div className="mt-4">
                <div className="mb-2 flex justify-between text-xs text-muted-foreground">
                  <span>Uploading...</span>
                  <span>{Math.round(uploadProgress)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {uploadStatus === "success" && (
              <p className="mt-4 text-center text-sm text-confidence-high">
                File uploaded successfully
              </p>
            )}

            {uploadStatus === "error" && errorMessage && (
              <p className="mt-4 text-center text-sm text-destructive">
                {errorMessage}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
