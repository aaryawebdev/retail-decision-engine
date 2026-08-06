import { useMemo, useState } from 'react';
import Papa from 'papaparse';
import { supabase } from '../lib/supabaseClient';
import { useActingUser } from '../context/ActingUserContext';
import SupabaseSelect from '../components/SupabaseSelect';

const MAP_TARGETS = [
  { value: '', label: 'Ignore this column' },
  { value: 'transaction_date', label: 'Transaction Date' },
  { value: 'amount', label: 'Amount' },
  { value: 'investment_category', label: 'Investment Category' },
  { value: 'product_category', label: 'Product Category' },
  { value: 'notes', label: 'Campaign Name (→ Notes)' },
];

const SOURCE_TO_DEFAULT_INV_CAT = {
  'Google Ads API': 'INV-01.1',
  'Meta Ads API': 'INV-01.2',
  'Marketplace/Affiliate': 'INV-01.3',
};

const OFFLINE_VERTICAL_NAME = 'Offline Retail';

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function isValidAmount(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = Number(v);
  return !Number.isNaN(n) && n > 0;
}

function isValidDate(v) {
  if (!v) return false;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) <= todayIso();
}

export default function InvestmentBulkUpload() {
  const { actingUserId } = useActingUser();

  const [verticalId, setVerticalId] = useState('');
  const [verticalName, setVerticalName] = useState('');
  const [locationId, setLocationId] = useState('');
  const [channelId, setChannelId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [sourceName, setSourceName] = useState('');

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]); // raw parsed row objects
  const [mapping, setMapping] = useState({}); // header -> target field

  // Per-row category overrides, keyed by row index, when a leaf inv_cat_id
  // needs to be picked manually instead of coming from the mapped column.
  const [rowCategoryOverrides, setRowCategoryOverrides] = useState({});
  const [skipInvalid, setSkipInvalid] = useState(false);

  const [committing, setCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState(null); // { insertedCount, skippedCount, error }

  // Lazily resolved map of investment category name -> inv_cat_id, used to
  // translate a mapped "Investment Category" text column into an id, and to
  // resolve the source-system default.
  const [invCatByCode, setInvCatByCode] = useState(null);
  const [invCatByName, setInvCatByName] = useState(null);

  const defaultInvCatCode = sourceName ? SOURCE_TO_DEFAULT_INV_CAT[sourceName] : null;

  const loadInvCatLookup = async () => {
    if (invCatByCode && invCatByName) return { invCatByCode, invCatByName };
    const { data, error } = await supabase
      .from('dim_investment_category')
      .select('inv_cat_id, code, name')
      .eq('level', 'leaf');
    if (error) {
      console.error('Failed to load investment categories', error);
      return { invCatByCode: {}, invCatByName: {} };
    }
    const byCode = {};
    const byName = {};
    for (const row of data) {
      byCode[row.code] = row.inv_cat_id;
      byName[row.name] = row.inv_cat_id;
    }
    setInvCatByCode(byCode);
    setInvCatByName(byName);
    return { invCatByCode: byCode, invCatByName: byName };
  };

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setCommitResult(null);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = results.meta.fields || [];
        setHeaders(fields);
        setRows(results.data);
        // Reset mapping for the new file
        const initialMapping = {};
        fields.forEach((h) => {
          initialMapping[h] = '';
        });
        setMapping(initialMapping);
        setRowCategoryOverrides({});
        loadInvCatLookup();
      },
      error: (err) => {
        console.error('CSV parse failed', err);
        setCommitResult({ error: `Failed to parse CSV: ${err.message}` });
      },
    });
  };

  const setColumnMapping = (header, target) => {
    setMapping((m) => ({ ...m, [header]: target }));
  };

  // Build the "applied" view of each row given current mapping, for preview
  // and for the eventual insert payload. Returns richer info per row.
  const mappedRows = useMemo(() => {
    if (rows.length === 0) return [];

    const invertedMapping = {}; // target field -> source header
    Object.entries(mapping).forEach(([header, target]) => {
      if (target) invertedMapping[target] = header;
    });

    return rows.map((row, idx) => {
      const rawDate = invertedMapping.transaction_date
        ? row[invertedMapping.transaction_date]
        : undefined;
      const rawAmount = invertedMapping.amount ? row[invertedMapping.amount] : undefined;
      const rawInvCatText = invertedMapping.investment_category
        ? row[invertedMapping.investment_category]
        : undefined;
      const rawProductCatText = invertedMapping.product_category
        ? row[invertedMapping.product_category]
        : undefined;
      const rawNotes = invertedMapping.notes ? row[invertedMapping.notes] : undefined;

      const mappedInvCatId =
        rowCategoryOverrides[idx] ||
        (rawInvCatText && invCatByName ? invCatByName[rawInvCatText] : null) ||
        (defaultInvCatCode && invCatByCode ? invCatByCode[defaultInvCatCode] : null) ||
        '';

      const dateValid = isValidDate(rawDate);
      const amountValid = isValidAmount(rawAmount);
      const categoryValid = Boolean(mappedInvCatId);

      return {
        idx,
        rawDate,
        rawAmount,
        rawProductCatText,
        rawNotes,
        invCatId: mappedInvCatId,
        dateValid,
        amountValid,
        categoryValid,
        isValid: dateValid && amountValid && categoryValid,
      };
    });
  }, [rows, mapping, rowCategoryOverrides, invCatByName, invCatByCode, defaultInvCatCode]);

  const invalidCount = mappedRows.filter((r) => !r.isValid).length;
  const previewRows = mappedRows.slice(0, 10);

  const canCommit =
    rows.length > 0 &&
    verticalId &&
    locationId &&
    channelId &&
    sourceId &&
    (invalidCount === 0 || skipInvalid) &&
    !committing;

  const handleCommit = async () => {
    setCommitting(true);
    setCommitResult(null);

    const toInsert = mappedRows.filter((r) => (skipInvalid ? r.isValid : true));
    const skippedCount = mappedRows.length - toInsert.length;

    const payload = toInsert.map((r) => ({
      inv_cat_id: r.invCatId,
      vertical_id: verticalId,
      location_id: locationId,
      channel_id: channelId,
      product_category_id: null, // resolved server-side is out of scope; text-only column in CSV
      amount_inr: Number(r.rawAmount).toFixed(2),
      transaction_date: new Date(r.rawDate).toISOString().slice(0, 10),
      notes: r.rawNotes || 'seed:bulk-upload',
      source_id: sourceId,
      entered_by: actingUserId,
    }));

    const { error } = await supabase.from('fact_investment').insert(payload);
    setCommitting(false);

    if (error) {
      setCommitResult({ error: error.message, insertedCount: 0, skippedCount });
      return;
    }

    setCommitResult({ insertedCount: payload.length, skippedCount, error: null });
  };

  return (
    <div className="page">
      <h1>Investment — Bulk Upload</h1>
      <p className="page-subtitle">
        CSV upload for performance marketing spend exports (Google Ads, Meta Ads,
        marketplace/affiliate).
      </p>

      <div className="entry-form">
        <div className="field">
          <label>Vertical *</label>
          <SupabaseSelect
            table="dim_vertical"
            idColumn="vertical_id"
            labelColumn="vertical_name"
            value={verticalId}
            onChange={(id, row) => {
              setVerticalId(id);
              setVerticalName(row?.vertical_name || '');
              setLocationId(''); // re-fetch/reset dependent field
            }}
            placeholder="Select vertical…"
          />
        </div>

        <div className="field">
          <label>Location *</label>
          <SupabaseSelect
            table="dim_location"
            idColumn="location_id"
            labelColumn={(row) => `${row.region} — ${row.store_name || 'Online'}`}
            value={locationId}
            onChange={setLocationId}
            placeholder="Select location…"
            filter={{ column: 'is_offline', value: verticalName === OFFLINE_VERTICAL_NAME }}
            disabled={!verticalId}
          />
        </div>

        <div className="field">
          <label>Channel *</label>
          <SupabaseSelect
            table="dim_channel"
            idColumn="channel_id"
            labelColumn="channel_name"
            value={channelId}
            onChange={setChannelId}
            placeholder="Select channel…"
          />
        </div>

        <div className="field">
          <label>Source System *</label>
          <SupabaseSelect
            table="dim_source_system"
            idColumn="source_id"
            labelColumn="source_name"
            extraWhere="source_name IN ('Google Ads API','Meta Ads API','Marketplace/Affiliate')"
            value={sourceId}
            onChange={(id, row) => {
              setSourceId(id);
              setSourceName(row?.source_name || '');
            }}
            placeholder="Select source system…"
          />
        </div>

        <div className="field">
          <label>CSV File</label>
          <input type="file" accept=".csv" onChange={handleFile} />
          {fileName && <div className="file-name">{fileName} ({rows.length} rows)</div>}
        </div>
      </div>

      {headers.length > 0 && (
        <>
          <h2>Column Mapping</h2>
          <table className="mapping-table">
            <thead>
              <tr>
                <th>CSV Column</th>
                <th>Maps to</th>
              </tr>
            </thead>
            <tbody>
              {headers.map((h) => (
                <tr key={h}>
                  <td>{h}</td>
                  <td>
                    <select
                      value={mapping[h] || ''}
                      onChange={(e) => setColumnMapping(h, e.target.value)}
                    >
                      {MAP_TARGETS.map((t) => (
                        <option key={t.value} value={t.value}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Preview (first 10 rows)</h2>
          <p>
            {invalidCount} of {mappedRows.length} row(s) flagged invalid.
          </p>
          <table className="preview-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Investment Category</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((r) => (
                <tr key={r.idx} className={r.isValid ? '' : 'row-invalid'}>
                  <td>{r.idx + 1}</td>
                  <td>{r.rawDate ?? ''}</td>
                  <td>{r.rawAmount ?? ''}</td>
                  <td>
                    <SupabaseSelect
                      table="dim_investment_category"
                      idColumn="inv_cat_id"
                      labelColumn="name"
                      extraWhere="level = 'leaf'"
                      value={r.invCatId}
                      onChange={(id) =>
                        setRowCategoryOverrides((m) => ({ ...m, [r.idx]: id }))
                      }
                      placeholder="Select category…"
                    />
                  </td>
                  <td>{r.rawNotes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <label className="field-checkbox">
            <input
              type="checkbox"
              checked={skipInvalid}
              onChange={(e) => setSkipInvalid(e.target.checked)}
            />{' '}
            Skip invalid rows
          </label>

          {commitResult && (
            <div className={commitResult.error ? 'status-error' : 'status-success'}>
              {commitResult.error
                ? `Commit failed: ${commitResult.error}`
                : `Inserted ${commitResult.insertedCount} row(s). Skipped ${commitResult.skippedCount} invalid row(s).`}
            </div>
          )}

          <button onClick={handleCommit} disabled={!canCommit}>
            {committing ? 'Committing…' : 'Commit'}
          </button>
        </>
      )}
    </div>
  );
}
