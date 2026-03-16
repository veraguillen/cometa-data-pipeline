#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script para probar el endpoint /api/results
"""
import requests
import json
import sys

# Configurar encoding para Windows
if sys.platform == 'win32':
    import codecs
    sys.stdout = codecs.getwriter('utf-8')(sys.stdout.buffer, 'strict')

def test_api_results():
    """Prueba el endpoint de resultados"""
    url = "http://localhost:8000/api/results"
    
    try:
        print(f"Probando endpoint: {url}")
        
        response = requests.get(url, timeout=10)
        
        print(f"Status Code: {response.status_code}")
        print(f"Response Headers: {dict(response.headers)}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"Respuesta exitosa:")
            print(f"   Status: {data.get('status')}")
            print(f"   Count: {data.get('count')}")
            
            results = data.get('results', [])
            if results:
                print(f"Primer resultado:")
                first_result = results[0]
                
                # Acceder a metadata para obtener los datos básicos
                metadata = first_result.get('metadata', {})
                print(f"   Archivo: {metadata.get('original_filename')}")
                print(f"   Hash: {metadata.get('file_hash')}")
                print(f"   Email: {metadata.get('founder_email')}")
                print(f"   Fecha: {metadata.get('processed_at')}")
                print(f"   GCS Path: {metadata.get('gcs_path')}")
                
                # Mostrar KPIs si existen
                result_data = first_result.get('data', {})
                
                if result_data:
                    print(f"   KPIs extraidos:")
                    print(f"   {json.dumps(result_data, indent=4, ensure_ascii=False)}")
                else:
                    print(f"   No hay datos de KPIs disponibles")
            else:
                print("No hay resultados disponibles")
        else:
            print(f"Error en la respuesta:")
            print(f"   Status: {response.status_code}")
            print(f"   Text: {response.text}")
            
    except requests.exceptions.ConnectionError:
        print("Error de conexion: Asegurate que el servidor backend este corriendo en http://localhost:8000")
    except requests.exceptions.Timeout:
        print("Error de timeout: El servidor tardo demasiado en responder")
    except Exception as e:
        print(f"Error inesperado: {e}")

if __name__ == "__main__":
    test_api_results()
