/**
 * Storage over HTTP: bucket lifecycle, large-upload integrity, signed URLs, TUS.
 * (upstream docker/tests/test-self-hosted.sh storage sections)
 */

import { randomBytes } from 'node:crypto'
import { getConfig, requireEnv } from '../../lib/config.mjs'
import { assertEqual, assertTrue, runChecks, skip } from '../../lib/runner.mjs'
import { b64, http, httpBytes, httpStatus, keyHeaders, sha256, uniqueId } from '../../lib/http.mjs'

const LARGE_SIZE = 7 * 1024 * 1024 // above Studio's 6MB TUS threshold, as upstream
const TUS_CHUNK = 4 * 1024 * 1024

export async function runStorageSuite() {
  const cfg = getConfig()
  requireEnv(cfg, 'serviceRoleKey')

  const storage = cfg.api.storage
  const auth = keyHeaders(cfg.serviceRoleKey)
  const bucket = uniqueId('smoke-store')
  const tusBucket = uniqueId('smoke-tus')
  const large = randomBytes(LARGE_SIZE)
  const largeHash = sha256(large)

  const createBucket = (id) =>
    http(`${storage}/bucket`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: id, public: true }),
    })

  const putObject = (id, key, body, contentType) =>
    httpStatus(`${storage}/object/${id}/${key}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': contentType },
      body,
    })

  const deleteObject = (id, key) =>
    httpStatus(`${storage}/object/${id}/${key}`, { method: 'DELETE', headers: auth })

  const deleteBucket = (id) => httpStatus(`${storage}/bucket/${id}`, { method: 'DELETE', headers: auth })

  // Every check after a bucket creation is skipped rather than cascading if it failed.
  const created = new Set()
  const needs = (id, fn) => async () => (created.has(id) ? fn() : skip('bucket not created'))

  const checks = [
    ['create public bucket', async () => {
      const res = await createBucket(bucket)
      assertEqual(res.status, 200, res.text)
      created.add(bucket)
    }],
    ['upload 7MB object', needs(bucket, async () => {
      assertEqual(await putObject(bucket, 'test-large-file.bin', large, 'application/octet-stream'), 200)
    })],
    ['download 7MB size + hash match', needs(bucket, async () => {
      const res = await httpBytes(`${storage}/object/public/${bucket}/test-large-file.bin`)
      assertEqual(res.status, 200)
      assertEqual(res.buf.length, large.length, 'size')
      assertEqual(sha256(res.buf), largeHash, 'hash')
    })],
    ['signed URL fetch without auth', needs(bucket, async () => {
      assertEqual(await putObject(bucket, 'sign-test.txt', 'signed url test content', 'text/plain'), 200)

      const sign = await http(`${storage}/object/sign/${bucket}/sign-test.txt`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 600 }),
      })
      const signedPath = sign.json?.signedURL
      assertTrue(!!signedPath, sign.text)

      const signedUrl = signedPath.startsWith('http') ? signedPath : `${storage}${signedPath}`
      const body = await http(signedUrl)
      assertEqual(body.status, 200)
      assertEqual(body.text, 'signed url test content')
    })],
    ['delete large object', needs(bucket, async () => {
      assertEqual(await deleteObject(bucket, 'test-large-file.bin'), 200)
    })],
    ['delete bucket', needs(bucket, async () => {
      await deleteObject(bucket, 'sign-test.txt')
      assertEqual(await deleteBucket(bucket), 200)
      created.delete(bucket)
    })],

    ['TUS: create bucket', async () => {
      const res = await createBucket(tusBucket)
      assertEqual(res.status, 200, res.text)
      created.add(tusBucket)
    }],
    ['TUS: resumable upload 7MB in chunks', needs(tusBucket, async () => {
      const metadata = [
        `bucketName ${b64(tusBucket)}`,
        `objectName ${b64('tus-test-file.bin')}`,
        `contentType ${b64('application/octet-stream')}`,
      ].join(',')

      const create = await http(`${storage}/upload/resumable`, {
        method: 'POST',
        headers: {
          ...auth,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(large.length),
          'Upload-Metadata': metadata,
          'x-upsert': 'true',
        },
      })
      assertEqual(create.status, 201, create.text)

      // Storage rebuilds this absolute URL from X-Forwarded-Prefix, so it must carry
      // the gateway's /storage/v1 prefix back to the client.
      const location = create.headers.get('location')
      assertTrue(!!location, 'missing Location')
      assertTrue(location.includes(cfg.storagePrefix), `Location missing prefix: ${location}`)

      for (const offset of [0, TUS_CHUNK]) {
        const patch = await http(location, {
          method: 'PATCH',
          headers: {
            ...auth,
            'Tus-Resumable': '1.0.0',
            'Upload-Offset': String(offset),
            'Content-Type': 'application/offset+octet-stream',
          },
          body: large.subarray(offset, offset + TUS_CHUNK),
        })
        assertEqual(patch.status, 204, `offset ${offset}: ${patch.text}`)
      }

      const dl = await httpBytes(`${storage}/object/public/${tusBucket}/tus-test-file.bin`)
      assertEqual(dl.status, 200)
      assertEqual(dl.buf.length, large.length, 'tus size')
      assertEqual(sha256(dl.buf), largeHash, 'tus hash')
    })],
    ['TUS: delete bucket', needs(tusBucket, async () => {
      await deleteObject(tusBucket, 'tus-test-file.bin')
      assertEqual(await deleteBucket(tusBucket), 200)
      created.delete(tusBucket)
    })],
  ]

  try {
    return await runChecks('smoke:storage', checks)
  } finally {
    // Buckets are uniquely named per run, so a failure mid-suite would otherwise leak them.
    for (const id of created) {
      await http(`${storage}/bucket/${id}/empty`, { method: 'POST', headers: auth }).catch(() => {})
      await deleteBucket(id).catch(() => {})
    }
  }
}
