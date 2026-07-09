import { json } from '@stack/json.ts'

export default {
  fetch: async (req: Request) => {
    try {
      const url = new URL(req.url)
      const name = url.searchParams.get('name') ?? 'Guest'
      const data = { message: `Hello ${name} from example1!` }

      return json(data)
    } catch (err) {
      return json({ error: 'Invalid request' }, 400)
    }
  },
}
