import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { supabase } from '../lib/supabaseClient';
import { getQuarterBoundaries, KPI_CALCULATORS } from '../lib/kpiCalculations';
import { getSpendByBranch } from '../lib/operatingCalculations';
import {
  scanVerticalKPIAlerts,
  scanStoreFootfallAlerts,
  getStoreFootfallByDay,
  getDrillBreakdown,
  getDrillByDay,
  VERTICAL_KPI_THRESHOLD_PCT,
} from '../lib/diagnosticCalculations';

const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];

const KPI_META = {
  KPI01: { code: 'KPI-01', name: 'Group Net Revenue Growth', format: 'percent' },
  KPI02: { code: 'KPI-02', name: 'Blended Marketing ROI', format: 'multiplier' },
  KPI03: { code: 'KPI-03', name: 'Repeat Purchase Rate', format: 'percent' },
  KPI04: { code: 'KPI-04', name: 'Blended CAC', format: 'currency' },
};

// Which investment branches to pair against each KPI's trend, per the
// prompt: revenue/ROI/CAC alerts all point back at the performance/brand/
// content spend branches (INV-01/02/03).
const RELEVANT_BRANCHES = ['INV-01', 'INV-02', 'INV-03'];

function formatValue(value, format) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  switch (format) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'multiplier':
      return `${value.toFixed(2)}×`;
    case 'currency':
      return `₹${Math.round(value).toLocaleString('en-IN')}`;
    default:
      return String(value);
  }
}

