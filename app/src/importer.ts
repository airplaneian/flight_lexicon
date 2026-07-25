import { Agent } from '@atproto/api'
import type { OAuthSession } from '@atproto/oauth-client-browser'
import { initAuth, signIn, signOut } from './auth.ts'
import { parseFlightyCsv, FlightyParseError, nowIso, SOURCE, type ParsedFlight } from './flighty.ts'
import { groupIntoTrips, buildTripRecord } from './trips.ts'
import { FLIGHT_NSID, TRIP_NSID, prune, type FlightRecord } from './lexicon.ts'
import { listAll, indexBySourceId, planWrites, executeWrites, sourceKey, type RepoClient } from './repo.ts'

interface State {
  phase: 'loading' | 'signedOut' | 'ready' | 'preview' | 'writing' | 'done'
  session?: OAuthSession
  flights: ParsedFlight[]
  /** Nothing is written unless it is chosen. Empty by default, deliberately. */
  selected: Set<number>
  /** Per-row field overrides, applied on top of the parsed record. */
  edits: Map<number, Record<string, string>>
  filter: string
  includeTrips: boolean
  progress?: { done: number; total: number; label: string }
  result?: { created: number; updated: number; trips: number }
  error?: string
}

const state: State = {
  phase: 'loading',
  flights: [],
  selected: new Set(),
  edits: new Map(),
  filter: '',
  includeTrips: true,
}

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

/** The record as it would be written: parsed values with any edits applied.
 *  Clearing a field in the editor removes it, since absent means unknown. */
function effective(f: ParsedFlight): FlightRecord {
  const edits = state.edits.get(f.row)
  if (!edits) return f.record
  return prune({ ...f.record, ...edits }) as FlightRecord
}

const selectedFlights = () => state.flights.filter((f) => state.selected.has(f.row))

function matchesFilter(f: ParsedFlight): boolean {
  if (!state.filter) return true
  const r = effective(f)
  const hay = [
    f.label, r.date, r.operator, r.operatorName, r.flightNumber, r.callsign,
    r.registration, r.aircraftType, r.registeredOwner, r.status,
    (r.origin as { iata?: string } | undefined)?.iata,
    (r.destination as { iata?: string } | undefined)?.iata,
  ].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(state.filter.toLowerCase())
}

const visibleFlights = () => state.flights.filter(matchesFilter)

/** Trips are derived from the chosen flights, so a partly-selected booking
 *  simply does not produce one. */
const selectedTrips = () => groupIntoTrips(selectedFlights())

// ---------------------------------------------------------------------------

function render(): void {
  root.replaceChildren(...view())
}

function view(): Node[] {
  const nodes: Node[] = []
  if (state.error) nodes.push(el('p', { class: 'error', role: 'alert' }, state.error))
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
    state.selected = new Set()
    state.edits = new Map()
    state.filter = ''
    state.phase = 'preview'
  } catch (err) {
    state.error =
      err instanceof FlightyParseError ? err.message : `Could not read that file: ${err}`
  }
  render()
}

// --- preview ---------------------------------------------------------------
//
// Toggling a checkbox or typing in the editor must not rebuild the list: with
// a few hundred rows that is slow, and it would destroy focus and caret
// position mid-edit. Chrome and rows are updated in place instead.

let listEl: HTMLElement | undefined
let countEl: HTMLElement | undefined
let writeBtn: HTMLButtonElement | undefined
let tripNoteEl: HTMLElement | undefined
let selectAllBtn: HTMLButtonElement | undefined
const rowNodes = new Map<number, HTMLElement>()

