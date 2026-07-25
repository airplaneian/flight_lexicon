export const FLIGHT_NSID = 'com.airplaneian.contrail.temp.flight'
export const TRIP_NSID = 'com.airplaneian.contrail.temp.trip'

/** Every field optional except createdAt -- absent means unknown, never empty. */
export interface Place {
  icao?: string
  iata?: string
  faaLid?: string
  name?: string
  geo?: { latitude: string; longitude: string; altitude?: string; name?: string }
  terminal?: string
  gate?: string
}

export interface FlightRecord {
  $type: typeof FLIGHT_NSID
  createdAt: string
  date?: string
  origin?: Place
  destination?: Place
  source?: string
  sourceId?: string
  operatingAirline?: string
  flightNumber?: string
  marketingAirline?: string
  marketingFlightNumber?: string
  registration?: string
  aircraftType?: string
  icaoTypeDesignator?: string
  icao24?: string
  scheduledGateDeparture?: string
  actualGateDeparture?: string
  scheduledTakeoff?: string
  actualTakeoff?: string
  scheduledLanding?: string
  actualLanding?: string
  scheduledGateArrival?: string
  actualGateArrival?: string
  relationship?: string
  seat?: string
  cabin?: string
  status?: string
  diversionAirport?: Place
  notes?: string
  /** Fields written by other tools, preserved verbatim on update. */
  [key: string]: unknown
}

export interface TripRecord {
  $type: typeof TRIP_NSID
  createdAt: string
  name?: string
  flights?: string[]
  source?: string
  sourceId?: string
  [key: string]: unknown
}

/** Drop keys whose value is undefined or an empty string, recursively.
 *
 * The schema's central rule is that absent means unknown. Writing an empty
 * string instead would assert that the value is known to be empty, so nothing
 * empty may reach the record. */
export function prune<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) {
      if (v.length) out[k] = v
    } else if (typeof v === 'object') {
      const nested = prune(v as object)
      if (Object.keys(nested).length) out[k] = nested
    } else {
      out[k] = v
    }
  }
  return out as T
}
