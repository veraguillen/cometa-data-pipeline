import sys, io
if sys.stdout.encoding != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
if sys.stderr.encoding != "utf-8":
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

from fastapi import FastAPI, UploadFile, File, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, model_validator
import os
import hashlib
import json
import traceback
from google.cloud import storage
from google.auth.exceptions import DefaultCredentialsError
from google.api_core.exceptions import Forbidden, Unauthorized
from google.oauth2 import service_account
from src.adapters.google_cloud import GeminiAuditor
from src.adapters.document_ai import DocumentAIAdapter
from src.core.data_contract import build_contract
from src.core.db_writer import (
    insert_contract, ensure_schema, update_kpi_value,
    lookup_portfolio, detect_company_from_text, PORTFOLIO_MAP,
    query_portfolio_analytics, run_audit_query, audit_contract,
    run_fidelity_audit, COMPANY_BUCKET,
)
from src.core.data_contract import build_checklist_status, KPI_REGISTRY
import pandas as pd

app = FastAPI(title="Cometa Pipeline API", version="1.0.0")


@app.on_event("startup")
async def _startup():
    """Bootstrap BigQuery tables once at server start."""
    import asyncio
    print("🚀 [Startup] Servidor iniciando — intentando bootstrap de BigQuery...")
    try:
        # ensure_schema() hace I/O bloqueante (BigQuery). Lo corremos en un
        # thread con timeout de 15 s para que el servidor nunca quede zombi
        # si GCP no responde (ej. error 403 o red no disponible).
        await asyncio.wait_for(
            asyncio.get_event_loop().run_in_executor(None, ensure_schema),
            timeout=15.0
        )
        print("✅ [Startup] BigQuery schema OK")
    except asyncio.TimeoutError:
        print("⚠️  [Startup] BigQuery schema bootstrap TIMEOUT (15 s) — servidor listo sin BQ")
    except Exception as e:
        # Non-fatal: if BQ is unreachable the upload still works via GCS.
        print(f"⚠️  [Startup] BigQuery schema bootstrap falló (non-fatal): {e}")
    print("✅ [Startup] Servidor listo para recibir archivos en :8000")

cors_origins_raw = os.getenv("CORS_ORIGINS", "[\"http://localhost:3000\"]")
try:
    cors_origins = json.loads(cors_origins_raw)
    if not isinstance(cors_origins, list):
        cors_origins = ["http://localhost:3000"]
