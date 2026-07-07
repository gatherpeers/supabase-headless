import { formatError, reseed, runSdkSuite, signInTestUser } from '../lib.mjs'

export async function runDatabaseSuite(ctx) {
  const { anon, service } = ctx
  await reseed(service)

  const readTests = [
    ['from.select', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id,title')
      if (error) throw error
      if (data.length !== 3) throw new Error(`expected 3 rows, got ${data.length}`)
    }],
    ['from.select.alias', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('heading:title').limit(1)
      if (error) throw error
      if (!data[0]?.heading) throw new Error('alias failed')
    }],
    ['from.select.cast', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('views::text').limit(1)
      if (error) throw error
      if (typeof data[0]?.views !== 'string') throw new Error('cast failed')
    }],
    ['from.eq', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').eq('published', true)
      if (error) throw error
      if (data.length !== 2) throw new Error(`expected 2, got ${data.length}`)
    }],
    ['from.neq', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').neq('published', true)
      if (error) throw error
      if (data.length !== 1) throw new Error(`expected 1, got ${data.length}`)
    }],
    ['from.gt', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').gt('views', 90)
      if (error) throw error
      if (data.length !== 2) throw new Error(`expected 2, got ${data.length}`)
    }],
    ['from.in', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').in('id', [1, 3])
      if (error) throw error
      if (data.length !== 2) throw new Error(`expected 2, got ${data.length}`)
    }],
    ['from.ilike', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('title').ilike('title', '%git%')
      if (error) throw error
      if (data.length !== 1) throw new Error('ilike failed')
    }],
    ['from.or', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').or('views.gt.200,title.eq.Kernel')
      if (error) throw error
      if (data.length !== 2) throw new Error('or failed')
    }],
    ['from.not', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').not('published', 'eq', true)
      if (error) throw error
      if (data.length !== 1) throw new Error('not failed')
    }],
    ['from.contains', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').contains('tags', ['unix'])
      if (error) throw error
      if (data.length !== 2) throw new Error('contains failed')
    }],
    ['from.filter.json', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('title').eq('meta->>country', 'FI')
      if (error) throw error
      if (data[0]?.title !== 'Git') throw new Error('json filter failed')
    }],
    ['from.textSearch', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('title').textSearch('search', 'plumbing', {
        type: 'plain',
        config: 'english',
      })
      if (error) throw error
      if (data.length !== 1) throw new Error('textSearch failed')
    }],
    ['from.order', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('title').order('views', { ascending: false }).limit(1)
      if (error) throw error
      if (data[0]?.title !== 'Git') throw new Error('order failed')
    }],
    ['from.range', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').order('id').range(1, 2)
      if (error) throw error
      if (data.map((r) => r.id).join(',') !== '2,3') throw new Error('range failed')
    }],
    ['from.limit', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('id').limit(2)
      if (error) throw error
      if (data.length !== 2) throw new Error('limit failed')
    }],
    ['from.single', async () => {
      const { data, error } = await anon.from('sdk_test_items').select('title').eq('id', 1).single()
      if (error) throw error
      if (data.title !== 'Engines') throw new Error('single failed')
    }],
    ['from.maybeSingle', async () => {
      const none = await anon.from('sdk_test_items').select('id').eq('id', 999).maybeSingle()
      if (none.error || none.data !== null) throw new Error('maybeSingle none failed')
      const multi = await anon.from('sdk_test_items').select('id').maybeSingle()
      if (!multi.error) throw new Error('maybeSingle multi should error')
    }],
    ['from.count', async () => {
      const { count, error } = await anon.from('sdk_test_items').select('*', { count: 'exact', head: true })
      if (error) throw error
      if (count !== 3) throw new Error(`count ${count}`)
    }],
    ['from.embed', async () => {
      const { data, error } = await anon
        .from('sdk_test_items')
        .select('title, children:sdk_test_items!parent_id(title)')
        .eq('id', 1)
        .single()
      if (error) throw error
      if (data.children?.[0]?.title !== 'Git') throw new Error('embed failed')
    }],
    ['from.embed.many', async () => {
      const { data, error } = await anon
        .from('sdk_test_labels')
        .select('name, sdk_test_items(title)')
        .eq('name', 'unix')
        .single()
      if (error) throw error
      const titles = data.sdk_test_items?.map((r) => r.title).sort()
      if (titles?.join(',') !== 'Git,Kernel') throw new Error('many embed failed')
    }],
  ]

  const mutateTests = [
    ['from.insert', async () => {
      await signInTestUser(anon, service)
      const { data, error } = await anon
        .from('sdk_test_items')
        .insert({ title: `tmp-${Date.now()}` })
        .select()
        .single()
      if (error) throw new Error(formatError(error))
      if (!data.id) throw new Error('insert failed')
    }],
    ['from.update', async () => {
      const { data, error } = await anon.from('sdk_test_items').update({ views: 300 }).eq('id', 2).select().single()
      if (error) throw new Error(formatError(error))
      if (data.views !== 300) throw new Error('update failed')
    }],
    ['from.upsert', async () => {
      const { data, error } = await anon
        .from('sdk_test_items')
        .upsert({ id: 1, title: 'Ada Lovelace' })
        .select()
        .single()
      if (error) throw new Error(formatError(error))
      if (data.title !== 'Ada Lovelace') throw new Error('upsert failed')
    }],
    ['from.delete', async () => {
      const ins = await anon.from('sdk_test_items').insert({ title: 'drop-me' }).select().single()
      if (ins.error) throw new Error(formatError(ins.error))
      const { error } = await anon.from('sdk_test_items').delete().eq('id', ins.data.id)
      if (error) throw new Error(formatError(error))
    }],
    ['rls', async () => {
      await anon.auth.signOut()
      const user = await signInTestUser(anon, service)
      await anon.from('sdk_test_secrets').insert({ content: 'mine' })
      const mine = await anon.from('sdk_test_secrets').select()
      if (mine.data?.length !== 1) throw new Error('RLS own row failed')
      await anon.auth.signOut()
      const anonRead = await anon.from('sdk_test_secrets').select()
      if (anonRead.data?.length) throw new Error('anon should see nothing')
      await service.auth.admin.deleteUser(user.userId)
    }],
  ]

  const rpcTests = [
    ['rpc', async () => {
      const { data, error } = await anon.rpc('sdk_test_add', { a: 2, b: 40 })
      if (error) throw error
      if (data !== 42) throw new Error(`rpc ${data}`)
    }],
    ['rpc.void', async () => {
      const { error } = await anon.rpc('sdk_test_void')
      if (error) throw error
    }],
    ['rpc.setof', async () => {
      const { data, error } = await anon.rpc('sdk_test_published_items')
      if (error) throw error
      if (data.length !== 2) throw new Error(`setof rpc failed: ${data.length} rows`)
    }],
  ]

  const r1 = await runSdkSuite('from() reads (anon)', readTests)
  const r2 = await runSdkSuite('from() writes (authenticated)', mutateTests)
  const r3 = await runSdkSuite('rpc', rpcTests)

  return {
    passed: r1.passed + r2.passed + r3.passed,
    failed: r1.failed + r2.failed + r3.failed,
    skipped: r1.skipped + r2.skipped + r3.skipped,
    failures: [...r1.failures, ...r2.failures, ...r3.failures],
  }
}
