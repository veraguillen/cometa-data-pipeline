#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script para auditar archivos JSON en GCS y detectar problemas de estructura
"""
import os
import json
import sys
from google.cloud import storage
from google.oauth2 import service_account

# Configurar encoding para Windows
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')

def audit_gcs_files():
    """Audita todos los archivos JSON en GCS staging/"""
    
    print("AUDITORIA DE ARCHIVOS GCS")
    print("=" * 50)
    
    # Configuración
    project_id = os.getenv("GOOGLE_PROJECT_ID", "cometa-mvp")
    bucket_name = os.getenv("GCS_OUTPUT_BUCKET", "ingesta-financiera-raw-cometa-mvp")
    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    
    if not credentials_path or not os.path.exists(credentials_path):
        print("❌ Error: No se encuentran credenciales de GCS")
        return False
    
    print(f"🔐 Usando credenciales: {credentials_path}")
    print(f"📦 Bucket: {bucket_name}")
    print(f"🗂️ Proyecto: {project_id}")
    
    try:
        # Inicializar cliente de Storage
        credentials = service_account.Credentials.from_service_account_file(credentials_path)
        client = storage.Client(project=project_id, credentials=credentials)
        bucket = client.bucket(bucket_name)
        
        # Listar todos los blobs en staging/
        print(f"\n📋 Listando archivos en staging/...")
        blobs = list(bucket.list_blobs(prefix="staging/"))
        
        json_files = [blob for blob in blobs if blob.name.endswith('.json')]
        
        print(f"   📄 Archivos JSON encontrados: {len(json_files)}")
        
        valid_files = []
        invalid_files = []
        
        for i, blob in enumerate(json_files, 1):
            print(f"\n🔍 Analizando archivo {i}: {blob.name}")
            
            try:
                # Descargar contenido
                content = blob.download_as_text()
                
                # Manejar doble serialización
                try:
                    data = json.loads(content)
                    if isinstance(data, str):
                        print(f"   🔄 Detectada doble serialización")
                        data = json.loads(data)
                except json.JSONDecodeError as e:
                    print(f"   ❌ Error parseando JSON: {e}")
                    invalid_files.append({
                        'file': blob.name,
                        'error': f'JSON decode error: {e}',
                        'content_preview': content[:200] + '...' if len(content) > 200 else content
                    })
                    continue
                
                # Verificar estructura
                if not isinstance(data, dict):
                    print(f"   ❌ Error: El JSON no es un diccionario")
                    invalid_files.append({
                        'file': blob.name,
                        'error': 'JSON is not a dictionary',
                        'type': type(data).__name__
                    })
                    continue
                
                # Verificar financial_metrics_2025
                if 'financial_metrics_2025' not in data:
                    print(f"   ❌ Error: No contiene 'financial_metrics_2025'")
                    invalid_files.append({
                        'file': blob.name,
                        'error': 'Missing financial_metrics_2025 key',
                        'available_keys': list(data.keys())[:5]
                    })
                    continue
                
                metrics = data['financial_metrics_2025']
                if not isinstance(metrics, dict) or len(metrics) == 0:
                    print(f"   ❌ Error: 'financial_metrics_2025' está vacío o no es diccionario")
                    invalid_files.append({
                        'file': blob.name,
                        'error': 'financial_metrics_2025 is empty or not a dictionary',
                        'type': type(metrics).__name__
                    })
                    continue
                
                # Verificar métricas clave
                key_metrics = ['revenue_growth', 'profit_margins', 'cash_flow_indicators', 'debt_ratios']
                available_metrics = []
                missing_metrics = []
                
                for key in key_metrics:
                    if key in metrics and metrics[key]:
                        available_metrics.append(key)
                    else:
                        missing_metrics.append(key)
                
                print(f"   ✅ Métricas disponibles ({len(available_metrics)}): {', '.join(available_metrics)}")
                if missing_metrics:
                    print(f"   ⚠️ Métricas faltantes: {', '.join(missing_metrics)}")
                
                # Si tiene métricas clave, es válido
                if len(available_metrics) >= 2:  # Al menos 2 métricas clave
                    valid_files.append({
                        'file': blob.name,
                        'metrics_count': len(available_metrics),
                        'available_metrics': available_metrics,
                        'missing_metrics': missing_metrics,
                        'metadata': blob.metadata or {}
                    })
                    print(f"   ✅ Archivo VÁLIDO para dashboard")
                else:
                    print(f"   ❌ Archivo INVÁLIDO (insuficientes métricas)")
                    invalid_files.append({
                        'file': blob.name,
                        'error': f'Insufficient metrics: only {len(available_metrics)} available',
                        'available_metrics': available_metrics,
                        'missing_metrics': missing_metrics
                    })
                
            except Exception as e:
                print(f"   ❌ Error procesando archivo: {e}")
                invalid_files.append({
                    'file': blob.name,
                    'error': f'Processing error: {e}',
                    'exception_type': type(e).__name__
                })
        
        # Resumen final
        print(f"\n📊 RESUMEN DE AUDITORÍA:")
        print(f"   ✅ Archivos válidos: {len(valid_files)}")
        print(f"   ❌ Archivos inválidos: {len(invalid_files)}")
        
        if valid_files:
            print(f"\n✅ ARCHIVOS VÁLIDOS PARA DASHBOARD:")
            for file in valid_files:
                print(f"   📄 {file['file']}")
                print(f"      Métricas: {len(file['available_metrics'])} disponibles")
                print(f"      Disponibles: {', '.join(file['available_metrics'])}")
                if file['missing_metrics']:
                    print(f"      Faltantes: {', '.join(file['missing_metrics'])}")
        
        if invalid_files:
            print(f"\n❌ ARCHIVOS INVÁLIDOS (REQUIEREN ATENCIÓN):")
            for file in invalid_files:
                print(f"   📄 {file['file']}")
                print(f"      Error: {file['error']}")
                if 'available_metrics' in file:
                    print(f"      Disponibles: {file.get('available_metrics', 'N/A')}")
        
        # Recomendaciones
        print(f"\n💡 RECOMENDACIONES:")
        if len(invalid_files) > 0:
            print(f"   🔧 Se deben reparar {len(invalid_files)} archivos antes de usarlos en dashboard")
            print(f"   🗑️ Considerar eliminar archivos inválidos de staging/")
        else:
            print(f"   ✅ Todos los archivos son válidos para el dashboard")
        
        return len(valid_files) > 0
        
    except Exception as e:
        print(f"❌ Error en auditoría: {e}")
        return False

if __name__ == "__main__":
    audit_gcs_files()
