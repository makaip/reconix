import { defineTool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { optStr, str } from '../validate'

const MAX_BYTES = 1024 * 1024
const MAX_ENCODED = 4 * Math.ceil(MAX_BYTES / 3)

interface UploadInput {
  selector: string
  files: { name: string; mimeType: string; base64: string }[]
}

export const uploadFiles = defineTool<UploadInput, unknown>({
  name: 'upload_files',
  description: 'Select files in an input[type=file] using actual contents, not host filesystem paths. Supply files [{name, content, encoding?: "utf8"|"base64", mimeType?}]. Replaces the selection and fires input/change; page handlers may upload immediately, otherwise submit separately. Supports hidden inputs, up to 10 files and 1 MiB total. Use instead of fill or opening a file picker.',
  riskTier: 'M',
  inputSchema: {
    type: 'object', required: ['selector', 'files'], additionalProperties: false,
    properties: {
      selector: { type: 'string', minLength: 1 },
      files: {
        type: 'array', minItems: 1, maxItems: 10,
        items: {
          type: 'object', required: ['name', 'content'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 255 },
            content: { type: 'string', maxLength: MAX_ENCODED },
            encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
            mimeType: { type: 'string', maxLength: 128 }
          }
        }
      }
    }
  },
  outputSchema: {
    type: 'object', properties: {
      ok: { type: 'boolean' },
      files: { type: 'array', items: {
        type: 'object', properties: { name: { type: 'string' }, size: { type: 'number' }, type: { type: 'string' } }
      } }
    }
  },
  parse: (raw) => {
    const selector = str(raw, 'selector')
    const files = (raw as Record<string, unknown>).files
    if (!Array.isArray(files) || files.length < 1 || files.length > 10) {
      throw new ToolInputError('files must contain 1–10 files')
    }
    let total = 0
    return { selector, files: files.map((file: unknown) => {
      const name = str(file, 'name')
      if (name.length > 255 || /[\/\\\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') {
        throw new ToolInputError('name must be a filename without directories or control characters')
      }
      const content = optStr(file, 'content')
      if (content === undefined) throw new ToolInputError('content is required (an empty string creates an empty file)')
      if (content.length > MAX_ENCODED) throw new ToolInputError('files exceed the 1 MiB total limit')
      const encoding = optStr(file, 'encoding') ?? 'utf8'
      if (encoding !== 'utf8' && encoding !== 'base64') throw new ToolInputError('encoding must be utf8 or base64')
      const mimeType = optStr(file, 'mimeType') ?? 'application/octet-stream'
      if (mimeType.length > 128 || /[^\x20-\x7e]/.test(mimeType)) throw new ToolInputError('mimeType must contain at most 128 printable ASCII characters')
      const bytes = Buffer.from(content, encoding)
      if (encoding === 'base64' && bytes.toString('base64') !== content) {
        throw new ToolInputError('content must be canonical padded base64 when encoding is base64')
      }
      total += bytes.length
      if (total > MAX_BYTES) throw new ToolInputError('files exceed the 1 MiB total limit')
      return { name, mimeType, base64: bytes.toString('base64') }
    }) }
  },
  execute: async (input, ctx) => {
    // Values are serialized as data. Nothing reads the host filesystem, and
    // binary bytes survive independently of text encoding in the target page.
    const raw = await ctx.cdp.evaluate(`(()=>{
      let el;
      try { el=document.querySelector(${JSON.stringify(input.selector)}); }
      catch { return {error:'Invalid CSS selector. Inspect the DOM with query_dom and use a valid input[type=file] selector.'}; }
      if(!el || el.tagName!=='INPUT' || el.type!=='file') return {error:'Selector must match an input[type=file]. Use query_dom with selector "input[type=file]" to locate it.'};
      if(el.matches(':disabled')) return {error:'File input is disabled. Enable it (or wait for the page to finish loading) before uploading.'};
      const files=${JSON.stringify(input.files)};
      if(files.length>1 && !el.multiple) return {error:'This file input accepts only one file. Send a single file, or choose a multiple file input.'};
      const transfer=new DataTransfer();
      for(const file of files){
        const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));
        transfer.items.add(new File([bytes],file.name,{type:file.mimeType}));
      }
      el.files=transfer.files;
      const selected=Array.from(el.files,f=>({name:f.name,size:f.size,type:f.type}));
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return {ok:true,files:selected};
    })()`)
    let result: { error?: string }
    try {
      result = JSON.parse(raw) as { error?: string }
    } catch {
      throw new ToolExecError(
        `upload_files: page returned a non-JSON result (${String(raw).slice(0, 200)}). ` +
          'The page may have navigated — inspect it with get_page_info and retry.'
      )
    }
    if (result.error) throw new ToolExecError(`${result.error} (selector: ${input.selector})`)
    return result
  }
})
