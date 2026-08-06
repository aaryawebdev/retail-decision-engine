import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis, Tooltip } from 'recharts';
import { supabase } from '../lib/supabaseClient';
import {
  getQuarterBoundaries,
  calcAllKPIs,
  getTarget,
  compareToTarget,
  KPI_CALCULATORS,
} from '../lib/kpiCalculations';

const QUARTER_LABELS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];

const KPI_META = [
  { code: 'KPI-01', key: 'KPI01', name: 'Group Net Revenue Growth', format: 'percent' },
  { code: 'KPI-02', key: 'KPI02', name: 'Blended Marketing ROI', format: 'multiplier' },
  { code: 'KPI-03', key: 'KPI03', name: 'Repeat Purchase Rate', format: 'percent' },
  { code: 'KPI-04', key: 'KPI04', name: 'Blended CAC', format: 'currency' },
  { code: 'KPI-05', key: 'KPI05', name: 'Owned Brand Contribution Share', format: 'percent' },
];

const VERTICAL_OPTIONS = [
  { id: null, label: 'All' },
  { id: 1, label: 'BPC' },
  { id: 2, label: 'Fashion' },
  { id: 3, label: 'eB2B' },
  { id: 4, label: 'Offline Retail' },
];

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

function formatDelta(delta, format) {
  if (delta === null || delta === undefined || Number.isNaN(delta)) return '—';
  const sign = delta > 0 ? '+' : '';
  switch (format) {
    case 'percent':
      return `${sign}${delta.toFixed(1)} pts`;
    case 'multiplier':
      return `${sign}${delta.toFixed(2)}×`;
    case 'currency':
      return `${sign}₹${Math.round(delta).toLocaleString('en-IN')}`;
    default:
      return `${sign}${delta}`;
  }
}

