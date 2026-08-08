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

// ---------------------------------------------------------------------
// Progressive drill-down for a vertical_kpi alert: Vertical (already
// selected via the alert) -> Channel -> Product Category -> Store
// (Offline Retail only) -> Time. Each step narrows both fact_investment
// and fact_return by whatever filters accumulated at the steps above it,
// and reports on the same two series the alert itself is about — spend
// (INV-01/02/03, matching the KPI trend chart already shown) and revenue
// (RET-01.2) — so a person can see where within the vertical a swing is
// concentrated. There is no campaign dimension anywhere in this schema
// (no campaign_id, no campaign table, and the notes column is unused seed
// filler) — Campaign is intentionally not a drill step here, rather than
// inventing one.
// ---------------------------------------------------------------------

async function fetchFilteredRows(table, categoryColumn, categoryValues, quarter, filters) {
  let query = supabase
    .from(table)
    .select('*')
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (categoryValues) query = query.in(categoryColumn, categoryValues);
  if (filters.verticalId) query = query.eq('vertical_id', filters.verticalId);
  if (filters.channelId) query = query.eq('channel_id', filters.channelId);
  if (filters.productCategoryId) query = query.eq('product_category_id', filters.productCategoryId);
  if (filters.locationId) query = query.eq('location_id', filters.locationId);
  const { data, error } = await query;
  if (error) console.error(`fetchFilteredRows failed for ${table}:`, error);
  return data || [];
}

const MARKETING_BRANCH_PREFIXES = ['INV-01', 'INV-02', 'INV-03'];

function sumMarketingSpend(rows) {
  return rows
    .filter((r) => MARKETING_BRANCH_PREFIXES.some((p) => r.inv_cat_id.startsWith(p)))
    .reduce((s, r) => s + Number(r.amount_inr), 0);
}

function sumRevenue(rows) {
  return rows.filter((r) => r.ret_cat_id === 'RET-01.2').reduce((s, r) => s + Number(r.value), 0);
}

// One breakdown step: groups spend + revenue by whichever dimension key is
// requested, within the quarter and whatever filters are already applied
// from steps above. `dimension` is 'channel_id' | 'product_category_id' |
// 'location_id'.
export async function getDrillBreakdown(dimension, quarter, filters) {
  const [investmentRows, returnRows] = await Promise.all([
    fetchFilteredRows('fact_investment', null, null, quarter, filters),
    fetchFilteredRows('fact_return', 'ret_cat_id', ['RET-01.2'], quarter, filters),
  ]);

  const keys = new Set([
    ...investmentRows.map((r) => r[dimension]).filter((v) => v !== null && v !== undefined),
    ...returnRows.map((r) => r[dimension]).filter((v) => v !== null && v !== undefined),
  ]);

  return [...keys].map((key) => {
    const invForKey = investmentRows.filter((r) => r[dimension] === key);
    const retForKey = returnRows.filter((r) => r[dimension] === key);
    const spend = sumMarketingSpend(invForKey);
    const revenue = sumRevenue(retForKey);
    return { key, spend, revenue, ratio: spend > 0 ? revenue / spend : null };
  });
}

// Final Time step: day-level spend + revenue for whatever filters have
// accumulated through Channel/Product Category/Store, within the alert's
// quarter — the same "pinpoint the exact date" job getStoreFootfallByDay
// already does for footfall alerts, generalized to any filter combination.
export async function getDrillByDay(quarter, filters) {
  const [investmentRows, returnRows] = await Promise.all([
    fetchFilteredRows('fact_investment', null, null, quarter, filters),
    fetchFilteredRows('fact_return', 'ret_cat_id', ['RET-01.2'], quarter, filters),
  ]);

  const byDay = {};
  investmentRows.forEach((r) => {
    if (!MARKETING_BRANCH_PREFIXES.some((p) => r.inv_cat_id.startsWith(p))) return;
    const d = r.transaction_date;
    byDay[d] = byDay[d] || { date: d, spend: 0, revenue: 0 };
    byDay[d].spend += Number(r.amount_inr);
  });
  returnRows.forEach((r) => {
    const d = r.transaction_date;
    byDay[d] = byDay[d] || { date: d, spend: 0, revenue: 0 };
    byDay[d].revenue += Number(r.value);
  });

  return Object.values(byDay).sort((a, b) => (a.date < b.date ? -1 : 1));
}
