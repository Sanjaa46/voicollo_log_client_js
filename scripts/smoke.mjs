// Verifies the *built* package loads in both module systems (run after `npm run build`).
import { createRequire } from 'node:module'
import * as esm from '../dist/index.js'

const require = createRequire(import.meta.url)
const cjs = require('../dist/index.cjs')

for (const [name, mod] of [['esm', esm], ['cjs', cjs]]) {
  if (typeof mod.LMSClient !== 'function' || !mod.VERSION) throw new Error(`${name} build is broken`)
  const lms = new mod.LMSClient({
    baseUrl: 'http://localhost',
    secret: 's',
    sourceService: 'svc',
    environment: 'test',
    fetch: async () => new Response('{"log_id":1,"ingested_at":"2026-01-01T00:00:00Z"}', { status: 201 }),
  })
  const result = await lms.info('smoke')
  if (result.log_id !== 1) throw new Error(`${name} request failed`)
  console.log(`${name} ok — lms-logger ${mod.VERSION}`)
}
