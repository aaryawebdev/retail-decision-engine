import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useActingUser } from '../context/ActingUserContext';
import SupabaseSelect from '../components/SupabaseSelect';

// Setup screen: a person configures a feed once (or occasionally). This is
// not a per-transaction entry form — no Amount, no Date.
const SYNC_FREQUENCIES = ['Daily', 'Weekly'];

const emptyForm = {
  integrationName: '',
  sourceId: '',
  apiEndpoint: '',
  syncFrequency: 'Daily',
  defaultVerticalId: '',
  defaultChannelId: '',
  returnCategoryMapping: '',
  isActive: true,
};

export default function IntegrationConfig() {
  const { actingUserId } = useActingUser();
  const [integrations, setIntegrations] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);

  const loadIntegrations = () => {
    setListLoading(true);
    supabase
      .from('integration_config')
      .select(
        `
        integration_id,
        integration_name,
        is_active,
        last_sync_status,
        last_sync_at,
        dim_source_system ( source_name ),
        dim_vertical ( vertical_name ),
        dim_channel ( channel_name )
      `
      )
      .order('integration_id', { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          console.error('Failed to load integration_config', error);
          setListError(error.message);
        } else {
          setListError(null);
          setIntegrations(data || []);
        }
        setListLoading(false);
      });
  };

  useEffect(() => {
    loadIntegrations();
  }, []);

  const update = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const validate = () => {
    if (!form.integrationName.trim()) return 'Integration Name is required.';
    if (!form.sourceId) return 'Source System is required.';
    if (!form.apiEndpoint.trim()) return 'API Endpoint / Connection String is required.';
    if (!SYNC_FREQUENCIES.includes(form.syncFrequency)) return 'Sync Frequency is required.';
    if (!form.defaultVerticalId) return 'Default Vertical is required.';
    if (!form.defaultChannelId) return 'Default Channel is required.';
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatus(null);

    const validationError = validate();
    if (validationError) {
      setStatus({ type: 'error', message: validationError });
      return;
    }

    setSubmitting(true);
    const { error } = await supabase.from('integration_config').insert([
      {
        integration_name: form.integrationName.trim(),
        source_id: form.sourceId,
        api_endpoint: form.apiEndpoint.trim(),
        sync_frequency: form.syncFrequency,
        default_vertical_id: form.defaultVerticalId,
        default_channel_id: form.defaultChannelId,
        return_category_mapping: form.returnCategoryMapping || null,
        is_active: form.isActive,
        created_by: actingUserId,
      },
    ]);
    setSubmitting(false);

    if (error) {
      setStatus({ type: 'error', message: error.message });
      return;
    }

    setStatus({ type: 'success', message: 'Integration created.' });
    setForm(emptyForm);
    loadIntegrations();
  };

  return (
    <div className="page">
      <h1>Integration Configuration</h1>
      <p className="page-subtitle">
        Configure the feeds that pull data into the system. This is a setup screen — changes here
        happen occasionally, not per-transaction.
      </p>

      <h2>Existing Integrations</h2>
      {listLoading && <p>Loading…</p>}
      {listError && <div className="status-error">{listError}</div>}
      {!listLoading && !listError && (
        <table className="preview-table">
          <thead>
            <tr>
              <th>Integration Name</th>
              <th>Source System</th>
              <th>Vertical</th>
              <th>Channel</th>
              <th>Active</th>
              <th>Last Sync Status</th>
              <th>Last Sync At</th>
            </tr>
          </thead>
          <tbody>
            {integrations.length === 0 && (
              <tr>
                <td colSpan={7}>No integrations configured yet.</td>
              </tr>
            )}
            {integrations.map((row) => (
              <tr key={row.integration_id}>
                <td>{row.integration_name}</td>
                <td>{row.dim_source_system?.source_name ?? '—'}</td>
                <td>{row.dim_vertical?.vertical_name ?? '—'}</td>
                <td>{row.dim_channel?.channel_name ?? '—'}</td>
                <td>
                  <span className={row.is_active ? 'badge badge-green' : 'badge badge-grey'}>
                    {row.is_active ? 'Yes' : 'No'}
                  </span>
                </td>
                <td>{row.last_sync_status ?? '—'}</td>
                <td>{row.last_sync_at ? new Date(row.last_sync_at).toLocaleString() : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Add New Integration</h2>
      <form onSubmit={handleSubmit} className="entry-form">
        <div className="field">
          <label>Integration Name *</label>
          <input
            type="text"
            value={form.integrationName}
            onChange={(e) => update('integrationName')(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Source System *</label>
          <SupabaseSelect
            table="dim_source_system"
            idColumn="source_id"
            labelColumn="source_name"
            value={form.sourceId}
            onChange={update('sourceId')}
            placeholder="Select source system…"
          />
        </div>

        <div className="field">
          <label>API Endpoint / Connection String *</label>
          <input
            type="text"
            value={form.apiEndpoint}
            onChange={(e) => update('apiEndpoint')(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Sync Frequency *</label>
          <select value={form.syncFrequency} onChange={(e) => update('syncFrequency')(e.target.value)}>
            {SYNC_FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Default Vertical *</label>
          <SupabaseSelect
            table="dim_vertical"
            idColumn="vertical_id"
            labelColumn="vertical_name"
            value={form.defaultVerticalId}
            onChange={update('defaultVerticalId')}
            placeholder="Select vertical…"
          />
        </div>

        <div className="field">
          <label>Default Channel *</label>
          <SupabaseSelect
            table="dim_channel"
            idColumn="channel_id"
            labelColumn="channel_name"
            value={form.defaultChannelId}
            onChange={update('defaultChannelId')}
            placeholder="Select channel…"
          />
        </div>

        <div className="field">
          <label>Return Category Mapping</label>
          <textarea
            value={form.returnCategoryMapping}
            onChange={(e) => update('returnCategoryMapping')(e.target.value)}
            rows={3}
            placeholder="e.g. order_total → RET-01.2"
          />
        </div>

        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => update('isActive')(e.target.checked)}
            />{' '}
            Active
          </label>
        </div>

        {status && (
          <div className={status.type === 'error' ? 'status-error' : 'status-success'}>
            {status.message}
          </div>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Add Integration'}
        </button>
      </form>
    </div>
  );
}
