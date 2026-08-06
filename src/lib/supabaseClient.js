import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

console.log('Supabase URL loaded as:', supabaseUrl);
console.log('Anon key loaded (first 20 chars):', supabaseAnonKey?.slice(0, 20));
