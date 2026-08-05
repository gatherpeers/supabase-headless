/**
 * Storage's S3 protocol through the public gateway (/storage/v1/s3).
 * Upstream equivalent: docker/tests/test-s3.sh.
 */

import { randomBytes } from 'node:crypto'
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getConfig, requireEnv } from '../../lib/config.mjs'
import { assertEqual, assertTrue, runChecks, skip } from '../../lib/runner.mjs'
import { http, sha256, uniqueId } from '../../lib/http.mjs'

const LARGE_SIZE = 7 * 1024 * 1024
const PART_SIZE = 5 * 1024 * 1024 // S3 minimum part size, so 7MB becomes two parts
const SMALL_BODY = 'hello from s3 upload test'

/** Values a client might inject to move SigV4's host binding off the real gateway. */
const SPOOFED_FORWARDED_HEADERS = {
  'x-forwarded-host': 'evil.example.com',
  'x-forwarded-proto': 'http',
  'x-forwarded-prefix': '/evil',
}

function s3Client(cfg, { credentials, headers } = {}) {
  const client = new S3Client({
    region: cfg.s3Region,
    endpoint: `${cfg.api.storage}/s3`,
    forcePathStyle: true,
    credentials: credentials ?? {
      accessKeyId: cfg.s3AccessKeyId,
      secretAccessKey: cfg.s3SecretAccessKey,
    },
  })

  if (headers) {
    client.middlewareStack.add(
      (next) => async (args) => {
        Object.assign(args.request.headers, headers)
        return next(args)
      },
      { step: 'finalizeRequest', name: 'injectHeaders' },
    )
  }
  return client
}

