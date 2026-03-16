class FinancialAuditor:
    def __init__(self, threshold=0.05):
        self.threshold = threshold # 5% de tolerancia para discrepancias

    def build_audit_strategy(self, company_id, rules, history):
        """
        Construye la lógica narrativa que se le enviará a la IA.
        """
        target_kpis = rules.get('target_kpis', [])
        logic = rules.get('audit_logic', '')
        
        strategy = f"""
        ESTRATEGIA PARA {company_id}:
        1. PRIORIDAD: Extraer {', '.join(target_kpis)}.
        2. FOCO ESTRATÉGICO: {logic}.
        3. TOLERANCIA: Cualquier discrepancia Tabla vs Gráfico mayor al {self.threshold*100}% debe ser reportada.
        4. VERIFICACIÓN: Comparar contra la tendencia de los últimos periodos.
        """
        return strategy

    def check_anomalies(self, extracted_value, historical_value):
        """Lógica simple para detectar saltos extraños antes de confirmar el JSON."""
        if historical_value == 0: return False
        change = abs(extracted_value - historical_value) / historical_value
        return change > 0.50 # Alerta si hay un cambio mayor al 50%