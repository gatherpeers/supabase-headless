import { createClient } from '@supabase/supabase-js'
import {
  clientOpts,
  getConfig,
  runSdkSuite,
  signInExistingUser,
  testPassword,
  uniqueEmail,
} from '../lib.mjs'

export async function runAuthSuite(ctx) {
  const { anon, service } = ctx
  const config = getConfig()
  const password = testPassword(config)
  const email = uniqueEmail('sdk')
  let userId
  let session
  let currentPassword = password
  const captchaToken = process.env.SDK_TEST_CAPTCHA_TOKEN?.trim()

  const tests = [
    ['auth.admin.createUser', async () => {
      const { data, error } = await service.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { suite: 'sdk' },
      })
      if (error) throw error
      userId = data.user.id
    }],
    ['auth.admin.getUserById', async () => {
      const { data, error } = await service.auth.admin.getUserById(userId)
      if (error) throw error
      if (data.user.email !== email) throw new Error('email mismatch')
    }],
    ['auth.admin.listUsers', async () => {
      const { data, error } = await service.auth.admin.listUsers({ page: 1, perPage: 5 })
      if (error) throw error
      if (!data.users.length) throw new Error('empty user list')
    }],
    ['auth.signInWithPassword', async () => {
      if (config.captchaEnabled && !captchaToken) return 'skip'
      const { data, error } = await anon.auth.signInWithPassword({
        email,
        password,
        options: captchaToken ? { captchaToken } : undefined,
      })
      if (error) throw error
      session = data.session
      if (!session?.access_token) throw new Error('no session')
    }, config.captchaEnabled && !captchaToken ? { skip: 'set SDK_TEST_CAPTCHA_TOKEN or uses verifyOtp fallback below' } : undefined],
    ['auth.admin.generateLink', async () => {
      if (!config.captchaEnabled) return 'skip'
      const { data, error } = await service.auth.admin.generateLink({ type: 'magiclink', email })
      if (error) throw error
      if (!data.properties?.hashed_token) throw new Error('missing hashed_token')
    }, !config.captchaEnabled ? { skip: 'only needed when captcha blocks password sign-in' } : undefined],
    ['auth.verifyOtp', async () => {
      if (config.captchaEnabled && !captchaToken) {
        await anon.auth.signOut()
        const link = await service.auth.admin.generateLink({ type: 'magiclink', email })
        if (link.error) throw link.error
        const { data, error } = await anon.auth.verifyOtp({
          email,
          token: link.data.properties.email_otp,
          type: 'email',
        })
        if (error) throw error
        session = data.session
        if (!session?.access_token) throw new Error('no session from verifyOtp')
        return
      }
      return 'skip'
    }, config.captchaEnabled && !captchaToken ? undefined : { skip: 'captcha off or SDK_TEST_CAPTCHA_TOKEN set' }],
    ['auth.getSession', async () => {
      if (!session) session = await signInExistingUser(anon, service, { email, password })
      const { data, error } = await anon.auth.getSession()
      if (error) throw error
      if (!data.session?.access_token) throw new Error('no active session')
    }],
    ['auth.getUser', async () => {
      const { data, error } = await anon.auth.getUser()
      if (error) throw error
      if (data.user?.email !== email) throw new Error('wrong user')
    }],
    ['auth.updateUser', async () => {
      const next = testPassword(config) + 'Z'
      const { data, error } = await anon.auth.updateUser({ data: { plan: 'pro' }, password: next })
      if (error) throw error
      if (data.user?.user_metadata?.plan !== 'pro') throw new Error('metadata not updated')
      session = await signInExistingUser(anon, service, { email, password: next })
      currentPassword = next
    }],
    ['auth.refreshSession', async () => {
      if (!session?.refresh_token) {
        session = await signInExistingUser(anon, service, { email, password: currentPassword })
      }
      const old = session.refresh_token
      const { data, error } = await anon.auth.refreshSession({ refresh_token: old })
      if (error) throw error
      if (!data.session?.access_token) throw new Error('no refreshed session')
      if (data.session.refresh_token === old) throw new Error('token did not rotate')
      session = data.session
    }],
    ['auth.setSession', async () => {
      const current = (await anon.auth.getSession()).data.session ?? session
      if (!current?.access_token) throw new Error('Auth session missing!')
      const isolated = createClient(config.url, config.publishableKey, clientOpts)
      const { data, error } = await isolated.auth.setSession({
        access_token: current.access_token,
        refresh_token: current.refresh_token,
      })
      if (error) throw error
      if (!data.session) throw new Error('setSession failed')
      const { data: userData } = await isolated.auth.getUser()
      if (userData.user?.email !== email) throw new Error('isolated client wrong user')
      session = data.session
    }],
    ['auth.onAuthStateChange', async () => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 5000)
        const { data: sub } = anon.auth.onAuthStateChange((event) => {
          if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
            clearTimeout(timer)
            sub.subscription.unsubscribe()
            resolve()
          }
        })
      })
    }],
    ['auth.signOut', async () => {
      const { error } = await anon.auth.signOut()
      if (error) throw error
      const { data } = await anon.auth.getUser()
      if (data.user) throw new Error('still signed in')
    }],
    ['auth.signUp', async () => {
      const { data, error } = await anon.auth.signUp({
        email: uniqueEmail('signup'),
        password: testPassword(config),
      })
      if (error) throw error
      if (!config.mailerAutoconfirm && data.session) throw new Error('expected no session without autoconfirm')
      if (data.user?.id) await service.auth.admin.deleteUser(data.user.id)
    }, config.captchaEnabled ? { skip: 'GOTRUE_SECURITY_CAPTCHA_ENABLED' } : undefined],
    config.anonymousEnabled
      ? ['auth.signInAnonymously', async () => {
          const { data, error } = await anon.auth.signInAnonymously()
          if (error) throw error
          if (!data.user?.is_anonymous) throw new Error('not anonymous')
          await anon.auth.signOut()
          if (data.user.id) await service.auth.admin.deleteUser(data.user.id)
        }]
      : ['auth.signInAnonymously', null, { skip: 'GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=false' }],
    ['auth.signInWithOAuth', null, { skip: 'requires browser OAuth redirect' }],
    ['auth.signInWithOtp', null, { skip: 'requires SMTP / inbox capture' }],
    ['auth.signInWithSSO', null, { skip: 'requires SSO provider configuration' }],
    ['auth.signInWithIdToken', null, { skip: 'requires OIDC id_token from provider' }],
    ['auth.resetPasswordForEmail', null, { skip: 'sends email' }],
    ['auth.exchangeCodeForSession', null, { skip: 'requires OAuth authorization code' }],
    ['auth.resend', null, { skip: 'requires pending signup / email flow' }],
    ['auth.reauthenticate', null, { skip: 'not enabled or needs nonce flow' }],
    ['auth.admin.inviteUserByEmail', null, { skip: 'sends email' }],
    ['auth.admin.updateUserById', async () => {
      const { data, error } = await service.auth.admin.updateUserById(userId, {
        user_metadata: { suite: 'sdk-updated' },
      })
      if (error) throw error
      if (data.user.user_metadata?.suite !== 'sdk-updated') throw new Error('not updated')
    }],
    ['auth.admin.deleteUser', async () => {
      const { data, error } = await service.auth.admin.deleteUser(userId)
      if (error) throw error
      if (!data) throw new Error('delete failed')
      userId = undefined
    }],
  ]

  return runSdkSuite('auth', tests)
}
