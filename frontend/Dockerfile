# ──────────────────────────────────────────────────────────────────────────────
# Stage 1: Instalar dependencias npm
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# ──────────────────────────────────────────────────────────────────────────────
# Stage 2: Build de Next.js (modo standalone)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Variables públicas de build (no contienen secrets)
ARG NEXT_PUBLIC_API_URL=https://cometa-backend-HASH-uc.a.run.app
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

# next.config.ts debe tener output: 'standalone' — ver nota al pie
RUN npm run build


# ──────────────────────────────────────────────────────────────────────────────
# Stage 3: Runtime mínimo (solo el output standalone de Next.js)
# ──────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Copiar solo lo necesario del build standalone
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Usuario no-root
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs
USER nextjs

EXPOSE 8080

CMD ["node", "server.js"]