except Exception:
    cors_origins = ["http://localhost:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rutas de archivos estáticos ───────────────────────────────────────────────
# BASE_DIR apunta a la raíz del proyecto (/app en Cloud Run) sin importar
# desde qué directorio se invoque uvicorn. Evita problemas con rutas relativas.
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_assets_dir = os.path.join(BASE_DIR, "assets")
if os.path.isdir(_assets_dir):
    app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

@app.get("/", include_in_schema=False)
async def root():
    return {"status": "online", "message": "Cometa API v1"}

# Configuración
PROJECT_ID = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")
LOCATION_DOC_AI = os.getenv("DOCUMENT_AI_LOCATION", "us")
PROCESSOR_ID = os.getenv("DOCUMENT_AI_PROCESSOR_ID", "c5e1adfde68e63cf")
VERTEX_LOCATION = os.getenv("VERTEX_AI_LOCATION", "us-central1")
GCS_INPUT_BUCKET = os.getenv("GCS_INPUT_BUCKET", "ingesta-financiera-raw-cometa-mvp")
GCS_OUTPUT_BUCKET = os.getenv("GCS_OUTPUT_BUCKET", "ingesta-financiera-raw-cometa-mvp")

def _resolve_service_account_path() -> str | None:
    env_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if env_path:
        return env_path
    # Fallback al JSON en raíz del repo
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    fallback = os.path.join(repo_root, "cometa_key.json")
    return fallback if os.path.exists(fallback) else None

def _parse_sa_json(raw: str, tag: str = "") -> dict:
    """
    Parsea el JSON de una service account desde una variable de entorno,
    tolerando: espacios/newlines extra y doble-serialización (string dentro de string).
    Lanza ValueError con diagnóstico si el resultado no tiene los campos requeridos.
    """
    raw = raw.strip()
    parsed = json.loads(raw)
    # Doble-serialización: el valor del secreto era una cadena JSON (string de string)
    if isinstance(parsed, str):
        print(f"⚠️  {tag} GCP_SERVICE_ACCOUNT_JSON estaba doblemente serializado — decodificando de nuevo")
        parsed = json.loads(parsed)
    if not isinstance(parsed, dict):
        raise ValueError(f"{tag} GCP_SERVICE_ACCOUNT_JSON no es un objeto JSON válido (tipo: {type(parsed).__name__})")
    required = {"type", "project_id", "private_key", "client_email"}
    missing = required - parsed.keys()
    if missing:
        raise ValueError(
            f"{tag} GCP_SERVICE_ACCOUNT_JSON le faltan campos: {missing}. "
            f"Claves presentes: {list(parsed.keys())}"
        )
    print(f"✅  {tag} Service account JSON OK — client_email: {parsed.get('client_email')}")
    return parsed


def _load_gcp_credentials():
    # ── Prioridad 1: GCP_SERVICE_ACCOUNT_JSON (Cloud Run + Secret Manager) ──────
    # El JSON completo se inyecta como variable de entorno desde Secret Manager.
    # No requiere archivo físico — compatible con contenedores inmutables.
    sa_json_str = os.getenv("GCP_SERVICE_ACCOUNT_JSON")
    if sa_json_str:
        print("🔐 [GCP] Usando GCP_SERVICE_ACCOUNT_JSON (Secret Manager)")
        sa_info = _parse_sa_json(sa_json_str, "[GCP]")
        creds = service_account.Credentials.from_service_account_info(sa_info)
        creds_project = getattr(creds, "project_id", None)
        if creds_project and creds_project != PROJECT_ID:
            print(f"⚠️  [GCP] project_id del JSON ({creds_project}) != PROJECT_ID ({PROJECT_ID})")
        return creds

    # ── Prioridad 2: GOOGLE_APPLICATION_CREDENTIALS (archivo, dev local) ────────
    sa_path = _resolve_service_account_path()
    if not sa_path:
        raise DefaultCredentialsError(
            "No se encontró GCP_SERVICE_ACCOUNT_JSON ni GOOGLE_APPLICATION_CREDENTIALS "
            "y no existe cometa_key.json en la raíz"
        )
    if not os.path.isabs(sa_path):
        sa_path = os.path.abspath(sa_path)

    print(f"🔐 [GCP] Usando Service Account JSON: {sa_path}")
    if not os.path.exists(sa_path):
        raise DefaultCredentialsError(f"Service Account JSON no existe en: {sa_path}")

    creds = service_account.Credentials.from_service_account_file(sa_path)
    creds_project = getattr(creds, "project_id", None)
    if creds_project and creds_project != PROJECT_ID:
        print(
            f"⚠️  [GCP] project_id del JSON ({creds_project}) no coincide con PROJECT_ID ({PROJECT_ID})"
        )
    return creds

def _get_storage_client() -> storage.Client:
    """Crea un Storage client usando credenciales explícitas cuando es posible."""
    try:
        creds = _load_gcp_credentials()
        return storage.Client(project=PROJECT_ID, credentials=creds)
    except Exception as e:
        print(f"❌ [GCP] No se pudieron cargar credenciales explícitas: {e}")
        # Intentar fallback a ADC (podría funcionar en Cloud Run/GCE)
        return storage.Client(project=PROJECT_ID)

def get_file_hash(file_content: bytes) -> str:
    """Genera hash SHA-256 del contenido del archivo"""
    return hashlib.sha256(file_content).hexdigest()[:16]


def _is_financial_document(resultado: dict) -> bool:
    """
    Devuelve True si Gemini extrajo al menos 1 KPI financiero con valor real.
    Cualquiera de estos campos con un valor no-nulo califica el documento.
    Usado como gate antes de persistir en GCS / BigQuery.
    """
    fm = resultado.get("financial_metrics_2025")
    if not fm or not isinstance(fm, dict):
        return False

    # Rutas a los KPIs "core" — basta con que uno sea no-nulo
    _SENTINEL = {"", "null", "n/a", "--", "0", "none"}
    core_paths = [
        ["revenue_growth", "value"],
        ["base_metrics", "revenue", "value"],
        ["base_metrics", "ebitda", "value"],
        ["profit_margins", "gross_profit_margin", "value"],
        ["profit_margins", "ebitda_margin", "value"],
        ["cash_flow_indicators", "cash_in_bank_end_of_year", "value"],
        ["cash_flow_indicators", "annual_cash_flow", "value"],
        ["debt_ratios", "working_capital_debt", "value"],
        ["sector_metrics", "mrr", "value"],
        ["sector_metrics", "gmv", "value"],
        ["sector_metrics", "portfolio_size", "value"],
        ["sector_metrics", "loss_ratio", "value"],
    ]
    for path in core_paths:
        node = fm
        for key in path:
            if not isinstance(node, dict):
                node = None
                break
            node = node.get(key)
        if node is not None and str(node).strip().lower() not in _SENTINEL:
            return True
    return False

# ── Multi-format processing helpers ──────────────────────────────────────────

# Maximum rows rendered per sheet to stay within Gemini's token budget.
# 500 rows ≈ 40–80 KB of Markdown — well within the 1 M-token context window.
_MAX_ROWS_PER_SHEET = 500


def _df_to_markdown(df: pd.DataFrame) -> str:
    """
    Convert a DataFrame to a GitHub-flavored Markdown table.
    No external dependencies (no tabulate required).
    """
    if df.empty:
        return "*(tabla vacía)*"

    # Stringify column names
    cols = [str(c).strip() for c in df.columns]
    header    = "| " + " | ".join(cols) + " |"
    separator = "| " + " | ".join(["---"] * len(cols)) + " |"

    rows = []
    for _, row in df.iterrows():
        cells = [
            str(v).replace("|", "\\|").strip() if pd.notna(v) else ""
            for v in row
        ]
        rows.append("| " + " | ".join(cells) + " |")

    return "\n".join([header, separator] + rows)


def _process_tabular(file_path: str, ext: str, gemini, prompt_schema: str) -> str:
    """
    Read ALL sheets from CSV / XLSX / PARQUET, convert each to Markdown,
    then call Gemini with the identical financial-audit prompt used for PDFs.

    Changes vs. previous implementation:
    - XLSX: reads every sheet (sheet_name=None), not just the first one.
    - Row cap raised to _MAX_ROWS_PER_SHEET (500) per sheet.
    - Output format: GitHub-flavored Markdown tables (better structure preservation).
    - Prompt: uses the full FASE 1 + FASE 2 schema (same as PDF pipeline).
    """
    print(f"📊 [Tabular] Leyendo archivo {ext} (todas las hojas)...")

    try:
        sheets: dict = {}

        if ext == ".csv":
            df = pd.read_csv(file_path, nrows=_MAX_ROWS_PER_SHEET)
            sheets["Hoja1"] = df

        elif ext in (".xlsx", ".xls"):
            # sheet_name=None → devuelve un dict {nombre: DataFrame}
            all_sheets = pd.read_excel(
                file_path, sheet_name=None, engine="openpyxl"
            )
            for name, df in all_sheets.items():
                sheets[str(name)] = df.head(_MAX_ROWS_PER_SHEET)

        elif ext == ".parquet":
            df = pd.read_parquet(file_path).head(_MAX_ROWS_PER_SHEET)
            sheets["Hoja1"] = df

        else:
            raise ValueError(f"Extensión tabular no reconocida: {ext}")

    except Exception as e:
        print(f"❌ [Tabular] Error leyendo archivo: {e}")
        raise RuntimeError(f"No se pudo leer el archivo {ext}: {e}") from e

    _sheet_keys = list(sheets.keys())
    print(f"   Pestañas encontradas: {_sheet_keys}")

    # ── Build Markdown content (one section per sheet) ────────────────────
    md_sections = []
    for sheet_name, df in sheets.items():
        # Drop columns that are 100 % null — they add noise, no signal
        df = df.dropna(axis=1, how="all")
        _n_rows = df.shape[0]
        _n_cols = df.shape[1]
        print(f"   Hoja '{sheet_name}': {_n_rows} filas × {_n_cols} columnas")
        md = _df_to_markdown(df)
        md_sections.append(f"## Pestaña: {sheet_name}\n\n{md}")

    full_markdown = "\n\n---\n\n".join(md_sections)
    _md_len      = len(full_markdown)
    _sheet_count = len(sheets)
    print(f"   Markdown generado: {_md_len:,} caracteres, {_sheet_count} pestaña(s)")

    # ── Prompt: same FASE 1 + FASE 2 schema as the PDF pipeline ─────────
    # Prepend a short adapter note so Gemini knows the source is a spreadsheet,
    # then inject the full audit schema unchanged.
    _ext_upper   = ext.upper()
    _n_sheets    = len(sheets)
    adapter_header = (
        f"Eres un auditor financiero senior especializado en due diligence de startups.\n"
        f"Recibes el contenido completo de un archivo {_ext_upper} con "
        f"{_n_sheets} pestaña(s), convertido a tablas Markdown.\n"
        f"Analiza TODAS las pestañas para localizar las métricas financieras.\n"
        f"Cuando una métrica aparezca en varias hojas, usa la fuente más reciente o la más detallada.\n"
        f"Si los valores están en términos absolutos y tienes los ingresos, calcula los márgenes (%).\n"
        f"Para Revenue Growth YoY: (valor_último - valor_anterior) / |valor_anterior| × 100.\n\n"
        f"Aplica las siguientes instrucciones de extracción EXACTAMENTE:\n\n"
    )
    full_prompt = adapter_header + prompt_schema

    # Pass the prompt as first arg and the Markdown content as second —
    # analizar_texto calls generate_content([prompt, contenido_texto]).
    return gemini.analizar_texto(full_prompt, full_markdown)


def _process_docx(file_path: str, gemini, prompt_schema: str) -> str:
    """Extract text from DOCX and send to Gemini with the financial audit prompt."""
    print(f"📝 [DOCX] Extrayendo texto...")
    try:
        from docx import Document as DocxDocument
        doc = DocxDocument(file_path)
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        # Also extract tables
        table_texts = []
        for table in doc.tables:
            for row in table.rows:
                row_text = " | ".join(cell.text.strip() for cell in row.cells if cell.text.strip())
                if row_text:
                    table_texts.append(row_text)
        full_text = "\n".join(paragraphs)
        if table_texts:
            full_text += "\n\nTABLAS DEL DOCUMENTO:\n" + "\n".join(table_texts)
    except ImportError:
        raise RuntimeError("python-docx no está instalado. Ejecuta: pip install python-docx")
    except Exception as e:
        print(f"❌ [DOCX] Error extrayendo texto: {e}")
        raise RuntimeError(f"No se pudo procesar el DOCX: {e}") from e

    print(f"   Texto extraído: {len(full_text)} caracteres, {len(paragraphs)} párrafos")

    docx_instruction = (
        "Eres un auditor financiero senior. Analiza el siguiente documento Word (DOCX) "
        "que contiene información financiera de una startup. Extrae las métricas del texto "
        "y tablas, y emite el JSON estándar.\n\nCONTENIDO DEL DOCUMENTO:\n"
    )
    return gemini.analizar_texto(docx_instruction + full_text + "\n\n" + prompt_schema, "")


# ── PDF helpers ───────────────────────────────────────────────────────────────

_PDF_CHUNK_SIZE = 90  # páginas máximas por llamada a Gemini

# Sections that MUST exist in the merged Gemini JSON for build_contract() to
# find all 16 KPIs.  If a section is absent (e.g. all chunks had null values)
# we guarantee an empty dict so downstream code never KeyErrors.
_REQUIRED_FM_SECTIONS = (
    "revenue_growth",
    "profit_margins",
    "cash_flow_indicators",
    "debt_ratios",
    "base_metrics",
    "sector_metrics",
)


def _ensure_dict(obj) -> dict:
    """
    Garantiza que el resultado recuperado de GCS sea un dict de Python.

    GCS puede almacenar JSONs con doble serialización (el string ya fue
    serializado una vez antes de ser guardado como string). Este helper
    maneja ambos casos sin excepciones silenciosas.

    Raises TypeError si el objeto no puede convertirse a dict.
    """
    if isinstance(obj, dict):
        return obj
    if isinstance(obj, str):
        parsed = json.loads(obj)
        # Doble serialización: json.loads devolvió otro string
        if isinstance(parsed, str):
            return json.loads(parsed)
        if isinstance(parsed, dict):
            return parsed
        raise TypeError(f"_ensure_dict: json.loads devolvió {type(parsed).__name__}, no dict")
    raise TypeError(f"_ensure_dict: esperaba dict o str, recibió {type(obj).__name__}")


def _ensure_fm_sections(gemini_json: dict) -> dict:
    """
    Garantiza que financial_metrics_2025 tenga todas las sub-secciones
    requeridas para que build_contract() pueda iterar KPI_REGISTRY completo.

    Modifica el dict en-lugar y también lo devuelve (para encadenamiento).
    """
    fm = gemini_json.setdefault("financial_metrics_2025", {})
    for section in _REQUIRED_FM_SECTIONS:
        fm.setdefault(section, {})
    return gemini_json


def split_pdf_to_chunks(file_bytes: bytes, size: int = _PDF_CHUNK_SIZE) -> list[bytes]:
    """
    Divide los bytes de un PDF en fragmentos de máximo `size` páginas.

    Devuelve una lista de bytes — cada elemento es un PDF autónomo válido
    que puede guardarse en disco o enviarse directamente a Gemini.

    Parameters
    ----------
    file_bytes : bytes — contenido completo del PDF original.
    size       : int   — máximo de páginas por fragmento (default 50).

    Returns
    -------
    list[bytes] con 1..N fragmentos. Si el PDF tiene ≤ size páginas,
    la lista tiene exactamente un elemento (los bytes originales sin modificar).
    """
    try:
        import fitz
    except ImportError:
        raise RuntimeError("PyMuPDF no instalado. Ejecuta: pip install pymupdf")

    src_doc     = fitz.open(stream=file_bytes, filetype="pdf")
    total_pages = len(src_doc)

    if total_pages <= size:
        src_doc.close()
        return [file_bytes]

    n_chunks = (total_pages + size - 1) // size
    chunks: list[bytes] = []

    for idx in range(n_chunks):
        start = idx * size
        end   = min(start + size - 1, total_pages - 1)

        chunk_doc = fitz.open()
        chunk_doc.insert_pdf(src_doc, from_page=start, to_page=end)
        chunks.append(chunk_doc.tobytes())
        chunk_doc.close()

        _blk_num    = idx + 1
        _page_start = start + 1
        _page_end   = end + 1
        print(f"[Chunking] Bloque {_blk_num}/{n_chunks}: páginas {_page_start}–{_page_end}")

    src_doc.close()
    return chunks


def merge_consolidated_results(jsons: list[dict]) -> dict:
    """
    Une los resultados de múltiples llamadas a Gemini (chunks de PDF)
    en un único diccionario consolidado.

    Regla de consolidación por KPI:
    - Si un KPI aparece en varios chunks con value != null, se queda el de
      mayor confidence score.
    - Empate de confidence → gana el chunk anterior (índice más bajo),
      preservando el orden documental del PDF.
    - _document_context se toma siempre del primer chunk que lo contenga.
    - base_metrics y sector_metrics se garantizan presentes en el resultado
      (secciones vacías si ningún chunk extrajo datos para ellas).

    Parameters
    ----------
    jsons : list de dicts Gemini ya parseados — mínimo uno.

    Returns
    -------
    Un único dict Gemini con la misma estructura del schema Cometa-Vault.
    """
    import copy

    if not jsons:
        raise ValueError("merge_consolidated_results: lista vacía")
    if len(jsons) == 1:
        return _ensure_fm_sections(jsons[0])

    merged = copy.deepcopy(jsons[0])

    def _get(obj: dict, path: list[str]):
        cur = obj
        for k in path:
            if not isinstance(cur, dict):
                return None
            cur = cur.get(k)
        return cur

    def _set(obj: dict, path: list[str], value) -> None:
        cur = obj
        for k in path[:-1]:
            cur = cur.setdefault(k, {})
        cur[path[-1]] = value

    for chunk_json in jsons[1:]:
        for kpi_def in KPI_REGISTRY:
            path     = kpi_def["path"]
            existing = _get(merged, path)
            incoming = _get(chunk_json, path)

            if not isinstance(incoming, dict) or incoming.get("value") is None:
                continue  # este chunk no tiene dato para este KPI

            if not isinstance(existing, dict) or existing.get("value") is None:
                _set(merged, path, incoming)
                continue

            # Ambos tienen valor — queda el de mayor confidence
            existing_conf = float(existing.get("confidence") or 0.0)
            incoming_conf = float(incoming.get("confidence") or 0.0)
            if incoming_conf > existing_conf:
                _set(merged, path, incoming)

    # Garantizar secciones requeridas aunque todos los chunks tengan null
    _ensure_fm_sections(merged)
    return merged


# Alias de compatibilidad (el upload path lo llamaba merge_kpi_results en
# versiones anteriores — conservamos el nombre por si algún test lo importa)
merge_kpi_results = merge_consolidated_results


def _chunk_and_process_pdf(temp_path: str, gemini, prompt_config: str) -> str:
    """
    Motor de Chunking — lee el PDF desde disco, lo divide en bloques de 50
    páginas con split_pdf_to_chunks(), llama a Gemini por cada bloque y
    consolida con merge_consolidated_results().

    - PDFs ≤ 50 páginas: una sola llamada directa a Gemini (sin overhead).
    - PDFs > 50 páginas: N bloques secuenciales; si un bloque falla se omite
      y se continúa. Si TODOS fallan → RuntimeError.

    Returns
    -------
    String JSON listo para json.loads() — mismo contrato que
    gemini.extraer_y_auditar().
    """
    import re as _re

    with open(temp_path, "rb") as fh:
        file_bytes = fh.read()

    chunks = split_pdf_to_chunks(file_bytes, size=_PDF_CHUNK_SIZE)
    n_chunks = len(chunks)

    if n_chunks == 1:
        print(f"[Chunking] PDF ≤ {_PDF_CHUNK_SIZE} páginas — llamada directa a Gemini")
        return gemini.extraer_y_auditar(temp_path, prompt_config)

    print(f"[Chunking] {n_chunks} bloques de hasta {_PDF_CHUNK_SIZE} páginas")

    chunk_results: list[dict] = []
    for i, chunk_bytes in enumerate(chunks):
        chunk_path = f"{temp_path}_chunk{i}.pdf"
        try:
            with open(chunk_path, "wb") as cf:
                cf.write(chunk_bytes)

            _blk = i + 1
            print(f"[Chunking] Enviando bloque {_blk}/{n_chunks} a Gemini...")
            raw = gemini.extraer_y_auditar(chunk_path, prompt_config)

            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    clean  = _re.sub(r'^```json\s*|\s*```$', '', raw.strip())
                    parsed = json.loads(clean)
            else:
                parsed = raw

            chunk_results.append(parsed)
            print(f"[Chunking] Bloque {_blk} OK")

        except Exception as chunk_err:
            _blk = i + 1
            print(f"[Chunking] Bloque {_blk} falló ({chunk_err}) — omitido")
        finally:
            if os.path.exists(chunk_path):
                os.remove(chunk_path)

    if not chunk_results:
        raise RuntimeError("[Chunking] Ningún bloque fue procesado por Gemini")

    merged = merge_consolidated_results(chunk_results)
    print(f"[Chunking] {len(chunk_results)}/{n_chunks} bloques mergeados exitosamente")
    return json.dumps(merged, ensure_ascii=False)


def check_hash_exists_in_gcs(bucket_name: str, file_hash: str) -> bool:
    """Verifica si existe un archivo con el mismo hash en custom_metadata"""
    try:
        storage_client = _get_storage_client()
        bucket = storage_client.bucket(bucket_name)
        
        # Listar blobs y buscar por metadata
        blobs = bucket.list_blobs()
        
        for blob in blobs:
            if blob.metadata and blob.metadata.get('file_hash') == file_hash:
                print(f"📋 [API] Hash duplicado encontrado en GCS: {file_hash}")
                return True
        
        return False
    except (DefaultCredentialsError, Forbidden, Unauthorized) as e:
        sa_path = _resolve_service_account_path()
        print(f"❌ [API] Error de credenciales/permisos en GCS: {e}")
        print(f"   GOOGLE_APPLICATION_CREDENTIALS={os.getenv('GOOGLE_APPLICATION_CREDENTIALS')}")
        print(f"   Service Account resuelto={sa_path}")
        raise RuntimeError("GCS_AUTH") from e
    except Exception as e:
        print(f"❌ [API] Error verificando hash en GCS: {e}")
        raise RuntimeError("GCS_ERROR") from e

def get_existing_result(bucket_name: str, file_hash: str) -> dict:
    """Obtiene el resultado JSON existente para un hash específico"""
    try:
        storage_client = _get_storage_client()
        bucket = storage_client.bucket(bucket_name)
        
        # Buscar en staging por hash
        blobs = bucket.list_blobs(prefix="staging/")
        
        for blob in blobs:
            if blob.metadata and blob.metadata.get('file_hash') == file_hash:
                # Descargar y retornar el resultado existente
                content = blob.download_as_text()
                result = json.loads(content)
                print(f"📋 [API] Resultado existente encontrado para hash: {file_hash}")
                return result
        
        return None
    except (DefaultCredentialsError, Forbidden, Unauthorized) as e:
        sa_path = _resolve_service_account_path()
        print(f"❌ [API] Error de credenciales/permisos obteniendo resultado: {e}")
        print(f"   GOOGLE_APPLICATION_CREDENTIALS={os.getenv('GOOGLE_APPLICATION_CREDENTIALS')}")
        print(f"   Service Account resuelto={sa_path}")
        raise RuntimeError("GCS_AUTH") from e
    except Exception as e:
        print(f"❌ [API] Error obteniendo resultado existente: {e}")
        raise RuntimeError("GCS_ERROR") from e

@app.post("/upload")
async def upload_pdf(
    file: UploadFile = File(...),
    founder_email: str = Header(None, description="Email del founder para identificación"),
    company_id: str = Header(None, description="Company ID para multi-tenancy")
):
    """
    Endpoint para subir PDF y procesar con Gemini (asíncrono)
    """
    # ── DEBUG: log inmediato al primer byte de la request ─────────────────
    print("=" * 60)
    print(f"📥 [DEBUG] /upload HIT — conexión recibida")
    _filename     = getattr(file, "filename", "N/A")
    _content_type = getattr(file, "content_type", "N/A")
    print(f"   filename     : {_filename}")
    print(f"   content_type : {_content_type}")
    print(f"   founder_email: {founder_email!r}")
    print(f"   company_id   : {company_id!r}")
    print("=" * 60)
    # ─────────────────────────────────────────────────────────────────────

    try:
        # 1. Validar archivo
        ALLOWED_EXTENSIONS = {'.pdf', '.csv', '.xlsx', '.xls', '.parquet', '.docx', '.doc'}
        file_ext = os.path.splitext(file.filename or "")[1].lower()
        if not file.filename or file_ext not in ALLOWED_EXTENSIONS:
            _allowed_str = ", ".join(sorted(ALLOWED_EXTENSIONS))
            raise HTTPException(
                status_code=400,
                detail=f"Formato no soportado. Permitidos: {_allowed_str}"
            )
        print(f"📁 [DEBUG] Extensión detectada: {file_ext}")
        
        # 2. Extraer company_id del header o del email
        company_domain = company_id if company_id else (founder_email.split('@')[-1] if '@' in founder_email else 'unknown')
        print(f"🏢 [API] Company domain: {company_domain}")
        
        # 3. Si no hay company_id, Vertex AI lo identificará del contenido del PDF
        if not company_domain or company_domain == 'unknown':
            print(f"[API] No company_id en header — se identificará desde el PDF")
            company_domain = 'pending_detection'
        
        # 4. Leer contenido y calcular hash
        file_content = await file.read()
        file_hash = get_file_hash(file_content)
        
        print(f"📤 [API] Archivo recibido: {file.filename}")
        print(f"🔍 [API] Hash calculado: {file_hash}")
        print(f"👤 [API] Founder: {founder_email}")
        print(f"🏢 [API] Vault path: vault/{company_domain}/")
        
        # 5. Verificar si ya existe por hash en la bóveda específica
        try:
            # Primero verificar en la bóveda de la empresa
            vault_prefix = f"vault/{company_domain}/"
            storage_client = _get_storage_client()
            bucket = storage_client.bucket(GCS_OUTPUT_BUCKET)
            
            # Buscar en la bóveda específica de la empresa
            blobs = bucket.list_blobs(prefix=vault_prefix)
            
            for blob in blobs:
                if blob.metadata and blob.metadata.get('file_hash') == file_hash:
                    # Encontrar resultado existente en la bóveda de la empresa
                    content = blob.download_as_text()
                    # Fix-1: garantizar dict (GCS puede devolver doble-serialización)
                    result = _ensure_dict(json.loads(content))
                    print(f"📋 [API] Resultado duplicado encontrado en bóveda de {company_domain}: {file_hash}")
                    # OBS-04: recalcular checklist_status desde el JSON cacheado
                    try:
                        _dup_contract = build_contract(
                            gemini_json=result,
                            file_hash=file_hash,
                            company_id=company_domain,
                            founder_email=founder_email or "",
                            original_filename=file.filename,
                        )
                        _dup_bucket = COMPANY_BUCKET.get(company_domain, "UNKNOWN")
                        dup_checklist = build_checklist_status(_dup_contract["kpi_rows"], _dup_bucket)
                    except Exception as _ce:
                        print(f"[API] checklist recalc failed for duplicate ({_ce}) — omitting")
                        dup_checklist = None
                    return JSONResponse(
                        content={
                            "status": "success",
                            "message": "Documento reconocido en la bóveda de Cometa. Sincronizando métricas...",
                            "duplicate": True,
                            "result": result,
                            "file_hash": file_hash,
                            "company_domain": company_domain,
                            "checklist_status": dup_checklist,
                        },
                        status_code=200
                    )
            
            # Si no existe en la bóveda de la empresa, buscar en el bucket general
            if check_hash_exists_in_gcs(GCS_INPUT_BUCKET, file_hash):
                # Copiar resultado a la bóveda de la empresa
                existing_result_raw = get_existing_result(GCS_OUTPUT_BUCKET, file_hash)
                if existing_result_raw:
                    # Fix-1: garantizar dict antes de operar con él
                    existing_result = _ensure_dict(existing_result_raw)
                    # Copiar a la bóveda específica
                    vault_result_filename = f"{vault_prefix}{file_hash}_result.json"
                    vault_blob = bucket.blob(vault_result_filename)

                    vault_blob.metadata = {
                        'file_hash': file_hash,
                        'original_filename': existing_result.get('original_filename', 'unknown'),
                        'founder_email': founder_email,
                        'company_domain': company_domain,
                        'vault_path': vault_prefix,
                        'processed_at': pd.Timestamp.now().isoformat(),
                        'copied_from_general': True
                    }
                    
                    vault_blob.upload_from_string(
                        json.dumps(existing_result, indent=2),
                        content_type='application/json'
                    )
                    
                    print(f"📋 [API] Resultado copiado a bóveda de {company_domain}: {vault_result_filename}")
                    # OBS-04: recalcular checklist_status desde el JSON cacheado
                    try:
                        _dup_contract2 = build_contract(
                            gemini_json=existing_result,
                            file_hash=file_hash,
                            company_id=company_domain,
                            founder_email=founder_email or "",
                            original_filename=file.filename,
                        )
                        _dup_bucket2 = COMPANY_BUCKET.get(company_domain, "UNKNOWN")
                        dup_checklist2 = build_checklist_status(_dup_contract2["kpi_rows"], _dup_bucket2)
                    except Exception as _ce2:
                        print(f"[API] checklist recalc failed for duplicate-copy ({_ce2}) — omitting")
                        dup_checklist2 = None
                    return JSONResponse(
                        content={
                            "status": "success",
                            "message": "Documento reconocido en la bóveda de Cometa. Sincronizando métricas...",
                            "duplicate": True,
                            "result": existing_result,
                            "file_hash": file_hash,
                            "company_domain": company_domain,
                            "checklist_status": dup_checklist2,
                        },
                        status_code=200
                    )
        except RuntimeError as e:
            if str(e) == "GCS_AUTH":
                raise HTTPException(
                    status_code=500,
                    detail=(
                        "Error de autenticación/permisos con GCS. "
                        "Verifica GOOGLE_APPLICATION_CREDENTIALS y permisos del bucket."
                    ),
                )
            raise HTTPException(
                status_code=500,
                detail="Error de conexión/lectura con GCS durante deduplicación",
            )
        
        # 6. Si es nuevo, iniciar procesamiento asíncrono
        print(f"🆕 [API] Archivo nuevo ({file_ext}), iniciando procesamiento asíncrono...")

        # Guardar temporalmente para procesamiento
        safe_filename = file.filename.replace(" ", "_")
        temp_path = os.path.join('/tmp', f"{file_hash}_{safe_filename}")
        os.makedirs('/tmp', exist_ok=True)

        with open(temp_path, "wb") as temp_file:
            temp_file.write(file_content)

        # 7. Iniciar procesamiento con Vertex AI
        try:
            # Inicializar adaptadores
            doc_ai = DocumentAIAdapter(PROJECT_ID, LOCATION_DOC_AI, PROCESSOR_ID)
            print(f"DEBUG: El valor de VERTEX_LOCATION es: '{VERTEX_LOCATION}'")
            gemini = GeminiAuditor(PROJECT_ID, VERTEX_LOCATION)
            
            # ── Contexto de vertical (inyectado antes del prompt) ─────────────
            # El bucket_id se conoce en cuanto detectamos la empresa; pasarlo
            # al prompt evita que Gemini busque métricas de otras verticales.
            _bucket_id = COMPANY_BUCKET.get(company_domain, "UNKNOWN")
            _sector_hints: dict[str, str] = {
                "SAAS":  "Prioriza MRR, Churn Rate y CAC. Si el documento menciona 'Monthly Recurring Revenue', 'Churn' o 'Customer Acquisition Cost', extráelos en sector_metrics.",
                "LEND":  "Prioriza Portfolio Size y NPL Ratio. Si el documento menciona 'cartera de crédito', 'morosidad', 'NPL' o 'Non-Performing Loans', extráelos en sector_metrics.",
                "ECOM":  "Prioriza GMV. Si el documento menciona 'Gross Merchandise Value', 'Total Sales Volume', 'Total Transaction Value' o 'GMV', extráelo en sector_metrics.gmv.",
                "INSUR": "Prioriza Loss Ratio. Si el documento menciona 'siniestralidad', 'claims ratio' o 'loss ratio', extráelo en sector_metrics.",
                "OTH":   "Extrae las métricas financieras estándar. No hay métricas sectoriales obligatorias.",
            }
            _sector_instruction = _sector_hints.get(
                _bucket_id,
                "Extrae todas las métricas del esquema. No hay contexto sectorial específico disponible.",
            )

            # ── Prompt CoT + esquema con confidence ──────────────────────────
            # El prompt se construye en dos partes para evitar conflictos de
            # escape en f-strings: el prefijo dinámico (f-string con bucket_id
            # y sector_instruction) se concatena con el cuerpo estático que
            # contiene el esquema JSON (curly braces literales).
            _prompt_prefix = (
                f"Eres un auditor financiero senior especializado en due diligence de startups.\n"
                f"Tu misión es extraer métricas financieras de un PDF con precisión institucional.\n"
                f"\n"
                f"╔══════════════════════════════════════════════════════════════╗\n"
                f"║  CONTEXTO DE INDUSTRIA                                      ║\n"
                f"╚══════════════════════════════════════════════════════════════╝\n"
                f"\n"
                f"Estás analizando una empresa de la vertical {_bucket_id}.\n"
                f"{_sector_instruction}\n"
                f"No intentes inventar o extraer métricas de otras verticales a menos que el\n"
                f"documento las mencione explícitamente como KPIs de negocio de la empresa.\n"
                f"\n"
            )
            _prompt_body = """
╔══════════════════════════════════════════════════════════════╗
║  FASE 1 — ANÁLISIS PREVIO  (escribe en _document_context)  ║
╚══════════════════════════════════════════════════════════════╝

Ejecuta este análisis y materializa las conclusiones en el campo
`_document_context` del JSON de salida (ver esquema más abajo).

  A. MONEDA PRINCIPAL
     ¿Cuál es la moneda del documento? (USD, MXN, EUR, COP, etc.)
     Si hay más de una moneda, ¿cuál domina los estados financieros?

  B. PERÍODO DE REPORTE
     ¿Qué año fiscal o período cubre el documento?
     Busca encabezados como "FY2025", "Año terminado el 31/12/2025",
     "H1 2025", "Q4 2025". Anota si el documento cubre períodos parciales.

  C. ESCALA NUMÉRICA
     ¿Los montos están expresados en unidades base, miles ($K) o millones ($M)?
     Busca notas al pie como "en miles de pesos" o "amounts in USD thousands".
     Normaliza TODOS los valores al output usando K, M o B según corresponda.

  D. ZONAS DE AMBIGÜEDAD
     Identifica métricas donde:
       · El dato no aparece explícito y debes calcularlo o inferirlo.
       · Hay dos cifras posibles (ej. consolidado vs. entidad separada).
       · El documento es un deck de presentación sin estados auditados.
     Para cada zona de ambigüedad, prepara una explicación para el campo
     "description" y asigna confidence < 0.70.

Las conclusiones de A, B y C van en `_document_context`.
Las zonas de D informan los campos description y confidence de cada métrica.

╔══════════════════════════════════════════════════════════════╗
║  FASE 2 — EXTRACCIÓN JSON                                   ║
╚══════════════════════════════════════════════════════════════╝

REGLAS OBLIGATORIAS:
1. Responde ÚNICAMENTE con el objeto JSON. Cero caracteres fuera del JSON.
2. Usa EXACTAMENTE las claves del esquema. Sin sinónimos, sin claves extra.
3. Cada métrica contiene tres campos obligatorios:

   "value"
     El número con unidad y escala normalizada según FASE 1.
     Ejemplos: "36%", "$9.7M", "-$320K", "-0.74%".
     NUNCA omitas la unidad. NUNCA escribas un número puro.

   "confidence"
     Float 0.0–1.0 que refleja tu certeza sobre el valor extraído:
       >= 0.90  → dato explícito, sin ambigüedad, fuente directa.
       0.70–0.89 → dato requirió cálculo menor o inferencia razonable.
       < 0.70  → dato ambiguo, estimado, parcial o de fuente indirecta.
     Sé honesto: subestimar confidence es mejor que inflar confianza falsa.

   "description"
     Cita exacta de la fuente: tabla, línea y página/sección del documento.
     Si confidence < 0.70: DEBE incluir (a) por qué el dato es incierto,
     (b) qué alternativas se consideraron y (c) cuál fue el criterio de
     selección del valor reportado.

4. Si una métrica no aparece en el documento: escribe null (no "N/A", no "---").
5. La clave raíz SIEMPRE debe ser "financial_metrics_2025".
6. Normaliza la escala usando el contexto de FASE 1 antes de escribir cada value.
7. El campo `_document_context` es OBLIGATORIO. Escribe exactamente sus 4 sub-campos.
   currency usa el código ISO 4217 de 3 letras (USD, MXN, EUR, BRL, COP, ARS...).

ESQUEMA REQUERIDO:
{
  "_document_context": {
    "currency":    "<ISO 4217 de la moneda dominante del documento, ej. 'MXN'>",
    "period":      "<período fiscal, ej. 'FY2025', 'H1 2025', 'Q4 2025'>",
    "scale":       "<escala de montos: 'units', 'thousands', 'millions', 'billions'>",
    "scale_notes": "<dónde se encontró la indicación de escala en el doc, o null>"
  },
  "financial_metrics_2025": {
    "revenue_growth": {
      "value": "<crecimiento YoY en %, ej. '36%' o '-4.2%'>",
      "confidence": <float 0.0-1.0>,
      "description": "<tabla/línea de origen; si confidence<0.70: razonamiento>"
    },
    "profit_margins": {
      "gross_profit_margin": {
        "value": "<%, ej. '68%'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      },
      "ebitda_margin": {
        "value": "<%, puede ser negativo, ej. '-12%'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      }
    },
    "cash_flow_indicators": {
      "cash_in_bank_end_of_year": {
        "value": "<monto con símbolo y escala, ej. '$9.7M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      },
      "annual_cash_flow": {
        "value": "<monto, ej. '-$3.2M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      }
    },
    "debt_ratios": {
      "working_capital_debt": {
        "value": "<monto, ej. '$1.1M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      }
    },
    "base_metrics": {
      "revenue": {
        "value": "<monto absoluto con símbolo y escala, ej. '$4.2M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      },
      "ebitda": {
        "value": "<monto, puede ser negativo, ej. '-$0.8M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      },
      "cogs": {
        "value": "<costo de ventas, ej. '$1.3M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente>"
      }
    },
    "sector_metrics": {
      "mrr": {
        "value": "<Monthly Recurring Revenue, ej. '$350K'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — solo para SaaS>"
      },
      "churn_rate": {
        "value": "<%mensual de cancelaciones, ej. '2.1%'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — solo para SaaS>"
      },
      "cac": {
        "value": "<Customer Acquisition Cost, ej. '$120'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — SaaS/ECOM/INSUR>"
      },
      "portfolio_size": {
        "value": "<cartera total de créditos, ej. '$25M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — solo para Lending>"
      },
      "npl_ratio": {
        "value": "<Non-Performing Loan ratio, ej. '3.4%'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — solo para Lending>"
      },
      "gmv": {
        "value": "<Gross Merchandise Value / Total Sales Volume / Total Transaction Value / GMV, ej. '$8.5M'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — eCommerce/logística. Aliases aceptados: 'Total Sales Volume', 'Total Transaction Value', 'GMV'>"
      },
      "loss_ratio": {
        "value": "<siniestralidad, ej. '62%'>",
        "confidence": <float 0.0-1.0>,
        "description": "<fuente — solo para Insurtech>"
      }
    }
  }
}

Analiza el documento adjunto y responde con el JSON completo. Nada más.
"""
            prompt_config = _prompt_prefix + _prompt_body

            # ── Enrutar por tipo de archivo ────────────────────────────────
            if file_ext in ('.csv', '.xlsx', '.xls', '.parquet'):
                resultado_raw = _process_tabular(temp_path, file_ext, gemini, prompt_config)
            elif file_ext in ('.docx', '.doc'):
                resultado_raw = _process_docx(temp_path, gemini, prompt_config)
            else:
                # PDF — Smart Chunking (bloques de 50 páginas)
                resultado_raw = _chunk_and_process_pdf(temp_path, gemini, prompt_config)

            # Normalizar: Gemini devuelve un string JSON; lo parseamos para evitar
            # doble serialización al guardarlo en GCS.
            if isinstance(resultado_raw, str):
                try:
                    resultado = json.loads(resultado_raw)
                except json.JSONDecodeError:
                    # Si el modelo devolvió texto envuelto en ```json ... ```, limpiarlo
                    import re
                    clean = re.sub(r'^```json\s*|\s*```$', '', resultado_raw.strip())
                    resultado = json.loads(clean)
            else:
                resultado = resultado_raw
            
            # 8a. Identificación silenciosa — Vertex AI detecta la empresa del PDF.
            # Escanea el JSON de Gemini + nombre de archivo para identificar la startup.
            # Si se detecta, sobrescribe company_domain y asigna portfolio_id desde dim_company.
            detected_key, detected_portfolio = detect_company_from_text(
                json.dumps(resultado) + " " + file.filename
            )
            if detected_key != "unknown":
                print(f"[API] Empresa auto-detectada: '{detected_key}' -> Fondo {detected_portfolio}")
                company_domain = detected_key
                portfolio_id   = detected_portfolio
            else:
                portfolio_id = lookup_portfolio(company_domain)
                print(f"[API] Empresa no detectada del contenido, usando header: {company_domain} -> {portfolio_id}")

            # 8b. Build the canonical data contract (Rule 4 + Rule 8)
            contract = build_contract(
                gemini_json=resultado,
                file_hash=file_hash,
                company_id=company_domain,
                founder_email=founder_email or "",
                original_filename=file.filename,
                portfolio_id=portfolio_id,
            )

            integrity = contract["integrity"]
            _sub        = contract["submission"]
            _kpi_valid  = _sub["kpi_count_valid"]
            _kpi_total  = _sub["kpi_count_total"]
            _period_id  = _sub["period_id"]
            _period_ok  = integrity["period_consistent"]
            print(
                f"📋 [API] Contract built — "
                f"valid KPIs: {_kpi_valid}/{_kpi_total}, "
                f"period: {_period_id}, "
                f"period_consistent: {_period_ok}"
            )

            if integrity["warnings"]:
                for w in integrity["warnings"]:
                    print(f"⚠️  [API] Integrity warning: {w}")

            # 8c. Sector checklist — computed from contract KPI rows + company bucket
            company_bucket = COMPANY_BUCKET.get(company_domain, "UNKNOWN")
            checklist_status = build_checklist_status(contract["kpi_rows"], company_bucket)
            if not checklist_status["is_complete"]:
                _missing_kpis = checklist_status["missing_critical_kpis"]
                print(f"[API] Checklist incompleto ({company_bucket}): faltan {_missing_kpis}")

            # ── Validación de contenido financiero ──────────────────────────────
            # Si Gemini no extrajo ningún KPI reconocible, el archivo no es un
            # reporte financiero válido: bloquear toda persistencia y avisar al
            # frontend con 422 (el tempfile ya se limpia más abajo en el except).
            if not _is_financial_document(resultado):
                print(
                    f"🚫 [API] Documento rechazado — sin KPIs financieros reconocibles. "
                    f"Hash: {file_hash}, archivo: {file.filename}"
                )
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Archivo no reconocido como reporte financiero válido. "
                        "No se han guardado datos."
                    ),
                )
            # ────────────────────────────────────────────────────────────────────

            # 8d. Persist to BigQuery (non-fatal if BQ is down)
            db_result = {"inserted": False, "duplicate": False, "submission_id": None}
            try:
                db_result = insert_contract(contract)
                if db_result["duplicate"]:
                    print(f"[API] BQ dedup — submission already exists for hash {file_hash}")
            except Exception as db_err:
                print(f"[API] BigQuery write failed (non-fatal, GCS copy kept): {db_err}")

            # 8d. Save to GCS vault bajo el company_domain ya detectado
            storage_client = _get_storage_client()
            bucket = storage_client.bucket(GCS_OUTPUT_BUCKET)
            vault_prefix = f"vault/{company_domain}/"
            result_filename = f"{vault_prefix}{file_hash}_result.json"
            blob = bucket.blob(result_filename)
            blob.metadata = {
                'file_hash': file_hash,
                'original_filename': file.filename,
                'founder_email': founder_email,
                'company_domain': company_domain,
                'portfolio_id': portfolio_id,
                'vault_path': vault_prefix,
                'processed_at': pd.Timestamp.now().isoformat()
            }
            blob.upload_from_string(
                json.dumps(resultado, indent=2, ensure_ascii=False),
                content_type='application/json'
            )

            print(f"✅ [API] Resultado guardado en GCS: {result_filename}")

            # Guardar archivo original en GCS (vault/{company}/raw/)
            raw_filename = f"vault/{company_domain}/raw/{file_hash}_{safe_filename}"
            raw_blob = bucket.blob(raw_filename)
            raw_blob.metadata = {
                'file_hash': file_hash,
                'original_filename': file.filename,
                'founder_email': founder_email,
                'company_domain': company_domain,
                'file_type': file_ext,
                'uploaded_at': pd.Timestamp.now().isoformat(),
            }
            raw_blob.upload_from_string(file_content, content_type=file.content_type or 'application/octet-stream')
            print(f"📦 [API] Archivo original guardado en GCS: {raw_filename}")

            # 9. Limpiar archivo temporal
            os.remove(temp_path)

            # 10. Retornar contrato completo al frontend
            return JSONResponse(
                content={
                    "status": "success",
                    "message": "Archivo procesado exitosamente",
                    "duplicate": False,
                    # Legacy field: raw Gemini dict for existing frontend consumers
                    "result": resultado,
                    # Structured contract for The Vault
                    "submission":        contract["submission"],
                    "kpi_rows":          contract["kpi_rows"],
                    "integrity":         integrity,
                    "db":                db_result,
                    "file_hash":         file_hash,
                    "company_domain":    company_domain,
                    # Sector checklist — feedback inmediato al founder
                    "checklist_status":  checklist_status,
                },
                status_code=200
            )
            
        except Exception as e:
            # Limpiar archivo temporal en caso de error
            if os.path.exists(temp_path):
                os.remove(temp_path)
            
            print(f"❌ [API] Error en procesamiento: {str(e)}")
            traceback.print_exc()
            
            # Error claro para el usuario
            return JSONResponse(
                content={
                    "status": "error",
                    "message": "Error procesando el archivo",
                    "error": str(e)
                },
                status_code=500
            )
    
    except Exception as e:
        print(f"❌ [API] Error general en upload: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Error en el servidor: {str(e)}")


