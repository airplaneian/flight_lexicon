import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { initAuth, signIn, signOut } from './auth.ts'
import { parseFlightyCsv, FlightyParseError, nowIso, type ParsedFlight } from './flighty.ts'
import { groupIntoTrips, buildTripRecord, type TripGroup } from './trips.ts'
import { FLIGHT_NSID, TRIP_NSID } from './lexicon.ts'
import { listAll, indexBySourceId, planWrites, executeWrites, type RepoClient } from './repo.ts'

interface State {
  phase: 'loading' | 'signedOut' | 'ready' | 'preview' | 'writing' | 'done'
  session?: OAuthSession
  flights: ParsedFlight[]
  trips: TripGroup[]
  excluded: Set<number>
  includeTrips: boolean
  progress?: { done: number; total: number; label: string }
  result?: { created: number; updated: number; trips: number }
  error?: string
}

const state: State = { phase: 'loading', flights: [], trips: [], excluded: new Set(), includeTrips: true }
const root = document.getElementById('app')!

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  node.append(...children)
  return node
}

const included = () => state.flights.filter((f) => !state.excluded.has(f.row))

function render(): void {
  root.replaceChildren(...view())
}

function view(): Node[] {
  const nodes: Node[] = []
  if (state.error) {
    nodes.push(el('p', { class: 'error', role: 'alert' }, state.error))
  }
  switch (state.phase) {
    case 'loading':
      nodes.push(el('p', { class: 'muted' }, 'Checking for an existing session…'))
      break
    case 'signedOut':
      nodes.push(signInForm())
      break
    case 'ready':
      nodes.push(accountBar(), dropZone())
      break
    case 'preview':
      nodes.push(accountBar(), previewPanel())
      break
    case 'writing':
      nodes.push(accountBar(), progressPanel())
      break
    case 'done':
      nodes.push(accountBar(), resultPanel())
      break
  }
  return nodes
}

function signInForm(): Node {
  const input = el('input', {
    type: 'text', id: 'handle', placeholder: 'you.bsky.social',
    autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none',
  })
  const form = el('form', { class: 'signin' },
    el('label', { for: 'handle' }, 'Sign in with your atproto handle'),
    el('div', { class: 'row' }, input, el('button', { type: 'submit' }, 'Sign in')),
    el('p', { class: 'aside' },
      'Contrail asks for permission to create and update records in its two collections. ' +
      'Nothing else. Not delete, not your posts, not your account.'),
  )
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    if (!input.value.trim()) return
    try {
      await signIn(input.value)
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err)
      render()
    }
  })
  return form
}

function accountBar(): Node {
  const out = el('button', { type: 'button', class: 'link' }, 'Sign out')
  out.addEventListener('click', async () => {
    if (state.session) await signOut(state.session)
    location.reload()
  })
  return el('div', { class: 'account' },
    el('span', {}, 'Signed in as ', el('code', {}, state.session?.did ?? '')), out)
}

function dropZone(): Node {
  const input = el('input', { type: 'file', accept: '.csv,text/csv', id: 'csv' })
  const zone = el('div', { class: 'dropzone' },
    el('label', { for: 'csv' }, 'Choose a Flighty CSV export'),
    el('p', { class: 'aside' }, 'or drag it here. The file is read in this page and never uploaded.'),
    input)

  input.addEventListener('change', () => input.files?.[0] && loadFile(input.files[0]))
  for (const evt of ['dragenter', 'dragover']) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add('over') })
  }
  for (const evt of ['dragleave', 'drop']) {
    zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove('over') })
  }
  zone.addEventListener('drop', (e) => {
    const file = (e as DragEvent).dataTransfer?.files?.[0]
    if (file) loadFile(file)
  })
  return zone
}

async function loadFile(file: File): Promise<void> {
  state.error = undefined
  try {
    const flights = parseFlightyCsv(await file.text())
    if (!flights.length) throw new FlightyParseError('That export contains no flights.')
    state.flights = flights
    state.trips = groupIntoTrips(flights)
    state.excluded = new Set()
    state.phase = 'preview'
  } catch (err) {
    state.error =
      err instanceof FlightyParseError ? err.message : `Could not read that file: ${err}`
  }
  render()
}

