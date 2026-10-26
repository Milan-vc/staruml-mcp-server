#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API_URL = 'https://files.staruml.io/api-docs/4.0.0/api/index.html#relationship'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(
  root,
  'staruml-v4-extension',
  'types',
  'staruml-api-4.d.ts'
)

function decodeHtml (value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, function (_, value) {
      return String.fromCodePoint(parseInt(value, 16))
    })
    .replace(/&#(\d+);/g, function (_, value) {
      return String.fromCodePoint(parseInt(value, 10))
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeComment (value) {
  return decodeHtml(value).replace(/\*\//g, '* /')
}

function normalizeType (value) {
  let type = decodeHtml(value)
  if (!type) return 'any'
  if (/^Object\b/.test(type)) return 'Record<string, any>'

  type = type
    .replace(/^!/, '')
    .replace(/^\?(.+)$/, '$1 | null')
    .replace(/\bArray\s*\.\s*<([^>]+)>/g, 'Array<$1>')
    .replace(/\bPromise\s*\.\s*<([^>]+)>/g, 'Promise<$1>')
    .replace(/\bObject\s*\.\s*<[\s\S]+>/g, 'Record<string, any>')
    .replace(/\bObject\b/g, 'Record<string, any>')
    .replace(/\bfunction\b/g, '(...args: any[]) => any')
    .replace(/\*/g, 'any')

  if (/^\{.*\}$/.test(type)) return 'Record<string, any>'
  if (/^[A-Za-z_$][\w$]*(?:<.*>)?(?: \| null)?$/.test(type)) return type
  if (/^(string|number|boolean|void|any|null|undefined)(?: \| null)?$/.test(type)) return type
  return 'any'
}

function normalizeSignature (signature, memberName) {
  let result = decodeHtml(signature)
  if (!result.includes('(')) return null

  if (/\bfunction\s*\(/.test(result)) {
    return memberName + '(...args: any[]): any'
  }

  result = result
    .replace(/^async\s+/, '')
    .replace(/:\s*!/g, ': ')
    .replace(/Array\s*\.\s*<([^>]+)>/g, 'Array<$1>')
    .replace(/Promise\s*\.\s*<([^>]+)>/g, 'Promise<$1>')
    .replace(/Object\s*\.\s*<[\s\S]+>/g, 'Record<string, any>')
    .replace(/\bArray\s*<\s*([^>]+?)\s*>/g, 'Array<$1>')
    .replace(/\bArray\b(?!\s*<)/g, 'any[]')
    .replace(/\bCore\./g, '')
    .replace(/\bGraphics\.Font\b/g, 'Font')
    .replace(/\bGraphics\.[A-Za-z_$][\w$]*/g, 'any')
    .replace(/\bconstructor\b/g, 'Constructor')
    .replace(/:\s*([A-Za-z_$][\w$]*(?:<[^>]+>)?)\s*\?/g, ': $1 | undefined')
    .replace(/\bdiagram\b(?=\s*[,)>])/g, 'Diagram')
    .replace(/\((string|number|boolean|any|Object|Array)\)/g, '$1')
    .replace(/:\s*Object\b/g, ': Record<string, any>')
    .replace(/:\s*function\b/g, ': (...args: any[]) => any')
    .replace(/:\s*\*/g, ': any')
    .replace(/\?([A-Z][\w$]*)/g, '$1 | null')
    .replace(/([A-Za-z_$][\w$]*):\s*\.\.\.any/g, '...$1: any[]')

  // documentation.js includes default values in some displayed signatures;
  // optional parameters are a better declaration-file representation.
  result = result.replace(/([A-Za-z_$][\w$]*)(\??):\s*([^,)=]+)\s*=\s*[^,)]+/g, '$1?: $3')

  if (!result.startsWith(memberName + '(')) {
    const open = result.indexOf('(')
    result = memberName + result.slice(open)
  }

  if (/\)$/.test(result) && !/\)\s*:\s*.+$/.test(result)) result += ': any'

  // Fall back to a permissive signature for documentation constructs that are
  // not valid TypeScript syntax. The original signature remains in the JSDoc.
  if (/[{}]|\.\.>|=>\s*\{/.test(result)) {
    return memberName + '(...args: any[]): any'
  }

  return result
}

function findTypeText (chunk, description) {
  const match = chunk.match(/Type:\s*(?:<a[^>]*>)?([\s\S]*?)(?:<\/a>)?\s*<\/p>/i)
  if (match) return normalizeType(match[1])

  const instanceMatch = description.match(/^An instance of ([A-Za-z_$][\w$]*)/)
  if (instanceMatch) return instanceMatch[1]
  if (/^Application (name|version)/.test(description)) return 'string'
  if (/^All available element classes/.test(description)) return 'StarUMLTypeRegistry'
  return 'any'
}