@app.get("/api/result/{file_hash}")
async def get_analysis_result(file_hash: str):
    """
    Obtiene el resultado del análisis por hash de archivo
    """
    try:
        result = get_existing_result(GCS_OUTPUT_BUCKET, file_hash)
        if result:
            return JSONResponse(content=result)
        else:
            raise HTTPException(status_code=404, detail="Resultado no encontrado")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error obteniendo resultado: {str(e)}")

@app.get("/api/results")
async def get_all_results(company_id: str = None):
    """
    Obtiene todos los resultados de análisis guardados en GCS/vault/{company_id}/
    """
    try:
        storage_client = _get_storage_client()
        bucket = storage_client.bucket(GCS_OUTPUT_BUCKET)
        
        # Si no se proporciona company_id, devolver error
        if not company_id:
            raise HTTPException(status_code=400, detail="company_id es obligatorio")
        
        # Listar archivos en vault/{company_id}/
        vault_prefix = f"vault/{company_id}/"
        blobs = bucket.list_blobs(prefix=vault_prefix)
        
        results = []
        
        for blob in blobs:
            if blob.name.endswith('.json'):
                try:
                    # Descargar contenido del JSON
                    content = blob.download_as_text()
                    
                    # Manejar posible doble serialización
                    try:
                        result_data = json.loads(content)
                        # Si el resultado sigue siendo un string, aplicar segundo parse
                        if isinstance(result_data, str):
                            print(f" [API] Detectada doble serialización en {blob.name}")
                            result_data = json.loads(result_data)
                    except json.JSONDecodeError as e:
                        print(f" [API] Error parseando JSON de {blob.name}: {e}")
                        continue
                    
                    # Asegurarse que result_data sea un diccionario
                    if not isinstance(result_data, dict):
                        _blob_name      = blob.name
                        _result_type    = type(result_data).__name__
                        print(f" [API] Resultado no es diccionario en {_blob_name}: {_result_type}")
                        continue
                    
                    # Extraer metadata
                    metadata = blob.metadata or {}
                    
                    # Construir objeto de resultado con estructura clara
                    # Derive portfolio — prefer stored metadata, fall back to lookup
                    blob_portfolio = metadata.get('portfolio_id') or lookup_portfolio(
                        metadata.get('company_domain', company_id)
                    )
                    result_item = {
                        "id": blob.name.replace('.json', '').replace(vault_prefix, ''),
                        "data": result_data,
                        "date": metadata.get('processed_at', 'unknown'),
                        "metadata": {
                            "original_filename": metadata.get('original_filename', 'unknown'),
                            "founder_email": metadata.get('founder_email', 'unknown'),
                            "file_hash": metadata.get('file_hash', ''),
                            "processed_at": metadata.get('processed_at', 'unknown'),
                            "gcs_path": blob.name,
                            "portfolio_id": blob_portfolio,
                        }
                    }
                    
                    results.append(result_item)
                    _blob_name   = blob.name
                    _data_type   = type(result_data).__name__
                    _data_keys   = list(result_data.keys()) if isinstance(result_data, dict) else "N/A"
                    print(f" [API] Resultado cargado: {_blob_name}")
                    print(f" [API] Tipo de data: {_data_type}")
                    print(f" [API] Keys en data: {_data_keys}")
                    
                except Exception as e:
                    print(f" [API] Error procesando {blob.name}: {e}")
                    continue
        
        # Ordenar por fecha de procesamiento (más reciente primero)
        results.sort(key=lambda x: x['date'], reverse=True)
        
        print(f" [API] Resultados encontrados para {company_id}: {len(results)}")
        
        return JSONResponse(
            content={
                "status": "success",
                "results": results,
                "company_id": company_id,
                "total": len(results)
            }
        )
    except (DefaultCredentialsError, Forbidden, Unauthorized) as e:
        sa_path = _resolve_service_account_path()
        print(f" [API] Error de credenciales/permisos obteniendo resultados: {e}")
        print(f"   GOOGLE_APPLICATION_CREDENTIALS={os.getenv('GOOGLE_APPLICATION_CREDENTIALS')}")
        print(f"   Service Account resuelto={sa_path}")
        raise HTTPException(
            status_code=500,
            detail="Error de autenticación/permisos con GCS. Verifica credenciales."
        )
    except Exception as e:
        print(f"[API] Error general en get_all_results: {e}")
        raise HTTPException(status_code=500, detail=f"Error obteniendo resultados: {str(e)}")

