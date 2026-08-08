import { supabase } from './supabaseClient';

export async function getBranchNames() {
  const { data } = await supabase
    .from('dim_investment_category')
    .select('inv_cat_id, name')
    .eq('level', 'branch');
  const map = {};
  (data || []).forEach((r) => {
    map[r.inv_cat_id] = r.name;
  });
  return map;
}

function branchOf(invCatId) {
  return invCatId.split('.')[0]; // 'INV-01.2' -> 'INV-01'
}

// Shared reference point, not per-category attribution — see the note
// rendered on the Operating screen. The data model has no field linking a
// specific investment transaction to the specific return it produced.
export async function getVerticalRevenue(verticalId, quarter) {
  const { data } = await supabase
    .from('fact_return')
    .select('value')
    .eq('ret_cat_id', 'RET-01.2')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  return (data || []).reduce((s, r) => s + Number(r.value), 0);
}

export async function getSpendByBranch(verticalId, quarter) {
  const { data } = await supabase
    .from('fact_investment')
    .select('inv_cat_id, amount_inr')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  const byBranch = {};
  (data || []).forEach((r) => {
    const b = branchOf(r.inv_cat_id);
    byBranch[b] = (byBranch[b] || 0) + Number(r.amount_inr);
  });
  return byBranch;
}

export async function getSpendByChannel(verticalId, quarter) {
  const { data } = await supabase
    .from('fact_investment')
    .select('channel_id, amount_inr')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  const byChannel = {};
  (data || []).forEach((r) => {
    byChannel[r.channel_id] = (byChannel[r.channel_id] || 0) + Number(r.amount_inr);
  });
  return byChannel;
}

export async function getSpendByLocation(verticalId, quarter) {
  // Only meaningful when verticalId corresponds to Offline Retail — the
  // screen should only offer this grouping option for that vertical.
  const { data } = await supabase
    .from('fact_investment')
    .select('location_id, amount_inr')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  const byLocation = {};
  (data || []).forEach((r) => {
    byLocation[r.location_id] = (byLocation[r.location_id] || 0) + Number(r.amount_inr);
  });
  return byLocation;
}

// ---------------------------------------------------------------------
// Micro KPIs — the same-formula-sliced-by-a-dimension pattern the macro
// KPIs use, but at channel/category level, for the Operating View's
// "where is the waste" question. Each answers a specific reallocation
// decision rather than a generic efficiency ratio.
// ---------------------------------------------------------------------

// Cost per New Customer, by channel — which channel is currently the
// cheapest acquisition engine, so next quarter's incremental budget can
// shift toward it. Same numerator scope as KPI-04 (Blended CAC): INV-01
// Performance + INV-02 Brand + INV-03 Content/Influencer only.
// Explains movement in: KPI-04 Blended CAC.
//
// channelId/locationId are optional narrowing filters (from the Operating
// View's filter bar) — when set, the table collapses to that one slice
// instead of breaking out every channel, which is what "respond to the
// Channel/Location filter" means for a table whose whole point is a
// channel breakdown.
export async function getCostPerNewCustomerByChannel(verticalId, quarter, channelId, locationId) {
  let spendQuery = supabase
    .from('fact_investment')
    .select('channel_id, inv_cat_id, amount_inr')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (channelId) spendQuery = spendQuery.eq('channel_id', channelId);
  if (locationId) spendQuery = spendQuery.eq('location_id', locationId);
  const { data: spendRows } = await spendQuery;
  const marketingSpend = (spendRows || []).filter(
    (r) => r.inv_cat_id.startsWith('INV-01') || r.inv_cat_id.startsWith('INV-02') || r.inv_cat_id.startsWith('INV-03')
  );
  const spendByChannel = {};
  marketingSpend.forEach((r) => {
    spendByChannel[r.channel_id] = (spendByChannel[r.channel_id] || 0) + Number(r.amount_inr);
  });

  let customerQuery = supabase
    .from('fact_return')
    .select('channel_id, value')
    .eq('vertical_id', verticalId)
    .eq('ret_cat_id', 'RET-02.1')
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (channelId) customerQuery = customerQuery.eq('channel_id', channelId);
  if (locationId) customerQuery = customerQuery.eq('location_id', locationId);
  const { data: customerRows } = await customerQuery;
  const customersByChannel = {};
  (customerRows || []).forEach((r) => {
    customersByChannel[r.channel_id] = (customersByChannel[r.channel_id] || 0) + Number(r.value);
  });

  const channelIds = new Set([...Object.keys(spendByChannel), ...Object.keys(customersByChannel)]);
  const rows = [...channelIds].map((cid) => {
    const spend = spendByChannel[cid] || 0;
    const customers = customersByChannel[cid] || 0;
    return { channelId: Number(cid), spend, customers, cac: customers > 0 ? spend / customers : null };
  });
  return rows;
}