function formatPct(pct) {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return '—';
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

export default function Diagnostic() {
  const [searchParams] = useSearchParams();
  // Pre-fill from a click-through link (e.g. Operating's "Reallocation
  // candidates" panel) if present, so the URL is shareable/reloadable.
  const initialQuarter = searchParams.get('quarter');
  const linkedVerticalId = searchParams.get('vertical');

  const [boundaries, setBoundaries] = useState([]);
  const [quarterLabel, setQuarterLabel] = useState(
    initialQuarter && QUARTER_LABELS.includes(initialQuarter) ? initialQuarter : 'Q8'
  );
  const [alerts, setAlerts] = useState([]);
  const [alertsLoading, setAlertsLoading] = useState(true);
  const [autoSelectAttempted, setAutoSelectAttempted] = useState(false);

  const [selectedAlert, setSelectedAlert] = useState(null);
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  const [findingNote, setFindingNote] = useState('');

  // Progressive drill-down path for a vertical_kpi alert: each entry narrows
  // the next breakdown step further. Vertical is already fixed by the
  // selected alert, so the path starts at Channel. Store is only reachable
  // once a Product Category step has run and only for Offline Retail.
  const [drillPath, setDrillPath] = useState([]); // [{ dimension, id, label }, ...]
  const [breakdown, setBreakdown] = useState([]);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [dayBreakdown, setDayBreakdown] = useState(null);

  const [channelNames, setChannelNames] = useState({});
  const [productCategoryNames, setProductCategoryNames] = useState({});
  const [offlineLocationNames, setOfflineLocationNames] = useState({});

  useEffect(() => {
    getQuarterBoundaries().then(setBoundaries);
    supabase
      .from('dim_channel')
      .select('channel_id, channel_name')
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((r) => (map[r.channel_id] = r.channel_name));
        setChannelNames(map);
      });
    supabase
      .from('dim_product_category')
      .select('product_category_id, category_name')
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((r) => (map[r.product_category_id] = r.category_name));
        setProductCategoryNames(map);
      });
    supabase
      .from('dim_location')
      .select('location_id, region, store_name')
      .eq('is_offline', true)
      .then(({ data }) => {
        const map = {};
        (data || []).forEach((r) => (map[r.location_id] = `${r.region} — ${r.store_name}`));
        setOfflineLocationNames(map);
      });
  }, []);

  useEffect(() => {
    if (boundaries.length === 0) return;
    let cancelled = false;
    setAlertsLoading(true);
    setSelectedAlert(null);
    setDrillData(null);

    (async () => {
      const [kpiAlerts, footfallAlerts] = await Promise.all([
        scanVerticalKPIAlerts(quarterLabel, boundaries),
        scanStoreFootfallAlerts(quarterLabel, boundaries),
      ]);
      const combined = [...kpiAlerts, ...footfallAlerts].sort(
        (a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange)
      );
      if (cancelled) return;
      setAlerts(combined);
      setAlertsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, quarterLabel]);

  const selectAlert = async (alert) => {
    setSelectedAlert(alert);
    setDrillLoading(true);
    setFindingNote('');
    setDrillPath([]);
    setDayBreakdown(null);

    const idx = boundaries.findIndex((b) => b.label === quarterLabel);

    if (alert.type === 'store_footfall') {
      const dayRows = await getStoreFootfallByDay(alert.locationId, boundaries[idx]);
      setDrillData({ type: 'store_footfall', dayRows });
      setDrillLoading(false);
      return;
    }

    // vertical_kpi drill: KPI value across all 8 quarters, paired with the
    // relevant investment branches' spend across all 8 quarters, plus
    // best-so-far for the KPI itself.
    const calc = KPI_CALCULATORS[KPI_META[alert.kpi].code];
    const kpiSeries = await Promise.all(
      QUARTER_LABELS.map(async (q) => ({
        quarter: q,
        kpiValue: (await calc(q, alert.verticalId, boundaries))?.value ?? null,
      }))
    );
    const spendByQuarter = await Promise.all(
      QUARTER_LABELS.map(async (q, i) => {
        const spendByBranch = await getSpendByBranch(alert.verticalId, boundaries[i]);
        const relevantSpend = RELEVANT_BRANCHES.reduce((s, b) => s + (spendByBranch[b] || 0), 0);
        return relevantSpend;
      })
    );
    const combinedSeries = kpiSeries.map((point, i) => ({
      ...point,
      relevantSpend: spendByQuarter[i],
    }));

    const validKpiValues = kpiSeries.map((p) => p.kpiValue).filter((v) => v !== null && !Number.isNaN(v));
    const isLowerBetter = alert.kpi === 'KPI04';
    const bestSoFar =
      validKpiValues.length > 0
        ? isLowerBetter
          ? Math.min(...validKpiValues)
          : Math.max(...validKpiValues)
        : null;

    setDrillData({ type: 'vertical_kpi', series: combinedSeries, bestSoFar });
    setDrillLoading(false);
  };

  // Drill order for a vertical_kpi alert: Channel -> Product Category ->
  // Store (Offline Retail only) -> Time. Vertical is already fixed by the
  // alert itself, so it isn't a step here. Store is skipped for verticals
  // that aren't Offline Retail, since location_id is only meaningfully
  // populated (real stores, not just "Online — National") there.
  const nextDimension = () => {
    const done = drillPath.map((p) => p.dimension);
    if (!done.includes('channel_id')) return 'channel_id';
    if (!done.includes('product_category_id')) return 'product_category_id';
    if (!done.includes('location_id') && selectedAlert?.vertical === 'Offline Retail') return 'location_id';
    return null; // path exhausted -> Time step
  };

  const pathToFilters = (path) => {
    const filters = { verticalId: selectedAlert?.verticalId };
    path.forEach((p) => {
      if (p.dimension === 'channel_id') filters.channelId = p.id;
      if (p.dimension === 'product_category_id') filters.productCategoryId = p.id;
      if (p.dimension === 'location_id') filters.locationId = p.id;
    });
    return filters;
  };

  const dimensionLabel = (dimension, key) => {
    if (dimension === 'channel_id') return channelNames[key] ?? key;
    if (dimension === 'product_category_id') return productCategoryNames[key] ?? key;
    if (dimension === 'location_id') return offlineLocationNames[key] ?? key;
    return key;
  };

  const dimensionStepName = {
    channel_id: 'Channel',
    product_category_id: 'Product Category',
    location_id: 'Store',
  };

  // Re-fetches the breakdown (or the day-level table, once the path is
  // exhausted) whenever the selected alert or the accumulated drill path
  // changes. Only runs for vertical_kpi alerts — store_footfall alerts keep
  // their existing single-step day drill untouched.
  useEffect(() => {
    if (!selectedAlert || selectedAlert.type !== 'vertical_kpi' || boundaries.length === 0) return;
    let cancelled = false;
    const idx = boundaries.findIndex((b) => b.label === quarterLabel);
    const quarter = boundaries[idx];
    const filters = pathToFilters(drillPath);
    const dim = nextDimension();

    if (dim) {
      setBreakdownLoading(true);
      setDayBreakdown(null);
      getDrillBreakdown(dim, quarter, filters).then((rows) => {
        if (cancelled) return;
        setBreakdown(rows.sort((a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity)));
        setBreakdownLoading(false);
      });
    } else {
      setBreakdownLoading(true);
      setBreakdown([]);
      getDrillByDay(quarter, filters).then((rows) => {
        if (cancelled) return;
        setDayBreakdown(rows);
        setBreakdownLoading(false);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [selectedAlert, drillPath, boundaries, quarterLabel]);

  // Auto-select the alert matching a click-through link's vertical, once
  // per landing on this quarter via a link. If nothing matches — likely,
  // since Diagnostic's alerts aren't the same computation as Operating's
  // reallocation candidates — just leave the full list showing rather than
  // forcing a match that isn't there.
  useEffect(() => {
    if (!linkedVerticalId || autoSelectAttempted || alertsLoading || alerts.length === 0) return;
    setAutoSelectAttempted(true);
    const match = alerts.find(
      (a) => a.type === 'vertical_kpi' && String(a.verticalId) === String(linkedVerticalId)
    );
    if (match) selectAlert(match);
  }, [linkedVerticalId, autoSelectAttempted, alertsLoading, alerts]);

  const alertLabel = (alert) => {
    if (alert.type === 'store_footfall') return alert.store;
    return `${alert.vertical} — ${KPI_META[alert.kpi]?.name ?? alert.kpi}`;
  };

  const alertFormat = (alert) => {
    if (alert.type === 'store_footfall') return 'count';
    return KPI_META[alert.kpi]?.format ?? 'default';
  };

  const formatAlertValue = (value, alert) => {
    const format = alertFormat(alert);
    if (format === 'count') {
      return value === null || value === undefined ? '—' : Math.round(value).toLocaleString('en-IN');
    }
    return formatValue(value, format);
  };

  // Diagnostic Summary — plain-English read of the alerts and drill-down
  // already computed above. No new alert logic; just describes what the
  // biggest alert is and, if the user has started drilling in, what the
  // breakdown so far is pointing at. Never claims a cause — only the
  // existing drill-down data can do that.
  const diagnosticSummary = (() => {
    if (alertsLoading) return null;
    if (alerts.length === 0) {
      return [`No alerts for ${quarterLabel} — nothing crossed the movement threshold this quarter.`];
    }

    const lines = [];
    const top = alerts[0];
    const topLabel = alertLabel(top);
    const dirWord = top.pctChange >= 0 ? 'up' : 'down';
    lines.push(
      `The largest movement is ${topLabel} — ${dirWord} ${formatPct(Math.abs(top.pctChange)).replace('+', '')} vs. ${
        top.type === 'store_footfall' ? 'the cross-store average' : 'last quarter'
      }.`
    );

    if (alerts.length > 1) {
      lines.push(`${alerts.length - 1} other alert${alerts.length - 1 === 1 ? '' : 's'} also crossed the threshold this quarter.`);
    }

    if (selectedAlert) {
      const selLabel = alertLabel(selectedAlert);
      if (selectedAlert.type === 'vertical_kpi') {
        if (drillPath.length === 0) {
          lines.push(
            `The alert on ${selLabel} identifies the area for investigation, but the cause needs to be checked through the channel and product drill-down below.`
          );
        } else {
          const lastStep = drillPath[drillPath.length - 1];
          const stepName = dimensionStepName[lastStep.dimension];
          lines.push(
            `So far, drilling into ${selLabel} points to ${stepName} "${lastStep.label}" — further drill-down is needed to confirm this is the main driver.`
          );
        }
      } else {
        lines.push(`${selLabel}'s day-level readings are shown below — check whether the drop is a single day or spread across the quarter.`);
      }
    }

    return lines.slice(0, 3);
  })();

  return (
    <div className="page page-wide">
      <h1>Diagnostic View</h1>
      <p className="page-subtitle">
        What broke, and when. Read-only. Scanning is deliberately narrow — vertical-level KPI
        swings quarter-over-quarter, and store-level footfall swings for Offline Retail — not
        every possible dimension combination.
      </p>

      <div className="attribution-note">
        Per-vertical KPI values come from a small number of transactions per quarter, so
        quarter-over-quarter swings are noisy by nature. The threshold below (
        {VERTICAL_KPI_THRESHOLD_PCT}%) is set high enough to filter routine noise, but this list is
        a starting point for questions, not a verdict. Store footfall is recorded only
        sporadically (a handful of point-in-time readings per store across the whole dataset), so
        footfall alerts compare each reading to the cross-store average rather than to a prior
        quarter.
      </div>

      <div className="filter-bar">
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
      </div>

      <h2>Alerts — {quarterLabel}</h2>
      {alertsLoading && <p>Loading…</p>}
      {!alertsLoading && alerts.length === 0 && <p>No alerts for this quarter.</p>}
      {!alertsLoading && alerts.length > 0 && (
        <table className="preview-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Vertical / Store</th>
              <th>Current</th>
              <th>Previous</th>
              <th>% Change</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a, i) => (
              <tr
                key={i}
                className={selectedAlert === a ? 'row-selected alert-row' : 'alert-row'}
                onClick={() => selectAlert(a)}
              >
                <td>{a.type === 'store_footfall' ? 'Store Footfall' : 'Vertical KPI'}</td>
                <td>{alertLabel(a)}</td>
                <td>{formatAlertValue(a.current, a)}</td>
                <td>{formatAlertValue(a.previous, a)}</td>
                <td>
                  {a.pctChange >= 0 ? '↑' : '↓'} {formatPct(a.pctChange)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selectedAlert && (
        <>
          <h2>Drill Down — {alertLabel(selectedAlert)}</h2>
          {drillLoading && <p>Loading…</p>}

          {!drillLoading && drillData?.type === 'store_footfall' && (
            <>
              <p>Day-level footfall readings within {quarterLabel}:</p>
              {drillData.dayRows.length === 0 && <p>No day-level readings in this quarter.</p>}
              {drillData.dayRows.length > 0 && (
                <table className="preview-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Footfall</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillData.dayRows.map((r) => (
                      <tr
                        key={r.transaction_date}
                        className={Number(r.value) === selectedAlert.current ? 'row-invalid' : ''}
                      >
                        <td>{r.transaction_date}</td>
                        <td>{Math.round(Number(r.value)).toLocaleString('en-IN')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="table-note">
                Compared against the cross-store average of {Math.round(selectedAlert.previous).toLocaleString('en-IN')}{' '}
                (all stores, all 24 months) — {selectedAlert.store} isn't read frequently enough for
                a same-store prior-quarter comparison to be meaningful.
              </p>
            </>
          )}

          {!drillLoading && drillData?.type === 'vertical_kpi' && (
            <>
              <div className="kpi-card-row" style={{ marginBottom: 12 }}>
                <span>Best So Far (all 8 quarters, this vertical):</span>
                <span>{formatValue(drillData.bestSoFar, KPI_META[selectedAlert.kpi]?.format)}</span>
              </div>
              <div className="trend-chart-card" style={{ maxWidth: 640 }}>
                <div className="trend-chart-title">
                  {KPI_META[selectedAlert.kpi]?.name} vs. INV-01/02/03 Spend — {selectedAlert.vertical}
                </div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={drillData.series}>
                    <XAxis dataKey="quarter" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="kpi" hide />
                    <YAxis yAxisId="spend" orientation="right" hide />
                    <Tooltip />
                    <Legend />
                    <Line
                      yAxisId="kpi"
                      type="monotone"
                      dataKey="kpiValue"
                      name={KPI_META[selectedAlert.kpi]?.name}
                      stroke="#FF2E8B"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      connectNulls={false}
                    />
                    <Line
                      yAxisId="spend"
                      type="monotone"
                      dataKey="relevantSpend"
                      name="INV-01/02/03 Spend"
                      stroke="#7B4FA8"
                      strokeWidth={2}
                      dot={{ r: 3 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="table-note">
                Two independent series on separate scales — the KPI's own value, and this
                vertical's performance/brand/content investment spend — shown together to see
                whether a spend change coincided with the KPI's swing. This is not a claim that one
                caused the other.
              </p>

              <h3>Investigate — {selectedAlert.vertical}</h3>
              <p className="field-hint" style={{ marginBottom: 6 }}>
                Narrow the vertical's spend and revenue one dimension at a time to find where the
                swing is concentrated: Channel → Product Category
                {selectedAlert.vertical === 'Offline Retail' ? ' → Store' : ''} → Time.
              </p>

              <div className="radio-group" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
                <span
                  className={drillPath.length === 0 ? 'badge badge-green' : 'badge badge-grey'}
                  style={drillPath.length > 0 ? { cursor: 'pointer' } : undefined}
                  onClick={() => drillPath.length > 0 && setDrillPath([])}
                >
                  {selectedAlert.vertical}
                </span>
                {drillPath.map((step, i) => (
                  <span
                    key={step.dimension}
                    className={i === drillPath.length - 1 ? 'badge badge-green' : 'badge badge-grey'}
                    style={i < drillPath.length - 1 ? { cursor: 'pointer' } : undefined}
                    onClick={() => i < drillPath.length - 1 && setDrillPath(drillPath.slice(0, i + 1))}
                  >
                    {dimensionStepName[step.dimension]}: {step.label}
                  </span>
                ))}
              </div>

              {breakdownLoading && <p>Loading…</p>}

              {!breakdownLoading && nextDimension() && (
                <>
                  <p className="table-note">
                    By {dimensionStepName[nextDimension()]} — click a row to narrow further.
                  </p>
                  {breakdown.length === 0 && <p>No spend or revenue recorded for this selection.</p>}
                  {breakdown.length > 0 && (
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>{dimensionStepName[nextDimension()]}</th>
                          <th>Marketing Spend</th>
                          <th>Net Revenue</th>
                          <th>Ratio</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.map((row) => {
                          const dim = nextDimension();
                          return (
                            <tr
                              key={row.key}
                              className="alert-row"
                              onClick={() =>
                                setDrillPath([
                                  ...drillPath,
                                  { dimension: dim, id: row.key, label: dimensionLabel(dim, row.key) },
                                ])
                              }
                            >
                              <td>{dimensionLabel(dim, row.key)}</td>
                              <td>{formatValue(row.spend, 'currency')}</td>
                              <td>{formatValue(row.revenue, 'currency')}</td>
                              <td>{row.ratio !== null ? `${row.ratio.toFixed(2)}×` : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {!breakdownLoading && !nextDimension() && dayBreakdown && (
                <>
                  <p className="table-note">Day-level, within {quarterLabel} — the narrowest this drill-down goes.</p>
                  {dayBreakdown.length === 0 && <p>No spend or revenue recorded on any day for this selection.</p>}
                  {dayBreakdown.length > 0 && (
                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Marketing Spend</th>
                          <th>Net Revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dayBreakdown.map((r) => (
                          <tr key={r.date}>
                            <td>{r.date}</td>
                            <td>{formatValue(r.spend, 'currency')}</td>
                            <td>{formatValue(r.revenue, 'currency')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </>
          )}

          <h3>Finding Note</h3>
          <p className="field-hint" style={{ marginBottom: 6 }}>
            Not saved — for discussion during the presentation only.
          </p>
          <textarea
            className="finding-note"
            rows={4}
            value={findingNote}
            onChange={(e) => setFindingNote(e.target.value)}
            placeholder="Jot down what you think happened here — this is scratch space, not persisted anywhere."
          />
        </>
      )}

      <div className="summary-box">
        <h2>Diagnostic Summary</h2>
        {alertsLoading && <p>Loading…</p>}
        {!alertsLoading && diagnosticSummary && (
          <ul>
            {diagnosticSummary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
