import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlightyCsv, FlightyParseError } from '../src/flighty.ts'
import { FLIGHT_NSID } from '../src/lexicon.ts'

const COLUMNS = [
  'Date', 'Airline', 'Flight', 'From', 'To', 'Dep Terminal', 'Dep Gate', 'Arr Terminal', 'Arr Gate',
  'Canceled', 'Diverted To', 'Gate Departure (Scheduled)', 'Gate Departure (Actual)',
  'Take off (Scheduled)', 'Take off (Actual)', 'Landing (Scheduled)', 'Landing (Actual)',
  'Gate Arrival (Scheduled)', 'Gate Arrival (Actual)', 'Aircraft Type Name', 'Tail Number', 'PNR',
  'Seat', 'Seat Type', 'Cabin Class', 'Flight Reason', 'Notes', 'Flight Flighty ID',
]

function csv(...rows: Record<string, string>[]): string {
  const body = rows.map((r) => COLUMNS.map((c) => quote(r[c] ?? '')).join(','))
  return [COLUMNS.join(','), ...body].join('\n')
}
const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

test('rejects a file that is not a Flighty export', () => {
  assert.throws(() => parseFlightyCsv('a,b,c\n1,2,3'), FlightyParseError)
})

test('maps a complete row, giving every time an explicit offset', () => {
  const [f] = parseFlightyCsv(csv({
    'Date': '2025-07-13', 'Airline': 'VIR', 'Flight': '20', 'From': 'SFO', 'To': 'LHR',
    'Dep Terminal': 'INTL', 'Dep Gate': 'A2', 'Arr Terminal': '3', 'Canceled': 'false',
    'Gate Departure (Scheduled)': '2025-07-13T16:05', 'Gate Departure (Actual)': '2025-07-13T15:57',
    'Take off (Scheduled)': '2025-07-13T16:24', 'Take off (Actual)': '2025-07-13T16:25',
    'Landing (Scheduled)': '2025-07-14T10:03', 'Landing (Actual)': '2025-07-14T10:14',
    'Gate Arrival (Scheduled)': '2025-07-14T10:25', 'Gate Arrival (Actual)': '2025-07-14T10:23',
    'Aircraft Type Name': 'Boeing 787-9', 'Tail Number': 'GVBOW', 'PNR': 'H4LP2M', 'Seat': '46K',
    'Cabin Class': 'PREMIUM_ECONOMY', 'Flight Flighty ID': 'bef37d51',
  }))

  assert.deepEqual(f.issues, [])
  assert.equal(f.record.$type, FLIGHT_NSID)
  assert.equal(f.record.date, '2025-07-13')
  assert.equal(f.record.operatingAirline, 'VIR')
  assert.equal(f.record.flightNumber, '20', 'flight number stays a string')
  assert.deepEqual(f.record.origin, { iata: 'SFO', terminal: 'INTL', gate: 'A2' })
  assert.deepEqual(f.record.destination, { iata: 'LHR', terminal: '3' }, 'no empty gate key')
  // Departure in origin-local, arrival in destination-local.
  assert.equal(f.record.actualGateDeparture, '2025-07-13T15:57:00-07:00')
  assert.equal(f.record.actualGateArrival, '2025-07-14T10:23:00+01:00')
  assert.equal(f.record.cabin, 'premiumEconomy', 'UPPER_SNAKE becomes lower camel case')
  assert.equal(f.record.status, 'normal', 'written explicitly; absent would mean unknown')
  assert.equal(f.record.relationship, 'passenger')
  assert.equal(f.record.sourceId, 'bef37d51')
})

test('never writes the booking reference into the record', () => {
  const [f] = parseFlightyCsv(csv({
    'Date': '2025-07-13', 'Airline': 'VIR', 'Flight': '20', 'From': 'SFO', 'To': 'LHR',
    'Canceled': 'false', 'PNR': 'H4LP2M', 'Flight Flighty ID': 'a1',
  }))
  assert.equal(f.pnr, 'H4LP2M', 'available in memory for trip grouping')
  assert.ok(!JSON.stringify(f.record).includes('H4LP2M'), 'but absent from the record')
})