export default function Leadership() {
  const navigate = useNavigate();
  const [boundaries, setBoundaries] = useState([]);
  const [quarterLabel, setQuarterLabel] = useState('Q8');
  const [verticalId, setVerticalId] = useState(null);

  const [cardData, setCardData] = useState(null); // { KPI01: {...}, ... } for current quarter+vertical
  const [prevData, setPrevData] = useState(null); // same shape, prior quarter
  const [bestSoFar, setBestSoFar] = useState(null); // { KPI01: number, ... } best across all 8 quarters
  const [targets, setTargets] = useState(null); // { 'KPI-01': { target, direction }, ... }
  const [cardsLoading, setCardsLoading] = useState(true);

  const [comparisonRows, setComparisonRows] = useState([]);
  const [comparisonLoading, setComparisonLoading] = useState(true);

  const [trendSeries, setTrendSeries] = useState(null); // { KPI01: [{quarter, value}, ...], ... }
  const [trendLoading, setTrendLoading] = useState(true);

  const [belowTarget, setBelowTarget] = useState([]);
  const [belowTargetLoading, setBelowTargetLoading] = useState(true);

  // Quarter boundaries only need computing once.
  useEffect(() => {
    getQuarterBoundaries().then(setBoundaries);
  }, []);

  const quarterIdx = QUARTER_LABELS.indexOf(quarterLabel);
  const prevQuarterLabel = quarterIdx > 0 ? QUARTER_LABELS[quarterIdx - 1] : null;

  // KPI cards: current quarter, previous quarter, best-so-far, and targets.
  useEffect(() => {
    if (boundaries.length === 0) return;
    let cancelled = false;
    setCardsLoading(true);

    (async () => {
      const current = await calcAllKPIs(quarterLabel, verticalId, boundaries);
      const previous = prevQuarterLabel
        ? await calcAllKPIs(prevQuarterLabel, verticalId, boundaries)
        : null;

      const bestEntries = await Promise.all(
        KPI_META.map(async ({ code, key }) => {
          const calc = KPI_CALCULATORS[code];
          const values = await Promise.all(
            QUARTER_LABELS.map((q) => calc(q, verticalId, boundaries))
          );
          const nums = values.map((v) => v?.value).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
          if (nums.length === 0) return [key, null];
          const isLowerBetter = code === 'KPI-04';
          const best = isLowerBetter ? Math.min(...nums) : Math.max(...nums);
          return [key, best];
        })
      );

      const targetEntries = await Promise.all(
        KPI_META.map(async ({ code }) => [code, await getTarget(code, quarterLabel, verticalId)])
      );

      if (cancelled) return;
      setCardData(current);
      setPrevData(previous);
      setBestSoFar(Object.fromEntries(bestEntries));
      setTargets(Object.fromEntries(targetEntries));
      setCardsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, quarterLabel, verticalId, prevQuarterLabel]);

  // Vertical comparison table: calcAllKPIs once per vertical for the selected quarter.
  useEffect(() => {
    if (boundaries.length === 0) return;
    let cancelled = false;
    setComparisonLoading(true);

    (async () => {
      const rows = await Promise.all(
        VERTICAL_OPTIONS.filter((v) => v.id !== null).map(async (v) => ({
          label: v.label,
          data: await calcAllKPIs(quarterLabel, v.id, boundaries),
        }))
      );
      if (cancelled) return;
      setComparisonRows(rows);
      setComparisonLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, quarterLabel]);

  // Trend strip: group-level value for each KPI across all 8 quarters.
  useEffect(() => {
    if (boundaries.length === 0) return;
    let cancelled = false;
    setTrendLoading(true);

    (async () => {
      const series = {};
      for (const { code, key } of KPI_META) {
        const calc = KPI_CALCULATORS[code];
        const points = await Promise.all(
          QUARTER_LABELS.map(async (q) => ({
            quarter: q,
            value: (await calc(q, null, boundaries))?.value ?? null,
          }))
        );
        series[key] = points;
      }
      if (cancelled) return;
      setTrendSeries(series);
      setTrendLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries]);

  // Verticals below target: kpi_target rows with vertical_id set for this quarter.
  useEffect(() => {
    if (boundaries.length === 0) return;
    let cancelled = false;
    setBelowTargetLoading(true);

    (async () => {
      const { data: targetRows, error } = await supabase
        .from('kpi_target')
        .select('*, dim_kpi(kpi_code, kpi_name, direction), dim_vertical(vertical_name)')
        .eq('period_value', quarterLabel)
        .not('vertical_id', 'is', null);

      if (error) {
        console.error('Failed to load vertical-level targets', error);
        if (!cancelled) {
          setBelowTarget([]);
          setBelowTargetLoading(false);
        }
        return;
      }

      const results = await Promise.all(
        (targetRows || []).map(async (row) => {
          const code = row.dim_kpi?.kpi_code;
          const calc = KPI_CALCULATORS[code];
          if (!calc) return null;
          const actual = (await calc(quarterLabel, row.vertical_id, boundaries))?.value;
          const outcome = compareToTarget(actual, row.target_value, row.dim_kpi?.direction);
          if (outcome !== 'misses') return null;
          return {
            id: row.target_id,
            vertical: row.dim_vertical?.vertical_name ?? '—',
            verticalId: row.vertical_id,
            kpiName: row.dim_kpi?.kpi_name ?? '—',
            actual,
            target: row.target_value,
            format: KPI_META.find((m) => m.code === code)?.format ?? 'default',
          };
        })
      );

      if (cancelled) return;
      setBelowTarget(results.filter(Boolean));
      setBelowTargetLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [boundaries, quarterLabel]);

  const cards = useMemo(() => {
    if (!cardData) return [];
    return KPI_META.map(({ code, key, name, format }) => {
      const actual = cardData[key]?.value ?? null;
      const previousVal = prevData ? prevData[key]?.value ?? null : null;
      const best = bestSoFar ? bestSoFar[key] ?? null : null;
      const targetInfo = targets ? targets[code] : null;
      const targetValue = targetInfo?.target?.target_value ?? null;
      const idealValue = targetInfo?.target?.ideal_value ?? null;
      const direction = targetInfo?.direction ?? 'higher_is_better';
      const outcome = compareToTarget(actual, targetValue, direction);
      const vsPrevious =
        actual !== null && previousVal !== null ? actual - previousVal : null;

      return { code, name, format, actual, targetValue, idealValue, outcome, vsPrevious, best };
    });
  }, [cardData, prevData, bestSoFar, targets]);

  return (
    <div className="page page-wide">
      <h1>Leadership View</h1>
      <p className="page-subtitle">
        Group-level and vertical KPI performance against targets, prior period, and best-so-far.
        Read-only — no data is written from this screen.
      </p>
      <p className="page-subtitle">
        These five headline metrics are lag KPIs — they show outcomes after the fact. Lead
        indicators (branded search volume, store footfall trend, app session frequency) are
        captured at the transaction level via the Return entry screens and surfaced in the
        Operating and Diagnostic views, rather than as macro-level cards here.
      </p>

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

        <div className="field">
          <label>Vertical</label>
          <div className="toggle-group">
            {VERTICAL_OPTIONS.map((v) => (
              <button
                key={v.label}
                type="button"
                className={verticalId === v.id ? 'toggle-btn active' : 'toggle-btn'}
                onClick={() => setVerticalId(v.id)}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <h2>KPI Cards — {quarterLabel}</h2>
      {cardsLoading && <p>Loading…</p>}
      {!cardsLoading && (
        <div className="kpi-card-grid">
          {cards.map((c) => (
            <div
              key={c.code}
              className={
                c.outcome === 'meets'
                  ? 'kpi-card kpi-card-green'
                  : c.outcome === 'misses'
                  ? 'kpi-card kpi-card-red'
                  : 'kpi-card'
              }
            >
              <span className="lag-kpi-badge">Lag KPI</span>
              <div className="kpi-card-name">{c.name}</div>
              <div className="kpi-card-value">{formatValue(c.actual, c.format)}</div>
              <div className="kpi-card-row">
                <span>vs Target:</span>
                <span>{c.targetValue !== null ? formatValue(c.targetValue, c.format) : 'No target set'}</span>
              </div>
              <div className="kpi-card-row">
                <span>vs Previous Period:</span>
                <span>{formatDelta(c.vsPrevious, c.format)}</span>
              </div>
              <div className="kpi-card-row">
                <span>vs Best So Far:</span>
                <span>{c.best !== null ? formatValue(c.best, c.format) : '—'}</span>
              </div>
              <div className="kpi-card-row">
                <span>vs Ideal:</span>
                <span>{c.idealValue !== null ? formatValue(c.idealValue, c.format) : '—'}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Vertical Comparison — {quarterLabel}</h2>
      {comparisonLoading && <p>Loading…</p>}
      {!comparisonLoading && (
        <>
          <table className="preview-table">
            <thead>
              <tr>
                <th>Vertical</th>
                {KPI_META.map((m) => (
                  <th key={m.code}>{m.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparisonRows.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {KPI_META.map((m) => (
                    <td key={m.code}>
                      {m.code === 'KPI-05' ? '—' : formatValue(row.data[m.key]?.value, m.format)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="table-note">
            Owned Brand Contribution Share is a group-level metric (BPC + Offline Retail combined)
            and isn't broken out per vertical — see the KPI card above for its value.
          </p>
        </>
      )}

      <h2>Trends — All 8 Quarters (Group-Level)</h2>
      {trendLoading && <p>Loading…</p>}
      {!trendLoading && trendSeries && (
        <div className="trend-strip">
          {KPI_META.map((m) => (
            <div key={m.code} className="trend-chart-card">
              <div className="trend-chart-title">{m.name}</div>
              <ResponsiveContainer width="100%" height={100}>
                <LineChart data={trendSeries[m.key]}>
                  <XAxis dataKey="quarter" tick={{ fontSize: 10 }} />
                  <YAxis hide />
                  <Tooltip formatter={(v) => formatValue(v, m.format)} />
                  <Line type="monotone" dataKey="value" stroke="#1a1a2e" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ))}
        </div>
      )}

      <h2>Verticals Below Target — {quarterLabel}</h2>
      {belowTargetLoading && <p>Loading…</p>}
      {!belowTargetLoading && belowTarget.length === 0 && (
        <p>No vertical-level targets set for this quarter.</p>
      )}
      {!belowTargetLoading && belowTarget.length > 0 && (
        <table className="preview-table">
          <thead>
            <tr>
              <th>Vertical</th>
              <th>KPI</th>
              <th>Actual</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {belowTarget.map((row) => (
              <tr
                key={row.id}
                className="row-invalid alert-row"
                onClick={() =>
                  navigate(`/operating?vertical=${row.verticalId}&quarter=${quarterLabel}`)
                }
                title="View this vertical's spend efficiency in Operating"
              >
                <td>{row.vertical}</td>
                <td>{row.kpiName}</td>
                <td>{formatValue(row.actual, row.format)}</td>
                <td>{formatValue(row.target, row.format)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
