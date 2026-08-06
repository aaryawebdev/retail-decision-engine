import { supabase } from './supabaseClient';
import { calcAllKPIs } from './kpiCalculations';

// Per-vertical KPI values are computed from a small number of transactions
// per quarter (often under 30), so quarter-over-quarter swings are noisy by
// nature — a naive 15% bar fires on almost every vertical/KPI/quarter
// combination, which drowns out anything genuinely worth investigating.
// This threshold is set high enough to filter routine noise while still
// catching real swings; it is a blunt instrument, not precise anomaly
// detection, and quieter quarters will still show a handful of alerts.
export const VERTICAL_KPI_THRESHOLD_PCT = 60;

export async function scanVerticalKPIAlerts(quarterLabel, boundaries) {
  const idx = boundaries.findIndex((b) => b.label === quarterLabel);
  if (idx === 0) return [];
  const { data: verticals } = await supabase.from('dim_vertical').select('vertical_id, vertical_name');
  const alerts = [];
  for (const v of verticals || []) {
    const current = await calcAllKPIs(quarterLabel, v.vertical_id, boundaries);
    const previous = await calcAllKPIs(boundaries[idx - 1].label, v.vertical_id, boundaries);
    for (const kpiKey of ['KPI01', 'KPI02', 'KPI03', 'KPI04']) {
      // KPI05 (Owned Brand Share) is group-level only, skipped per-vertical.
      const cur = current[kpiKey]?.value;
      const prev = previous[kpiKey]?.value;
      if (cur == null || prev == null || prev === 0) continue;
      const pctChange = ((cur - prev) / Math.abs(prev)) * 100;
      if (Math.abs(pctChange) >= VERTICAL_KPI_THRESHOLD_PCT) {
        alerts.push({
          type: 'vertical_kpi',
          vertical: v.vertical_name,
          verticalId: v.vertical_id,
          kpi: kpiKey,
          current: cur,
          previous: prev,
          pctChange,
        });
      }
    }
  }
  return alerts.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
}

// Store footfall (RET-05.1) is recorded only sporadically — a handful of
// point-in-time readings per store across the whole 24-month dataset, not a
// steady per-quarter series. That makes a quarter-sum-vs-prior-quarter-sum
// comparison meaningless (most quarters have zero rows for a given store).
// Instead, each reading in the selected quarter is compared against the
// cross-store average of every other reading in the full dataset — a
// reading far below that average (e.g. one store's footfall a fraction of
// what every other store reports) is what actually surfaces as a problem
// worth asking about.
const FOOTFALL_RATIO_THRESHOLD = 0.3; // flag readings below 30% of cross-store average

export async function scanStoreFootfallAlerts(quarterLabel, boundaries) {
  const idx = boundaries.findIndex((b) => b.label === quarterLabel);
  const q = boundaries[idx];

  const { data: allRows } = await supabase
    .from('fact_return')
    .select('location_id, value, transaction_date')
    .eq('ret_cat_id', 'RET-05.1');
  const rows = allRows || [];
  if (rows.length === 0) return [];

  const { data: stores } = await supabase
    .from('dim_location')
    .select('location_id, store_name')
    .eq('is_offline', true);
  const storeNameById = {};
  (stores || []).forEach((s) => {
    storeNameById[s.location_id] = s.store_name;
  });

  const rowsInQuarter = rows.filter((r) => r.transaction_date >= q.start && r.transaction_date < q.end);
  if (rowsInQuarter.length === 0) return [];

  const alerts = [];
  for (const row of rowsInQuarter) {
    const otherValues = rows.filter((r) => r.location_id !== row.location_id).map((r) => Number(r.value));
    if (otherValues.length === 0) continue;
    const crossStoreAvg = otherValues.reduce((s, v) => s + v, 0) / otherValues.length;
    if (crossStoreAvg === 0) continue;
    const value = Number(row.value);
    if (value < FOOTFALL_RATIO_THRESHOLD * crossStoreAvg) {
      const pctChange = ((value - crossStoreAvg) / crossStoreAvg) * 100;
      alerts.push({
        type: 'store_footfall',
        store: storeNameById[row.location_id] ?? `Location ${row.location_id}`,
        locationId: row.location_id,
        current: value,
        previous: crossStoreAvg, // cross-store average, used as the comparison baseline
        pctChange,
        transactionDate: row.transaction_date,
      });
    }
  }
  return alerts.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
}

// Day-level breakdown for a store within a quarter, to pinpoint the exact
// date of a swing.
export async function getStoreFootfallByDay(locationId, quarter) {
  const { data } = await supabase
    .from('fact_return')
    .select('transaction_date, value')
    .eq('ret_cat_id', 'RET-05.1')
    .eq('location_id', locationId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end)
    .order('transaction_date');
  return data || [];
}