test("drops Flighty's corrupted landing time", () => {
  // Landing (Actual) here is the scheduled gate departure re-expressed in
  // arrival-local time: 18:40 CDT and 19:40 EDT are the same instant.
  const [f] = parseFlightyCsv(csv({
    'Date': '2014-03-15', 'Airline': 'JBU', 'Flight': '112', 'From': 'ORD', 'To': 'BOS',
    'Canceled': 'false', 'Gate Departure (Scheduled)': '2014-03-15T18:40',
    'Gate Departure (Actual)': '2014-03-15T18:30', 'Take off (Actual)': '2014-03-15T18:49',
    'Landing (Actual)': '2014-03-15T19:40', 'Gate Arrival (Actual)': '2014-03-15T21:35',
    'Flight Flighty ID': 'ffbdd305',
  }))
  assert.equal(f.record.actualLanding, undefined, 'corrupt value dropped')
  assert.equal(f.issues.filter((i) => i.kind === 'corrupt-landing').length, 1)
  assert.equal(f.issues.filter((i) => i.kind === 'out-of-order').length, 0, 'no violation once dropped')
  assert.equal(f.record.actualGateArrival, '2014-03-15T21:35:00-04:00', 'other times survive')
})

test('keeps a legitimate landing time that merely looks close', () => {
  const [f] = parseFlightyCsv(csv({
    'Date': '2025-07-13', 'Airline': 'UAL', 'Flight': '1', 'From': 'SFO', 'To': 'LAX',
    'Canceled': 'false', 'Gate Departure (Scheduled)': '2025-07-13T09:00',
    'Gate Departure (Actual)': '2025-07-13T09:02', 'Take off (Actual)': '2025-07-13T09:20',
    'Landing (Actual)': '2025-07-13T10:35', 'Gate Arrival (Actual)': '2025-07-13T10:45',
    'Flight Flighty ID': 'b2',
  }))
  assert.equal(f.record.actualLanding, '2025-07-13T10:35:00-07:00')
  assert.deepEqual(f.issues, [])
})

test('normalises registrations so hyphenation does not split an airframe', () => {
  const rows = parseFlightyCsv(csv(
    { 'Date': '2025-07-13', 'Airline': 'VIR', 'Flight': '20', 'From': 'SFO', 'To': 'LHR', 'Canceled': 'false', 'Tail Number': 'G-VBOW', 'Flight Flighty ID': 'c1' },
    { 'Date': '2025-07-14', 'Airline': 'VIR', 'Flight': '21', 'From': 'LHR', 'To': 'SFO', 'Canceled': 'false', 'Tail Number': 'GVBOW', 'Flight Flighty ID': 'c2' },
  ))
  assert.equal(rows[0].record.registration, 'GVBOW')
  assert.equal(rows[1].record.registration, 'GVBOW')
})

test('marks cancelled flights and flags implausible flight numbers', () => {
  const [cancelled, bad] = parseFlightyCsv(csv(
    { 'Date': '2018-11-15', 'Airline': 'SWA', 'Flight': '1558', 'From': 'BWI', 'To': 'PVD', 'Canceled': 'true', 'Gate Departure (Scheduled)': '2018-11-15T22:25', 'Flight Flighty ID': 'd1' },
    { 'Date': '2015-10-24', 'Airline': 'SWA', 'Flight': '20024338924', 'From': 'BWI', 'To': 'CLT', 'Canceled': 'false', 'Flight Flighty ID': 'd2' },
  ))
  assert.equal(cancelled.record.status, 'cancelled')
  assert.equal(cancelled.record.actualGateDeparture, undefined)
  assert.equal(bad.issues.filter((i) => i.kind === 'suspicious-flight-number').length, 1)
  assert.equal(bad.record.flightNumber, '20024338924', 'flagged but preserved verbatim')
})

test('flags an airport it has no timezone for, and omits its times', () => {
  const [f] = parseFlightyCsv(csv({
    'Date': '2025-07-13', 'Airline': 'XXX', 'Flight': '1', 'From': 'SFO', 'To': 'ZZZ',
    'Canceled': 'false', 'Gate Departure (Actual)': '2025-07-13T09:00',
    'Gate Arrival (Actual)': '2025-07-13T12:00', 'Flight Flighty ID': 'e1',
  }))
  assert.equal(f.issues.filter((i) => i.kind === 'unknown-airport').length, 1)
  assert.equal(f.record.actualGateDeparture, '2025-07-13T09:00:00-07:00', 'known side still resolved')
  assert.equal(f.record.actualGateArrival, undefined, 'unknown side omitted rather than guessed')
  assert.deepEqual(f.record.destination, { iata: 'ZZZ' }, 'the code itself is still recorded')
})

test('omits absent values entirely rather than writing empties', () => {
  const [f] = parseFlightyCsv(csv({
    'Date': '2025-07-13', 'Airline': 'UAL', 'Flight': '1', 'From': 'SFO', 'To': 'LAX',
    'Canceled': 'false', 'Flight Flighty ID': 'f1',
  }))
  for (const key of ['seat', 'cabin', 'registration', 'aircraftType', 'notes', 'marketingAirline']) {
    assert.ok(!(key in f.record), `${key} should be absent, not empty`)
  }
})
