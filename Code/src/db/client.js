import { createClient } from '@supabase/supabase-js';

export function createSupabaseClient({ url, serviceKey } = {}) {
  if (!url || !serviceKey) {
    throw new Error(
      'createSupabaseClient: url and serviceKey are required (see .env.example: SUPABASE_URL, SUPABASE_SERVICE_KEY)'
    );
  }
  return createClient(url, serviceKey, {
    db: { schema: 'information_analysis_agent' }
  });
}
