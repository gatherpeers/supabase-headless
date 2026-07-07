import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.110.0'
import { requireEnv } from './requireEnv.ts'

// Uses the internal docker service name of the gateway so communication is internal. URLs generated won't be public.
export function createRlsClient(req: Request): SupabaseClient {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) throw new Error('Missing authorization header')

  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_ANON_KEY'),
    {
      global: {
        headers: {
          Authorization: authHeader
        },
      },
    },
  )
}

// Public-origin client for frontend-facing URL generation (getPublicUrl, etc).
export function createPublicUrlClient(): SupabaseClient {
  return createClient(
    requireEnv('SUPABASE_PUBLIC_URL'),
    requireEnv('SUPABASE_ANON_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    }
  )
}

// ALERT! ELEVATED PRIVILEGES - ROW LEVEL SECURITY BYPASS
export function createAdminClient(): SupabaseClient {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      },
    },
  )
}