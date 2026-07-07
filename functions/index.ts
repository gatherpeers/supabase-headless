// @ts-ignore
import { STATUS_CODE } from 'jsr:@std/http@1.1.1/status'
import { context, propagation } from 'npm:@opentelemetry/api@1.9.1'
import { W3CBaggagePropagator } from 'npm:@opentelemetry/core@2.8.0'
import { json } from './_shared/json.ts'

// @ts-ignore See https://github.com/denoland/deno/issues/28082
if (globalThis[Symbol.for('opentelemetry.js.api.1')]) {
  globalThis[Symbol.for('opentelemetry.js.api.1')].propagation = new W3CBaggagePropagator()
}

const FUNCTIONS_ROOT = '/home/deno/functions'
const FUNCTION_NAME_RE = /^[a-zA-Z0-9_-]+$/
const ENTRYPOINT_FILES = ['index.ts', 'index.js']
const EXCLUDED_FUNCTION_DIRS = ['_shared', '.']

console.log('Starting Edge Runtime function loader...')

addEventListener('beforeunload', () => {
  console.log('main worker exiting')
})

addEventListener('unhandledrejection', (ev) => {
  console.log(ev)
  ev.preventDefault()
})

function isExcludedFunctionDir(name: string): boolean {
  if (name.startsWith('.') && EXCLUDED_FUNCTION_DIRS.includes('.')) return true
  return EXCLUDED_FUNCTION_DIRS.includes(name)
}

async function functionExists(functionName: string): Promise<boolean> {
  if (isExcludedFunctionDir(functionName)) return false

  try {
    const dirStat = await Deno.stat(`${FUNCTIONS_ROOT}/${functionName}`)
    if (!dirStat.isDirectory) return false

    for (const entrypoint of ENTRYPOINT_FILES) {
      try {
        const entrypointStat = await Deno.stat(`${FUNCTIONS_ROOT}/${functionName}/${entrypoint}`)
        if (entrypointStat.isFile) return true
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) continue
        throw err
      }
    }

    return false
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

Deno.serve(async (req: Request) => {
  // Extract OTel context and request ID from W3C baggage headers
  const ctx = propagation.extract(context.active(), req.headers, {
    get(carrier, key) { return carrier.get(key) ?? void 0 },
    keys(carrier) { return [...carrier.keys()] },
  })
  const baggage = propagation.getBaggage(ctx)
  const requestId = baggage?.getEntry('sb-request-id')?.value ?? null

  const headers = new Headers({ 'Content-Type': 'application/json' })

  const url = new URL(req.url)
  const { pathname } = url

  // Internal: health check (used by load balancers / Docker health probes)
  if (pathname === '/_internal/health') {
    return json({ message: 'ok' }, {
      status: STATUS_CODE.OK,
      headers,
    })
  }

  // Internal: runtime metrics
  if (pathname === '/_internal/metric') {
    const metric = await EdgeRuntime.getRuntimeMetrics()
    return Response.json(metric)
  }

  const pathParts = pathname.split('/').filter(Boolean)
  const functionName = pathParts[0]

  if (!functionName) return json({ msg: 'missing function name in request' }, { status: STATUS_CODE.BadRequest })
  if (!FUNCTION_NAME_RE.test(functionName)) return json({ msg: 'invalid function name' }, { status: STATUS_CODE.BadRequest })
  if (isExcludedFunctionDir(functionName)) return json({ msg: 'function not found' }, { status: STATUS_CODE.NotFound })

  const exists = await functionExists(functionName)
  if (!exists) return json({ msg: 'function not found' }, { status: STATUS_CODE.NotFound })

  const servicePath = `${FUNCTIONS_ROOT}/${functionName}`

  const createWorker = async (otelAttributes?: Record<string, string>) => {
    const envVarsObj = Deno.env.toObject()
    const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]]) as [string, string][]

    return await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 5 * 60_000,
      noModuleCache: false,
      envVars,
      forceCreate: false,
      cpuTimeSoftLimitMs: 10_000,
      cpuTimeHardLimitMs: 20_000,
      context: {
        useReadSyncFileAPI: true,
        otel: otelAttributes,
      },
      otelConfig: {
        tracing_enabled: true,
        propagators: ['TraceContext', 'Baggage'],
      },
    })
  }

  const callWorker = async (): Promise<Response> => {
    try {
      const worker = await createWorker(
        requestId ? { sb_request_id: requestId } : void 0,
      )

      const controller = new AbortController()
      return await worker.fetch(req, { signal: controller.signal })
    } catch (e) {
      if (e instanceof Deno.errors.WorkerAlreadyRetired) {
        // Worker was finishing up — retry with a fresh one
        return await callWorker()
      }
      if (e instanceof Deno.errors.WorkerRequestCancelled) {
        // Worker hit CPU/wall-clock limit; signal client to close and reconnect
        headers.append('Connection', 'close')
      }

      console.error(`Function execution failed for "${functionName}"`, e)
      return json({ msg: String(e) }, { status: STATUS_CODE.InternalServerError, headers })
    }
  }

  return callWorker()
})

// Log number of loaded functions and their names
async function logLoadedFunctions() {
  try {
    const functionNames: string[] = []

    for await (const entry of Deno.readDir(FUNCTIONS_ROOT)) {
      if (!entry.isDirectory) continue
      if (!FUNCTION_NAME_RE.test(entry.name)) continue
      if (isExcludedFunctionDir(entry.name)) continue
      if (await functionExists(entry.name)) functionNames.push(entry.name)
    }

    console.log(`Loaded ${functionNames.length} function(s): ${functionNames.join(', ')}`)
  } catch (err) {
    console.error('Error reading functions directory:', err)
  }
}

logLoadedFunctions().then(() => {
  console.log('Edge Function Runtime loaded correctly. Listening for requests!')
}).catch((err) => {
  console.error('Error during startup:', err)
  console.log('Edge Function Runtime loaded with errors. Listening for requests, but some functions may not work correctly.')
})