// Generates src/generated/airports.json: IATA -> timezone, ICAO indicator and FAA LID.
//
// Flighty exports naked local timestamps with no UTC offset, and the lexicon
// requires explicit offsets. Resolving one to the other needs the timezone of
// each airport; the browser's own Intl implementation supplies the historical
// DST rules, so all we ship is the airport-to-zone mapping.
//
// Source: github.com/mborsetti/airportsdata (MIT).
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const SOURCE =
  'https://raw.githubusercontent.com/mborsetti/airportsdata/main/airportsdata/airports.csv'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../src/generated/airports.json')

const res = await fetch(SOURCE)
if (!res.ok) throw new Error(`fetching airport data: ${res.status} ${res.statusText}`)

const { data, errors } = Papa.parse(await res.text(), { header: true, skipEmptyLines: true })
if (errors.length) throw new Error(`parsing airport data: ${errors[0].message}`)

// Zone strings repeat heavily across ~7900 airports, so intern them and store
// indices. Keeps the shipped file a fraction of the naive size.
const zones = []
const zoneIndex = new Map()
const iata = {}

for (const row of data) {
  if (!row.iata || !row.tz) continue
  let i = zoneIndex.get(row.tz)
  if (i === undefined) {
    i = zones.length
    zones.push(row.tz)
    zoneIndex.set(row.tz, i)
  }
  // For US fields with no ICAO indicator this dataset repeats the FAA LID in
  // the icao column. Writing that into `icao` would publish a wrong code, so
  // treat icao == lid as "no ICAO indicator".
  const icao = row.icao && row.icao !== row.lid ? row.icao : ''
  iata[row.iata] = [i, icao, row.lid ?? '']
}

const payload = { source: SOURCE, license: 'MIT', zones, iata }
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(payload))

const bytes = JSON.stringify(payload).length
const withIcao = Object.values(iata).filter(([, c]) => c).length
const withLid = Object.values(iata).filter(([, , l]) => l).length
console.log(
  `wrote ${Object.keys(iata).length} airports (${withIcao} with ICAO, ${withLid} with FAA LID), ` +
    `${zones.length} zones, ${(bytes / 1024).toFixed(0)} KB`,
)
