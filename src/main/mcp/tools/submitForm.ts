import { defineTool } from '../tool'
import { ToolExecError, ToolInputError } from '../errors'
import { optStr, str } from '../validate'

interface SubmitInput {
  selector: string
  submitterSelector?: string
}

export const submitForm = defineTool<SubmitInput, unknown>({
  name: 'submit_form',
  description: 'Submit an existing HTML form by CSS selector using native requestSubmit: preserves browser validation, submit handlers, cookies, hidden fields, and selected files. Fill fields and use upload_files first. Optional submitterSelector selects a submit button (including its name/value and action/method overrides). Requires approval. Returns submission_requested or handled_by_page, not proof of server success; inspect network results afterward.',
  riskTier: 'M',
  inputSchema: {
    type: 'object', required: ['selector'], additionalProperties: false,
    properties: {
      selector: { type: 'string', minLength: 1 },
      submitterSelector: { type: 'string', minLength: 1 }
    }
  },
  outputSchema: {
    type: 'object', properties: {
      ok: { type: 'boolean' }, status: { type: 'string', enum: ['submission_requested', 'handled_by_page'] },
      action: { type: 'string' }, method: { type: 'string' },
      serverResponseVerified: { type: 'boolean', const: false }
    }
  },
  parse: (raw) => {
    const selector = str(raw, 'selector')
    const submitterSelector = optStr(raw, 'submitterSelector')
    if (submitterSelector === '') throw new ToolInputError('submitterSelector must be non-empty when provided')
    return { selector, submitterSelector }
  },
  execute: async (input, ctx) => {
    // Resolve twice: first to scope-check the effective destination in main,
    // then to ensure the form/button did not change before the actual submit.
    const setup = `
      let form,button;
      try {
        form=document.querySelector(${JSON.stringify(input.selector)});
        button=${input.submitterSelector === undefined ? 'null' : `document.querySelector(${JSON.stringify(input.submitterSelector)})`};
      } catch { return {error:'Invalid CSS selector. Inspect the DOM and choose a form and optional submit button.'}; }
      if(!(form instanceof HTMLFormElement)) return {error:'selector must match an HTML form. Use list_forms or query_dom to locate it.'};
      if(${input.submitterSelector !== undefined} && !button) return {error:'submitterSelector did not match a submit button.'};
      if(button && (!((button instanceof HTMLButtonElement && button.type==='submit') || (button instanceof HTMLInputElement && ['submit','image'].includes(button.type))) || button.form!==form)) return {error:'submitterSelector must match a submit button belonging to the selected form.'};
      // Frameworks (Angular/React/Vue) often keep the submit button disabled
      // attribute stale after programmatic fills because change detection has
      // not flushed. Treat a disabled button as fatal only when the underlying
      // form is also invalid; otherwise submit through the form itself (no
      // submitter) so the action still fires. Track it so the caller knows.
      let submitterDisabled = false
      if (button && button.matches(':disabled')) {
        const formValid = Object.getOwnPropertyDescriptor(proto, 'noValidate').get.call(form)
          ? true
          : proto.checkValidity.call(form)
        if (!formValid) {
          const fields = Array.from(form.elements).filter((el: any) => el.willValidate && !el.validity.valid).slice(0, 20).map((el: any) => String(el.name || el.id || el.tagName).slice(0, 100))
          return { error: 'The submit button is disabled and the form is invalid. Correct invalid fields before retrying: ' + fields.join(', ') }
        }
        submitterDisabled = true
      }
      const proto=HTMLFormElement.prototype;
      const destination=()=>({
        action:button && button.hasAttribute('formaction') ? button.formAction : Object.getOwnPropertyDescriptor(proto,'action').get.call(form),
        method:button && button.hasAttribute('formmethod') ? button.formMethod : Object.getOwnPropertyDescriptor(proto,'method').get.call(form)
      });
      const target=destination();
      if(!/^https?:$/.test(new URL(target.action).protocol) || !['get','post'].includes(target.method)) return {error:'Only HTTP(S) GET/POST form submissions are supported.'};
    `
    const read = async (body: string): Promise<{ error?: string; action: string; method: string }> => {
      const raw = await ctx.cdp.evaluate(`(()=>{${setup}\n${body}})()`)
      const result = JSON.parse(raw) as { error?: string; action: string; method: string }
      if (result.error) throw new ToolExecError(result.error)
      return result
    }
    const target = await read('return target;')
    ctx.scope.assertInScope(target.action)
    return read(`
      const expected=${JSON.stringify(target)};
      const unchanged=()=>{const current=destination();return current.action===expected.action && current.method===expected.method};
      if(!unchanged()) return {error:'Form destination changed before submission. Inspect the form again.'};
      if(!Object.getOwnPropertyDescriptor(proto,'noValidate').get.call(form) && !(button && button.formNoValidate) && !proto.reportValidity.call(form)) {
        const fields=Array.from(form.elements).filter(el=>el.willValidate && !el.validity.valid).slice(0,20).map(el=>String(el.name||el.id||el.tagName).slice(0,100));
        return {error:'Form validation failed. Correct invalid fields before retrying: '+fields.join(', ')};
      }
      if(!unchanged()) return {error:'Form destination changed during validation. Inspect the form again.'};
      let event;
      const observe=e=>{if(e.target===form)event=e};
      window.addEventListener('submit',observe,{capture:true});
      let submitError=null;
      try { proto.requestSubmit.call(form,...(button && !submitterDisabled?[button]:[])); }
      catch(e){ submitError=e && (e as Error).message ? (e as Error).message : String(e); }
      finally { window.removeEventListener('submit',observe,{capture:true}); }
      if(submitError) return {error:'requestSubmit failed: '+submitError};
      if(!event) return {error:'No submit event was observed. Check form validation and page state before retrying.'};
      return {ok:true,status:event.defaultPrevented?'handled_by_page':'submission_requested',action:target.action,method:target.method,serverResponseVerified:false,submitterDisabled};
    `)
  }
})
