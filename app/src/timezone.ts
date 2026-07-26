// Turning Flighty's naked local timestamps into the offset-carrying datetimes
// the lexicon requires.
//
// Flighty writes wall-clock time at the relevant airport with no offset:
// departure times are local to the origin, arrival times local to the
// destination. The lexicon requires an explicit offset and forbids fractional
// seconds. Bridging the two means knowing which offset was in force at that
// airport on that date, which is a historical question -- this export spans
// 2014 to 2026, crossing many DST rule changes.
//
// We do not ship a timezone database for that. Intl already contains one, with
// full historical rules, so we only need to know each airport's IANA zone.

import airports from './generated/airports.json' with { type: 'json' }

export type Resolution = 'unique' | 'ambiguous' | 'nonexistent'

export interface ResolvedTime {
  /** RFC 3339 with explicit offset and no fractional seconds. */
  iso: string
  /** Milliseconds since epoch, for ordering comparisons. */
  epochMs: number
  offsetMinutes: number
  /**
   * DST transitions make some wall times ambiguous (the hour repeats) and
   * others nonexistent (the hour is skipped). Both are reported rather than
   * silently resolved, because a silently-wrong hour is exactly the kind of
   * error that survives into a published record.
   */
  resolution: Resolution
}

const zoneCache = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = zoneCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    zoneCache.set(timeZone, f)
  }
  return f
}

/** Wall-clock time in `timeZone` at a given instant, as ms since epoch treated as UTC. */
function wallClockAt(epochMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs))
  const at = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour'), at('minute'), at('second'))
}

/** Offset in minutes east of UTC that `timeZone` was using at `epochMs`. */
function offsetAt(epochMs: number, timeZone: string): number {
  return (wallClockAt(epochMs, timeZone) - epochMs) / 60_000
}

type Entry = [zone: number, icao: string, faaLid: string]
const table = airports.iata as unknown as Record<string, Entry>

export function zoneForIata(iata: string): string | undefined {
  const entry = table[iata.toUpperCase()]
  return entry ? airports.zones[entry[0]] : undefined
}

/** The ICAO indicator and FAA LID for an IATA code, where the airport has them.
 *  Empty strings mean the airport has no such identifier, not that it is
 *  unknown, and are dropped rather than written. */
export function codesForIata(iata: string): { icao?: string; faaLid?: string } {
  const entry = table[iata.toUpperCase()]
  if (!entry) return {}
  const out: { icao?: string; faaLid?: string } = {}
  if (entry[1]) out.icao = entry[1]
  if (entry[2]) out.faaLid = entry[2]
  return out
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  const hh = String(Math.floor(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return `${sign}${hh}:${mm}`
}

/**
 * Resolve a naive local timestamp in a zone to an instant plus explicit offset.
 *
 * `naive` is `YYYY-MM-DDTHH:MM` or `YYYY-MM-DDTHH:MM:SS` -- Flighty emits both.
 * Returns undefined only if the input is unparseable; DST edge cases resolve to
 * a best answer with `resolution` set so the caller can surface them.
 */
export function resolveLocal(naive: string, timeZone: string): ResolvedTime | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(naive.trim())
  if (!m) return undefined
  const [, y, mo, d, h, mi, s] = m
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0)

  // Collect the offsets this zone could plausibly have been using. Probing a
  // day either side is enough: DST transitions are months apart, so a window
  // that wide spans at most one of them.
  const DAY = 86_400_000
  const candidateOffsets = new Set([
    offsetAt(wall - DAY, timeZone),
    offsetAt(wall, timeZone),
    offsetAt(wall + DAY, timeZone),
  ])

  // An offset is only a real answer if the instant it implies actually reads
  // back as this wall time in this zone. Testing that is what distinguishes a
  // genuinely repeated hour from a merely unlucky first guess.
  const valid: number[] = []
  for (const offset of candidateOffsets) {
    if (offsetAt(wall - offset * 60_000, timeZone) === offset) valid.push(offset)
  }

  let offsetMinutes: number
  let resolution: Resolution
  if (valid.length === 1) {
    offsetMinutes = valid[0]
    resolution = 'unique'
  } else if (valid.length > 1) {
    // The hour repeated. Prefer the earlier instant, which is the larger offset.
    offsetMinutes = Math.max(...valid)
    resolution = 'ambiguous'
  } else {
    // Nothing reads back: the wall time was skipped by a spring-forward. Use
    // the post-transition offset, which shifts the result out of the gap.
    offsetMinutes = Math.min(...candidateOffsets)
    resolution = 'nonexistent'
  }

  const epochMs = wall - offsetMinutes * 60_000
  const sec = s ?? '00'
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${formatOffset(offsetMinutes)}`
  return { iso, epochMs, offsetMinutes, resolution }
}