export async function runS3Suite() {
  const cfg = getConfig()
  requireEnv(cfg, 's3AccessKeyId', 's3SecretAccessKey')

  const client = s3Client(cfg)
  const bucket = uniqueId('s3-test')
  const large = randomBytes(LARGE_SIZE)
  const largeHash = sha256(large)

  let bucketReady = false
  const needsBucket = (fn) => async () => (bucketReady ? fn() : skip('bucket not created'))

  const put = (Key, Body, extra) => client.send(new PutObjectCommand({ Bucket: bucket, Key, Body, ...extra }))
  const getText = async (Key, extra) => {
    const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key, ...extra }))
    return out.Body.transformToString()
  }
  const listKeys = async () => {
    const out = await client.send(new ListObjectsV2Command({ Bucket: bucket }))
    return (out.Contents || []).map((o) => o.Key)
  }

  const checks = [
    ['ListBuckets returns response', async () => {
      const out = await client.send(new ListBucketsCommand({}))
      assertTrue(Array.isArray(out.Buckets), 'Buckets missing')
    }],
    ['CreateBucket', async () => {
      await client.send(new CreateBucketCommand({ Bucket: bucket }))
      const out = await client.send(new ListBucketsCommand({}))
      assertTrue(out.Buckets.some((b) => b.Name === bucket), 'bucket not listed')
      bucketReady = true
    }],
    ['PutObject', needsBucket(async () => {
      await put('s3-uploaded.txt', Buffer.from(SMALL_BODY), { ContentType: 'text/plain' })
    })],
    ['ListObjectsV2 finds object', needsBucket(async () => {
      assertTrue((await listKeys()).includes('s3-uploaded.txt'))
    })],
    ['HeadObject size matches', needsBucket(async () => {
      const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: 's3-uploaded.txt' }))
      assertEqual(out.ContentLength, SMALL_BODY.length)
    })],
    ['GetObject content matches', needsBucket(async () => {
      assertEqual(await getText('s3-uploaded.txt'), SMALL_BODY)
    })],
    ['CopyObject', needsBucket(async () => {
      await client.send(
        new CopyObjectCommand({ Bucket: bucket, CopySource: `${bucket}/s3-uploaded.txt`, Key: 's3-copied.txt' }),
      )
      assertEqual(await getText('s3-copied.txt'), SMALL_BODY)
    })],
    ['DeleteObject', needsBucket(async () => {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: 's3-copied.txt' }))
      assertTrue(!(await listKeys()).includes('s3-copied.txt'))
    })],
    ['DeleteObjects (batch)', needsBucket(async () => {
      const keys = ['batch-a.txt', 'batch-b.txt', 'batch-c.txt']
      for (const key of keys) await put(key, Buffer.from(key))
      const out = await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }),
      )
      assertEqual((out.Deleted || []).length, keys.length)
      const remaining = (await listKeys()).filter((key) => keys.includes(key))
      assertEqual(remaining.length, 0, remaining.join(','))
    })],
    ['multipart upload 7MB in 2 parts', needsBucket(async () => {
      // PutObject is always a single PUT regardless of body size; only lib-storage's
      // Upload issues CreateMultipartUpload / UploadPart / CompleteMultipartUpload.
      const out = await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: 'large-file.bin',
          Body: large,
          ContentType: 'application/octet-stream',
        },
        partSize: PART_SIZE,
        queueSize: 2,
      }).done()

      // A completed multipart ETag is "<hash>-<partCount>"; a single PUT has no suffix.
      assertTrue(/-2"?$/.test(out.ETag ?? ''), `expected a 2-part multipart ETag, got ${out.ETag}`)

      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: 'large-file.bin' }))
      assertEqual(head.ContentLength, large.length)

      const got = await client.send(new GetObjectCommand({ Bucket: bucket, Key: 'large-file.bin' }))
      const buf = Buffer.from(await got.Body.transformToByteArray())
      assertEqual(buf.length, large.length, 'size')
      assertEqual(sha256(buf), largeHash, 'hash')
    })],
    ['Range GetObject', needsBucket(async () => {
      await put('range-test.txt', Buffer.from('hello range test content'))
      assertEqual(await getText('range-test.txt', { Range: 'bytes=0-4' }), 'hello')
    })],
    ['Presigned URL fetch', needsBucket(async () => {
      // Upstream marks this as expected-to-fail because Kong injects an empty
      // Authorization header; the Caddyfile leaves SigV4 requests untouched instead.
      await put('presign-test.txt', Buffer.from('presigned content test'))
      const signed = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: 'presign-test.txt' }),
        { expiresIn: 600 },
      )
      const res = await http(signed)
      assertEqual(res.status, 200)
      assertEqual(res.text, 'presigned content test')
    })],
    ['invalid credentials rejected', async () => {
      const bad = s3Client(cfg, {
        credentials: { accessKeyId: 'invalid-key', secretAccessKey: 'invalid-secret' },
      })
      await assertRejects(() => bad.send(new ListBucketsCommand({})), 'expected auth failure')
    }],
    ['client cannot spoof forwarded headers', async () => {
      // S3_ALLOW_FORWARDED_HEADER lets Storage rebuild the SigV4 host from X-Forwarded-*,
      // which is only safe because the gateway overwrites whatever the client sent.
      for (const [header, value] of Object.entries(SPOOFED_FORWARDED_HEADERS)) {
        const spoofed = s3Client(cfg, { headers: { [header]: value } })
        const out = await spoofed.send(new ListBucketsCommand({}))
        assertTrue(Array.isArray(out.Buckets), `${header} reached Storage and broke signing`)
      }
    }],
    ['cleanup bucket', needsBucket(async () => {
      await emptyAndDeleteBucket(client, bucket)
      bucketReady = false
    })],
  ]

  try {
    return await runChecks('smoke:s3', checks)
  } finally {
    if (bucketReady) await emptyAndDeleteBucket(client, bucket).catch(() => {})
  }
}

async function assertRejects(fn, detail) {
  try {
    await fn()
  } catch {
    return
  }
  throw new Error(detail)
}

async function emptyAndDeleteBucket(client, Bucket) {
  const listed = await client.send(new ListObjectsV2Command({ Bucket }))
  for (const obj of listed.Contents || []) {
    await client.send(new DeleteObjectCommand({ Bucket, Key: obj.Key }))
  }
  await client.send(new DeleteBucketCommand({ Bucket }))
}
