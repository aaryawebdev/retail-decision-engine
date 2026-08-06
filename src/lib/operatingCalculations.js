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
