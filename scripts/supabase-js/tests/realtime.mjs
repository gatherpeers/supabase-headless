import { runSdkSuite } from '../lib.mjs'

function waitFor(channel, predicate, ms = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    channel.on('broadcast', { event: 'probe' }, (payload) => {
      if (predicate(payload)) {
        clearTimeout(timer)
        resolve(payload)
      }
    })
  })
}

function subscribed(channel) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe timeout')), 12_000)
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer)
        resolve()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(timer)
        reject(err ?? new Error(status))
      }
    })
  })
}

/** Reset client state after auth/storage suites before postgres_changes. */
async function prepareRealtimeClient(client) {
  await client.auth.signOut()
  await client.removeAllChannels()
  await client.realtime.disconnect()
  await new Promise((r) => setTimeout(r, 300))
}

async function waitForPostgresInsert(anon, service) {
  const ch = anon.channel(`pg-${Date.now()}`)
  const event = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no postgres change')), 25_000)
    ch.on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sdk_test_items' }, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
  try {
    await subscribed(ch)
    // Replication subscription can lag SUBSCRIBED briefly after a long test run.
    await new Promise((r) => setTimeout(r, 1500))
    const { error } = await service.from('sdk_test_items').insert({ title: `rt-${Date.now()}` })
    if (error) throw error
    const payload = await event
    if (payload.eventType !== 'INSERT') throw new Error('wrong event')
    return payload
  } finally {
    await ch.unsubscribe()
  }
}

export async function runRealtimeSuite(ctx) {
  const { anon, service } = ctx
  const second = ctx.second

  await prepareRealtimeClient(anon)
  await prepareRealtimeClient(second)

  return runSdkSuite('realtime', [
    ['realtime.postgres_changes', async () => {
      try {
        await waitForPostgresInsert(anon, service)
      } catch (err) {
        if (!String(err?.message ?? err).includes('no postgres change')) throw err
        await prepareRealtimeClient(anon)
        await waitForPostgresInsert(anon, service)
      }
    }],
    ['realtime.channel', async () => {
      const ch = anon.channel(`sdk-${Date.now()}`)
      await subscribed(ch)
      await ch.unsubscribe()
    }],
    ['realtime.broadcast', async () => {
      const topic = `sdk-broadcast-${Date.now()}`
      const a = anon.channel(topic)
      const b = second.channel(topic)
      const got = waitFor(b, (p) => p.payload?.ok === true)
      await subscribed(a)
      await subscribed(b)
      await a.send({ type: 'broadcast', event: 'probe', payload: { ok: true } })
      await got
      await a.unsubscribe()
      await b.unsubscribe()
    }],
    ['realtime.presence', async () => {
      const topic = `sdk-presence-${Date.now()}`
      const a = anon.channel(topic, { config: { presence: { key: 'a' } } })
      const b = second.channel(topic, { config: { presence: { key: 'b' } } })
      const joined = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('presence join timeout')), 12_000)
        b.on('presence', { event: 'join' }, ({ key }) => {
          if (key === 'a') {
            clearTimeout(timer)
            resolve()
          }
        })
      })
      await subscribed(b)
      await subscribed(a)
      await a.track({ online: true })
      await joined
      await a.unsubscribe()
      await b.unsubscribe()
    }],
    ['realtime.getChannels', async () => {
      const ch = anon.channel(`tmp-${Date.now()}`)
      await subscribed(ch)
      const channels = anon.getChannels()
      if (!channels.some((c) => c.topic === ch.topic)) throw new Error('channel not listed')
      await ch.unsubscribe()
    }],
    ['realtime.removeChannel', async () => {
      const ch = anon.channel(`rm-${Date.now()}`)
      await subscribed(ch)
      await anon.removeChannel(ch)
      if (anon.getChannels().some((c) => c.topic === ch.topic)) throw new Error('still present')
    }],
    ['realtime.removeAllChannels', async () => {
      const ch = anon.channel(`all-${Date.now()}`)
      await subscribed(ch)
      await anon.removeAllChannels()
      if (anon.getChannels().length) throw new Error('channels remain')
    }],
    ['realtime.setAuth', null, { skip: 'implicit via supabase client session' }],
  ])
}
