# Cometa Vault — Guía de UI/UX

**Última actualización:** 2026-03-22

---

## Sistema de Temas

Cometa Vault usa 4 temas visuales definidos como CSS custom properties en `frontend/src/globals.css`. El cambio de tema es un cambio del atributo `data-theme` en el elemento `<html>` — cero re-renders de React, sin recarga de página.

### Los 4 temas

| Tema | `data-theme` | Fondo | Acento | Uso |
|------|-------------|-------|--------|-----|
| **Pearl & Emerald** | `pearl` | `#FFFFFF` | `#00A86B` | Dashboard analista · Portal founder |
| **Obsidiana & Steel** | `obsidian` | `#000000` | `#64CAE4` | Login · Entrada premium |
| **Ivory & Slate** | `slate` | `#F4F1EB` | `#ECE5BC` | Alternativa banca privada |
| **Deep Umber & Gold** | `umber` | `#1A0F07` | `#ECE5BC` | Alternativa premium oscuro |

### Variables CSS por tema

Cada tema define el mismo conjunto de custom properties:

```css
--cometa-bg            /* Color de fondo principal */
--cometa-bg-gradient   /* Gradiente de fondo (160deg) */
--cometa-fg            /* Color de texto principal */
--cometa-fg-muted      /* Texto secundario / labels / metadatos */
--cometa-card-bg       /* Fondo de tarjetas y paneles */
--cometa-card-border   /* Borde de tarjetas */
--cometa-accent        /* Color de acento (botones CTA, highlights) */
--cometa-accent-fg     /* Texto sobre fondo de acento */
--cometa-dark-blue     /* Color complementario oscuro */
```

### Clases de utilidad temáticas

```css
.theme-card      /* Aplica card-bg + card-border + backdrop-filter */
.theme-fg        /* color: var(--cometa-fg) */
.theme-fg-muted  /* color: var(--cometa-fg-muted) */
.theme-accent    /* color: var(--cometa-accent) */
.kpi-card        /* Tarjeta KPI con hover glow del acento */
.glass           /* Glassmorphism con rgba(255,255,255,0.04) */
.glass-card      /* Glassmorphism más sutil */
```

---

## Routing Automático de Temas

El sistema aplica el tema correcto automáticamente según la ruta, sin que el usuario tenga que configurar nada.

```
/login          → ResetTheme()              → data-theme="obsidian"
/analyst/*      → ThemeProvider             → localStorage ?? "pearl"
/founder/*      → ResetTheme theme="pearl"  → data-theme="pearl"
/success        → ResetTheme theme="pearl"  → data-theme="pearl"
```

### Cómo funciona cada mecanismo

#### 1. SSR default — `layout.tsx`

```tsx
// Root layout — SSR
<html lang="es" data-theme="obsidian">
```

El servidor renderiza todas las páginas con `data-theme="obsidian"` como punto de partida. Esto evita el flash de tema incorrecto en rutas públicas (login, landing).

#### 2. `ResetTheme` — rutas públicas y founder

Componente de efecto puro. Se monta en el cliente y sobreescribe el atributo:

```tsx
// Uso en rutas públicas (tema por defecto: obsidian)
<ResetTheme />

// Uso en rutas privadas founder (fuerza pearl)
<ResetTheme theme="pearl" />
```

Internamente:
1. Elimina el elemento `<style id="cometa-theme-vars">` inyectado por `ThemeContext` (si existe)
2. Ejecuta `document.documentElement.setAttribute("data-theme", theme)`

#### 3. `ThemeProvider` — rutas de analista

Contexto React que permite al analista cambiar de tema manualmente. Lee `localStorage` para persistir la preferencia entre sesiones.

```tsx
// En /analyst/layout.tsx
<ThemeProvider>
  {children}
</ThemeProvider>
```

Si no hay preferencia guardada en localStorage, usa `"pearl"` como default.

El analista puede cambiar de tema con el componente `ThemeSwitcher` visible en el header del dashboard.

### Flujo de resolución de tema en el cliente

```
SSR: data-theme="obsidian"
        │
        ▼ Hidratación React
   ¿Ruta /analyst/*?
        │ Sí → ThemeProvider lee localStorage
        │       └─ ¿Tiene preferencia? → aplica tema guardado
        │          ¿Sin preferencia?   → aplica "pearl"
        │
        │ No → ¿Tiene <ResetTheme theme="pearl">?
                  │ Sí → setAttribute("data-theme", "pearl")
                  │ No → <ResetTheme /> sola → setAttribute("data-theme", "obsidian")
```

---

## Tipografía

### Fuentes

| Función | Fuente | `font-weight` | Contexto |
|---------|--------|:---:|---------|
| Cuerpo y lectura | Helvetica Now Display → Inter (fallback) | `400` | Párrafos, labels, nav |
| Títulos y KPIs | Helvetica Now Display → Inter (fallback) | `100` (Extra Light) | `h1`–`h6`, KPI values |
| Código | JetBrains Mono | `400` | Terminal IA, valores técnicos |

