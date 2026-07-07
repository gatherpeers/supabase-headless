import { json } from '../_shared/json.ts'
import { createRlsClient } from '../_shared/supabase.ts'

console.info('example2 function started')

// @ts-ignore Deno global is provided by the edge runtime.
Deno.serve(async (req: Request) => {
  try {
    if (req.method !== 'GET') {
      return json({ msg: 'Method not allowed' }, {
        status: 405,
        headers: { 'Allow': 'GET' },
      })
    }

    let supabase
    try {
      supabase = createRlsClient(req)
    } catch (err) {
      return json({ msg: 'Unauthorized' }, 401)
    }

    const { data: { user }, error } = await supabase.auth.getUser()

    if (error || !user) {
      return json({ msg: 'Unauthorized' }, 401)
    }

    return json({
      id: user.id,
      email: user.email ?? null
    }, {
      headers: { 'Connection': 'keep-alive' },
    })
  } catch (err) {
    return json({ error: 'Unexpected error' }, 500)
  }
})