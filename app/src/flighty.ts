// Parsing a Flighty CSV export and turning each row into a flight record.
//
// Everything here runs in the browser; the file is never uploaded.

import Papa from 'papaparse'
import { FLIGHT_NSID, prune, type FlightRecord, type Place } from './lexicon.ts'
import { resolveLocal, zoneForIata, type Resolution } from './timezone.ts'

export const SOURCE = 'flighty'

/** Column headers we depend on. A file missing any of these is not a Flighty export. */
const REQUIRED_COLUMNS = ['Date', 'Airline', 'Flight', 'From', 'To', 'Flight Flighty ID'] as const

/** The four out/off/on/in pairs, and which airport's local time each is in. */
const TIME_COLUMNS = [
  { column: 'Gate Departure', scheduled: 'scheduledGateDeparture', actual: 'actualGateDeparture', side: 'origin' },
  { column: 'Take off', scheduled: 'scheduledTakeoff', actual: 'actualTakeoff', side: 'origin' },
  { column: 'Landing', scheduled: 'scheduledLanding', actual: 'actualLanding', side: 'destination' },
  { column: 'Gate Arrival', scheduled: 'scheduledGateArrival', actual: 'actualGateArrival', side: 'destination' },
] as const

export type IssueKind =
  | 'unknown-airport'
  | 'corrupt-landing'
  | 'dst-ambiguous'
  | 'dst-nonexistent'
  | 'suspicious-flight-number'
  | 'out-of-order'
  | 'unparseable-time'

export interface Issue {
  kind: IssueKind
  detail: string
}

export interface ParsedFlight {
  /** Row number in the source file, 1-based excluding the header. */
  row: number
  record: FlightRecord
  issues: Issue[]
  /** Booking reference, used in-browser for trip grouping and never written. */
  pnr?: string
  /** Human-readable summary for the preview table. */
  label: string
}

export class FlightyParseError extends Error {}

const clean = (v: string | undefined) => (v ?? '').trim()

/** Uppercase, strip separators. 'G-VBOW' and 'GVBOW' must not be two aircraft. */
function normaliseRegistration(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

function place(iata: string, terminal: string, gate: string): Place | undefined {
  const p = prune({ iata: iata.toUpperCase(), terminal, gate })
  return Object.keys(p).length ? p : undefined
}

export function parseFlightyCsv(text: string): ParsedFlight[] {
  const { data, errors, meta } = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  })

  if (errors.length && !data.length) {
    throw new FlightyParseError(`Could not read the file: ${errors[0].message}`)
  }
  const missing = REQUIRED_COLUMNS.filter((c) => !meta.fields?.includes(c))
  if (missing.length) {
    throw new FlightyParseError(
      `This does not look like a Flighty export. Missing columns: ${missing.join(', ')}.`,
    )
  }

  const createdAt = nowIso()
  return data.map((row, i) => transformRow(row, i + 1, createdAt))
}

/** Current time as an offset-carrying datetime with no fractional seconds. */
export function nowIso(date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}

function transformRow(row: Record<string, string>, rowNumber: number, createdAt: string): ParsedFlight {
  const issues: Issue[] = []
  const from = clean(row['From']).toUpperCase()
  const to = clean(row['To']).toUpperCase()
  const divertedTo = clean(row['Diverted To']).toUpperCase()

  const originZone = zoneForIata(from)
  const destinationZone = zoneForIata(to)
  for (const [code, zone] of [
    [from, originZone],
    [to, destinationZone],
  ] as const) {
    if (code && !zone) {
      issues.push({
        kind: 'unknown-airport',
        detail: `No timezone known for ${code}; its times cannot be given an offset and are omitted.`,
      })
    }
  }

  const record: FlightRecord = {
    $type: FLIGHT_NSID,
    createdAt,
    date: clean(row['Date']) || undefined,
    origin: place(from, clean(row['Dep Terminal']), clean(row['Dep Gate'])),
    destination: place(to, clean(row['Arr Terminal']), clean(row['Arr Gate'])),
    source: SOURCE,
    sourceId: clean(row['Flight Flighty ID']) || undefined,
    operator: clean(row['Airline']).toUpperCase() || undefined,
    flightNumber: clean(row['Flight']) || undefined,
    registration: normaliseRegistration(clean(row['Tail Number'])) || undefined,
    aircraftType: clean(row['Aircraft Type Name']) || undefined,
    seat: clean(row['Seat']) || undefined,
    cabin: normaliseCabin(clean(row['Cabin Class'])),
    // Flighty records the author's own flights, so a relationship is claimed.
    relationship: 'passenger',
  }

  // Flighty's Canceled column is a real assertion either way, so status is
  // always known here -- absent would mean unknown, which would be wrong.
  const cancelled = clean(row['Canceled']).toLowerCase() === 'true'
  if (cancelled) {
    record.status = 'cancelled'
  } else if (divertedTo) {
    record.status = 'diverted'
    record.diversionAirport = place(divertedTo, '', '')
  } else {
    record.status = 'normal'
  }

  const flightNumber = record.flightNumber
  if (flightNumber && !/^\d{1,4}[A-Z]?$/i.test(flightNumber)) {
    issues.push({
      kind: 'suspicious-flight-number',
      detail: `Flight number "${flightNumber}" is not a plausible one; the source data looks wrong.`,
    })
  }

  applyTimes(row, record, issues, originZone, destinationZone)

  return {
    row: rowNumber,
    record: prune(record),
    pnr: clean(row['PNR']) || undefined,
    issues,
    label: `${clean(row['Date'])} ${clean(row['Airline'])}${clean(row['Flight'])} ${from}→${to}`,
  }
}