function previewPanel(): Node {
  rowNodes.clear()

  const search = el('input', {
    type: 'text', class: 'search', placeholder: 'Filter by airline, route, registration, date…',
    'aria-label': 'Filter flights', spellcheck: 'false',
  }) as HTMLInputElement
  search.value = state.filter
  search.addEventListener('input', () => {
    state.filter = search.value
    applyFilter()
    updateChrome()
  })

  selectAllBtn = el('button', { type: 'button', class: 'small' }, 'Select all')
  selectAllBtn.addEventListener('click', () => {
    for (const f of visibleFlights()) state.selected.add(f.row)
    syncCheckboxes()
    updateChrome()
  })

  const selectNone = el('button', { type: 'button', class: 'small' }, 'Select none')
  selectNone.addEventListener('click', () => {
    state.selected.clear()
    syncCheckboxes()
    updateChrome()
  })

  countEl = el('p', { class: 'selcount' })

  writeBtn = el('button', { type: 'button', class: 'primary' }, '')
  writeBtn.addEventListener('click', doImport)

  const tripToggle = el('input', { type: 'checkbox', id: 'trips' }) as HTMLInputElement
  tripToggle.checked = state.includeTrips
  tripToggle.addEventListener('change', () => {
    state.includeTrips = tripToggle.checked
    updateChrome()
  })
  tripNoteEl = el('span', {})

  listEl = el('div', { class: 'flightlist' })
  let year = ''
  for (const f of state.flights) {
    const y = String(f.record.date ?? '').slice(0, 4)
    if (y && y !== year) {
      year = y
      listEl.append(el('div', { class: 'yearmark', 'data-year': y }, y))
    }
    const node = flightRow(f)
    rowNodes.set(f.row, node)
    listEl.append(node)
  }

  const panel = el('div', { class: 'panel' },
    el('div', { class: 'toolbar' },
      search,
      el('div', { class: 'toolbar-actions' }, selectAllBtn, selectNone),
    ),
    countEl,
    el('div', { class: 'scroll' }, listEl),
    el('label', { class: 'trips' }, tripToggle, ' ', tripNoteEl),
    writeBtn,
  )
  applyFilter()
  updateChrome()
  return panel
}

function applyFilter(): void {
  let shownInYear = new Map<string, number>()
  for (const f of state.flights) {
    const node = rowNodes.get(f.row)
    if (!node) continue
    const show = matchesFilter(f)
    node.hidden = !show
    const y = String(f.record.date ?? '').slice(0, 4)
    if (show && y) shownInYear.set(y, (shownInYear.get(y) ?? 0) + 1)
  }
  // Hide a year marker with nothing under it.
  for (const marker of listEl?.querySelectorAll<HTMLElement>('.yearmark') ?? []) {
    marker.hidden = !shownInYear.get(marker.dataset.year ?? '')
  }
}

function syncCheckboxes(): void {
  for (const [row, node] of rowNodes) {
    const box = node.querySelector<HTMLInputElement>('input[type=checkbox]')
    if (box) box.checked = state.selected.has(row)
    node.classList.toggle('picked', state.selected.has(row))
  }
}

function updateChrome(): void {
  const n = state.selected.size
  const visible = visibleFlights().length
  const total = state.flights.length

  if (countEl) {
    countEl.replaceChildren(
      `${n} of ${total} flight${total === 1 ? '' : 's'} selected`,
      state.filter ? ` · ${visible} match your filter` : '',
      n === 0 ? ' · nothing will be written until you choose some' : '',
    )
  }
  if (selectAllBtn) {
    selectAllBtn.textContent = state.filter ? `Select all ${visible} matching` : 'Select all'
    selectAllBtn.disabled = visible === 0
  }

  const groups = selectedTrips().length
  const trips = state.includeTrips ? groups : 0
  if (tripNoteEl) {
    tripNoteEl.textContent =
      `Also write trip records for legs booked together (${groups} from the current selection). ` +
      'Booking references are read in the browser and never written.'
  }
  if (writeBtn) {
    writeBtn.textContent = n
      ? `Write ${n} flight${n === 1 ? '' : 's'}${trips ? ` and ${trips} trip${trips === 1 ? '' : 's'}` : ''} to my repository`
      : 'Select at least one flight'
    writeBtn.disabled = n === 0
  }
}

