import hljs from 'highlight.js/lib/core'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import type { SourceLanguage } from './sourceFormat'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('css', css)
hljs.registerLanguage('json', json)
hljs.registerLanguage('xml', xml)

/** Above this many characters highlighting is skipped — it would stall the renderer. */
const MAX_HIGHLIGHT = 1_000_000

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Returns HTML for the Sources viewer.
 *
 * SECURITY (ARCHITECTURE §5.A): `source` is target-controlled. highlight.js
 * HTML-escapes every input character and only emits `<span class="hljs-*">`
 * wrappers, and the plaintext path escapes explicitly, so the result is safe to
 * inject as markup. The renderer CSP (no inline script/style) is a second layer.
 */
export function highlight(source: string, language: SourceLanguage): string {
  if (language === 'plaintext' || source.length > MAX_HIGHLIGHT) return escapeHtml(source)
  const grammar = language === 'html' ? 'xml' : language
  return hljs.highlight(source, { language: grammar, ignoreIllegals: true }).value
}
