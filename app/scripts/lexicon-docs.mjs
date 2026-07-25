// Renders the lexicon files into the page as a browsable field reference.
//
// Generated at build time from the schema JSON itself, so the documentation
// cannot drift from what is actually published. Emits plain HTML with no
// runtime JavaScript: the tabs are radio inputs driven by CSS, so the reference
// works with scripting disabled, same as the rest of the document.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LEXICONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../lexicons/com/airplaneian/contrail/temp')
const FILES = ['flight', 'trip', 'defs']
const PLACEHOLDER = '<!--LEXICON_DEFINITIONS-->'

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A compact type label: 'string', 'string:datetime', 'array<string:at-uri>', or a ref NSID. */
function typeLabel(schema) {
  if (schema.type === 'ref') return schema.ref
  if (schema.type === 'union') return 'union'
  if (schema.type === 'array') {
    const item = schema.items ?? {}
    return `array<${item.type === 'ref' ? item.ref : item.format ? `${item.type}:${item.format}` : (item.type ?? '?')}>`
  }
  return schema.format ? `${schema.type}:${schema.format}` : schema.type
}

const CONSTRAINT_KEYS = ['minLength', 'maxLength', 'maxGraphemes', 'minimum', 'maximum', 'maxSize']

// Lexicon descriptions are a single string, but the longer ones are several
// sentences of specification and read as a wall. Group them into paragraphs at
// sentence boundaries. Presentational only: the schema is untouched.
const ABBREVIATIONS = /(?:\b(?:e\.g|i\.e|cf|vs|etc|approx|no)\.)$/i

function paragraphs(text, targetChars = 280) {
  const sentences = []
  let current = ''
  for (const piece of text.split(/(?<=\.)\s+/)) {
    current = current ? `${current} ${piece}` : piece
    // Do not break on an abbreviation's full stop. Quoted field names cannot be
    // split across, since a break needs a period followed by whitespace.
    if (ABBREVIATIONS.test(current)) continue
    sentences.push(current)
    current = ''
  }
  if (current) sentences.push(current)

  const out = []
  let para = ''
  for (const sentence of sentences) {
    // Decide before appending, so a long closing sentence does not overshoot.
    if (para && para.length + sentence.length + 1 > targetChars) {
      out.push(para)
      para = sentence
    } else {
      para = para ? `${para} ${sentence}` : sentence
    }
  }
  if (para) {
    // Avoid orphaning a short trailing sentence in its own paragraph.
    if (out.length && para.length < 60) out[out.length - 1] += ` ${para}`
    else out.push(para)
  }
  return out
}

const renderProse = (text, className) =>
  paragraphs(text).map((p) => `<p class="${className}">${esc(p)}</p>`).join('')

function constraints(schema) {
  const parts = CONSTRAINT_KEYS.filter((k) => schema[k] !== undefined).map((k) => `${k}: ${schema[k]}`)
  if (schema.accept) parts.push(`accept: [${schema.accept.join(', ')}]`)
  return parts
}

function renderField(name, schema, required) {
  const bits = constraints(schema)
  const known = schema.knownValues ?? []
  return [
    '<div class="lexfield">',
    '<div class="lexfield-head">',
    `<code class="lexfield-name">${esc(name)}</code>`,
    `<span class="lextype">${esc(typeLabel(schema))}</span>`,
    required ? '<span class="lexreq">required</span>' : '',
    '</div>',
    bits.length ? `<div class="lexconstraints">${esc(bits.join('  '))}</div>` : '',
    known.length
      ? `<div class="lexknown"><span class="lexknown-label">known values</span>${known
          .map((v) => `<code>${esc(v)}</code>`)
          .join('')}</div>`
      : '',
    schema.description ? renderProse(schema.description, 'lexdesc') : '',
    '</div>',
  ].join('')
}

/** Defs that carry properties: records and plain objects. Tokens and the like are skipped. */
function objectDefs(doc) {
  return Object.entries(doc.defs)
    .map(([name, def]) => {
      if (def.type === 'record') return { name, def, shape: def.record, kind: `record, key: ${def.key}` }
      if (def.type === 'object') return { name, def, shape: def, kind: 'object' }
      return undefined
    })
    .filter(Boolean)
}

function renderPanel(doc) {
  const sections = objectDefs(doc).map(({ name, def, shape, kind }) => {
    const required = new Set(shape.required ?? [])
    const fields = Object.entries(shape.properties ?? {})
      .map(([f, s]) => renderField(f, s, required.has(f)))
      .join('')
    return [
      `<div class="lexdef">`,
      `<div class="lexdef-head"><code>${esc(name === 'main' ? doc.id : `${doc.id}#${name}`)}</code><span class="lexkind">${esc(kind)}</span></div>`,
      def.description ? renderProse(def.description, 'lexdef-desc') : '',
      `<div class="lexfields">${fields}</div>`,
      `</div>`,
    ].join('')
  })
  return `<section class="lexdoc-panel">${sections.join('')}</section>`
}

export function lexiconDocs() {
  return {
    name: 'contrail-lexicon-docs',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!html.includes(PLACEHOLDER)) return html

        const docs = FILES.map((f) => JSON.parse(readFileSync(`${LEXICONS}/${f}.json`, 'utf8')))
        const ids = docs.map((d) => d.id)

        const radios = ids
          .map((id, i) => `<input type="radio" name="lexdoc" id="lexdoc-${i}"${i === 0 ? ' checked' : ''}>`)
          .join('')
        const tabs = ids
          .map((id, i) => `<label for="lexdoc-${i}">${esc(id.replace('com.airplaneian.contrail.temp.', ''))}</label>`)
          .join('')
        const panels = docs.map(renderPanel).join('')

        return html.replace(
          PLACEHOLDER,
          `<div class="lexdoc">${radios}<div class="lexdoc-tabs" role="tablist">${tabs}</div><div class="lexdoc-panels">${panels}</div></div>`,
        )
      },
    },
    // Editing a schema should refresh the page in dev.
    configureServer(server) {
      server.watcher.add(LEXICONS)
      server.watcher.on('change', (file) => {
        if (file.startsWith(LEXICONS)) server.ws.send({ type: 'full-reload' })
      })
    },
  }
}
