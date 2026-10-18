import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from './db'
import { createTraceStore } from './traces'

const tempFile = (): string => join(mkdtempSync(join(tmpdir(), 'reconix-traces-')), 'reconix.db')

describe('createTraceStore', () => {
  it('saves a text trace and reads it back', async () => {
    const store = createTraceStore(openDatabase())
    const ref = await store.save('trace', 'hello world')

    expect(ref).toBe('trace_1')
    const record = store.get(ref)!
    expect(record).toMatchObject({ ref, kind: 'trace' })
    expect(Buffer.from(record.data).toString('utf8')).toBe('hello world')
  })

  it('round-trips binary bytes exactly', async () => {
    const store = createTraceStore(openDatabase())
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const ref = await store.save('screenshot', png)

    expect(Buffer.compare(Buffer.from(store.get(ref)!.data), png)).toBe(0)
  })

  it('returns null for an unknown ref', () => {
    expect(createTraceStore(openDatabase()).get('trace_999')).toBeNull()
  })

  it('continues the ref sequence across restarts', async () => {
    const file = tempFile()
    const firstDb = openDatabase(file)
    await createTraceStore(firstDb).save('trace', 'a')
    firstDb.close()

    const secondDb = openDatabase(file)
    const store = createTraceStore(secondDb)
    expect(await store.save('trace', 'b')).toBe('trace_2')
    expect(store.get('trace_1')).not.toBeNull()
    secondDb.close()
  })
})