@app.get("/health")
async def health_check():
    """Endpoint de verificación de salud"""
    return {"status": "healthy", "service": "cometa-pipeline-api"}


# ── Analyst KPI correction ────────────────────────────────────────────────────

class KpiUpdateRequest(BaseModel):
    """
    Body for PUT /api/kpi-update.

    Fields
    ------
    submission_id : UUID of the submission in BigQuery (fact_kpi_values.submission_id).
    metric_id     : KPI key as stored in fact_kpi_values.kpi_key
                    (e.g. "revenue_growth", "ebitda_margin").
    value         : New raw string value typed by the Analyst
                    (e.g. "42%", "$8.5M"). Passed through parse_numeric.
    """
    submission_id: str
    metric_id:     str
    value:         str


@app.put("/api/kpi-update")
async def kpi_update(payload: KpiUpdateRequest):
    """
    Persist an Analyst correction to a KPI row in BigQuery.

    - Validates the new value via parse_numeric (Rule 4).
    - Sets is_manually_edited=TRUE and edited_at=CURRENT_TIMESTAMP().
    - Preserves the original value in edited_raw_value for audit.

    Returns the updated KPI data including parse result.
    """
    try:
        result = update_kpi_value(
            submission_id=payload.submission_id,
            kpi_key=payload.metric_id,
            new_raw_value=payload.value,
        )
        return JSONResponse(
            content={
                "status":  "success",
                "message": f"KPI '{payload.metric_id}' actualizado correctamente",
                **result,
            }
        )

    except ValueError as e:
        # Row not found in BigQuery
        raise HTTPException(status_code=404, detail=str(e))

    except Exception as e:
        print(f"❌ [API] Error en /api/kpi-update: {e}")
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Error actualizando KPI en BigQuery: {str(e)}"
        )

