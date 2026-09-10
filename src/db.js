const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SECRET_KEY in .env\n' +
    'Salin .env.example ke .env dan isi nilainya.'
  );
}

/**
 * Supabase client menggunakan service role key.
 * Service role key mem-bypass Row Level Security (RLS) —
 * aman untuk backend karena akses dikontrol via JWT middleware kita sendiri.
 */
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession:   false,
    autoRefreshToken: false,
  },
});

module.exports = { supabase };
