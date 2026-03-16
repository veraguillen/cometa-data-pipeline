// Script para probar el parseo de datos financieros
console.log("🧪 Probando parseo de datos financieros");

// Simular los datos que vienen del backend
const mockData = {
  financial_metrics_2025: {
    revenue_growth: {
      value: "36%",
      description: "Year-over-year revenue growth for full year 2025"
    },
    profit_margins: {
      gross_profit_margin: {
        value: "18.68%",
        description: "Gross Profit as a percentage of Revenue"
      },
      ebitda_margin: {
        value: "-0.74%",
        description: "EBITDA as a percentage of Revenue"
      }
    },
    cash_flow_indicators: {
      annual_cash_flow: {
        value: "$1.8M",
        description: "Positive cash flow for full year 2025"
      },
      cash_in_bank_end_of_year: {
        value: "$9.7M",
        description: "Cash left in the bank at the end of 2025"
      }
    },
    debt_ratios: {
      working_capital_debt: {
        value: "$12.0M",
        description: "Working Capital Debt as of Q4 2025"
      }
    }
  }
};

// Función parseFinancialValue simplificada
function parseFinancialValue(value) {
  if (!value) {
    return { value: 0, original: '' };
  }

  const original = value.trim();
  console.log(`🔍 Parseando: "${original}"`);
  
  // Manejar porcentajes
  if (original.includes('%')) {
    const numValue = parseFloat(original.replace('%', '').replace(',', '.'));
    const result = {
      value: isNaN(numValue) ? 0 : numValue,
      unit: '%',
      original
    };
    console.log(`✅ Porcentaje parseado:`, result);
    return result;
  }
  
  // Manejar valores monetarios
  if (original.includes('$')) {
    const cleanValue = original.replace('$', '').replace(',', '').trim();
    const match = cleanValue.match(/^(-?\d+\.?\d*)([A-Z])?$/);
    
    if (match) {
      const numValue = parseFloat(match[1]);
      const unit = match[2] || '';
      const result = {
        value: isNaN(numValue) ? 0 : numValue,
        unit,
        original
      };
      console.log(`✅ Monetario parseado:`, result);
      return result;
    }
  }
  
  // Manejar números simples
  const numValue = parseFloat(original.replace(',', '.'));
  const result = {
    value: isNaN(numValue) ? 0 : numValue,
    original
  };
  console.log(`✅ Simple parseado:`, result);
  return result;
}

// Función extractKeyMetrics
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

// Probar el flujo completo
console.log("\n📊 Datos originales:", JSON.stringify(mockData, null, 2));

const metrics = extractKeyMetrics(mockData);
console.log("\n🔑 Métricas extraídas:", metrics);

const parsedMetrics = {
  revenueGrowth: parseFinancialValue(metrics.revenueGrowth),
  grossMargin: parseFinancialValue(metrics.grossMargin),
  ebitdaMargin: parseFinancialValue(metrics.ebitdaMargin),
  cashInBank: parseFinancialValue(metrics.cashInBank),
  annualCashFlow: parseFinancialValue(metrics.annualCashFlow),
  workingCapitalDebt: parseFinancialValue(metrics.workingCapitalDebt),
};

console.log("\n💰 Métricas parseadas:");
console.log("  Revenue Growth:", parsedMetrics.revenueGrowth);
console.log("  Gross Margin:", parsedMetrics.grossMargin);
console.log("  EBITDA Margin:", parsedMetrics.ebitdaMargin);
console.log("  Cash in Bank:", parsedMetrics.cashInBank);
console.log("  Annual Cash Flow:", parsedMetrics.annualCashFlow);
console.log("  Working Capital Debt:", parsedMetrics.workingCapitalDebt);

// Datos para gráfico de barras
const comparisonData = [{
  name: "Skydropx Board Update",
  revenueGrowth: parsedMetrics.revenueGrowth.value,
  ebitdaMargin: parsedMetrics.ebitdaMargin.value,
  originalRevenue: parsedMetrics.revenueGrowth.original,
  originalEbitda: parsedMetrics.ebitdaMargin.original
}];

console.log("\n📈 Datos para gráfico de barras:", comparisonData);

// Análisis de márgenes
const marginAnalysis = {
  grossMargin: parsedMetrics.grossMargin,
  ebitdaMargin: parsedMetrics.ebitdaMargin,
  netMargin: Math.max(0, parsedMetrics.grossMargin.value - Math.abs(parsedMetrics.ebitdaMargin.value))
};

console.log("\n💼 Análisis de márgenes:", marginAnalysis);

console.log("\n✅ Prueba completada - Los datos deberían funcionar en los gráficos");