function previewPanel(): Node {
  const rows = state.flights.map(flightRow)
  const table = el('table', { class: 'preview' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col' }, ''), el('th', { scope: 'col' }, 'Flight'),
      el('th', { scope: 'col' }, 'Departs'), el('th', { scope: 'col' }, 'Aircraft'),
      el('th', { scope: 'col' }, 'Notes'))),
    el('tbody', {}, ...rows))

  const count = included().length
  const write = el('button', { type: 'button', class: 'primary' },
    `Write ${count} flight${count === 1 ? '' : 's'} to my repository`)
  if (!count) write.setAttribute('disabled', 'disabled')
  write.addEventListener('click', doImport)

  const tripToggle = el('input', { type: 'checkbox', id: 'trips' })
  if (state.includeTrips) tripToggle.setAttribute('checked', 'checked')
  tripToggle.addEventListener('change', () => {
    state.includeTrips = tripToggle.checked
    render()
  })

  const tripCount = state.trips.length
  const summary = el('div', { class: 'summary' },
    el('p', {},
      `${state.flights.length} flights found. `,
      state.excluded.size ? `${state.excluded.size} excluded. ` : '',
      `${count} will be written.`),
    tripCount
      ? el('label', { class: 'trips' }, tripToggle,
          ` Also write ${tripCount} trip records, grouping legs booked together. ` +
          'Booking references are used to work this out but are never written.')
      : el('p', { class: 'aside' }, 'No multi-leg bookings found, so no trip records.'),
  )

  return el('div', { class: 'panel' }, summary, el('div', { class: 'scroll' }, table), write)
}

function flightRow(f: ParsedFlight): Node {
  const box = el('input', { type: 'checkbox', 'aria-label': `Include ${f.label}` })
  if (!state.excluded.has(f.row)) box.setAttribute('checked', 'checked')
  box.addEventListener('change', () => {
    if (box.checked) state.excluded.delete(f.row)
    else state.excluded.add(f.row)
    render()
  })

  const r = f.record
  const airline = [r.operatingAirline, r.flightNumber].filter(Boolean).join(' ')
  const route = `${(r.origin as { iata?: string })?.iata ?? '?'} → ${(r.destination as { iata?: string })?.iata ?? '?'}`
  const departs = (r.actualGateDeparture ?? r.scheduledGateDeparture ?? r.date ?? '') as string

  const notes = el('td', {})
  for (const issue of f.issues) {
    notes.append(el('span', { class: `badge ${issue.kind}`, title: issue.detail }, issueLabel(issue.kind)))
  }
  if (r.status === 'cancelled') notes.append(el('span', { class: 'badge cancelled' }, 'cancelled'))

  const tr = el('tr', state.excluded.has(f.row) ? { class: 'excluded' } : {},
    el('td', {}, box),
    el('td', {}, el('strong', {}, airline || '\u2014'), el('br'), el('span', { class: 'muted' }, route)),
    el('td', { class: 'mono' }, departs.replace('T', ' ').slice(0, 16)),
    el('td', {}, (r.registration as string) ?? '\u2014', el('br'),
      el('span', { class: 'muted' }, (r.aircraftType as string) ?? '')),
    notes)
  return tr
}

const ISSUE_LABELS: Record<string, string> = {
  'corrupt-landing': 'landing time fixed',
  'suspicious-flight-number': 'odd flight number',
  'unknown-airport': 'unknown airport',
  'dst-ambiguous': 'ambiguous hour',
  'dst-nonexistent': 'skipped hour',
  'out-of-order': 'times disagree',
  'unparseable-time': 'unreadable time',
}
const issueLabel = (kind: string) => ISSUE_LABELS[kind] ?? kind

function progressPanel(): Node {
  const p = state.progress
  return el('div', { class: 'panel' },
    el('p', {}, p ? `${p.label}: ${p.done} of ${p.total}` : 'Starting…'),
    el('progress', p ? { value: String(p.done), max: String(p.total) } : {}))
}