// Brand Marketing Efficiency vs. Performance Marketing Efficiency — split
// out so a slow-payback brand campaign (INV-02) isn't judged on the same
// scale as a fast-payback performance campaign (INV-01) inside one blended
// "Marketing ROI" number. Both use the same Net Revenue numerator as the
// fixed KPI-02, just partitioned by branch instead of pooled.
// Explains movement in: KPI-02 Blended Marketing ROI.
export async function getBrandVsPerformanceEfficiency(verticalId, quarter, channelId, locationId) {
  let spendQuery = supabase
    .from('fact_investment')
    .select('inv_cat_id, amount_inr')
    .eq('vertical_id', verticalId)
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (channelId) spendQuery = spendQuery.eq('channel_id', channelId);
  if (locationId) spendQuery = spendQuery.eq('location_id', locationId);
  const { data: spendRows } = await spendQuery;

  const performanceSpend = (spendRows || [])
    .filter((r) => r.inv_cat_id.startsWith('INV-01'))
    .reduce((s, r) => s + Number(r.amount_inr), 0);
  const brandSpend = (spendRows || [])
    .filter((r) => r.inv_cat_id.startsWith('INV-02'))
    .reduce((s, r) => s + Number(r.amount_inr), 0);

  let returnQuery = supabase
    .from('fact_return')
    .select('value')
    .eq('vertical_id', verticalId)
    .eq('ret_cat_id', 'RET-01.2')
    .gte('transaction_date', quarter.start)
    .lt('transaction_date', quarter.end);
  if (channelId) returnQuery = returnQuery.eq('channel_id', channelId);
  if (locationId) returnQuery = returnQuery.eq('location_id', locationId);
  const { data: returnRows } = await returnQuery;
  const totalRevenue = (returnRows || []).reduce((s, r) => s + Number(r.value), 0);

  // Revenue isn't split by investment branch in this data model (no
  // transaction-level attribution — same limitation the efficiency table
  // above already discloses), so both ratios share the same revenue
  // numerator and differ only in which spend they're measured against.
  // That's still a meaningful comparison: it shows whether brand spend
  // looks disproportionately large or small next to performance spend for
  // the revenue this vertical produced, not a false claim of precise
  // per-campaign attribution.
  return {
    performanceSpend,
    brandSpend,
    performanceRatio: performanceSpend > 0 ? totalRevenue / performanceSpend : null,
    brandRatio: brandSpend > 0 ? totalRevenue / brandSpend : null,
  };
}

// Retention Program Payback — INV-05 (Loyalty & Retention spend) against
// RET-03.1 (Repeat Purchase Revenue), trended over the last few quarters.
// Answers whether loyalty/retention investment is generating repeat
// revenue or just running as a flat cost center.
// Explains movement in: KPI-03 Repeat Purchase Rate.
export async function getRetentionPayback(verticalId, quarterLabels, boundaries, channelId, locationId) {
  const points = await Promise.all(
    quarterLabels.map(async (label) => {
      const q = boundaries.find((b) => b.label === label);
      let spendQuery = supabase
        .from('fact_investment')
        .select('amount_inr, inv_cat_id')
        .eq('vertical_id', verticalId)
        .like('inv_cat_id', 'INV-05%')
        .gte('transaction_date', q.start)
        .lt('transaction_date', q.end);
      if (channelId) spendQuery = spendQuery.eq('channel_id', channelId);
      if (locationId) spendQuery = spendQuery.eq('location_id', locationId);
      let repeatQuery = supabase
        .from('fact_return')
        .select('value')
        .eq('vertical_id', verticalId)
        .eq('ret_cat_id', 'RET-03.1')
        .gte('transaction_date', q.start)
        .lt('transaction_date', q.end);
      if (channelId) repeatQuery = repeatQuery.eq('channel_id', channelId);
      if (locationId) repeatQuery = repeatQuery.eq('location_id', locationId);
      const [{ data: spendRows }, { data: repeatRows }] = await Promise.all([spendQuery, repeatQuery]);
      const retentionSpend = (spendRows || []).reduce((s, r) => s + Number(r.amount_inr), 0);
      const repeatRevenue = (repeatRows || []).reduce((s, r) => s + Number(r.value), 0);
      return { quarter: label, retentionSpend, repeatRevenue };
    })
  );
  return points;
}