```css
--font-sans: "Helvetica Now Display", "Helvetica Neue", Helvetica, Inter, Arial, sans-serif;
--font-mono: "JetBrains Mono", "Geist Mono", monospace;
```

### Tamaños base por tema

| Tema | Tamaño base | Motivo |
|------|:----------:|--------|
| Pearl & Emerald (dashboard analista) | `18px` | Mayor densidad de datos, legibilidad institucional |
| Obsidiana & Steel (login/landing) | `16px` | Pantalla de entrada, impacto visual sobre lectura |

### Clases tipográficas específicas

```css
.kpi-value          /* font-variant-numeric: tabular-nums; letter-spacing: -0.03em; font-weight: 100 */
.font-cometa-thin   /* font-weight: 100 — KPI numbers y page titles */
.font-cometa-extralight /* font-weight: 200 — PeriodFilterBar labels */
```

---

## Portfolio Coverage Heatmap — Semántica de Color

El heatmap en la pestaña "Cobertura" del analyst dashboard usa tres estados visuales para representar la calidad de los datos por empresa × período.

### Estados de celda

| Estado | Color | Animación | Significado |
|--------|-------|-----------|-------------|
| **Verified** | Acento del tema activo | — | Al menos un KPI confirmado por analista |
| **Legacy** | Ámbar `#F59E0B` | — | Solo KPIs extraídos por IA (sin revisión) |
| **Missing** | Rojo `#EF4444` | `cometa-pulse` | Sin datos para ese período |

### Animación `cometa-pulse`

Las celdas `Missing` pulsan suavemente para llamar la atención del analista:

```css
@keyframes cometa-pulse {
  0%, 100% { opacity: 1;    box-shadow: 0 0 0 0 rgba(239,68,68,0); }
  50%       { opacity: 0.8; box-shadow: 0 0 0 4px rgba(239,68,68,0.18); }
}
```

### Comportamiento por tema

El acento de las celdas `Verified` cambia con el tema activo:

| Tema | Color de celda Verified |
|------|------------------------|
| Pearl & Emerald | `#00A86B` (verde esmeralda) |
| Obsidiana & Steel | `#64CAE4` (azul steel) |
| Ivory & Slate | `#ECE5BC` (dorado marfil) |
| Deep Umber & Gold | `#ECE5BC` (dorado) |

### Tooltip

Al hacer hover sobre cualquier celda, se muestra un tooltip con el desglose exacto:

```
Empresa — Q1 2025
─────────────────
✓ Verified   3
◈ Legacy     5
Total KPIs   8
```

### Navegación

Un clic en cualquier celda navega al dashboard de esa empresa en ese período:

```typescript
router.push(`/analyst/dashboard?company_id=${company}`)
```

---

## Componentes de Layout

### `AppHeader`

Header fijo del analyst dashboard. Contiene:
- Logo Cometa
- Selector de empresa (`CompanySwitcher`)
- `ThemeSwitcher` (selector de 4 temas)
- Botón de logout

### `AnalystSidebar`

Navegación lateral con acceso a las secciones principales. Oculta en mobile.

### Estructura de pestañas del analyst dashboard

```
[Dashboard]  [Reportes]  [Cobertura]
      │             │           │
   BentoGrid   Historial   PortfolioHeatmap
   BentoCharts  de cargas
   AITerminal
```

La pestaña activa se controla por estado local `activeTab`. El `PeriodFilterBar` se oculta cuando `activeTab === "coverage"` (el heatmap tiene su propio control de tiempo implícito).

---

## Transiciones de Tema

Las transiciones entre temas son suaves (500ms) para evitar saltos bruscos:

```css
body {
  transition:
    background-color 500ms ease,
    background       500ms ease,
    color            500ms ease;
}

.theme-card, .glass, .kpi-card, .theme-fg, .theme-accent, ... {
  transition:
    background-color 500ms ease,
    color            500ms ease,
    border-color     500ms ease,
    box-shadow       500ms ease;
}
```

La transición es **property-specific** (no `transition: all`) para evitar interferir con animaciones de Framer Motion que controlan `transform` y `opacity` directamente.

---

## Patrones de Estado de Carga

| Patrón | Componente | Implementación |
|--------|-----------|----------------|
| Skeleton cards | BentoGrid | Divs con `animate-pulse` de Tailwind |
| Skeleton grid | PortfolioHeatmap | Grid de celdas grises con `animate-pulse` |
| Error state | Todos | Card roja con mensaje y botón de reintento |
| Empty state | PortfolioHeatmap | Icono + mensaje "Sin datos de cobertura" |
| Loading spinner | Upload panel | `cometa-spin` keyframe (360deg rotate) |

---

## Scrollbar Personalizada

La scrollbar refleja el tema activo via `color-mix`:

```css
::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--cometa-accent) 25%, transparent);
}
::-webkit-scrollbar-thumb:hover {
  background: color-mix(in srgb, var(--cometa-accent) 45%, transparent);
}
```

Esto garantiza que la scrollbar siempre combine con el acento del tema, sin valores hardcodeados.

---

*Cometa Vault — Guía UI/UX · 2026*
