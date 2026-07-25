import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexBySourceId, mergeRecord, planWrites, listAll, type RepoClient } from '../src/repo.ts'
import { FLIGHT_NSID, type FlightRecord } from '../src/lexicon.ts'

const flight = (sourceId: string, extra: Partial<FlightRecord> = {}): FlightRecord => ({
  $type: FLIGHT_NSID,
  createdAt: '2026-07-25T09:00:00-07:00',
  source: 'flighty',
  sourceId,
  ...extra,
})

test('follows pagination to the end', async () => {
  const pages = [
    { records: [{ uri: 'at://did/c/a', value: {} }], cursor: '1' },
    { records: [{ uri: 'at://did/c/b', value: {} }], cursor: '2' },
    { records: [{ uri: 'at://did/c/c', value: {} }], cursor: undefined },
  ]
  let n = 0
  const client: RepoClient = {
    listRecords: async () => pages[n++]!,
    applyWrites: async () => ({}),
  }
  const all = await listAll(client, 'c')
  assert.deepEqual(all.map((r) => r.rkey), ['a', 'b', 'c'])
})

test('re-importing updates rather than duplicating', () => {
  const existing = [{ uri: 'at://did/c/rk1', rkey: 'rk1', value: { source: 'flighty', sourceId: 'u1' } }]
  const ops = planWrites([flight('u1'), flight('u2')], indexBySourceId(existing), FLIGHT_NSID)
  assert.equal(ops[0].action, 'update')
  assert.equal(ops[0].rkey, 'rk1')
  assert.equal(ops[1].action, 'create')
  assert.equal(ops[1].rkey, undefined)
})

test('a record with no sourceId is always a create', () => {
  const index = indexBySourceId([{ uri: 'at://did/c/rk1', rkey: 'rk1', value: { source: 'flighty' } }])
  assert.equal(index.size, 0, 'unindexable without both fields')
  const [op] = planWrites([flight('') as FlightRecord], index, FLIGHT_NSID)
  assert.equal(op.action, 'create')
})

test('records from another source do not collide', () => {
  const existing = [{ uri: 'at://did/c/rk1', rkey: 'rk1', value: { source: 'adsb', sourceId: 'u1' } }]
  const [op] = planWrites([flight('u1')], indexBySourceId(existing), FLIGHT_NSID)
  assert.equal(op.action, 'create', 'same id, different source, different record')
})

test('preserves fields this tool does not own', () => {
  const existing = {
    $type: FLIGHT_NSID,
    createdAt: '2020-01-01T00:00:00Z',
    source: 'flighty',
    sourceId: 'u1',
    flightNumber: '111',
    someFutureField: { nested: true },
    ratingOutOfTen: 8,
  }
  const merged = mergeRecord(existing, flight('u1', { flightNumber: '112' }))
  assert.deepEqual(merged.someFutureField, { nested: true }, 'sidecar data survives')
  assert.equal(merged.ratingOutOfTen, 8)
  assert.equal(merged.flightNumber, '112', 'owned field updated')
})

test('keeps the original createdAt on update', () => {
  const merged = mergeRecord(
    { createdAt: '2020-01-01T00:00:00Z', source: 'flighty', sourceId: 'u1' },
    flight('u1'),
  )
  assert.equal(merged.createdAt, '2020-01-01T00:00:00Z', 'records when first written, not last touched')
})

test('drops an owned field that is newly absent', () => {
  // A flight that was diverted and has since been corrected: the stale
  // diversionAirport must not linger.
  const merged = mergeRecord(
    { createdAt: '2020-01-01T00:00:00Z', source: 'flighty', sourceId: 'u1', status: 'diverted', diversionAirport: { iata: 'BOS' } },
    flight('u1', { status: 'normal' }),
  )
  assert.equal(merged.status, 'normal')
  assert.ok(!('diversionAirport' in merged), 'stale owned field removed')
})

test('a second import of an unchanged file produces identical values', () => {
  const first = flight('u1', { flightNumber: '112' })
  const existing = [{ uri: 'at://did/c/rk1', rkey: 'rk1', value: { ...first } }]
  const [op] = planWrites([flight('u1', { flightNumber: '112' })], indexBySourceId(existing), FLIGHT_NSID)
  assert.equal(op.action, 'update')
  assert.deepEqual(op.value, first, 'idempotent: no drift on repeat import')
})

test('batches writes and reports progress', async () => {
  const batches: number[] = []
  const client: RepoClient = {
    listRecords: async () => ({ records: [] }),
    applyWrites: async ({ writes }) => { batches.push(writes.length); return {} },
  }
  const { executeWrites } = await import('../src/repo.ts')
  const ops = Array.from({ length: 250 }, (_, i) => ({
    action: 'create' as const, collection: FLIGHT_NSID, value: { n: i },
  }))
  const progress: number[] = []
  await executeWrites(client, ops, (done) => progress.push(done))
  assert.deepEqual(batches, [100, 100, 50])
  assert.deepEqual(progress, [100, 200, 250])
})
