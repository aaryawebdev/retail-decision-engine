import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useActingUser } from '../context/ActingUserContext';
import SupabaseSelect from '../components/SupabaseSelect';

const OFFLINE_VERTICAL_NAME = 'Offline Retail';

const emptyForm = {
  invCatId: '',
  verticalId: '',
  verticalName: '',
  locationId: '',
  channelId: '',
  productCategoryId: '',
  ownedBrand: false,
  brandId: '',
  amount: '',
  transactionDate: '',
  notes: '',
};

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export default function InvestmentDirectEntry() {
  const { actingUserId } = useActingUser();
  const [form, setForm] = useState(emptyForm);
  const [manualSourceId, setManualSourceId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState(null); // { type: 'success' | 'error', message }

  // Look up the 'Manual Upload' source_id once and cache it.
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
      locationId: '', // re-fetch/reset dependent field
    }));
  };

  const validate = () => {
    if (!form.invCatId) return 'Investment Category is required.';
    if (!form.verticalId) return 'Vertical is required.';
    if (!form.locationId) return 'Location is required.';
    if (!form.channelId) return 'Channel is required.';
    if (form.ownedBrand && !form.brandId) return 'Brand is required when Owned Brand is Yes.';
    const amountNum = Number(form.amount);
    if (!form.amount || Number.isNaN(amountNum) || amountNum <= 0) {
      return 'Amount must be a number greater than 0.';
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
    const { error } = await supabase.from('fact_investment').insert([
      {
        inv_cat_id: form.invCatId,
        vertical_id: form.verticalId,
        location_id: form.locationId,
        channel_id: form.channelId,
        product_category_id: form.productCategoryId || null,
        brand_id: form.ownedBrand ? form.brandId : null,
        amount_inr: Number(form.amount).toFixed(2),
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

    setStatus({ type: 'success', message: 'Investment entry saved.' });
    setForm(emptyForm);
  };

  return (
    <div className="page">
      <h1>Investment — Direct Entry</h1>
      <p className="page-subtitle">
        Manual entry for investment types not pulled from an ad platform — offline costs, team
        costs, trade spend, loyalty program costs.
      </p>

      <form onSubmit={handleSubmit} className="entry-form">
        <div className="field">
          <label>Investment Category *</label>
          <SupabaseSelect
            table="dim_investment_category"
            idColumn="inv_cat_id"
            labelColumn="name"
            extraWhere="level = 'leaf'"
            value={form.invCatId}
            onChange={update('invCatId')}
            placeholder="Select investment category…"
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
          <label>Amount (INR) *</label>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={form.amount}
            onChange={(e) => update('amount')(e.target.value)}
            required
          />
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
          {submitting ? 'Saving…' : 'Save Investment Entry'}
        </button>
      </form>
    </div>
  );
}
