import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { getQuarterBoundaries } from '../lib/kpiCalculations';
import {
  getBranchNames,
  getVerticalRevenue,
  getSpendByBranch,
  getSpendByChannel,
  getSpendByLocation,
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
      .select('location_id, region, store_name')
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((r) => {
          map[r.location_id] = `${r.region} — ${r.store_name || 'Online'}`;
        });
        setLocationLabels(map);
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
        </>
      )}
    </div>
  );
}