# ── Manual KPI entry (Analista Auditoría tab) ────────────────────────────────

_KPI_ENTRY_FIELDS = frozenset({
    "revenue_growth", "gross_profit_margin", "ebitda_margin",
    "cash_in_bank_end_of_year", "annual_cash_flow", "working_capital_debt",
    "revenue", "ebitda", "cogs",
    "mrr", "churn_rate", "cac", "portfolio_size", "npl_ratio", "gmv", "loss_ratio",
})


class ManualEntryRequest(BaseModel):
    """Body for POST /api/manual-entry — Analyst enters KPIs without a PDF.

    Supports all 16 KPIs of the current data contract:
      - 6 core financial KPIs
      - 3 base metrics (inputs for the derivation engine)
      - 7 sector metrics (sector-specific KPIs)

    Empty strings from the frontend are coerced to None before validation.
    Numeric values sent as float/int are coerced to str for parse_numeric.
    """
    # ── Identifiers ────────────────────────────────────────────────────────
    company_id:               str
    portfolio_id:             str
    period_id:                str  = "FY2025"
    founder_email:            str  = ""
    submission_id:            str | None = None   # links manual entry to original upload
    # ── Core financial KPIs ────────────────────────────────────────────────
    revenue_growth:           str | None = None
    gross_profit_margin:      str | None = None
    ebitda_margin:            str | None = None
    cash_in_bank_end_of_year: str | None = None
    annual_cash_flow:         str | None = None
    working_capital_debt:     str | None = None
    # ── Base metrics (derivation engine inputs) ────────────────────────────
    revenue:                  str | None = None
    ebitda:                   str | None = None
    cogs:                     str | None = None
    # ── Sector metrics ─────────────────────────────────────────────────────
    mrr:                      str | None = None   # SAAS
    churn_rate:               str | None = None   # SAAS
    cac:                      str | None = None   # SAAS / ECOM / INSUR
    portfolio_size:           str | None = None   # LEND
    npl_ratio:                str | None = None   # LEND
    gmv:                      str | None = None   # ECOM
    loss_ratio:               str | None = None   # INSUR

    @model_validator(mode="before")
    @classmethod
    def _coerce_kpi_fields(cls, data: dict) -> dict:
        """Convert empty strings → None and numbers → str for all KPI fields."""
        if not isinstance(data, dict):
            return data
        for field in _KPI_ENTRY_FIELDS:
            val = data.get(field)
            if val is None:
                continue
            if isinstance(val, (int, float)):
                # Frontend sent a bare number — convert to string for parse_numeric
                data[field] = str(val)
            elif isinstance(val, str) and val.strip() == "":
                # Empty string — treat as not provided
                data[field] = None
        return data


