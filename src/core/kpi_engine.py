import pandas as pd
import json

class KPIEngine:
    def __init__(self, dictionary_path='assets/kpi_dictionary.json'):
        with open(dictionary_path, 'r', encoding='utf-8') as f:
            self.rules = json.load(f)

    def get_company_context(self, company_id):
        """Retorna las reglas específicas del JSON para una empresa."""
        return self.rules.get(company_id, self.rules.get("Standard_KPIs"))

    def calculate_synthetic_metrics(self, current_data, history_df):
        """
        Calcula métricas faltantes como el Burn Multiple si no vienen en el PDF.
        Fórmula: $$\text{Burn Multiple} = \frac{\text{Net Burn}}{\text{Net New ARR}}$$
        """
        # Aquí añadiríamos lógica para calcular si faltan datos
        # Por ahora, aseguramos que el historial esté formateado para Gemini
        if history_df.empty:
            return "No hay historial previo para cálculos sintéticos."
        
        return history_df.tail(4).to_dict(orient='records') # Últimos 4 quarters