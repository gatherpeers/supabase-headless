import { json } from '@stack/json.ts'

console.info('example1 function started')

// @ts-ignore Deno global is provided by the edge runtime.
Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url)
    const name = url.searchParams.get('name') ?? 'Guest'
    const data = { message: `Hello ${name} from example1!` }

    return json(data, {
      headers: {
        'Connection': 'keep-alive',
      },
    })
  } catch (err) {
    return json({ error: 'Invalid request' }, 400)
  }
})