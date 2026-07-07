export function json(body: unknown, status?: number): Response
export function json(body: unknown, init?: ResponseInit): Response
export function json(body: unknown, statusOrInit: number | ResponseInit = 200): Response {
  const init: ResponseInit = typeof statusOrInit === 'number' ? { status: statusOrInit } : statusOrInit

  const headers = new Headers(init.headers ?? {})
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  })
}