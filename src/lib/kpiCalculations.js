import { supabase } from './supabaseClient';

// kpi_target.period_value uses relative labels ('Q1'..'Q8', oldest to
// newest) while fact_investment/fact_return use real calendar dates. This
// finds the earliest transaction date across both fact tables and divides
// the following 24 months into 8 consecutive 3-month buckets so every KPI
// calculation below can filter by real date range while still speaking in
// the same quarter labels the targets use.
export async function getQuarterBoundaries() {
  const [{ data: invMin }, { data: retMin }] = await Promise.all([
    supabase
      .from('fact_investment')
      .select('transaction_date')
      .order('transaction_date', { ascending: true })
      .limit(1),
    supabase
      .from('fact_return')
      .select('transaction_date')
      .order('transaction_date', { ascending: true })
      .limit(1),
  ]);
  const earliestDate = [invMin?.[0]?.transaction_date, retMin?.[0]?.transaction_date]
    .filter(Boolean)
    .sort()[0];
  const baseStart = new Date(earliestDate);

  const boundaries = [];
  for (let i = 0; i < 8; i++) {
    const start = new Date(baseStart);
    start.setMonth(start.getMonth() + i * 3);
    const end = new Date(baseStart);
    end.setMonth(end.getMonth() + (i + 1) * 3);
    boundaries.push({
      label: `Q${i + 1}`,
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    });
  }
  return boundaries;
}

// ~1,900 rows total across both fact tables — client-side reduction is
// simpler and more reliable here than fighting PostgREST's aggregation
// syntax, so every calc below fetches raw rows for the quarter and reduces
// in JS rather than pushing SUM/AVG into the query.
async function fetchRows(table, categoryColumn, categoryValues, quarter, verticalId) {
  let query = supabase
    .from(table)
    .select('*')
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (categoryValues) query = query.in(categoryColumn, categoryValues);
  if (verticalId) query = query.eq('vertical_id', verticalId);
  const { data, error } = await query;
  if (error) console.error(`fetchRows failed for ${table}:`, error);
  return data || [];
}

export async function calcKPI01_NetRevenueGrowth(quarterLabel, verticalId, boundaries) {
  const idx = boundaries.findIndex((b) => b.label === quarterLabel);
  const current = await fetchRows('fact_return', 'ret_cat_id', ['RET-01.2'], boundaries[idx], verticalId);
  const currentSum = current.reduce((s, r) => s + Number(r.value), 0);
  if (idx === 0) return { value: null, revenueAmount: currentSum }; // no prior quarter to compare a growth rate against
  const previous = await fetchRows('fact_return', 'ret_cat_id', ['RET-01.2'], boundaries[idx - 1], verticalId);
  const previousSum = previous.reduce((s, r) => s + Number(r.value), 0);
  const growthPct = previousSum > 0 ? ((currentSum - previousSum) / previousSum) * 100 : null;
  return { value: growthPct, revenueAmount: currentSum };
}

export async function calcKPI02_BlendedROI(quarterLabel, verticalId, boundaries) {
  const q = boundaries.find((b) => b.label === quarterLabel);
  const returns = await fetchRows('fact_return', 'ret_cat_id', ['RET-01.2'], q, verticalId);
  const investments = await fetchRows('fact_investment', null, null, q, verticalId);
  const totalReturn = returns.reduce((s, r) => s + Number(r.value), 0);
  const totalInvestment = investments.reduce((s, r) => s + Number(r.amount_inr), 0);
  return { value: totalInvestment > 0 ? totalReturn / totalInvestment : 0 };
}

export async function calcKPI03_RepeatPurchaseRate(quarterLabel, verticalId, boundaries) {
  const q = boundaries.find((b) => b.label === quarterLabel);
  const rows = await fetchRows('fact_return', 'ret_cat_id', ['RET-03.2'], q, verticalId);
  const avg = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.value), 0) / rows.length : 0;
  return { value: avg };
}

export async function calcKPI04_BlendedCAC(quarterLabel, verticalId, boundaries) {
  const q = boundaries.find((b) => b.label === quarterLabel);
  const spendRows = await fetchRows('fact_investment', null, null, q, verticalId);
  const relevantSpend = spendRows.filter(
    (r) => r.inv_cat_id.startsWith('INV-01') || r.inv_cat_id.startsWith('INV-02') || r.inv_cat_id.startsWith('INV-03')
  );
  const totalSpend = relevantSpend.reduce((s, r) => s + Number(r.amount_inr), 0);
  const customerRows = await fetchRows('fact_return', 'ret_cat_id', ['RET-02.1'], q, verticalId);
  const totalNewCustomers = customerRows.reduce((s, r) => s + Number(r.value), 0);
  return { value: totalNewCustomers > 0 ? totalSpend / totalNewCustomers : 0 };
}

