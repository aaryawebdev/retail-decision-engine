import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

/**
 * Generic reference-table dropdown, reused across screens for Vertical,
 * Channel, Product Category, Brand, Source System, Investment Category,
 * Return Category, Location, etc.
 *
 * Props:
 *  - table: string — table to query
 *  - idColumn: string — column used as option value
 *  - labelColumn: string | (row) => string — column to display, or a
 *      function to build a composite label (e.g. Location's
 *      "region — store_name")
 *  - value, onChange(id, row): controlled select state. `row` is the full
 *      fetched row for the selected option, in case a caller needs more
 *      than just the id (e.g. Vertical's name, to filter Location).
 *  - placeholder: string — disabled first option text
 *  - filter: { column, value } | null — simple equality filter
 *  - extraWhere: string | null — a small filter DSL for cases `filter`
 *      can't express:
 *        "column = 'value'"       -> equality
 *        "column IN ('a','b')"    -> inclusion list
 *      e.g. "level = 'leaf'" or "source_name IN ('Google Ads API','Meta Ads API')"
 */
export default function SupabaseSelect({
  table,
  idColumn,
  labelColumn,
  value,
  onChange,
  placeholder = 'Select…',
  filter = null,
  extraWhere = null,
  disabled = false,
}) {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const selectCols =
      typeof labelColumn === 'function'
        ? '*'
        : `${idColumn}, ${labelColumn}`;

    let query = supabase.from(table).select(selectCols);

    if (filter && filter.column) {
      query = query.eq(filter.column, filter.value);
    }
    if (extraWhere) {
      const inMatch = extraWhere.match(/^\s*(\w+)\s+IN\s*\(([^)]+)\)\s*$/i);
      const eqMatch = extraWhere.match(/^\s*(\w+)\s*=\s*'([^']*)'\s*$/);
      if (inMatch) {
        const [, column, rawList] = inMatch;
        const values = rawList
          .split(',')
          .map((v) => v.trim().replace(/^'|'$/g, ''));
        query = query.in(column, values);
      } else if (eqMatch) {
        const [, column, val] = eqMatch;
        query = query.eq(column, val);
      } else {
        console.warn(`SupabaseSelect: unrecognized extraWhere "${extraWhere}"`);
      }
    }

    const orderCol = typeof labelColumn === 'function' ? idColumn : labelColumn;
    query = query.order(orderCol, { ascending: true });

    query.then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        console.error(`SupabaseSelect fetch failed for table "${table}":`, error);
        setOptions([]);
      } else {
        setOptions(data || []);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [table, idColumn, labelColumn, filter?.column, filter?.value, extraWhere]);

  const labelFor = (row) =>
    typeof labelColumn === 'function' ? labelColumn(row) : row[labelColumn];

  const handleChange = (e) => {
    const id = e.target.value;
    const row = options.find((r) => String(r[idColumn]) === String(id));
    onChange(id, row);
  };

  return (
    <select
      value={value ?? ''}
      onChange={handleChange}
      disabled={disabled || loading}
    >
      <option value="" disabled>
        {loading ? 'Loading…' : placeholder}
      </option>
      {options.map((row) => (
        <option key={row[idColumn]} value={row[idColumn]}>
          {labelFor(row)}
        </option>
      ))}
    </select>
  );
}
