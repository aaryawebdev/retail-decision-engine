import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useActingUser } from '../context/ActingUserContext';
import SupabaseSelect from '../components/SupabaseSelect';

const PERIOD_TYPES = ['Month', 'Quarter', 'Year'];
const SCOPE_GROUP = 'group';
const SCOPE_VERTICAL = 'vertical';
const MIN_JUSTIFICATION_LENGTH = 20;

const STATUS_BADGE_CLASS = {
  Draft: 'badge badge-grey',
  'Pending Approval': 'badge badge-amber',
  Approved: 'badge badge-green',
};

const emptyForm = {
  kpiId: '',
  scope: SCOPE_GROUP,
  verticalId: '',
  periodType: 'Month',
  periodValue: '',
  targetValue: '',
  idealValue: '',
  justification: '',
};

export default function TargetSetting() {
  const { actingUserId } = useActingUser();
  const [targets, setTargets] = useState([]);
  const [selectedKpiDirection, setSelectedKpiDirection] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [approvingId, setApprovingId] = useState(null);

  const [form, setForm] = useState(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);

  const loadTargets = () => {
    setListLoading(true);
    supabase
      .from('kpi_target')
      .select(
        `
        target_id,
        period_type,
        period_value,
        target_value,
        approval_status,
        dim_kpi ( kpi_name ),
        dim_vertical ( vertical_name )
      `
      )
      .order('target_id', { ascending: false })
      .then(({ data, error }) => {
        if (error) {
          console.error('Failed to load kpi_target', error);
          setListError(error.message);
        } else {
          setListError(null);
          setTargets(data || []);
        }
        setListLoading(false);
      });
  };

  useEffect(() => {
    loadTargets();
  }, []);

  // Fetch the selected KPI's direction so the form can hint "(lower is
  // better)" for metrics like CAC, where a smaller target is the goal.
  useEffect(() => {
    if (!form.kpiId) {
      setSelectedKpiDirection(null);
      return;
    }
    let cancelled = false;
    supabase
      .from('dim_kpi')
      .select('direction')
      .eq('kpi_id', form.kpiId)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to load KPI direction', error);
          setSelectedKpiDirection(null);
        } else {
          setSelectedKpiDirection(data?.direction ?? null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [form.kpiId]);

  const update = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const validate = () => {
    if (!form.kpiId) return 'KPI is required.';
    if (form.scope === SCOPE_VERTICAL && !form.verticalId) {
      return 'Vertical is required when Scope is Specific Vertical.';
    }
    if (!PERIOD_TYPES.includes(form.periodType)) return 'Period Type is required.';
    if (!form.periodValue.trim()) return 'Period Value is required.';
    if (form.targetValue === '' || Number.isNaN(Number(form.targetValue))) {
      return 'Target Value must be a number.';
    }
    if (form.idealValue !== '' && Number.isNaN(Number(form.idealValue))) {
      return 'Ideal Value must be a number.';
    }
    if (form.justification.trim().length < MIN_JUSTIFICATION_LENGTH) {
      return `Justification must be at least ${MIN_JUSTIFICATION_LENGTH} characters.`;
    }
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
    const { error } = await supabase.from('kpi_target').insert([
      {
        kpi_id: form.kpiId,
        vertical_id: form.scope === SCOPE_VERTICAL ? form.verticalId : null,
        period_type: form.periodType,
        period_value: form.periodValue.trim(),
        target_value: Number(form.targetValue),
        ideal_value: form.idealValue !== '' ? Number(form.idealValue) : null,
        justification: form.justification.trim(),
        approval_status: 'Draft',
        set_by: actingUserId,
      },
    ]);
    setSubmitting(false);

    if (error) {
      setStatus({ type: 'error', message: error.message });
      return;
    }

    setStatus({ type: 'success', message: 'Target created as Draft.' });
    setForm(emptyForm);
    loadTargets();
  };

  const handleApprove = async (targetId) => {
    setApprovingId(targetId);
    const { error } = await supabase
      .from('kpi_target')
      .update({ approval_status: 'Approved', approved_by: actingUserId })
      .eq('target_id', targetId);
    setApprovingId(null);

    if (error) {
      console.error('Failed to approve target', error);
      setListError(error.message);
      return;
    }
    loadTargets();
  };

  return (
    <div className="page">
      <h1>KPI Target Setting</h1>
      <p className="page-subtitle">
        Targets go through an approval workflow: new targets start as Draft and must be approved
        before they're official.
      </p>

      <h2>Existing Targets</h2>
      {listLoading && <p>Loading…</p>}
      {listError && <div className="status-error">{listError}</div>}
      {!listLoading && !listError && (
        <table className="preview-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Scope</th>
              <th>Period</th>
              <th>Target Value</th>
              <th>Approval Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {targets.length === 0 && (
              <tr>
                <td colSpan={6}>No targets set yet.</td>
              </tr>
            )}
            {targets.map((row) => (
              <tr key={row.target_id}>
                <td>{row.dim_kpi?.kpi_name ?? '—'}</td>
                <td>{row.dim_vertical?.vertical_name ?? 'Group'}</td>
                <td>
                  {row.period_type} {row.period_value}
                </td>
                <td>{row.target_value}</td>
                <td>
                  <span className={STATUS_BADGE_CLASS[row.approval_status] || 'badge badge-grey'}>
                    {row.approval_status}
                  </span>
                </td>
                <td>
                  {(row.approval_status === 'Draft' || row.approval_status === 'Pending Approval') && (
                    <button
                      type="button"
                      onClick={() => handleApprove(row.target_id)}
                      disabled={approvingId === row.target_id}
                    >
                      {approvingId === row.target_id ? 'Approving…' : 'Approve'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Add New Target</h2>
      <form onSubmit={handleSubmit} className="entry-form">
        <div className="field">
          <label>KPI *</label>
          <SupabaseSelect
            table="dim_kpi"
            idColumn="kpi_id"
            labelColumn="kpi_name"
            value={form.kpiId}
            onChange={update('kpiId')}
            placeholder="Select KPI…"
          />
          {selectedKpiDirection === 'lower_is_better' && (
            <span className="field-hint">(lower is better)</span>
          )}
          {selectedKpiDirection === 'higher_is_better' && (
            <span className="field-hint">(higher is better)</span>
          )}
        </div>

        <div className="field">
          <label>Scope *</label>
          <div className="radio-group">
            <label>
              <input
                type="radio"
                name="scope"
                checked={form.scope === SCOPE_GROUP}
                onChange={() => setForm((f) => ({ ...f, scope: SCOPE_GROUP, verticalId: '' }))}
              />{' '}
              Group-level
            </label>
            <label>
              <input
                type="radio"
                name="scope"
                checked={form.scope === SCOPE_VERTICAL}
                onChange={() => setForm((f) => ({ ...f, scope: SCOPE_VERTICAL }))}
              />{' '}
              Specific Vertical
            </label>
          </div>
        </div>

        {form.scope === SCOPE_VERTICAL && (
          <div className="field">
            <label>Vertical *</label>
            <SupabaseSelect
              table="dim_vertical"
              idColumn="vertical_id"
              labelColumn="vertical_name"
              value={form.verticalId}
              onChange={update('verticalId')}
              placeholder="Select vertical…"
            />
          </div>
        )}

        <div className="field">
          <label>Period Type *</label>
          <select value={form.periodType} onChange={(e) => update('periodType')(e.target.value)}>
            {PERIOD_TYPES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Period Value *</label>
          <input
            type="text"
            value={form.periodValue}
            onChange={(e) => update('periodValue')(e.target.value)}
            placeholder="e.g. Q7"
          />
        </div>

        <div className="field">
          <label>Target Value *</label>
          <input
            type="number"
            step="any"
            value={form.targetValue}
            onChange={(e) => update('targetValue')(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Ideal Value</label>
          <input
            type="number"
            step="any"
            value={form.idealValue}
            onChange={(e) => update('idealValue')(e.target.value)}
          />
        </div>

        <div className="field">
          <label>Justification *</label>
          <textarea
            value={form.justification}
            onChange={(e) => update('justification')(e.target.value)}
            rows={3}
            placeholder="Why this target? (minimum 20 characters)"
          />
          <div className="char-count">
            {form.justification.trim().length}/{MIN_JUSTIFICATION_LENGTH} min
          </div>
        </div>

        {status && (
          <div className={status.type === 'error' ? 'status-error' : 'status-success'}>
            {status.message}
          </div>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save as Draft'}
        </button>
      </form>
    </div>
  );
}