// Brand Equity & Organic Pull — a lead indicator, not a lag one. Branded
// search, direct/type-in traffic and organic app installs (RET-04.1–.3)
// are the one part of the return tree built to move *before* revenue does
// (Stage 2 §3's "speed of return" distinction), and unlike every other KPI
// in this system, none of them are outcomes of a transaction — they're
// signals that brand pull is rising or falling ahead of the P&L showing it.
// Indexed to the first quarter with data (=100) so three differently-scaled
// series (search volume, traffic count, install count) can be read as one
// trend line instead of three incomparable numbers.
// Explains movement in: KPI-01 Group Net Revenue Growth (as an early
// warning — brand pull typically moves before revenue does).
export async function getBrandEquityTrend(verticalId, quarterLabels, boundaries, channelId, locationId) {
  const RET04_LEAVES = ['RET-04.1', 'RET-04.2', 'RET-04.3'];
  const rawPoints = await Promise.all(
    quarterLabels.map(async (label) => {
      const q = boundaries.find((b) => b.label === label);
      let query = supabase
        .from('fact_return')
        .select('value')
        .in('ret_cat_id', RET04_LEAVES)
        .gte('transaction_date', q.start)
        .lt('transaction_date', q.end);
      if (verticalId) query = query.eq('vertical_id', verticalId);
      if (channelId) query = query.eq('channel_id', channelId);
      if (locationId) query = query.eq('location_id', locationId);
      const { data } = await query;
      const total = (data || []).reduce((s, r) => s + Number(r.value), 0);
      return { quarter: label, total };
    })
  );
  const base = rawPoints.find((p) => p.total > 0)?.total || null;
  return rawPoints.map((p) => ({
    quarter: p.quarter,
    index: base ? (p.total / base) * 100 : null,
  }));
}

// Offline Conversion Efficiency — In-Store Conversion Rate (RET-05.2)
// against Offline Retail Investment (INV-06: rent, staffing, in-store
// marketing, launch costs), for the currently selected store/location.
// This is the one operational KPI that only means something once a
// specific Location is selected — a Retail Ops Head cannot act on a
// vertical-wide average when the decision is "is this store pulling its
// weight." Returns null when no location is selected, since averaging
// across stores would just reproduce the existing Location-grouped
// Spend Efficiency table instead of adding new information.
// Explains movement in: KPI-01 Group Net Revenue Growth (for Offline
// Retail specifically) and the Location-grouped Spend Efficiency ratio.
export async function getOfflineConversionEfficiency(verticalId, quarter, locationId) {
  if (!locationId) return null;
  const [{ data: conversionRows }, { data: investmentRows }] = await Promise.all([
    supabase
      .from('fact_return')
      .select('value')
      .eq('vertical_id', verticalId)
      .eq('location_id', locationId)
      .eq('ret_cat_id', 'RET-05.2')
      .gte('transaction_date', quarter.start)
      .lt('transaction_date', quarter.end),
    supabase
      .from('fact_investment')
      .select('amount_inr')
      .eq('vertical_id', verticalId)
      .eq('location_id', locationId)
      .like('inv_cat_id', 'INV-06%')
      .gte('transaction_date', quarter.start)
      .lt('transaction_date', quarter.end),
  ]);
  const rows = conversionRows || [];
  const avgConversionRate = rows.length > 0 ? rows.reduce((s, r) => s + Number(r.value), 0) / rows.length : null;
  const storeInvestment = (investmentRows || []).reduce((s, r) => s + Number(r.amount_inr), 0);
  return { avgConversionRate, storeInvestment };
}