function resultPanel(): Node {
  const r = state.result!
  const again = el('button', { type: 'button' }, 'Import another file')
  again.addEventListener('click', () => {
    state.phase = 'ready'
    state.flights = []
    state.trips = []
    state.result = undefined
    render()
  })
  return el('div', { class: 'panel' },
    el('h3', {}, 'Done'),
    el('p', {},
      `${r.created} flight${r.created === 1 ? '' : 's'} created, ${r.updated} updated` +
      (r.trips ? `, ${r.trips} trip record${r.trips === 1 ? '' : 's'} written` : '') + '.'),
    el('p', { class: 'aside' },
      'Re-importing the same file will update these records rather than duplicating them.'),
    el('p', {}, el('a', {
      href: `https://pdsls.dev/at://${state.session?.did}/${FLIGHT_NSID}`,
      target: '_blank', rel: 'noreferrer',
    }, 'Inspect them at pdsls.dev')),
    again)
}

async function doImport(): Promise<void> {
  if (!state.session) return
  state.phase = 'writing'
  state.error = undefined
  state.progress = { done: 0, total: included().length, label: 'Checking for existing records' }
  render()

  const agent = new Agent(state.session)
  const did = state.session.did
  const client: RepoClient = {
    listRecords: async ({ collection, cursor, limit }) => {
      const res = await agent.com.atproto.repo.listRecords({ repo: did, collection, cursor, limit })
      return {
        records: res.data.records.map((r) => ({ uri: r.uri, value: r.value as Record<string, unknown> })),
        cursor: res.data.cursor,
      }
    },
    applyWrites: async ({ writes }) =>
      agent.com.atproto.repo.applyWrites({ repo: did, writes: writes as never }),
  }

  try {
    const existing = await listAll(client, FLIGHT_NSID)
    const index = indexBySourceId(existing)
    const chosen = included()
    const ops = planWrites(chosen.map((f) => f.record), index, FLIGHT_NSID)

    state.progress = { done: 0, total: ops.length, label: 'Writing flights' }
    render()
    await executeWrites(client, ops, (done, total) => {
      state.progress = { done, total, label: 'Writing flights' }
      render()
    })

    let trips = 0
    if (state.includeTrips && state.trips.length) {
      // Trip records reference flights by AT-URI, so the flights must exist
      // first. Re-list to pick up the keys the server assigned.
      const written = indexBySourceId(await listAll(client, FLIGHT_NSID))
      const chosenRows = new Set(chosen.map((f) => f.row))
      const createdAt = nowIso()
      const tripRecords = state.trips
        .map((t) =>
          buildTripRecord(
            { ...t, flights: t.flights.filter((f) => chosenRows.has(f.row)) },
            (f) => written.get(`flighty ${f.record.sourceId}`)?.uri,
            createdAt,
          ),
        )
        .filter((t): t is NonNullable<typeof t> => Boolean(t))

      if (tripRecords.length) {
        const tripIndex = indexBySourceId(await listAll(client, TRIP_NSID))
        const tripOps = planWrites(tripRecords, tripIndex, TRIP_NSID)
        state.progress = { done: 0, total: tripOps.length, label: 'Writing trips' }
        render()
        await executeWrites(client, tripOps, (done, total) => {
          state.progress = { done, total, label: 'Writing trips' }
          render()
        })
        trips = tripOps.length
      }
    }

    state.result = {
      created: ops.filter((o) => o.action === 'create').length,
      updated: ops.filter((o) => o.action === 'update').length,
      trips,
    }
    state.phase = 'done'
  } catch (err) {
    state.error = `Writing failed: ${err instanceof Error ? err.message : String(err)}`
    state.phase = 'preview'
  }
  render()
}

export async function start(): Promise<void> {
  render()
  const auth = await initAuth()
  state.session = auth.session
  state.error = auth.error
  state.phase = auth.session ? 'ready' : 'signedOut'
  render()
}
