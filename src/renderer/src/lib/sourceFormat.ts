import beautify from 'js-beautify'

/** The languages the Sources viewer knows how to pretty-print and highlight. */
export type SourceLanguage = 'javascript' | 'css' | 'html' | 'xml' | 'json' | 'plaintext'

const BY_EXTENSION: Record<string, SourceLanguage> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'javascript',
  tsx: 'javascript',
  css: 'css',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  svg: 'xml',
  xml: 'xml',
  json: 'json',
  map: 'json',
  webmanifest: 'json'
}

/** Picks a language from the MIME type first, then CDP resource type, then the URL's extension. */
export function detectLanguage(resource: { url: string; type: string; mimeType: string }): SourceLanguage {
  const mime = resource.mimeType.toLowerCase()
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'javascript'
  if (mime.includes('json')) return 'json'
  if (mime.includes('css')) return 'css'
  if (mime.includes('html')) return 'html'
  if (mime.includes('xml')) return 'xml'
  if (resource.type === 'Script') return 'javascript'
  if (resource.type === 'Stylesheet') return 'css'
  if (resource.type === 'Document') return 'html'
  let path = resource.url
  try {
    path = new URL(resource.url).pathname
  } catch {
    // not a URL; fall through with the raw string
  }
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return BY_EXTENSION[ext] ?? 'plaintext'
}

const OPTIONS = { indent_size: 2, preserve_newlines: true, max_preserve_newlines: 2 }

/** Pretty-prints source in the given language. Anything it can't parse is returned unchanged. */
export function prettyPrint(source: string, language: SourceLanguage): string {
  try {
    switch (language) {
      case 'javascript':
        return beautify.js(source, OPTIONS)
      case 'css':
        return beautify.css(source, OPTIONS)
      case 'html':
      case 'xml':
        return beautify.html(source, { ...OPTIONS, wrap_line_length: 0 })
      case 'json':
        return JSON.stringify(JSON.parse(source), null, 2)
      default:
        return source
    }
  } catch {
    return source
  }
}
