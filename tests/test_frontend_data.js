// Script para probar la estructura de datos que espera el frontend
const mockData = {
  "status": "success",
  "count": 1,
  "results": [
    {
      "id": "ee145375b7da8714",
      "data": {
        "financial_metrics_2025": {
          "revenue_growth": {
            "value": "36%",
            "description": "Year-over-year revenue growth for full year 2025, compared to 2024 (Source: Page 11)."
          },
          "profit_margins": {
            "gross_profit_margin": {
              "value": "18.68%",
              "description": "Gross Profit as a percentage of Revenue for full year 2025 (Gross Profit: $22.133M, Revenue: $118.450M) (Source: Pages 11 & 15)."
            },
            "ebitda_margin": {
              "value": "-0.74%",
              "description": "EBITDA as a percentage of Revenue for full year 2025 (EBITDA: -$(880)K, Revenue: $118.450M) (Source: Pages 11 & 28)."
            }
          },
          "cash_flow_indicators": {
            "annual_cash_flow": {
              "value": "$1.8M",
              "description": "Positive cash flow for full year 2025 (Source: Page 2 & 3)."
            },
            "cash_in_bank_end_of_year": {
              "value": "$9.7M",
              "description": "Cash left in the bank at the end of 2025 (Source: Page 2 & 3)."
            }
          },
          "debt_ratios": {
            "working_capital_debt": {
              "value": "$12.0M",
              "description": "Working Capital Debt as of Q4 2025 (Source: Page 30)."
            },
            "net_working_capital": {
              "value": "-$2.3M",
              "description": "Net Working Capital as of Q4 2025 (Source: Page 30)."
            }
          }
        }
      },
      "date": "2026-03-05T12:34:20.170155",
      "metadata": {
        "file_hash": "ee145375b7da8714",
        "original_filename": "ee145375b7da8714_Skydropx _ Board Update _ Annual, Q4 & December 2025.pdf",
        "founder_email": "vera@cometa.vc",
        "processed_at": "2026-03-05T12:34:20.170155",
        "gcs_path": "staging/ee145375b7da8714_result.json"
      }
    }
  ]
};

// Simular la función extractKeyMetrics del frontend
function extractKeyMetrics(data) {
  const metrics = data?.financial_metrics_2025;
  
  return {
    revenueGrowth: metrics?.revenue_growth?.value,
    grossMargin: metrics?.profit_margins?.gross_profit_margin?.value,
    ebitdaMargin: metrics?.profit_margins?.ebitda_margin?.value,
    cashInBank: metrics?.cash_flow_indicators?.cash_in_bank_end_of_year?.value,
    annualCashFlow: metrics?.cash_flow_indicators?.annual_cash_flow?.value,
    workingCapitalDebt: metrics?.debt_ratios?.working_capital_debt?.value,
  };
}

function cleanFilename(filename) {
  return filename.replace(/^[a-f0-9]+_/, '');
}

// Probar la extracción de datos
console.log('🧪 Probando extracción de KPIs...');
const result = mockData.results[0];
const metrics = extractKeyMetrics(result.data);
const cleanName = cleanFilename(result.metadata.original_filename);

console.log('📄 Archivo limpio:', cleanName);
console.log('📊 KPIs extraídos:');
console.log('  Revenue Growth:', metrics.revenueGrowth);
console.log('  Gross Margin:', metrics.grossMargin);
console.log('  EBITDA Margin:', metrics.ebitdaMargin);
console.log('  Cash in Bank:', metrics.cashInBank);
console.log('  Annual Cash Flow:', metrics.annualCashFlow);
console.log('  Working Capital Debt:', metrics.workingCapitalDebt);

console.log('\n✅ Estructura de datos compatible con el frontend');
