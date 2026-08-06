import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useActingUser } from '../context/ActingUserContext';
import SupabaseSelect from '../components/SupabaseSelect';

const OFFLINE_VERTICAL_NAME = 'Offline Retail';
const UNIT_TYPES = ['INR', 'Count', 'Rate'];

const emptyForm = {
  retCatId: '',
  verticalId: '',
  verticalName: '',
  locationId: '',
  channelId: '',
  productCategoryId: '',
  ownedBrand: false,
  brandId: '',
  value: '',
  unitType: 'INR',
  transactionDate: '',
  notes: '',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function ReturnDirectEntry() {
  const { actingUserId } = useActingUser();
  const [form, setForm] = useState(emptyForm);
  const [manualSourceId, setManualSourceId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    supabase
      .from('dim_source_system')
      .select('source_id')
      .eq('source_name', 'Manual Upload')
      .single()
      .then(({ data, error }) => {
        if (error) {
          console.error('Failed to look up Manual Upload source_id', error);
        } else if (data) {
          setManualSourceId(data.source_id);
        }
      });
  }, []);

  const update = (field) => (value) => setForm((f) => ({ ...f, [field]: value }));

  const isOffline = form.verticalName === OFFLINE_VERTICAL_NAME;

  const handleVerticalChange = (verticalId, verticalName) => {
    setForm((f) => ({
      ...f,
      verticalId,
      verticalName,
      locationId: '',
    }));
  };

  const validate = () => {
    if (!form.retCatId) return 'Return Category is required.';
    if (!form.verticalId) return 'Vertical is required.';
    if (!form.locationId) return 'Location is required.';
    if (!form.channelId) return 'Channel is required.';
    if (form.ownedBrand && !form.brandId) return 'Brand is required when Owned Brand is Yes.';
    const valueNum = Number(form.value);
    if (form.value === '' || Number.isNaN(valueNum) || valueNum < 0) {
      return 'Value must be a number ≥ 0.';
    }
    if (!form.unitType) return 'Unit Type is required.';
    if (form.unitType === 'Rate' && (valueNum < 0 || valueNum > 100)) {
      return 'Value must be between 0 and 100 when Unit Type is Rate.';
    }
    if (!form.transactionDate) return 'Transaction Date is required.';
    if (form.transactionDate > todayIso()) return 'Transaction Date cannot be after today.';
    if (form.notes && form.notes.length > 500) return 'Notes must be 500 characters or fewer.';
    if (!manualSourceId) return 'Source system lookup has not loaded yet — try again in a moment.';
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
    const { error } = await supabase.from('fact_return').insert([
      {
        ret_cat_id: form.retCatId,
        vertical_id: form.verticalId,
        location_id: form.locationId,
        channel_id: form.channelId,
        product_category_id: form.productCategoryId || null,
        brand_id: form.ownedBrand ? form.brandId : null,
        value: Number(form.value),
        unit_type: form.unitType,
        transaction_date: form.transactionDate,
        notes: form.notes || null,
        source_id: manualSourceId,
        entered_by: actingUserId,
      },
    ]);
    setSubmitting(false);

    if (error) {
      setStatus({ type: 'error', message: error.message });
      return;
    }

    setStatus({ type: 'success', message: 'Return entry saved.' });
    setForm(emptyForm);
  };

  return (
    <div className="page">
      <h1>Return — Direct Entry</h1>
      <p className="page-subtitle">
        Manual entry for return metrics without a live feed — store footfall counts,
        brand-awareness survey results.
      </p>

      <form onSubmit={handleSubmit} className="entry-form">
        <div className="field">
          <label>Return Category *</label>
          <SupabaseSelect
            table="dim_return_category"
            idColumn="ret_cat_id"
            labelColumn="name"
            extraWhere="level = 'leaf'"
            value={form.retCatId}
            onChange={update('retCatId')}
            placeholder="Select return category…"
          />
        </div>

        <div className="field">
          <label>Vertical *</label>
          <SupabaseSelect
            table="dim_vertical"
            idColumn="vertical_id"
            labelColumn="vertical_name"
            value={form.verticalId}
            onChange={(id, row) => handleVerticalChange(id, row?.vertical_name || '')}
            placeholder="Select vertical…"
          />
        </div>

        <div className="field">
          <label>Location *</label>
          <SupabaseSelect
            table="dim_location"
            idColumn="location_id"
            labelColumn={(row) => `${row.region} — ${row.store_name || 'Online'}`}
            value={form.locationId}
            onChange={update('locationId')}
            placeholder="Select location…"
            filter={{ column: 'is_offline', value: isOffline }}
            disabled={!form.verticalId}
          />
        </div>

        <div className="field">
          <label>Channel *</label>
          <SupabaseSelect
            table="dim_channel"
            idColumn="channel_id"
            labelColumn="channel_name"
            value={form.channelId}
            onChange={update('channelId')}
            placeholder="Select channel…"
          />
        </div>

        <div className="field">
          <label>Product Category</label>
          <SupabaseSelect
            table="dim_product_category"
            idColumn="product_category_id"
            labelColumn="category_name"
            value={form.productCategoryId}
            onChange={update('productCategoryId')}
            placeholder="Select product category…"
          />
        </div>

        <div className="field field-checkbox">
          <label>
            <input
              type="checkbox"
              checked={form.ownedBrand}
              onChange={(e) =>
                setForm((f) => ({ ...f, ownedBrand: e.target.checked, brandId: '' }))
              }
            />{' '}
            Owned Brand?
          </label>
        </div>

        {form.ownedBrand && (
          <div className="field">
            <label>Brand *</label>
            <SupabaseSelect
              table="dim_brand"
              idColumn="brand_id"
              labelColumn="brand_name"
              value={form.brandId}
              onChange={update('brandId')}
              placeholder="Select brand…"
            />
          </div>
        )}

        <div className="field">
          <label>Value *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            value={form.value}
            onChange={(e) => update('value')(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label>Unit Type *</label>
          <select value={form.unitType} onChange={(e) => update('unitType')(e.target.value)}>
            {UNIT_TYPES.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Transaction Date *</label>
          <input
            type="date"
            max={todayIso()}
            value={form.transactionDate}
            onChange={(e) => update('transactionDate')(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label>Notes</label>
          <textarea
            maxLength={500}
            value={form.notes}
            onChange={(e) => update('notes')(e.target.value)}
            rows={3}
          />
          <div className="char-count">{form.notes.length}/500</div>
        </div>

        {status && (
          <div className={status.type === 'error' ? 'status-error' : 'status-success'}>
            {status.message}
          </div>
        )}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save Return Entry'}
        </button>
      </form>
    </div>
  );
}
