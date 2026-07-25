// Writing flight records to a repository without ever duplicating them.
//
// Re-importing an updated export must update the records already there rather
// than adding a second copy of every flight. Matching is on source + sourceId
// carried in the record body, not on the record key: keys are opaque TIDs
// precisely so that correcting a flight number updates a record instead of
// minting a new one.

import { FLIGHT_NSID, TRIP_NSID, type FlightRecord, type TripRecord } from './lexicon.ts'

/** Fields this tool owns. Anything else on an existing record is another
 *  tool's and must survive an update untouched. */
export const OWNED_FIELDS = new Set<keyof FlightRecord | '$type'>([
  '$type', 'date', 'origin', 'destination', 'route', 'source', 'sourceId',
  'callsign', 'operator', 'operatorName', 'flightNumber',
  'marketingAirline', 'marketingFlightNumber',
  'registration', 'registeredOwner', 'aircraftType', 'icaoTypeDesignator', 'icao24',
  'scheduledGateDeparture', 'actualGateDeparture', 'scheduledTakeoff', 'actualTakeoff',
  'scheduledLanding', 'actualLanding', 'scheduledGateArrival', 'actualGateArrival',
  'relationship', 'seat', 'cabin', 'status', 'diversionAirport', 'notes',
])

export interface ExistingRecord {
  uri: string
  rkey: string
  value: Record<string, unknown>
}

export interface WriteOp {
  action: 'create' | 'update'
  collection: string
  rkey?: string
  value: Record<string, unknown>
}

/** Minimal surface of the atproto client this module needs, so it can be tested
 *  without standing up a real session. */
export interface RepoClient {
  listRecords(params: { collection: string; cursor?: string; limit: number }): Promise<{
    records: { uri: string; value: Record<string, unknown> }[]
    cursor?: string
  }>
  applyWrites(params: { writes: unknown[] }): Promise<unknown>
}

export const rkeyFromUri = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1)

/** Index key for a record's provenance. Written in exactly one place so that a
 *  caller cannot reconstruct it slightly differently and silently miss. NUL
 *  separates because neither field may contain it, where a space would let
 *  ('a b', 'c') and ('a', 'b c') collide. */
export const sourceKey = (source: unknown, sourceId: unknown): string =>
  `${source}\u0000${sourceId}`

/** Every record already in the collection, following pagination to the end. */
export async function listAll(client: RepoClient, collection: string): Promise<ExistingRecord[]> {
  const out: ExistingRecord[] = []
  let cursor: string | undefined
  do {
    const page = await client.listRecords({ collection, cursor, limit: 100 })
    for (const r of page.records) out.push({ uri: r.uri, rkey: rkeyFromUri(r.uri), value: r.value })
    cursor = page.cursor
  } while (cursor)
  return out
}

/** Index existing records by the source that wrote them and that source's id. */
export function indexBySourceId(records: ExistingRecord[]): Map<string, ExistingRecord> {
  const index = new Map<string, ExistingRecord>()
  for (const r of records) {
    const source = r.value.source
    const sourceId = r.value.sourceId
    if (typeof source === 'string' && typeof sourceId === 'string') {
      // A duplicate key means a previous import went wrong. Keep the first so
      // repeated runs converge on one record rather than alternating.
      const key = sourceKey(source, sourceId)
      if (!index.has(key)) index.set(key, r)
    }
  }
  return index
}

/**
 * Merge a freshly-built record over an existing one.
 *
 * Fields this tool owns are replaced wholesale, including being dropped when
 * newly absent. Everything else -- sidecar data, fields from a newer version of
 * the schema, anything another client wrote -- is carried through untouched.
 * createdAt is kept from the original, since it records when the record was
 * first written and not when it was last touched.
 */
export function mergeRecord(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(existing)) {
    if (!OWNED_FIELDS.has(k as keyof FlightRecord) && k !== 'createdAt') merged[k] = v
  }
  merged.createdAt = existing.createdAt ?? incoming.createdAt
  for (const [k, v] of Object.entries(incoming)) {
    if (k !== 'createdAt') merged[k] = v
  }
  return merged
}

/** Decide, for each incoming record, whether it creates or updates. */
export function planWrites(
  incoming: (FlightRecord | TripRecord)[],
  existingIndex: Map<string, ExistingRecord>,
  collection: string,
): WriteOp[] {
  return incoming.map((record) => {
    const key = sourceKey(record.source, record.sourceId)
    const match = record.source && record.sourceId ? existingIndex.get(key) : undefined
    return match
      ? { action: 'update', collection, rkey: match.rkey, value: mergeRecord(match.value, record) }
      : { action: 'create', collection, value: record as Record<string, unknown> }
  })
}

/** applyWrites is limited per call, so writes go in batches. */
const BATCH_SIZE = 100

export async function executeWrites(
  client: RepoClient,
  ops: WriteOp[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  for (let i = 0; i < ops.length; i += BATCH_SIZE) {
    const batch = ops.slice(i, i + BATCH_SIZE)
    await client.applyWrites({
      writes: batch.map((op) =>
        op.action === 'create'
          ? { $type: 'com.atproto.repo.applyWrites#create', collection: op.collection, value: op.value }
          : {
              $type: 'com.atproto.repo.applyWrites#update',
              collection: op.collection,
              rkey: op.rkey,
              value: op.value,
            },
      ),
    })
    onProgress?.(Math.min(i + BATCH_SIZE, ops.length), ops.length)
  }
}

export { FLIGHT_NSID, TRIP_NSID }
