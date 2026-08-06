import { useActingUser } from '../context/ActingUserContext';

// Simulated-identity switcher — not a login control. Lets whoever is at the
// keyboard declare which `users` row they're entering data as.
export default function ActingUserPicker() {
  const { users, actingUserId, setActingUserId } = useActingUser();

  return (
    <label className="acting-user-picker">
      Acting as:{' '}
      <select
        value={actingUserId ?? ''}
        onChange={(e) => setActingUserId(e.target.value)}
      >
        {users.length === 0 && <option value="">Loading users…</option>}
        {users.map((u) => (
          <option key={u.user_id} value={u.user_id}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
    </label>
  );
}
