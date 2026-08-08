import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { supabase } from '../lib/supabaseClient';
import { getQuarterBoundaries } from '../lib/kpiCalculations';
import {
  getBranchNames,
  getVerticalRevenue,
  getSpendByBranch,
  getSpendByChannel,
  getSpendByLocation,
  getCostPerNewCustomerByChannel,
  getBrandVsPerformanceEfficiency,
  getRetentionPayback,
  getBrandEquityTrend,
  getOfflineConversionEfficiency,
} from '../lib/operatingCalculations';
import SupabaseSelect from '../components/SupabaseSelect';

const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];
const OFFLINE_RETAIL_NAME = 'Offline Retail';
const GROUP_BY_OPTIONS = ['Branch', 'Channel', 'Location'];

const SPEND_FN = {
  Branch: getSpendByBranch,
  Channel: getSpendByChannel,
  Location: getSpendByLocation,
};

function formatInr(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function formatRatio(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${n.toFixed(2)}×`;
}

function formatPctDelta(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export default function Operating() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Pre-fill from a click-through link (e.g. Leadership's "Verticals below
  // target" panel) if present, so the URL is shareable/reloadable — falls
  // back to the usual defaults (first vertical alphabetically, Q8) below
  // once the real vertical list loads.
  //
  // These can't just be useState initializers: React Router doesn't remount
  // this component when only the query string changes (same <Route>, same
  // path), so a useState initial-value argument only ever runs once per
  // component *instance* — not once per link click. Navigating here a
  // second time in the same session (e.g. Leadership -> Operating after
  // Operating was already visited) would silently keep the old state. The
  // effect below re-syncs from searchParams on every change instead.
  const initialVerticalId = searchParams.get('vertical');
  const initialQuarter = searchParams.get('quarter');

  const [boundaries, setBoundaries] = useState([]);
  const [verticalId, setVerticalId] = useState(initialVerticalId || '');
  const [verticalName, setVerticalName] = useState('');
  const [quarterLabel, setQuarterLabel] = useState(
    initialQuarter && QUARTER_LABELS.includes(initialQuarter) ? initialQuarter : 'Q8'
  );
  const [groupBy, setGroupBy] = useState('Branch');

  // Narrowing filters for the Operational KPI section only — the existing
  // Spend Efficiency table below is unaffected and keeps using Group By as
  // it always has.
  const [channelId, setChannelId] = useState('');
  const [locationId, setLocationId] = useState('');

  useEffect(() => {
    if (initialQuarter && QUARTER_LABELS.includes(initialQuarter)) {
      setQuarterLabel(initialQuarter);
    }
    if (initialVerticalId) {
      setVerticalId(initialVerticalId);
    }
    console.log('Operating: resolved quarter from URL ->', initialQuarter, '| applied:',
      initialQuarter && QUARTER_LABELS.includes(initialQuarter) ? initialQuarter : '(kept existing)');
  }, [initialQuarter, initialVerticalId]);

  const [branchNames, setBranchNames] = useState({});
  const [channelNames, setChannelNames] = useState({});
  const [locationLabels, setLocationLabels] = useState({});
  const [offlineLocationOptions, setOfflineLocationOptions] = useState([]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [threshold, setThreshold] = useState(null);
  const [thresholdTouched, setThresholdTouched] = useState(false);

  const isOfflineRetail = verticalName === OFFLINE_RETAIL_NAME;

  useEffect(() => {
    getQuarterBoundaries().then(setBoundaries);
    getBranchNames().then(setBranchNames);
    if (!initialVerticalId) {
      // No vertical specified on first load — default to the
      // alphabetically-first vertical. If a vertical *was* specified, the
      // name-resolution effect below (keyed on verticalId) handles it, and
      // also handles every subsequent click-through without needing a
      // remount.
      supabase
        .from('dim_vertical')
        .select('vertical_id, vertical_name')
        .order('vertical_name', { ascending: true })
        .limit(1)
        .then(({ data }) => {
          if (data && data.length > 0) {
            setVerticalId(data[0].vertical_id);
            setVerticalName(data[0].vertical_name);
          }
        });
    }
    supabase
      .from('dim_channel')
      .select('channel_id, channel_name')
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((r) => {
          map[r.channel_id] = r.channel_name;
        });
        setChannelNames(map);
      });
    supabase
      .from('dim_location')
      .select('location_id, region, store_name, is_offline')
      .then(({ data }) => {
        const map = {};
        const offlineOptions = [];
        (data || []).forEach((r) => {
          const label = `${r.region} — ${r.store_name || 'Online'}`;
          map[r.location_id] = label;
          if (r.is_offline) offlineOptions.push([r.location_id, label]);
        });
        setLocationLabels(map);
        setOfflineLocationOptions(offlineOptions);
      });
  }, []);

  // Resolves verticalName whenever verticalId changes — covers both the
  // SupabaseSelect dropdown (which already passes the row/name directly,
  // so this is a no-op there) and a click-through link setting verticalId
  // via the searchParams-sync effect above, including a second click-through
  // to a different vertical without a remount in between.
  useEffect(() => {
    if (!verticalId) return;
    supabase
      .from('dim_vertical')
      .select('vertical_name')
      .eq('vertical_id', verticalId)
      .single()
      .then(({ data }) => {
        if (data) setVerticalName(data.vertical_name);
      });
  }, [verticalId]);

  // Location grouping only makes sense for Offline Retail — fall back to
  // Branch if the vertical changes away from it while Location is selected.
  useEffect(() => {
    if (groupBy === 'Location' && !isOfflineRetail) {
      setGroupBy('Branch');
    }
  }, [isOfflineRetail, groupBy]);

  // Same rule for the Location filter itself, plus a full reset any time
  // the vertical changes — a channel/location picked for one vertical
  // rarely still applies to another.
  useEffect(() => {
    setChannelId('');
    setLocationId('');
  }, [verticalId]);

  useEffect(() => {
    if (locationId && !isOfflineRetail) {
      setLocationId('');
    }
  }, [isOfflineRetail, locationId]);

  const quarterIdx = QUARTER_LABELS.indexOf(quarterLabel);
  const prevQuarterLabel = quarterIdx > 0 ? QUARTER_LABELS[quarterIdx - 1] : null;

  useEffect(() => {
    if (boundaries.length === 0 || !verticalId) return;
    let cancelled = false;
    setLoading(true);

    (async () => {
      const quarter = boundaries[quarterIdx];
      const prevQuarter = prevQuarterLabel ? boundaries[quarterIdx - 1] : null;
      const spendFn = SPEND_FN[groupBy];

      const [revenue, spendByGroup, prevSpendByGroup] = await Promise.all([
        getVerticalRevenue(verticalId, quarter),
        spendFn(verticalId, quarter),
        prevQuarter ? spendFn(verticalId, prevQuarter) : Promise.resolve({}),
      ]);

      const nameMap =
        groupBy === 'Branch' ? branchNames : groupBy === 'Channel' ? channelNames : locationLabels;

      const computed = Object.entries(spendByGroup).map(([groupKey, spend]) => {
        const prevSpend = prevSpendByGroup[groupKey];
        const vsPrevious =
          prevSpend !== undefined && prevSpend > 0 ? ((spend - prevSpend) / prevSpend) * 100 : null;
        return {
          groupKey,
          name: nameMap[groupKey] ?? groupKey,
          spend,
          attributedReturn: revenue,
          ratio: spend > 0 ? revenue / spend : null,
          vsPrevious,
        };
      });

      computed.sort((a, b) => {
        if (a.ratio === null) return 1;
        if (b.ratio === null) return -1;
        return a.ratio - b.ratio;
      });

      if (cancelled) return;
      setRows(computed);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, verticalId, quarterIdx, prevQuarterLabel, groupBy, branchNames, channelNames, locationLabels]);

  const medianRatio = useMemo(() => {
    const ratios = rows.map((r) => r.ratio).filter((r) => r !== null).sort((a, b) => a - b);
    if (ratios.length === 0) return null;
    const mid = Math.floor(ratios.length / 2);
    return ratios.length % 2 !== 0 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  }, [rows]);

  // Reset the user-adjustable threshold to the freshly computed median
  // whenever the underlying rows change, unless the user has manually
  // edited it for this view already.
  useEffect(() => {
    if (!thresholdTouched) {
      setThreshold(medianRatio);
    }
  }, [medianRatio, thresholdTouched]);

  useEffect(() => {
    setThresholdTouched(false);
  }, [verticalId, quarterLabel, groupBy]);

  const candidates = useMemo(() => {
    if (threshold === null) return [];
    return rows.filter((r) => r.ratio !== null && r.ratio < threshold);
  }, [rows, threshold]);

  // Operational KPIs — sliced versions of the same marketing-efficiency
  // logic the macro (Leadership) KPIs use, at channel/category/location
  // level. Recomputed whenever vertical, quarter, channel or location
  // changes — independent of the Group By toggle, which only drives the
  // Spend Efficiency table below. Reuses the existing channelNames map
  // (fetched once above) rather than re-fetching.
  const [cacByChannel, setCacByChannel] = useState([]);
  const [brandVsPerformance, setBrandVsPerformance] = useState(null);
  const [retentionTrend, setRetentionTrend] = useState([]);
  const [brandEquityTrend, setBrandEquityTrend] = useState([]);
  const [offlineConversion, setOfflineConversion] = useState(null);
  const [microLoading, setMicroLoading] = useState(true);

  useEffect(() => {
    if (boundaries.length === 0 || !verticalId) return;
    let cancelled = false;
    setMicroLoading(true);

    (async () => {
      const quarter = boundaries[quarterIdx];
      const trailingLabels = QUARTER_LABELS.slice(0, quarterIdx + 1).slice(-4);

      const [cac, brandPerf, retention, brandEquity, offlineConv] = await Promise.all([
        getCostPerNewCustomerByChannel(verticalId, quarter, channelId, locationId),
        getBrandVsPerformanceEfficiency(verticalId, quarter, channelId, locationId),
        getRetentionPayback(verticalId, trailingLabels, boundaries, channelId, locationId),
        getBrandEquityTrend(verticalId, trailingLabels, boundaries, channelId, locationId),
        getOfflineConversionEfficiency(verticalId, quarter, locationId),
      ]);

      if (cancelled) return;
      setCacByChannel(cac);
      setOfflineConversion(offlineConv);
      setBrandVsPerformance(brandPerf);
      setRetentionTrend(retention);
      setBrandEquityTrend(brandEquity);
      setMicroLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, verticalId, quarterIdx, channelId, locationId]);

  // Operating Summary — plain-English read of the operational KPIs already
  // computed above (cacByChannel, brandVsPerformance, retentionTrend,
  // candidates). No new calculations; just picks out the most useful
  // findings for whatever vertical/quarter/channel/location/groupBy is
  // currently selected.
  const operatingSummary = useMemo(() => {
    if (!verticalId || microLoading || loading) return null;
    const lines = [];

    if (brandVsPerformance) {
      const { performanceRatio, brandRatio } = brandVsPerformance;
      if (performanceRatio !== null && brandRatio !== null) {
        if (brandRatio > performanceRatio) {
          lines.push(
            `Brand Marketing is currently more efficient than Performance Marketing (${brandRatio.toFixed(
              2
            )}× vs ${performanceRatio.toFixed(2)}×).`
          );
        } else if (performanceRatio > brandRatio) {
          lines.push(
            `Performance Marketing is currently more efficient than Brand Marketing (${performanceRatio.toFixed(
              2
            )}× vs ${brandRatio.toFixed(2)}×).`
          );
        } else {
          lines.push('Brand Marketing and Performance Marketing are running at about the same efficiency.');
        }
      } else if (performanceRatio !== null && brandRatio === null) {
        lines.push('Only Performance Marketing has recorded spend for this selection — no Brand Marketing spend to compare.');
      } else if (brandRatio !== null && performanceRatio === null) {
        lines.push('Only Brand Marketing has recorded spend for this selection — no Performance Marketing spend to compare.');
      }
    }

    if (cacByChannel.length > 0) {
      const withCac = cacByChannel.filter((r) => r.cac !== null);
      const withoutCac = cacByChannel.filter((r) => r.cac === null && r.spend > 0);
      if (withCac.length > 0) {
        const cheapest = withCac.slice().sort((a, b) => a.cac - b.cac)[0];
        const costliest = withCac.slice().sort((a, b) => b.cac - a.cac)[0];
        const cheapName = channelNames[cheapest.channelId] ?? cheapest.channelId;
        if (withCac.length > 1 && cheapest.channelId !== costliest.channelId) {
          const costName = channelNames[costliest.channelId] ?? costliest.channelId;
          lines.push(
            `${cheapName} has the lowest cost per new customer (${formatInr(cheapest.cac)}), while ${costName} has the highest (${formatInr(
              costliest.cac
            )}).`
          );
        } else {
          lines.push(`${cheapName} has a measurable cost per new customer of ${formatInr(cheapest.cac)}.`);
        }
      }
      if (withoutCac.length > 0) {
        const names = withoutCac.map((r) => channelNames[r.channelId] ?? r.channelId).join(', ');
        lines.push(`${names} ${withoutCac.length === 1 ? 'has' : 'have'} recorded spend but no new customers yet, so cost per new customer can't be calculated.`);
      }
    } else if (channelId || locationId) {
      lines.push('Not enough data is available for this selection to calculate cost per new customer.');
    }

    if (candidates.length > 0) {
      const names = candidates.slice(0, 3).map((c) => c.name).join(', ');
      lines.push(
        `${names} ${candidates.length === 1 ? 'is' : 'are'} flagged in Reallocation Candidates for running below the efficiency threshold.`
      );
    } else if (!loading && rows.length > 0) {
      lines.push(`No ${groupBy.toLowerCase()} is currently flagged below the efficiency threshold.`);
    }

    if (lines.length === 0) {
      lines.push('Not enough data is available for this selection to summarize operating performance.');
    }
    return lines.slice(0, 3);
  }, [
    verticalId,
    microLoading,
    loading,
    brandVsPerformance,
    cacByChannel,
    channelNames,
    channelId,
    locationId,
    candidates,
    rows,
    groupBy,
  ]);

  return (
    <div className="page page-wide">
      <h1>Operating View</h1>
      <p className="page-subtitle">
        Where is the spend concentrated, and how efficient does it look against the vertical's
        overall revenue? Read-only, scoped to one vertical at a time.
      </p>

      <div className="filter-bar">
        <div className="field">
          <label>Vertical</label>
          <SupabaseSelect
            table="dim_vertical"
            idColumn="vertical_id"
            labelColumn="vertical_name"
            value={verticalId}
            onChange={(id, row) => {
              setVerticalId(id);
              setVerticalName(row?.vertical_name || '');
            }}
            placeholder="Select vertical…"
          />
        </div>

        <div className="field">
          <label>Quarter</label>
          <select value={quarterLabel} onChange={(e) => setQuarterLabel(e.target.value)}>
            {QUARTER_LABELS.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Channel</label>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={!verticalId}
          >
            <option value="">All channels</option>
            {Object.entries(channelNames).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Location</label>
          <select
            value={locationId}
            onChange={(e) => setLocationId(e.target.value)}
            disabled={!verticalId || !isOfflineRetail}
            title={!isOfflineRetail ? 'Location filtering is only available for Offline Retail' : undefined}
          >
            <option value="">All locations</option>
            {offlineLocationOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Group By</label>
          <div className="toggle-group">
            {GROUP_BY_OPTIONS.map((opt) => {
              const disabled = opt === 'Location' && !isOfflineRetail;
              return (
                <button
                  key={opt}
                  type="button"
                  className={groupBy === opt ? 'toggle-btn active' : 'toggle-btn'}
                  onClick={() => !disabled && setGroupBy(opt)}
                  disabled={disabled}
                  title={disabled ? 'Location grouping is only available for Offline Retail' : undefined}
                >
                  {opt}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {!verticalId && <p>Select a vertical to see its spend efficiency.</p>}

      {verticalId && (
        <>
          <h2>Operational KPIs — {verticalName}, {quarterLabel}</h2>
          <p className="page-subtitle">
            Where the waste is, for a Marketing Manager or Vertical Head to act on directly. Each
            KPI below explains movement in a specific Leadership KPI, and narrows to whatever
            Channel and Location are selected above.
          </p>
          {microLoading && <p>Loading…</p>}
          {!microLoading && (
            <>
              <h3>Cost per New Customer, by Channel</h3>
              <p className="field-hint">Explains: KPI-04 Blended CAC.</p>
              {cacByChannel.length === 0 && <p>No performance/brand/content spend or new-customer data for this selection.</p>}
              {cacByChannel.length > 0 && (
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      <th>Marketing Spend</th>
                      <th>New Customers</th>
                      <th>Cost per New Customer</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cacByChannel
                      .slice()
                      .sort((a, b) => (a.cac ?? Infinity) - (b.cac ?? Infinity))
                      .map((r) => (
                        <tr key={r.channelId}>
                          <td>{channelNames[r.channelId] ?? r.channelId}</td>
                          <td>{formatInr(r.spend)}</td>
                          <td>{r.customers.toLocaleString('en-IN')}</td>
                          <td>{r.cac !== null ? formatInr(r.cac) : '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
              <p className="table-note">
                If Blended CAC on the Leadership screen rose this quarter, the channel with the
                highest cost here is usually why — lowest cost per new customer is the channel
                currently earning the next incremental acquisition rupee most efficiently, and a
                candidate to shift budget toward next quarter.
              </p>

              <h3>Brand vs. Performance Marketing Efficiency</h3>
              <p className="field-hint">Explains: KPI-02 Blended Marketing ROI.</p>
              {brandVsPerformance && (
                <div className="kpi-card-grid">
                  <div className="kpi-card">
                    <div className="kpi-card-name">Performance Marketing (INV-01)</div>
                    <div className="kpi-card-value">
                      {brandVsPerformance.performanceRatio !== null
                        ? `${brandVsPerformance.performanceRatio.toFixed(2)}×`
                        : '—'}
                    </div>
                    <div className="kpi-card-row">
                      <span>Spend:</span>
                      <span>{formatInr(brandVsPerformance.performanceSpend)}</span>
                    </div>
                  </div>
                  <div className="kpi-card">
                    <div className="kpi-card-name">Brand Marketing (INV-02)</div>
                    <div className="kpi-card-value">
                      {brandVsPerformance.brandRatio !== null
                        ? `${brandVsPerformance.brandRatio.toFixed(2)}×`
                        : '—'}
                    </div>
                    <div className="kpi-card-row">
                      <span>Spend:</span>
                      <span>{formatInr(brandVsPerformance.brandSpend)}</span>
                    </div>
                  </div>
                </div>
              )}
              <p className="table-note">
                Both ratios are this selection's revenue against each branch's own spend, shown
                separately rather than pooled into one Blended ROI — a dip in Marketing ROI on
                Leadership traces to whichever of these two moved. Brand campaigns are expected to
                look less efficient short-term than performance campaigns chasing the same
                revenue, so pooling them hides that difference instead of showing it.
              </p>

              <h3>Retention Program Payback — Trailing Quarters</h3>
              <p className="field-hint">Explains: KPI-03 Repeat Purchase Rate.</p>
              {retentionTrend.length > 0 && (
                <div className="trend-chart-card" style={{ maxWidth: 640 }}>
                  <div className="trend-chart-title">Loyalty/Retention Spend (INV-05) vs. Repeat Purchase Revenue (RET-03.1)</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={retentionTrend}>
                      <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
                      <YAxis hide />
                      <Tooltip formatter={(v) => formatInr(v)} />
                      <Line type="monotone" dataKey="retentionSpend" name="Retention Spend" stroke="#7B4FA8" strokeWidth={2} dot={{ r: 3 }} />
                      <Line type="monotone" dataKey="repeatRevenue" name="Repeat Purchase Revenue" stroke="#FF2E8B" strokeWidth={2} dot={{ r: 3 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              <p className="table-note">
                If retention spend is rising without a corresponding rise in repeat purchase
                revenue here, that's usually why Repeat Purchase Rate on Leadership isn't moving —
                the loyalty program is trending toward a cost center rather than paying back.
              </p>

              {isOfflineRetail && locationId && (
                <>
                  <h3>Offline Conversion Efficiency</h3>
                  <p className="field-hint">Explains: KPI-01 Group Net Revenue Growth (Offline Retail).</p>
                  {offlineConversion && (
                    <div className="kpi-card-grid">
                      <div className="kpi-card">
                        <div className="kpi-card-name">Avg. In-Store Conversion Rate</div>
                        <div className="kpi-card-value">
                          {offlineConversion.avgConversionRate !== null
                            ? `${offlineConversion.avgConversionRate.toFixed(1)}%`
                            : '—'}
                        </div>
                      </div>
                      <div className="kpi-card">
                        <div className="kpi-card-name">Store Investment (Rent, Staff, Launch)</div>
                        <div className="kpi-card-value">{formatInr(offlineConversion.storeInvestment)}</div>
                      </div>
                    </div>
                  )}
                  <p className="table-note">
                    A store carrying high rent/staff investment (INV-06) without a matching
                    conversion rate is a candidate for the Retail Ops Head to review — this is
                    what a Location-grouped ratio on its own can't show, since it only prices
                    spend against vertical-wide revenue, not against this store's own footfall
                    turning into sales.
                  </p>
                </>
              )}
              {isOfflineRetail && !locationId && (
                <p className="field-hint">Select a Location above to see Offline Conversion Efficiency for that store.</p>
              )}

              <h3>Brand Equity &amp; Organic Pull — Lead Indicator</h3>
              <p className="field-hint">
                Explains: KPI-01 Group Net Revenue Growth, ahead of time. Branded search volume,
                direct/type-in traffic and organic app installs (RET-04), indexed to the earliest
                quarter with data = 100. Unlike every other KPI on this screen, this is a lead
                indicator — it is built to move before revenue does, not after.
              </p>
              {brandEquityTrend.some((p) => p.index !== null) && (
                <div className="trend-chart-card" style={{ maxWidth: 640 }}>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={brandEquityTrend}>
                      <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
                      <YAxis hide />
                      <Tooltip formatter={(v) => (v !== null ? v.toFixed(1) : '—')} />
                      <Line type="monotone" dataKey="index" name="Brand Equity Index" stroke="#FF2E8B" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
              {!brandEquityTrend.some((p) => p.index !== null) && (
                <p>No RET-04 (Brand Equity) data recorded for this selection in the trailing quarters.</p>
              )}
            </>
          )}

          <div className="attribution-note">
            Attributed Return is the vertical's total net revenue for this period, shown as a
            shared reference point against each category's spend — the system does not track
            which specific transaction produced which specific return, so this is a proxy for
            efficiency, not precise per-category attribution. A lower ratio means a category is
            consuming a larger share of spend without the vertical's overall revenue reflecting
            it.
          </div>

          <h2>
            Spend Efficiency by {groupBy} — {verticalName}, {quarterLabel}
          </h2>
          {loading && <p>Loading…</p>}
          {!loading && (
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{groupBy}</th>
                  <th>Spend</th>
                  <th>Attributed Return</th>
                  <th>Ratio</th>
                  <th>vs Previous Quarter</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5}>No spend recorded for this vertical/quarter/grouping.</td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.groupKey}>
                    <td>{r.name}</td>
                    <td>{formatInr(r.spend)}</td>
                    <td>{formatInr(r.attributedReturn)}</td>
                    <td>{formatRatio(r.ratio)}</td>
                    <td>{formatPctDelta(r.vsPrevious)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Reallocation Candidates</h2>
          <div className="field threshold-field">
            <label>Ratio threshold (flag groups below this)</label>
            <input
              type="number"
              step="0.01"
              value={threshold ?? ''}
              onChange={(e) => {
                setThresholdTouched(true);
                setThreshold(e.target.value === '' ? null : Number(e.target.value));
              }}
            />
            <span className="field-hint">
              Defaults to the median ratio ({medianRatio !== null ? formatRatio(medianRatio) : '—'})
              across the rows above — adjust to tighten or loosen the flag.
            </span>
          </div>

          {!loading && candidates.length === 0 && <p>No groups fall below the current threshold.</p>}
          {!loading && candidates.length > 0 && (
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{groupBy}</th>
                  <th>Spend</th>
                  <th>Ratio</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((r) => (
                  <tr
                    key={r.groupKey}
                    className="row-invalid alert-row"
                    onClick={() =>
                      navigate(`/diagnostic?quarter=${quarterLabel}&vertical=${verticalId}`)
                    }
                    title="View this quarter's diagnostic alerts"
                  >
                    <td>{r.name}</td>
                    <td>{formatInr(r.spend)}</td>
                    <td>{formatRatio(r.ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="summary-box">
            <h2>Operating Summary</h2>
            {(microLoading || loading) && <p>Loading…</p>}
            {!microLoading && !loading && operatingSummary && (
              <ul>
                {operatingSummary.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
