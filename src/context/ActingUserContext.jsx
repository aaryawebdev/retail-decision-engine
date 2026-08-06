import { createContext, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

// NOTE: This is NOT an authentication system. There is no login, no session,
// no password check. It simply lets the person at the keyboard tell the app
// which `users` row to attribute their data entry to (`entered_by`). Real
// auth is out of scope for this build — see Stage 9A prompt.
const ActingUserContext = createContext(null);

export function ActingUserProvider({ children }) {
  const [users, setUsers] = useState([]);
  const [actingUserId, setActingUserId] = useState(null);

  useEffect(() => {
    supabase.from('users').select('user_id, name, role').then(({ data, error }) => {
      if (error) {
        console.error('ActingUserContext fetch failed for table "users":', error);
      }
      if (data) {
        setUsers(data);
        if (data.length > 0) setActingUserId(data[0].user_id);
      }
    });
  }, []);

  const actingUser = users.find(u => u.user_id === actingUserId) || null;

  return (
    <ActingUserContext.Provider value={{ users, actingUserId, setActingUserId, actingUser }}>
      {children}
    </ActingUserContext.Provider>
  );
}

export function useActingUser() {
  return useContext(ActingUserContext);
}