function flightRow(f: ParsedFlight): HTMLElement {
  const box = el('input', { type: 'checkbox', 'aria-label': `Select ${f.label}` }) as HTMLInputElement
  box.checked = state.selected.has(f.row)
  box.addEventListener('change', () => {
    if (box.checked) state.selected.add(f.row)
    else state.selected.delete(f.row)
    row.classList.toggle('picked', box.checked)
    updateChrome()
  })

  const summary = el('div', { class: 'flight-summary' })
  const badges = el('div', { class: 'flight-badges' })

  const editBtn = el('button', { type: 'button', class: 'small ghost' }, 'Edit')
  const editor = el('div', { class: 'editor' })
  editor.hidden = true
  editBtn.addEventListener('click', () => {
    if (editor.hidden) {
      if (!editor.childElementCount) editor.append(buildEditor(f, summary, badges))
      editor.hidden = false
      editBtn.textContent = 'Done'
    } else {
      editor.hidden = true
      editBtn.textContent = state.edits.has(f.row) ? 'Edited' : 'Edit'
    }
  })

  const row = el('div', { class: 'flight' },
    el('div', { class: 'flight-main' },
      el('label', { class: 'flight-pick' }, box),
      summary,
      badges,
      editBtn),
    editor)
  row.classList.toggle('picked', box.checked)
  paintSummary(f, summary, badges)
  return row
}

function paintSummary(f: ParsedFlight, summary: HTMLElement, badges: HTMLElement): void {
  const r = effective(f)
  const ident = [r.operator, r.flightNumber].filter(Boolean).join(' ') || r.callsign || '—'
  const route = `${(r.origin as { iata?: string } | undefined)?.iata ?? '?'} → ${(r.destination as { iata?: string } | undefined)?.iata ?? '?'}`
  const when = String(r.actualGateDeparture ?? r.scheduledGateDeparture ?? r.actualTakeoff ?? r.date ?? '')
  const aircraft = [r.registration, r.aircraftType].filter(Boolean).join(' · ')

  summary.replaceChildren(
    el('div', { class: 'flight-ident' },
      el('strong', {}, String(ident)), ' ', el('span', { class: 'muted' }, route)),
    el('div', { class: 'flight-meta' },
      el('span', { class: 'mono' }, when.replace('T', ' ').slice(0, 16)),
      aircraft ? el('span', { class: 'muted' }, ` · ${aircraft}`) : ''),
  )

  badges.replaceChildren()
  for (const issue of f.issues) {
    badges.append(el('span', { class: `badge ${issue.kind}`, title: issue.detail }, issueLabel(issue.kind)))
  }
  if (r.status === 'cancelled') badges.append(el('span', { class: 'badge cancelled' }, 'cancelled'))
  if (state.edits.has(f.row)) badges.append(el('span', { class: 'badge edited' }, 'edited'))
}

/** Fields safe to hand-edit. Timestamps are excluded on purpose: they carry
 *  resolved UTC offsets, and editing the wall time without the offset is a
 *  quiet way to publish the wrong instant. */
const EDITABLE: { field: keyof FlightRecord; label: string }[] = [
  { field: 'date', label: 'Date' },
  { field: 'route', label: 'Filed route' },
  { field: 'callsign', label: 'Callsign' },
  { field: 'operator', label: 'Operator (ICAO)' },
  { field: 'operatorName', label: 'Operator name' },
  { field: 'flightNumber', label: 'Flight number' },
  { field: 'marketingAirline', label: 'Marketing airline' },
  { field: 'marketingFlightNumber', label: 'Marketing number' },
  { field: 'registration', label: 'Registration' },
  { field: 'registeredOwner', label: 'Registered owner' },
  { field: 'aircraftType', label: 'Aircraft type' },
  { field: 'icaoTypeDesignator', label: 'Type designator' },
  { field: 'icao24', label: 'ICAO 24-bit address' },
  { field: 'seat', label: 'Seat' },
  { field: 'cabin', label: 'Cabin' },
  { field: 'relationship', label: 'Relationship' },
  { field: 'status', label: 'Status' },
]

const TIME_FIELDS: (keyof FlightRecord)[] = [
  'actualGateDeparture', 'actualTakeoff', 'actualLanding', 'actualGateArrival',
]