function findDescription (chunk) {
  const match = chunk.match(/<section[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i)
  return match ? safeComment(match[1]) : ''
}

function findInheritance (chunk) {
  const match = decodeHtml(chunk).match(/Extends\s+([A-Za-z_$][\w$]*)/i)
  return match ? match[1] : null
}

function parseClasses (html) {
  const headingPattern = /<h3 class='fl m0' id='([^']+)'>\s*([A-Za-z_$][\w$]*)\s*<\/h3>/g
  const headings = Array.from(html.matchAll(headingPattern))

  return headings.map(function (heading, index) {
    const start = heading.index
    const end = index + 1 < headings.length ? headings[index + 1].index : html.length
    const block = html.slice(start, end)
    const name = heading[2]
    const instanceHeading = block.indexOf("class='py1 quiet mt1 prose-big'>Instance Members")
    const staticHeading = block.indexOf("class='py1 quiet mt1 prose-big'>Static Members")
    const memberPattern = /<div class='border-bottom' id='([^']+)'>/g
    const memberStarts = Array.from(block.matchAll(memberPattern))
    const eventHeading = block.indexOf("class='py1 quiet mt1 prose-big'>Events")
    const members = memberStarts.map(function (memberStart, memberIndex) {
      if (eventHeading >= 0 && memberStart.index > eventHeading) return null
      const memberEnd = memberIndex + 1 < memberStarts.length
        ? memberStarts[memberIndex + 1].index
        : block.length
      const chunk = block.slice(memberStart.index, memberEnd)
      const nameMatch = chunk.match(/<span class='code strong strong truncate'>([\s\S]*?)<\/span>/)
      const signatureMatch = chunk.match(/<div class='pre p1 fill-light mt0'>([\s\S]*?)<\/div>/)
      if (!nameMatch || !signatureMatch) return null

      const displayName = decodeHtml(nameMatch[1])
      const memberName = displayName.replace(/\(.*/, '')
      const originalSignature = decodeHtml(signatureMatch[1])
      const signature = normalizeSignature(originalSignature, memberName)
      const isStatic = staticHeading >= 0 &&
        memberStart.index > staticHeading &&
        (instanceHeading < 0 || memberStart.index < instanceHeading)

      const description = findDescription(chunk)
      return {
        name: memberName,
        description,
        originalSignature,
        signature,
        type: findTypeText(chunk, description),
        isStatic
      }
    }).filter(Boolean)

    const events = eventHeading < 0
      ? []
      : memberStarts
          .filter(member => member.index > eventHeading)
          .map(function (member) {
            const eventChunk = block.slice(member.index)
            const match = eventChunk.match(/<span class='code strong strong truncate'>([\s\S]*?)<\/span>/)
            return match ? decodeHtml(match[1]).replace(/\(.*/, '') : null
          })
          .filter(Boolean)

    return {
      name,
      description: findDescription(block.slice(0, memberStarts[0]?.index || block.length)),
      extends: findInheritance(block.slice(0, memberStarts[0]?.index || block.length)),
      members,
      events
    }
  })
}

function emitMember (member) {
  const lines = []
  if (member.description || member.originalSignature) {
    lines.push('  /**')
    if (member.description) lines.push('   * ' + member.description)
    if (member.signature && member.originalSignature) {
      lines.push('   * @signature ' + member.originalSignature)
    }
    lines.push('   */')
  }

  const prefix = member.isStatic ? 'static ' : ''
  if (member.signature) {
    lines.push('  ' + prefix + member.signature + ';')
  } else {
    const readonly = member.isStatic ? 'readonly ' : ''
    lines.push('  ' + prefix + readonly + member.name + ': ' + member.type + ';')
  }
  return lines.join('\n')
}

function emitDeclarations (classes) {
  const classNames = new Set(classes.map(item => item.name))
  const body = classes.map(function (item) {
    const parent = item.extends && (classNames.has(item.extends) || item.extends === 'EventEmitter')
      ? ' extends ' + item.extends
      : ''
    const eventMembers = item.events.map(function (eventName) {
      return '  on(event: ' + JSON.stringify(eventName) + ', listener: (...args: any[]) => void): this;'
    })
    const members = item.members.map(emitMember).concat(eventMembers).join('\n\n')
    return [
      '/** ' + (item.description || item.name) + ' */',
      'declare class ' + item.name + parent + ' {',
      members,
      '}'
    ].join('\n')
  }).join('\n\n')

  const registryEntries = classes.map(function (item) {
    return '  ' + item.name + ': typeof ' + item.name + ';'
  }).join('\n')

  return `// Generated by scripts/generate-staruml-api-types.mjs
// Source: ${API_URL}
// Do not edit this file directly; update the generator and run npm run types:staruml.

declare class EventEmitter {
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
  emit(event: string, ...args: any[]): boolean;
}

type Constructor<T = any> = abstract new (...args: any[]) => T;
type jQueryObject = any;
type TagKind = any;

interface Editor { diagram: Diagram; repaint(): void; }
interface Canvas {}
interface Point { x: number; y: number; }
interface Rect { x1: number; y1: number; x2: number; y2: number; }
interface Points extends Array<Point> {}
interface CommandPalette {}
interface QuickFind {}
interface IconPickerDialog {}

declare class UMLAttribute extends Model {}

${body}

interface StarUMLTypeRegistry {
${registryEntries}
  [typeName: string]: any;
}

declare const app: AppContext;
declare const type: StarUMLTypeRegistry;
`
}

const response = await fetch(API_URL)
if (!response.ok) {
  throw new Error('Could not download StarUML API documentation: HTTP ' + response.status)
}

const html = await response.text()
const classes = parseClasses(html)
if (classes.length < 30) {
  throw new Error('The StarUML API page format changed; found only ' + classes.length + ' classes.')
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, emitDeclarations(classes), 'utf8')

const memberCount = classes.reduce((sum, item) => sum + item.members.length, 0)
console.log('Generated ' + outputPath)
console.log('Declared ' + classes.length + ' classes and ' + memberCount + ' members.')