function normaliseCabin(raw: string): string | undefined {
  if (!raw) return undefined
  // Flighty emits UPPER_SNAKE; the lexicon documents lower camel case so that
  // records from different tools compare equal.
  const [head, ...rest] = raw.toLowerCase().split('_')
  return head + rest.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}

function applyTimes(
  row: Record<string, string>,
  record: FlightRecord,
  issues: Issue[],
  originZone: string | undefined,
  destinationZone: string | undefined,
): void {
  const scheduledGateDepartureRaw = clean(row['Gate Departure (Scheduled)'])
  const resolved: Record<string, number> = {}

  for (const spec of TIME_COLUMNS) {
    const zone = spec.side === 'origin' ? originZone : destinationZone
    if (!zone) continue

    for (const kind of ['Scheduled', 'Actual'] as const) {
      const raw = clean(row[`${spec.column} (${kind})`])
      if (!raw) continue

      const value = resolveLocal(raw, zone)
      if (!value) {
        issues.push({ kind: 'unparseable-time', detail: `Could not read "${raw}" in ${spec.column} (${kind}).` })
        continue
      }
      flagDst(value.resolution, `${spec.column} (${kind})`, issues)

      const field = kind === 'Scheduled' ? spec.scheduled : spec.actual
      record[field] = value.iso
      resolved[field] = value.epochMs
    }
  }

  // Flighty has a long-standing bug in older rows: Landing (Actual) holds the
  // scheduled gate departure re-expressed in the arrival airport's local time.
  // Compared as instants the two are exactly equal, so this is an exact test
  // rather than a heuristic. Verified against a 117-flight export: it flags 32
  // rows, and dropping them leaves every remaining row correctly ordered.
  if (record.actualLanding && scheduledGateDepartureRaw && originZone) {
    const scheduledDeparture = resolveLocal(scheduledGateDepartureRaw, originZone)
    if (scheduledDeparture && scheduledDeparture.epochMs === resolved['actualLanding']) {
      delete record.actualLanding
      delete resolved['actualLanding']
      issues.push({
        kind: 'corrupt-landing',
        detail: 'Flighty recorded the scheduled departure as the landing time; it has been dropped.',
      })
    }
  }

  const order = ['actualGateDeparture', 'actualTakeoff', 'actualLanding', 'actualGateArrival']
    .filter((f) => f in resolved)
  for (let i = 0; i < order.length - 1; i++) {
    if (resolved[order[i]] > resolved[order[i + 1]]) {
      issues.push({
        kind: 'out-of-order',
        detail: `${order[i]} is later than ${order[i + 1]}; the source times disagree.`,
      })
    }
  }
}

function flagDst(resolution: Resolution, field: string, issues: Issue[]): void {
  if (resolution === 'ambiguous') {
    issues.push({
      kind: 'dst-ambiguous',
      detail: `${field} falls in a repeated hour at a daylight-saving change; the earlier reading was used.`,
    })
  } else if (resolution === 'nonexistent') {
    issues.push({
      kind: 'dst-nonexistent',
      detail: `${field} falls in an hour skipped by a daylight-saving change; the time may be wrong.`,
    })
  }
}