function buildEditor(f: ParsedFlight, summary: HTMLElement, badges: HTMLElement): Node {
  const grid = el('div', { class: 'editor-grid' })

  const onChange = (field: string, value: string) => {
    const edits = state.edits.get(f.row) ?? {}
    const original = String((f.record as Record<string, unknown>)[field] ?? '')
    if (value === original) delete edits[field]
    else edits[field] = value
    if (Object.keys(edits).length) state.edits.set(f.row, edits)
    else state.edits.delete(f.row)
    paintSummary(f, summary, badges)
    updateChrome()
  }

  for (const { field, label } of EDITABLE) {
    const current = String((effective(f) as Record<string, unknown>)[field] ?? '')
    const input = el('input', { type: 'text', spellcheck: 'false' }) as HTMLInputElement
    input.value = current
    input.addEventListener('input', () => onChange(field as string, input.value.trim()))
    grid.append(el('label', { class: 'editor-field' }, el('span', {}, label), input))
  }

  const notes = el('textarea', { rows: '2', placeholder: 'Public and permanent once written' }) as HTMLTextAreaElement
  notes.value = String((effective(f) as Record<string, unknown>)['notes'] ?? '')
  notes.addEventListener('input', () => onChange('notes', notes.value))

  const r = effective(f)
  const times = TIME_FIELDS.filter((t) => r[t]).map((t) =>
    el('div', { class: 'editor-time' }, el('span', {}, String(t).replace('actual', '')), el('code', {}, String(r[t]))))

  const issues = f.issues.length
    ? el('ul', { class: 'editor-issues' }, ...f.issues.map((i) => el('li', {}, i.detail)))
    : ''

  const reset = el('button', { type: 'button', class: 'small ghost' }, 'Undo edits')
  reset.addEventListener('click', () => {
    state.edits.delete(f.row)
    for (const input of grid.querySelectorAll('input')) {
      const label = input.closest('.editor-field')?.querySelector('span')?.textContent
      const spec = EDITABLE.find((e) => e.label === label)
      if (spec) input.value = String((f.record as Record<string, unknown>)[spec.field] ?? '')
    }
    notes.value = String((f.record as Record<string, unknown>)['notes'] ?? '')
    paintSummary(f, summary, badges)
    updateChrome()
  })

  return el('div', {},
    issues,
    grid,
    el('label', { class: 'editor-field wide' }, el('span', {}, 'Notes'), notes),
    times.length
      ? el('div', { class: 'editor-times' },
          el('span', { class: 'editor-times-label' }, 'Times, as resolved'), ...times)
      : '',
    el('p', { class: 'aside' },
      'Timestamps cannot be edited here. They carry the UTC offset that was in force at that ' +
      'airport on that date, and changing the clock time alone would publish the wrong instant. ' +
      'Clearing a field removes it from the record, since absent means unknown.'),
    reset,
  )
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
    state.selected = new Set()
    state.edits = new Map()
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
  const chosen = selectedFlights()
  if (!chosen.length) return

  state.phase = 'writing'
  state.error = undefined
  state.progress = { done: 0, total: chosen.length, label: 'Checking for existing records' }
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
    const index = indexBySourceId(await listAll(client, FLIGHT_NSID))
    const ops = planWrites(chosen.map(effective), index, FLIGHT_NSID)

    state.progress = { done: 0, total: ops.length, label: 'Writing flights' }
    render()
    await executeWrites(client, ops, (done, total) => {
      state.progress = { done, total, label: 'Writing flights' }
      render()
    })

    let trips = 0
    const groups = state.includeTrips ? selectedTrips() : []
    if (groups.length) {
      // Trip records reference flights by AT-URI, so the flights must exist
      // first. Re-list to pick up the keys the server assigned.
      const written = indexBySourceId(await listAll(client, FLIGHT_NSID))
      const createdAt = nowIso()
      const tripRecords = groups
        .map((t) => buildTripRecord(t, (f) => written.get(sourceKey(SOURCE, effective(f).sourceId))?.uri, createdAt))
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
