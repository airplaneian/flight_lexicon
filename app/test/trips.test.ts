import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupIntoTrips, buildTripRecord } from '../src/trips.ts'
import type { ParsedFlight } from '../src/flighty.ts'
import { FLIGHT_NSID } from '../src/lexicon.ts'

const f = (row: number, pnr: string | undefined, sourceId: string, date: string, from: string, to: string): ParsedFlight => ({
  row, issues: [], pnr, label: `${date} ${from}->${to}`,
  record: { $type: FLIGHT_NSID, createdAt: 'x', sourceId, date, origin: { iata: from }, destination: { iata: to },
    actualGateDeparture: `${date}T10:00:00-07:00` },
})

test('groups legs sharing a booking reference', () => {
  const trips = groupIntoTrips([
    f(1, 'ABC123', 'u1', '2025-07-13', 'SFO', 'LHR'),
    f(2, 'ABC123', 'u2', '2025-07-25', 'LHR', 'JFK'),
    f(3, 'ZZZ999', 'u3', '2025-08-01', 'SFO', 'LAX'),
  ])
  assert.equal(trips.length, 1, 'single-leg bookings are not trips')
  assert.deepEqual(trips[0].flights.map((x) => x.record.sourceId), ['u1', 'u2'])
})

test('matches booking references case-insensitively', () => {
  const trips = groupIntoTrips([
    f(1, 'O1wxz4', 'u1', '2026-07-08', 'SFO', 'CDG'),
    f(2, 'o1wxz4', 'u2', '2026-07-23', 'CDG', 'SFO'),
  ])
  assert.equal(trips.length, 1, 'the same reference in two cases is one trip')
})

test('ignores flights with no booking reference', () => {
  assert.equal(groupIntoTrips([f(1, undefined, 'u1', '2025-07-13', 'SFO', 'LHR')]).length, 0)
})

test('never derives the trip id from the booking reference', () => {
  const [trip] = groupIntoTrips([
    f(1, 'ABC123', 'u1', '2025-07-13', 'SFO', 'LHR'),
    f(2, 'ABC123', 'u2', '2025-07-25', 'LHR', 'JFK'),
  ])
  assert.equal(trip.sourceId, 'u1', 'first leg id, which is already public')
  const record = buildTripRecord(trip, (x) => `at://did/c/${x.record.sourceId}`, 'now')!
  assert.ok(!JSON.stringify(record).toUpperCase().includes('ABC123'))
})

test('orders legs by departure and links them as at-uris', () => {
  const [trip] = groupIntoTrips([
    f(2, 'ABC123', 'u2', '2025-07-25', 'LHR', 'JFK'),
    f(1, 'ABC123', 'u1', '2025-07-13', 'SFO', 'LHR'),
  ])
  const record = buildTripRecord(trip, (x) => `at://did/c/${x.record.sourceId}`, 'now')!
  assert.deepEqual(record.flights, ['at://did/c/u1', 'at://did/c/u2'], 'departure order')
})

test('does not write a trip whose legs were excluded', () => {
  const [trip] = groupIntoTrips([
    f(1, 'ABC123', 'u1', '2025-07-13', 'SFO', 'LHR'),
    f(2, 'ABC123', 'u2', '2025-07-25', 'LHR', 'JFK'),
  ])
  const only = buildTripRecord(trip, (x) => (x.record.sourceId === 'u1' ? 'at://did/c/u1' : undefined), 'now')
  assert.equal(only, undefined, 'one remaining leg is not a trip')
})
