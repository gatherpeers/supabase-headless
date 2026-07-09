import { json } from '@stack/json.ts'
import { createRlsClient } from '@stack/supabase.ts'

export default {
  fetch: async (req: Request) => {
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

      if (error || !user) return json({ msg: 'Unauthorized' }, 401)

      return json({
        id: user.id,
        email: user.email ?? null,
      })
    } catch (err) {
      return json({ error: 'Unexpected error' }, 500)
    }
  },
}
