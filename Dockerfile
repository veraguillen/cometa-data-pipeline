# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Build — instala dependencias en un entorno aislado
# ──────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# Dependencias de sistema necesarias para compilar paquetes con extensiones C
# (cryptography, grpcio) y para PyMuPDF en tiempo de instalación
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        libffi-dev \
        libssl-dev \
        gcc \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Runtime — imagen mínima de producción
# ──────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

WORKDIR /app

# Librerías de sistema requeridas en RUNTIME por PyMuPDF y grpcio
# (las de compilación quedan fuera → imagen más pequeña)
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 \
        libgomp1 \
        libgl1 \
        libfontconfig1 \
    && rm -rf /var/lib/apt/lists/*

# Copiar dependencias Python desde el builder
COPY --from=builder /install /usr/local

# Copiar código fuente
COPY src/       ./src/
COPY assets/    ./assets/

# Cloud Run exige el puerto 8080
ENV PORT=8080
EXPOSE 8080

# Usuario no-root por seguridad
RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# 2 workers Uvicorn por instancia. Cloud Run escala instancias según demanda.
# Para PDF chunking (CPU intensivo) la concurrencia por instancia se limita
# al nivel Cloud Run (--concurrency 10-20).
CMD ["uvicorn", "src.api:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "2", \
     "--timeout-keep-alive", "75"]
