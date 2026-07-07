import { runSdkSuite, signInTestUser } from '../lib.mjs'

export async function runFunctionsSuite(ctx) {
  const { anon, service } = ctx

  return runSdkSuite('functions', [
    ['functions.invoke', async () => {
      const { data, error } = await anon.functions.invoke('example1?name=sdk', { method: 'GET' })
      if (error) throw error
      if (!String(data?.message).includes('sdk')) throw new Error(JSON.stringify(data))
    }],
    ['functions.invoke.withBody', async () => {
      const { data, error } = await anon.functions.invoke('example1?name=body', { method: 'GET' })
      if (error) throw error
      if (!String(data?.message).includes('body')) throw new Error(JSON.stringify(data))
    }],
    ['functions.invoke.authHeader', async () => {
      const user = await signInTestUser(anon, service)
      const { data, error } = await anon.functions.invoke('example2', { method: 'GET' })
      if (error) throw error
      if (data.email !== user.email) throw new Error('jwt not forwarded')
      await service.auth.admin.deleteUser(user.userId)
      await anon.auth.signOut()
    }],
    ['functions.invoke.notFound', async () => {
      const { error } = await anon.functions.invoke('sdk-missing-fn')
      if (!error) throw new Error('expected error')
    }],
  ])
}