export async function calcKPI05_OwnedBrandShare(quarterLabel, boundaries) {
  // Group-level only, restricted to BPC + Offline Retail, per its formula.
  const q = boundaries.find((b) => b.label === quarterLabel);
  const { data: verticals } = await supabase
    .from('dim_vertical')
    .select('vertical_id, vertical_name')
    .in('vertical_name', ['BPC', 'Offline Retail']);
  const verticalIds = (verticals || []).map((v) => v.vertical_id);
  const { data: rows } = await supabase
    .from('fact_return')
    .select('value, brand_id')
    .eq('ret_cat_id', 'RET-01.2')
    .gte('transaction_date', q.start)
    .lt('transaction_date', q.end)
    .in('vertical_id', verticalIds);
  const { data: brands } = await supabase.from('dim_brand').select('brand_id, owned_flag');
  const ownedIds = new Set((brands || []).filter((b) => b.owned_flag).map((b) => b.brand_id));
  const total = (rows || []).reduce((s, r) => s + Number(r.value), 0);
  const owned = (rows || []).filter((r) => ownedIds.has(r.brand_id)).reduce((s, r) => s + Number(r.value), 0);
  return { value: total > 0 ? (owned / total) * 100 : 0 };
}

// Runs all five KPIs for a given quarter/vertical at once. KPI-05 is
// group-level only per its formula, so per-vertical calls skip it.
export async function calcAllKPIs(quarterLabel, verticalId, boundaries) {
  const [rev, roi, repeat, cac, owned] = await Promise.all([
    calcKPI01_NetRevenueGrowth(quarterLabel, verticalId, boundaries),
    calcKPI02_BlendedROI(quarterLabel, verticalId, boundaries),
    calcKPI03_RepeatPurchaseRate(quarterLabel, verticalId, boundaries),
    calcKPI04_BlendedCAC(quarterLabel, verticalId, boundaries),
    verticalId ? Promise.resolve({ value: null }) : calcKPI05_OwnedBrandShare(quarterLabel, boundaries),
  ]);
  return { KPI01: rev, KPI02: roi, KPI03: repeat, KPI04: cac, KPI05: owned };
}

export const KPI_CALCULATORS = {
  'KPI-01': calcKPI01_NetRevenueGrowth,
  'KPI-02': calcKPI02_BlendedROI,
  'KPI-03': calcKPI03_RepeatPurchaseRate,
  'KPI-04': calcKPI04_BlendedCAC,
  'KPI-05': (quarterLabel, verticalId, boundaries) =>
    verticalId ? Promise.resolve({ value: null }) : calcKPI05_OwnedBrandShare(quarterLabel, boundaries),
};

// Returns the matching target row for a KPI/quarter/vertical, preferring a
// vertical-specific target if one exists, falling back to the group-level
// (vertical_id IS NULL) target otherwise.
export async function getTarget(kpiCode, quarterLabel, verticalId) {
  const { data: kpi } = await supabase
    .from('dim_kpi')
    .select('kpi_id, direction')
    .eq('kpi_code', kpiCode)
    .single();
  if (!kpi) return null;
  const { data: rows } = await supabase
    .from('kpi_target')
    .select('*')
    .eq('kpi_id', kpi.kpi_id)
    .eq('period_value', quarterLabel);
  const specific = verticalId ? (rows || []).find((r) => r.vertical_id === verticalId) : null;
  const groupLevel = (rows || []).find((r) => r.vertical_id === null);
  return { target: specific || groupLevel || null, direction: kpi.direction };
}

// Compares an actual value to a target value, honoring KPI direction so
// callers don't need to special-case which KPIs invert (currently just
// CAC). Returns 'meets' | 'misses' | null (no target / no actual value).
export function compareToTarget(actualValue, targetValue, direction) {
  if (actualValue === null || actualValue === undefined) return null;
  if (targetValue === null || targetValue === undefined) return null;
  if (direction === 'lower_is_better') {
    return actualValue <= targetValue ? 'meets' : 'misses';
  }
  return actualValue >= targetValue ? 'meets' : 'misses';
}
