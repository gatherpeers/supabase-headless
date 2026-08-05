import { runChecks } from '../../lib/runner.mjs'
import { signInTestUser } from '../../lib/sdk.mjs'

// Smallest valid 1x1 PNG, used to prove the imgproxy transform path returns an image.
const PIXEL_PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

export async function runStorageSuite(ctx) {
  const { anon, service } = ctx
  const suffix = Date.now()
  const pubBucket = `sdk-test-pub-${suffix}`
  const privBucket = `sdk-test-priv-${suffix}`
  let storageUser

  const authed = () => anon.storage

  const result = await runChecks('sdk:storage', [
    ['storage.createBucket', async () => {
      const pub = await service.storage.createBucket(pubBucket, { public: true })
      if (pub.error) throw pub.error
      const priv = await service.storage.createBucket(privBucket, { public: false })
      if (priv.error) throw priv.error
    }],
    ['storage.listBuckets', async () => {
      const { data, error } = await service.storage.listBuckets()
      if (error) throw error
      const ids = data.map((b) => b.id)
      if (!ids.includes(pubBucket) || !ids.includes(privBucket)) throw new Error('buckets missing from list')
    }],
    ['storage.getBucket', async () => {
      const { data, error } = await service.storage.getBucket(pubBucket)
      if (error) throw error
      if (!data.public) throw new Error('expected public bucket')
    }],
    ['storage.updateBucket', async () => {
      const { error } = await service.storage.updateBucket(privBucket, { public: false, fileSizeLimit: 1024 * 1024 })
      if (error) throw error
    }],
    ['storage.from.upload', async () => {
      storageUser = await signInTestUser(anon, service)
      const { data, error } = await authed().from(privBucket).upload('a/hello.txt', new Blob(['sdk']), {
        contentType: 'text/plain',
      })
      if (error) throw error
      if (data.path !== 'a/hello.txt') throw new Error('upload path wrong')
    }],
    ['storage.from.download', async () => {
      const { data, error } = await authed().from(privBucket).download('a/hello.txt')
      if (error) throw error
      if ((await data.text()) !== 'sdk') throw new Error('download content wrong')
    }],
    ['storage.from.list', async () => {
      const { data, error } = await authed().from(privBucket).list('a')
      if (error) throw error
      if (!data.some((f) => f.name === 'hello.txt')) throw new Error('list missing file')
    }],
    ['storage.from.upload.upsert', async () => {
      const up = await authed().from(privBucket).upload('a/hello.txt', new Blob(['x']))
      if (!up.error) throw new Error('expected conflict')
      const { error } = await authed()
        .from(privBucket)
        .upload('a/hello.txt', new Blob(['updated']), { upsert: true })
      if (error) throw error
    }],
    ['storage.from.getPublicUrl', async () => {
      await authed().from(pubBucket).upload('x.txt', new Blob(['pub']))
      const { data } = authed().from(pubBucket).getPublicUrl('x.txt')
      const res = await fetch(data.publicUrl)
      if (!res.ok) throw new Error(`public url ${res.status}`)
    }],
    ['storage.from.createSignedUrl', async () => {
      const { data, error } = await authed().from(privBucket).createSignedUrl('a/hello.txt', 120)
      if (error) throw error
      const res = await fetch(data.signedUrl)
      if (!res.ok) throw new Error(`signed url ${res.status}`)
    }],
    ['storage.from.createSignedUrls', async () => {
      const { data, error } = await authed().from(privBucket).createSignedUrls(['a/hello.txt'], 120)
      if (error) throw error
      if (!data?.[0]?.signedUrl) throw new Error('createSignedUrls empty')
    }],
    ['storage.from.createSignedUploadUrl', async () => {
      const { data, error } = await authed().from(privBucket).createSignedUploadUrl('a/signed-up.txt')
      if (error) throw error
      const up = await authed().from(privBucket).uploadToSignedUrl(data.path, data.token, new Blob(['signed-up']), {
        contentType: 'text/plain',
      })
      if (up.error) throw up.error
    }],
    ['storage.from.createSignedUrl.transform', async () => {
      const up = await authed().from(pubBucket).upload('pixel.png', PIXEL_PNG, { contentType: 'image/png', upsert: true })
      if (up.error) throw up.error
      const { data, error } = await authed().from(pubBucket).createSignedUrl('pixel.png', 120, {
        transform: { width: 32, height: 32, resize: 'cover' },
      })
      if (error) throw error
      const res = await fetch(data.signedUrl)
      if (!res.ok) throw new Error(`transform signed url ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('image')) throw new Error(`expected image content-type, got ${ct}`)
    }],
    ['storage.from.copy', async () => {
      const { error } = await authed().from(privBucket).copy('a/hello.txt', 'a/copy.txt')
      if (error) throw error
    }],
    ['storage.from.move', async () => {
      const { error } = await authed().from(privBucket).move('a/copy.txt', 'b/moved.txt')
      if (error) throw error
    }],
    ['storage.from.remove', async () => {
      const { data, error } = await authed().from(privBucket).remove(['a/hello.txt', 'b/moved.txt'])
      if (error) throw error
      if (data.length !== 2) throw new Error('remove count wrong')
    }],
    ['storage.emptyBucket', async () => {
      await authed().from(pubBucket).upload('z.txt', new Blob(['z']))
      const { error } = await service.storage.emptyBucket(pubBucket)
      if (error) throw error
    }],
    ['storage.deleteBucket', async () => {
      for (const id of [pubBucket, privBucket]) {
        await service.storage.emptyBucket(id).catch(() => {})
        const { error } = await service.storage.deleteBucket(id)
        if (error) throw error
      }
    }],
    ['storage.from.upload.resumable', null, { skip: 'TUS covered at HTTP level in smoke:storage' }],
    ['storage.from.update', null, { skip: 'metadata update — optional' }],
  ], { track: true })

  if (storageUser?.userId) await service.auth.admin.deleteUser(storageUser.userId)

  return result
}