def _manual_node(value: str | None) -> dict:
    return {
        "value":       value,
        "confidence":  1.0,
        "description": "Entrada manual del Analista",
    }


@app.post("/api/manual-entry")
async def manual_entry(payload: ManualEntryRequest):
    """
    Persist analyst-entered KPIs directly to BigQuery without a PDF.
    Builds a synthetic Gemini JSON, runs it through build_contract(),
    and inserts it via insert_contract() — same deduplication rules apply.
    """
    import hashlib, uuid as _uuid

    # Synthetic Gemini JSON mirrors the real 16-KPI schema exactly
    synthetic_gemini = {
        "_document_context": {
            "currency":    "USD",
            "period":      payload.period_id,
            "scale":       "units",
            "scale_notes": "Entrada manual del Analista",
        },
        "financial_metrics_2025": {
            # ── Core KPIs ──────────────────────────────────────────────────
            "revenue_growth": _manual_node(payload.revenue_growth),
            "profit_margins": {
                "gross_profit_margin": _manual_node(payload.gross_profit_margin),
                "ebitda_margin":       _manual_node(payload.ebitda_margin),
            },
            "cash_flow_indicators": {
                "cash_in_bank_end_of_year": _manual_node(payload.cash_in_bank_end_of_year),
                "annual_cash_flow":         _manual_node(payload.annual_cash_flow),
            },
            "debt_ratios": {
                "working_capital_debt": _manual_node(payload.working_capital_debt),
            },
            # ── Base metrics (OBS-03) ──────────────────────────────────────
            "base_metrics": {
                "revenue": _manual_node(payload.revenue),
                "ebitda":  _manual_node(payload.ebitda),
                "cogs":    _manual_node(payload.cogs),
            },
            # ── Sector metrics (OBS-03) ────────────────────────────────────
            "sector_metrics": {
                "mrr":           _manual_node(payload.mrr),
                "churn_rate":    _manual_node(payload.churn_rate),
                "cac":           _manual_node(payload.cac),
                "portfolio_size":_manual_node(payload.portfolio_size),
                "npl_ratio":     _manual_node(payload.npl_ratio),
                "gmv":           _manual_node(payload.gmv),
                "loss_ratio":    _manual_node(payload.loss_ratio),
            },
        },
    }

    # Unique hash based on company + period + timestamp so re-entries don't dedup
    _company_id    = payload.company_id
    _period_id     = payload.period_id
    _unique_salt   = str(_uuid.uuid4())
    raw_hash_input = f"{_company_id}:{_period_id}:{_unique_salt}"
    file_hash = hashlib.sha256(raw_hash_input.encode()).hexdigest()[:16]

    try:
        contract = build_contract(
            gemini_json=synthetic_gemini,
            file_hash=file_hash,
            company_id=payload.company_id,
            founder_email=payload.founder_email,
            original_filename=f"[manual] {payload.company_id} {payload.period_id}",
            portfolio_id=payload.portfolio_id,
        )
        db_result = insert_contract(contract)
        return JSONResponse(content={
            "status":       "success",
            "message":      f"Datos de {payload.company_id} guardados correctamente",
            "submission":   contract["submission"],
            "kpi_rows":     contract["kpi_rows"],
            "db":           db_result,
        })
    except Exception as e:
        print(f"[API] Error en /api/manual-entry: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── Duplicate audit — delete a vault submission ───────────────────────────────

@app.delete("/api/submission")
async def delete_submission(file_hash: str, company_id: str):
    """
    Delete a specific submission from the GCS vault.
    Identifies the blob by matching file_hash in metadata.
    BigQuery row is NOT deleted (preserves audit trail).
    """
    try:
        storage_client = _get_storage_client()
        bucket         = storage_client.bucket(GCS_OUTPUT_BUCKET)
        vault_prefix   = f"vault/{company_id}/"
        blobs          = list(bucket.list_blobs(prefix=vault_prefix))
        deleted        = 0
        for blob in blobs:
            if blob.metadata and blob.metadata.get("file_hash") == file_hash:
                blob.delete()
                deleted += 1
                print(f"[API] Deleted vault blob: {blob.name}")
        if deleted == 0:
            raise HTTPException(status_code=404, detail=f"No blob found for hash {file_hash} in {company_id}")
        return JSONResponse(content={"status": "success", "deleted": deleted, "file_hash": file_hash})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Portfolio registry endpoints ──────────────────────────────────────────────

@app.get("/api/portfolio-companies")
async def get_portfolio_companies(portfolio_id: str = None):
    """
    Returns the canonical company list grouped by portfolio.

    Query params
    ------------
    portfolio_id : optional — "VII" or "CIII". If omitted, returns all funds.
    """
    grouped: dict[str, list[str]] = {}
    for key, info in PORTFOLIO_MAP.items():
        pid = info["portfolio_id"]
        if portfolio_id and pid != portfolio_id:
            continue
        grouped.setdefault(pid, []).append(key.capitalize())

    return JSONResponse(content={
        "status":    "success",
        "portfolios": [
            {
                "portfolio_id":   pid,
                "portfolio_name": f"Fondo {pid}",
                "companies":      sorted(names),
            }
            for pid, names in sorted(grouped.items())
        ],
    })


@app.get("/api/results/all")
async def get_all_results_global():
    """
    Returns ALL results from vault/ across every company and portfolio.
    Used by the Analyst dashboard to hydrate on mount.
    """
    try:
        storage_client = _get_storage_client()
        bucket = storage_client.bucket(GCS_OUTPUT_BUCKET)

        blobs = bucket.list_blobs(prefix="vault/")
        results = []

        for blob in blobs:
            if not blob.name.endswith('.json'):
                continue
            try:
                content = blob.download_as_text()
                try:
                    result_data = json.loads(content)
                    if isinstance(result_data, str):
                        result_data = json.loads(result_data)
                except json.JSONDecodeError:
                    continue
                if not isinstance(result_data, dict):
                    continue

                metadata = blob.metadata or {}
                # Extract company_id from path: vault/{company_id}/{hash}.json
                parts = blob.name.split("/")
                company_id = parts[1] if len(parts) >= 3 else "unknown"

                blob_portfolio = metadata.get('portfolio_id') or lookup_portfolio(
                    metadata.get('company_domain', company_id)
                )

                vault_prefix = f"vault/{company_id}/"
                result_item = {
                    "id": blob.name.replace('.json', '').replace(vault_prefix, ''),
                    "data": result_data,
                    "date": metadata.get('processed_at', 'unknown'),
                    "metadata": {
                        "original_filename": metadata.get('original_filename', 'unknown'),
                        "founder_email": metadata.get('founder_email', 'unknown'),
                        "file_hash": metadata.get('file_hash', ''),
                        "processed_at": metadata.get('processed_at', 'unknown'),
                        "gcs_path": blob.name,
                        "portfolio_id": blob_portfolio,
                        "company_domain": company_id,
                    }
                }
                results.append(result_item)
            except Exception as e:
                print(f"[API/all] Error procesando {blob.name}: {e}")
                continue

        results.sort(key=lambda x: x['date'], reverse=True)
        print(f"[API/all] Total resultados globales: {len(results)}")

        return JSONResponse(content={
            "status": "success",
            "results": results,
            "total": len(results),
        })
    except Exception as e:
        print(f"[API/all] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Error obteniendo todos los resultados: {str(e)}")


@app.get("/api/analytics/portfolio")
async def get_portfolio_analytics(portfolio_id: str = "CIII"):
    """
    Aggregated KPI analytics from BigQuery for the requested portfolio.
    Groups by (month, company_id) and returns per-KPI averages.
    """
    try:
        result = query_portfolio_analytics(portfolio_id)
        return JSONResponse(content={"status": "success", **result})
    except Exception as e:
        print(f"[API/analytics] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Error obteniendo analytics: {str(e)}")


@app.get("/api/audit")
async def get_audit_report(portfolio_id: str = None):
    """
    Runs the BigQuery post-insert audit across fact_kpi_values.
    Returns all rows flagged as ERROR or WARNING with their audit_status.

    Query params
    ------------
    portfolio_id : optional — "VII" or "CIII". If omitted, audits all funds.

    audit_status values
    -------------------
    PASS                          — row is clean
    ERROR: Duplicado              — more than one row for same (company, metric, period)
    ERROR: Valor no numérico      — is_valid = FALSE
    ERROR: Confianza crítica (<0.70) — Gemini was highly uncertain
    ADVERTENCIA: Confianza baja (<0.85) — flagged for human review
    """
    try:
        result = run_audit_query(portfolio_id=portfolio_id)
        return JSONResponse(content={"status": "success", **result})
    except Exception as e:
        print(f"[API/audit] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Error ejecutando audit: {str(e)}")


@app.get("/api/audit/fidelity/{submission_id}")
async def get_fidelity_audit(submission_id: str):
    """
    Reporte de Fidelidad de Datos — Auditor Senior Cometa.

    Ejecuta tres auditorías encadenadas sobre una submission específica:

    1. identity_check
       Verifica que company_id esté en los 30 registros oficiales de dim_company
       y que el bucket_id asignado coincida con el registro canónico COMPANY_BUCKET.

    2. calculator_audit
       Clasifica cada KPI como 'gemini' (extraído del PDF) o 'calculated' (derivado
       por Python).  Para gross_profit_margin y ebitda_margin re-ejecuta la fórmula
       matemática y compara contra el valor almacenado.  Discrepancias > 0.5pp
       generan WARN; > 2pp generan ERROR (posible manipulación de reporte founder).

    3. checklist_diagnosis
       Cruza los KPIs válidos del reporte con SECTOR_REQUIREMENTS del vertical
       (SAAS / LEND / ECOM / INSUR / OTH) y devuelve missing_kpis con mensaje
       listo para mostrar al founder.

    overall_status
    --------------
    PASS  — sin hallazgos de error ni advertencia
    WARN  — advertencias presentes; el reporte es usable pero debe revisarse
    FAIL  — errores bloqueantes detectados (identidad incorrecta, discrepancia alta)

    Path param
    ----------
    submission_id : UUID de la submission (devuelto por /upload o /api/submissions)
    """
    try:
        result = run_fidelity_audit(submission_id)
        return JSONResponse(content={"status": "success", **result}, status_code=200)
    except ValueError as e:
        # OBS-02: submission_id no existe en BigQuery → 404 real
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        print(f"[API/fidelity-audit] Error: {e}")
        raise HTTPException(status_code=500, detail=f"Error ejecutando fidelity audit: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
