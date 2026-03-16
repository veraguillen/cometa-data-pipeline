import os
import json
import hashlib
from datetime import datetime
from google.cloud import storage
import pandas as pd

# Importamos el Corazón (Core)
from core.kpi_engine import KPIEngine
from core.auditor import FinancialAuditor

# Importamos los Brazos (Adapters)
from adapters.google_cloud import GeminiAuditor
from adapters.document_ai import DocumentAIAdapter

# --- CONFIGURACIÓN GLOBAL ---
os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = "cometa_key.json"

PROJECT_ID = "cometa-mvp"    # <--- Cambia esto
PROCESSOR_ID = "c5e1adfde68e63cf" # <--- ID de Document AI
LOCATION_DOC_AI = "us"
LOCATION_GEMINI = "us-central1"
GCS_INPUT_BUCKET = "ingesta-financiera-raw-cometa-mvp"  # Bucket existente
GCS_OUTPUT_BUCKET = "ingesta-financiera-raw-cometa-mvp" # Bucket existente

def get_consistent_file_hash(file_path):
    """
    Genera un hash consistente basado en el contenido del archivo.
    
    Args:
        file_path: Ruta del archivo local
    
    Returns:
        str: Hash SHA-256 de 8 caracteres del archivo
    """
    hash_sha256 = hashlib.sha256()
    with open(file_path, "rb") as f:
        # Leer el archivo en chunks para manejar archivos grandes
        for chunk in iter(lambda: f.read(4096), b""):
            hash_sha256.update(chunk)
    return hash_sha256.hexdigest()[:8]

def clean_filename(filename):
    """
    Elimina espacios en blanco y caracteres especiales del nombre de archivo.
    
    Args:
        filename: Nombre del archivo original
    
    Returns:
        str: Nombre del archivo limpio
    """
    # Reemplazar espacios con guiones bajos
    cleaned = filename.replace(" ", "_")
    # Reemplazar & con 'and'
    cleaned = cleaned.replace("&", "and")
    # Eliminar comas
    cleaned = cleaned.replace(",", "")
    # Eliminar otros caracteres problemáticos
    cleaned = cleaned.replace("(", "")
    cleaned = cleaned.replace(")", "")
    cleaned = cleaned.replace(".", "_", cleaned.count(".") - 1)  # Mantener solo el último punto
    return cleaned

def upload_to_gcs_with_metadata(local_file_path, bucket_name, blob_name=None):
    """
    Sube archivo a GCS con verificación por metadatos de hash.
    
    Args:
        local_file_path: Ruta del archivo local
        bucket_name: Nombre del bucket de GCS
        blob_name: Nombre del blob en GCS (opcional)
    
    Returns:
        tuple: (gcs_uri, file_hash, is_duplicate)
    """
    try:
        storage_client = storage.Client()
        bucket = storage_client.bucket(bucket_name)
        
        # Calcular hash del archivo
        with open(local_file_path, "rb") as f:
            file_content = f.read()
        file_hash = hashlib.sha256(file_content).hexdigest()[:16]
        
        if blob_name is None:
            # Limpiar el nombre del archivo
            original_filename = os.path.basename(local_file_path)
            blob_name = clean_filename(original_filename)
        
        blob = bucket.blob(blob_name)
        gcs_uri = f"gs://{bucket_name}/{blob_name}"
        
        # Verificar si ya existe por hash en metadatos
        blobs = bucket.list_blobs()
        for existing_blob in blobs:
            if (existing_blob.metadata and 
                existing_blob.metadata.get('file_hash') == file_hash):
                print(f" [GCS] Hash duplicado encontrado: {file_hash}")
                return gcs_uri, file_hash, True
        
        # Si no existe, subir con metadatos
        print(f" [GCS] Subiendo archivo nuevo: {local_file_path} -> {gcs_uri}")
        blob.metadata = {
            'file_hash': file_hash,
            'original_filename': os.path.basename(local_file_path),
            'uploaded_at': pd.Timestamp.now().isoformat()
        }
        blob.upload_from_filename(local_file_path)
        
        print(f" [GCS] Archivo subido exitosamente: {gcs_uri}")
        return gcs_uri, file_hash, False
        
    except Exception as e:
        print(f" [GCS] Error subiendo archivo: {e}")
        raise e
        
    except Exception as e:
        raise RuntimeError(f" [GCS] Error subiendo archivo a GCS: {e}")

