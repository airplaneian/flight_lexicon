// Grouping imported flights into trips.
//
// Flighty has no trip concept, but it exports a booking reference, and legs
// booked together share one. That is the grouping signal. The reference itself
// is never written: a PNR is a credential that can be used to retrieve a
// reservation, and six alphanumeric characters is a small enough keyspace that
// publishing a hash of one would publish the PNR.
//
// The trip's sourceId is instead the first leg's Flighty id, which is opaque,
// already published as that flight's own sourceId, and stable across
// re-imports. The tradeoff: if a trip's first leg changes, the trip is written
// as a new record rather than updated.

import { TRIP_NSID, prune, type TripRecord } from './lexicon.ts'
import type { ParsedFlight } from './flighty.ts'
import { SOURCE } from './flighty.ts'

export interface TripGroup {
  /** Flights in this trip, in departure order. */
  flights: ParsedFlight[]
  sourceId: string
  name: string
}

/**
 * Group flights sharing a booking reference. Comparison is case-insensitive:
 * real exports contain the same reference in both cases, which would otherwise
 * split one trip in two.
 */
export function groupIntoTrips(flights: ParsedFlight[]): TripGroup[] {
  const byPnr = new Map<string, ParsedFlight[]>()
  for (const f of flights) {
    if (!f.pnr) continue
    const key = f.pnr.toUpperCase()
    const group = byPnr.get(key)
    if (group) group.push(f)
    else byPnr.set(key, [f])
  }

  const trips: TripGroup[] = []
  for (const group of byPnr.values()) {
    // A single flight is not a trip worth asserting separately.
    if (group.length < 2) continue
    const ordered = [...group].sort(compareByDeparture)
    const sourceId = ordered[0].record.sourceId
    if (typeof sourceId !== 'string') continue
    trips.push({ flights: ordered, sourceId, name: describe(ordered) })
  }
  return trips.sort((a, b) => compareByDeparture(a.flights[0], b.flights[0]))
}

function compareByDeparture(a: ParsedFlight, b: ParsedFlight): number {
  const key = (f: ParsedFlight) =>
    (f.record.actualGateDeparture ?? f.record.scheduledGateDeparture ?? f.record.date ?? '') as string
  return key(a).localeCompare(key(b)) || a.row - b.row
}

/** A name derived from where the trip went, not from the booking reference. */
function describe(flights: ParsedFlight[]): string {
  const codes = flights.map((f) => (f.record.destination as { iata?: string } | undefined)?.iata)
  const origin = (flights[0].record.origin as { iata?: string } | undefined)?.iata
  const furthest = codes.filter((c): c is string => Boolean(c && c !== origin))
  const date = flights[0].record.date as string | undefined
  const where = furthest[0] ?? origin ?? 'Trip'
  return date ? `${where}, ${date.slice(0, 7)}` : where
}

export function buildTripRecord(
  trip: TripGroup,
  uriForFlight: (flight: ParsedFlight) => string | undefined,
  createdAt: string,
): TripRecord | undefined {
  const uris = trip.flights.map(uriForFlight).filter((u): u is string => Boolean(u))
  // A trip whose flights were all excluded asserts nothing.
  if (uris.length < 2) return undefined
  return prune({
    $type: TRIP_NSID,
    createdAt,
    name: trip.name,
    flights: uris,
    source: SOURCE,
    sourceId: trip.sourceId,
  }) as TripRecord
}
