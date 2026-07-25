import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveLocal, zoneForIata, formatOffset } from '../src/timezone.ts'

test('resolves airport IATA codes to IANA zones', () => {
  assert.equal(zoneForIata('SFO'), 'America/Los_Angeles')
  assert.equal(zoneForIata('LHR'), 'Europe/London')
  assert.equal(zoneForIata('ICN'), 'Asia/Seoul')
  assert.equal(zoneForIata('sfo'), 'America/Los_Angeles', 'case insensitive')
  assert.equal(zoneForIata('ZZZ'), undefined, 'unknown code')
})

test('formats offsets', () => {
  assert.equal(formatOffset(-420), '-07:00')
  assert.equal(formatOffset(60), '+01:00')
  assert.equal(formatOffset(0), '+00:00')
  assert.equal(formatOffset(330), '+05:30', 'half-hour zone')
  assert.equal(formatOffset(345), '+05:45', 'quarter-hour zone')
})

test('applies the offset in force on the date, not today', () => {
  // Same airport, same wall time, opposite sides of the DST boundary.
  assert.equal(resolveLocal('2025-07-13T16:05', 'America/Los_Angeles')!.iso, '2025-07-13T16:05:00-07:00')
  assert.equal(resolveLocal('2025-01-01T16:05', 'America/Los_Angeles')!.iso, '2025-01-01T16:05:00-08:00')
  assert.equal(resolveLocal('2025-07-14T10:14', 'Europe/London')!.iso, '2025-07-14T10:14:00+01:00')
  assert.equal(resolveLocal('2025-01-14T10:14', 'Europe/London')!.iso, '2025-01-14T10:14:00+00:00')
})

test('honours historical DST rules, not current ones', () => {
  // US DST start moved in 2007; these dates are well after, but the point is
  // that a 2014 record must use 2014's rules rather than today's.
  assert.equal(resolveLocal('2014-03-15T18:40', 'America/Chicago')!.iso, '2014-03-15T18:40:00-05:00')
  assert.equal(resolveLocal('2014-03-01T18:40', 'America/Chicago')!.iso, '2014-03-01T18:40:00-06:00')
  // Zones that have never observed DST.
  assert.equal(resolveLocal('2024-11-28T10:48', 'Asia/Seoul')!.iso, '2024-11-28T10:48:00+09:00')
  assert.equal(resolveLocal('2024-07-28T10:48', 'Asia/Seoul')!.iso, '2024-07-28T10:48:00+09:00')
})

test('preserves seconds when present, pads when absent', () => {
  assert.equal(resolveLocal('2021-11-24T13:11:05', 'America/New_York')!.iso, '2021-11-24T13:11:05-05:00')
  assert.equal(resolveLocal('2021-11-24T13:11', 'America/New_York')!.iso, '2021-11-24T13:11:00-05:00')
})

test('flags the repeated hour at a fall-back transition', () => {
  // 2025-11-02 01:30 happens twice in Los Angeles.
  const r = resolveLocal('2025-11-02T01:30', 'America/Los_Angeles')!
  assert.equal(r.resolution, 'ambiguous')
  assert.equal(r.iso, '2025-11-02T01:30:00-07:00', 'prefers the earlier instant')
})

test('flags the skipped hour at a spring-forward transition', () => {
  // 2025-03-09 02:30 does not exist in Los Angeles.
  const r = resolveLocal('2025-03-09T02:30', 'America/Los_Angeles')!
  assert.equal(r.resolution, 'nonexistent')
})

test('marks ordinary times unique', () => {
  assert.equal(resolveLocal('2025-06-15T12:00', 'America/Los_Angeles')!.resolution, 'unique')
})

test('round-trips to the correct instant', () => {
  // SFO 15:57 PDT and LHR 10:14 BST next day: a ~10h17m flight, not 18h.
  const dep = resolveLocal('2025-07-13T15:57', 'America/Los_Angeles')!
  const arr = resolveLocal('2025-07-14T10:14', 'Europe/London')!
  assert.equal((arr.epochMs - dep.epochMs) / 3_600_000, 10.283333333333333)
})

test('rejects unparseable input', () => {
  assert.equal(resolveLocal('', 'America/Los_Angeles'), undefined)
  assert.equal(resolveLocal('2025-13-45', 'America/Los_Angeles'), undefined)
  assert.equal(resolveLocal('not a date', 'America/Los_Angeles'), undefined)
})

test('does not mistake a bad first probe for a repeated hour', () => {
  // 2015-11-01 is the morning US DST ended. 06:56 in Chicago is after the
  // 02:00 change, so it is unambiguously CST -- but a naive probe treats the
  // wall time as UTC, lands before the transition, and sees CDT.
  const r = resolveLocal('2015-11-01T06:56', 'America/Chicago')!
  assert.equal(r.resolution, 'unique')
  assert.equal(r.iso, '2015-11-01T06:56:00-06:00')
})

test('resolves both sides of a fall-back hour correctly', () => {
  // 00:30 is before the repeat, 01:30 is inside it, 02:30 is after.
  assert.equal(resolveLocal('2025-11-02T00:30', 'America/Los_Angeles')!.resolution, 'unique')
  assert.equal(resolveLocal('2025-11-02T00:30', 'America/Los_Angeles')!.iso, '2025-11-02T00:30:00-07:00')
  assert.equal(resolveLocal('2025-11-02T02:30', 'America/Los_Angeles')!.resolution, 'unique')
  assert.equal(resolveLocal('2025-11-02T02:30', 'America/Los_Angeles')!.iso, '2025-11-02T02:30:00-08:00')
})

test('handles a southern-hemisphere transition', () => {
  assert.equal(resolveLocal('2025-06-15T12:00', 'Australia/Sydney')!.iso, '2025-06-15T12:00:00+10:00')
  assert.equal(resolveLocal('2025-12-15T12:00', 'Australia/Sydney')!.iso, '2025-12-15T12:00:00+11:00')
})