def run_triple_audit(company_id, pdf_filename):
    """
    Orquestador principal que une el Core y los Adapters.
    """
    pdf_path = os.path.join("data/raw", pdf_filename)
    
    print(f"\n{'='*60}")
    print(f"🕵️  SISTEMA DE AUDITORÍA COMETA III - EMPRESA: {company_id.upper()}")
    print(f"{'='*60}")

    # 1. INICIALIZAR MOTORES DEL CORE
    engine = KPIEngine(dictionary_path='assets/kpi_dictionary.json')
    auditor_logic = FinancialAuditor(threshold=0.05)

    # 2. CARGAR CONTEXTO Y REGLAS
    print("📊 [Core] Cargando reglas de negocio y verdad base...")
    rules = engine.get_company_context(company_id)
    # Obtenemos el historial desde el CSV histórico
    history_df = engine.calculate_synthetic_metrics(None, pd.read_csv('data/raw/df_performance_metrics.csv'))
    
    # 3. EXTRAER TABLAS (DOCUMENT AI)
    print("📥 [Adapter] Digitalizando tablas con Document AI...")
    doc_ai = DocumentAIAdapter(PROJECT_ID, LOCATION_DOC_AI, PROCESSOR_ID)
    
    # Para el archivo específico de Simetrik, usar batch processing directamente
    if "simetrik" in pdf_filename.lower():
        print("📄 [Document AI] Archivo Simetrik detectado, usando batch processing...")
        
        # Subir PDF a GCS con hash consistente
        file_hash = get_consistent_file_hash(pdf_path)
        
        # Limpiar nombre de archivo: reemplazar espacios y caracteres especiales
        clean_filename = pdf_filename.replace(" ", "_").replace("&", "and").replace(",", "")
        gcs_blob_name = f"input/{company_id}_{file_hash}_{clean_filename}"
        gcs_input_uri = upload_to_gcs(pdf_path, GCS_INPUT_BUCKET, gcs_blob_name)
        
        print(f"📤 [GCS] Hash del archivo: {file_hash}")
        print(f"📤 [GCS] Nombre del blob: {gcs_blob_name}")
        
        # Configurar URI de salida (asegurar trailing slash) para la prueba con parte 1
        gcs_output_uri = f"gs://{GCS_OUTPUT_BUCKET}/output/simetrik_p1/"
        
        # Ejecutar batch processing
        texto_tablas = doc_ai.extraer_tablas_batch(gcs_input_uri, gcs_output_uri)
        
        print("✅ [Document AI] Batch processing completado")
    else:
        # Intentar procesamiento síncrono primero para otros archivos
        try:
            texto_tablas = doc_ai.extraer_tablas(pdf_path)
            print("✅ [Document AI] Procesamiento síncrono completado")
        except ValueError as e:
            if "demasiado grande" in str(e):
                print("📄 [Document AI] Archivo grande, usando batch processing...")
                
                # Subir PDF a GCS con hash consistente
                file_hash = get_consistent_file_hash(pdf_path)
                
                # Limpiar nombre de archivo: reemplazar espacios y caracteres especiales
                clean_filename = pdf_filename.replace(" ", "_").replace("&", "and").replace(",", "")
                gcs_blob_name = f"input/{company_id}_{file_hash}_{clean_filename}"
                gcs_input_uri = upload_to_gcs(pdf_path, GCS_INPUT_BUCKET, gcs_blob_name)
                
                print(f"📤 [GCS] Hash del archivo: {file_hash}")
                print(f"📤 [GCS] Nombre del blob: {gcs_blob_name}")
                
                # Configurar URI de salida (asegurar trailing slash) para consistencia
                gcs_output_uri = f"gs://{GCS_OUTPUT_BUCKET}/output/simetrik_p1/"
                
                # Ejecutar batch processing
                texto_tablas = doc_ai.extraer_tablas_batch(gcs_input_uri, gcs_output_uri)
                
                print("✅ [Document AI] Batch processing completado")
            else:
                raise

    # 4. CONSTRUIR ESTRATEGIA DE AUDITORÍA
    print("🎯 [Core] Definiendo estrategia de auditoría personalizada...")
    audit_strategy = auditor_logic.build_audit_strategy(company_id, rules, history_df)

    # 5. RAZONAMIENTO MULTIMODAL (GEMINI)
    print("🧠 [Adapter] Gemini analizando Visión + Tablas + Historia...")
    
    prompt_maestro = f"""
    {audit_strategy}

    FUENTES DE DATOS PARA RECONCILIAR:
    1. TABLAS DIGITALIZADAS (Document AI):
    {texto_tablas}

    2. HISTORIAL PREVIO (BigQuery/CSV):
    {history_df}

    3. DOCUMENTO VISUAL:
    Analiza el PDF adjunto para validar los GRÁFICOS contra las TABLAS anteriores.

    REQUERIMIENTOS DE SALIDA:
    Responde exclusivamente en formato JSON con la siguiente estructura:
    {{
      "Company_ID": "{company_id}",
      "Audit_Status": "Critical/Normal",
      "Metrics": [
        {{ "Metric": "string", "Value": 0.0, "Audit_Flag": bool, "Analyst_Note": "string" }}
      ],
      "Qualitative_Summary": "Resumen de la salud financiera"
    }}
    """

    gemini = GeminiAuditor(PROJECT_ID, LOCATION_GEMINI)
    resultado_raw = gemini.extraer_y_auditar(pdf_path, prompt_maestro)

    # 6. LIMPIEZA Y GUARDADO EN STAGING
    print("💾 [Staging] Guardando resultado para validación humana...")
    resultado_clean = resultado_raw.replace("```json", "").replace("```", "").strip()
    
    output_filename = f"{company_id}_audit_{datetime.now().strftime('%Y%m%d_%H%M')}.json"
    output_path = os.path.join("data/staging", output_filename)
    
    with open(output_path, "w", encoding='utf-8') as f:
        f.write(resultado_clean)

    print(f"\n✅ PROCESO FINALIZADO CON ÉXITO")
    print(f"📂 Reporte generado: {output_path}")
    print("\n--- PREVIEW DEL ANÁLISIS ---")
    print(resultado_clean)

if __name__ == "__main__":
    # Asegúrate de importar pandas solo para la carga inicial del historial
    import pandas as pd 
    
    # Nombre exacto de tu archivo en data/raw/
    ARCHIVO_PRUEBA = "simetrik_parte1.pdf"
    
    try:
        run_triple_audit("Simetrik", ARCHIVO_PRUEBA)
    except Exception as e:
        print(f"❌ Error crítico en el pipeline: {e}")

