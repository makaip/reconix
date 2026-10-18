// Slash commands for the Copilot composer. Two kinds live here:
//   - UI commands run entirely in the renderer (new chat, stop, open a panel).
//   - agent/skill/tool commands expand into an instruction and go to the agent
//     through the normal send path — the renderer has no direct line to the MCP
//     tools, so a slash command is a typed shortcut for a prompt, not a direct
//     tool call. The main process still gates every tool the agent then calls.

export type CommandCategory = 'ui' | 'agent' | 'skill' | 'tool'

/** Panel surfaces the UI commands can toggle, mirroring CopilotPanel's own state. */
export type CommandPanel = 'history' | 'tools' | 'restrictions'

/** Actions a command may invoke. All already exist on the panel/hook. */
export type CommandContext = {
  /** Send a message to the agent on the active target (same path as the composer). */
  send: (text: string) => void
  newChat: () => void
  suspend: () => void
  /** Open one of the header panels (or close all with null). */
  openPanel: (panel: CommandPanel | null) => void
  setAllToolsEnabled: (enabled: boolean) => void
}

export type SlashCommand = {
  /** Command word without the leading slash. */
  name: string
  aliases?: string[]
  category: CommandCategory
  description: string
  /** Shown after the name in the popup, e.g. "<url>". */
  argHint?: string
  /** True for tools registered in main but not yet implemented (they throw).
   *  Every tool in the catalog below is implemented, so nothing currently sets this. */
  pending?: boolean
  run: (ctx: CommandContext, args: string) => void
}

const AGENTS: { name: string; mention: string; description: string }[] = [
  {
    name: 'orchestrator',
    mention: 'pentest-orchestrator',
    description: 'Lead orchestrator: recon, hypotheses, delegation, reporting.'
  },
  { name: 'evaluator', mention: 'evaluator', description: 'Evidence analysis and false-positive filtering.' },
  { name: 'dom-analyzer', mention: 'dom-analyzer', description: 'Fast DOM analyzer: forms, inputs, handlers.' }
]

const SKILLS: { name: string; skill: string; description: string }[] = [
  { name: 'deobfuscation', skill: 'deobfuscation', description: 'Turn obfuscated JS (incl. runtime-generated) into readable source.' },
  { name: 'dom-evaluator', skill: 'dom-evaluator', description: 'Analyze state changes and errors after browser actions.' },
  { name: 'z3-solver', skill: 'z3-solver', description: 'Solve inputs for length bounds and regex constraints.' }
]

// Full MCP tool catalog (src/main/mcp/tools). Every tool listed here is already
// implemented and registered by main, so none is flagged `pending`.
const TOOLS: { name: string; description: string; argHint?: string; pending?: boolean }[] = [
  { name: 'get_scope', description: 'Report the engagement scope.' },
  { name: 'get_engagement_state', description: 'Report the current engagement state.' },
  { name: 'navigate', description: 'Navigate the target to a URL.', argHint: '<url>' },
  { name: 'get_page_info', description: 'Title, URL and basic info of the current page.' },
  { name: 'get_cookies', description: 'Cookies for the current page.' },
  { name: 'screenshot', description: 'Capture a screenshot of the target.' },
  { name: 'eval_in_page', description: 'Evaluate an expression in the target page.', argHint: '<expr>' },
  { name: 'click', description: 'Click an element.', argHint: '<ref|selector>' },
  { name: 'fill', description: 'Fill a field with a value.', argHint: '<ref> <value>' },
  { name: 'replay_request', description: 'Replay a captured request (gated).', argHint: '<request>' },
  { name: 'get_network_log', description: 'List captured network requests.' },
  { name: 'get_request', description: 'Details of one captured request.', argHint: '<id>' },
  { name: 'record_finding', description: 'Record a finding.', argHint: '<finding>' },
  { name: 'query_log', description: 'Query the activity log.', argHint: '<query>' },
  { name: 'get_trace', description: 'Fetch a stored trace.', argHint: '<ref>' },
  { name: 'gen_fuzz_payloads', description: 'Generate a fuzz payload set (data).', argHint: '<corpus>' },
  { name: 'break_regex', description: 'Catastrophic-backtracking candidates for a regex (data).', argHint: '<regex>' },
  { name: 'mutate_payload', description: 'Mutations of a seed string (data).', argHint: '<seed>' },
  { name: 'detect_encoding', description: 'Classify encodings and entropy of a body (data).', argHint: '<body>' },
  { name: 'diff_responses', description: 'Compact delta between two response bodies (data).', argHint: '<a> <b>' },
  { name: 'get_dom_extract', description: 'Schema’d DOM extract: forms/inputs/endpoints/links/headers/CSRF.' },
  { name: 'list_forms', description: 'Forms on the current page with identity refs.' },
  { name: 'list_links', description: 'Links on the current page, in/out of scope.' },
  { name: 'get_headers', description: 'Response headers of the current document.' },
  { name: 'dispatch_input', description: 'Raw CDP Input event sequence into the target page.' },
  { name: 'query_dom', description: 'Query DOM nodes matching a selector.' },
  { name: 'set_dom', description: 'Set innerHTML of a node in the target page only.' },
  { name: 'set_emulation', description: 'CSS/Emulation: device, viewport, media.' },
  { name: 'set_intercept_rule', description: 'CDP Fetch rewrite rule (gated).' },
  { name: 'submit_form', description: 'Submit a form by ref with values (mutating).' },
  { name: 'probe_reflection', description: 'Benign-marker reflection probe (detection only).' },
  { name: 'vary_parameter', description: 'Differential over a param set (IDOR/BAC/fuzz).' },
  { name: 'run_tool', description: 'Brokered external binary (nmap/nuclei/sqlmap).' },
  { name: 'reproduce', description: 'Replay a stored interaction; report whether it matches.' },
  { name: 'collect_evidence', description: 'Bundle screenshot + req/resp + trace into one ref.' }
]

function toolInstruction(tool: string, args: string): string {
  const trimmed = args.trim()
  return trimmed
    ? `Use the \`${tool}\` tool with: ${trimmed}`
    : `Use the \`${tool}\` tool.`
}

const uiCommands: SlashCommand[] = [
  {
    name: 'new',
    aliases: ['clear'],
    category: 'ui',
    description: 'Start a new chat.',
    run: (ctx) => ctx.newChat()
  },
  {
    name: 'stop',
    category: 'ui',
    description: 'Interrupt the current turn.',
    run: (ctx) => ctx.suspend()
  },
  {
    name: 'history',
    category: 'ui',
    description: 'Open previous chats.',
    run: (ctx) => ctx.openPanel('history')
  },
  {
    name: 'tools',
    category: 'ui',
    description: 'Open model functions. "all" or "none" toggles every function.',
    argHint: '[all|none]',
    run: (ctx, args) => {
      const arg = args.trim().toLowerCase()
      if (arg === 'all') ctx.setAllToolsEnabled(true)
      else if (arg === 'none') ctx.setAllToolsEnabled(false)
      else ctx.openPanel('tools')
    }
  },
  {
    name: 'restrictions',
    category: 'ui',
    description: 'Open engagement restrictions.',
    run: (ctx) => ctx.openPanel('restrictions')
  },
  {
    name: 'help',
    category: 'ui',
    description: 'List all slash commands.',
    // Handled specially by the composer (reopens the full list); the no-op keeps
    // the registry uniform if it is ever dispatched directly.
    run: () => {}
  }
]

const agentCommands: SlashCommand[] = AGENTS.map((agent) => ({
  name: agent.name,
  category: 'agent',
  description: agent.description,
  argHint: '<task>',
  run: (ctx, args) => {
    const task = args.trim()
    ctx.send(task ? `Delegate to @${agent.mention}: ${task}` : `Delegate the next step to @${agent.mention}.`)
  }
}))

const skillCommands: SlashCommand[] = SKILLS.map((entry) => ({
  name: entry.name,
  category: 'skill',
  description: entry.description,
  argHint: '[context]',
  run: (ctx, args) => {
    const extra = args.trim()
    ctx.send(extra ? `Use the ${entry.skill} skill. ${extra}` : `Use the ${entry.skill} skill.`)
  }
}))

const toolCommands: SlashCommand[] = TOOLS.map((tool) => ({
  name: tool.name,
  category: 'tool',
  description: tool.description,
  argHint: tool.argHint,
  pending: tool.pending,
  run: (ctx, args) => ctx.send(toolInstruction(tool.name, args))
}))

export const COMMANDS: SlashCommand[] = [
  ...uiCommands,
  ...agentCommands,
  ...skillCommands,
  ...toolCommands
]

const byName = new Map<string, SlashCommand>()
for (const command of COMMANDS) {
  byName.set(command.name, command)
  for (const alias of command.aliases ?? []) byName.set(alias, command)
}

export function findCommand(name: string): SlashCommand | undefined {
  return byName.get(name.toLowerCase())
}

export type Interpreted =
  | { kind: 'message'; text: string }
  | { kind: 'command'; command: SlashCommand; args: string }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string }

/** Decide what a submitted composer string means. A leading "//" escapes to a
 *  literal message so the agent can still be sent text that starts with a slash. */
export function interpret(raw: string): Interpreted {
  const text = raw.trim()
  if (!text.startsWith('/')) return { kind: 'message', text }
  if (text.startsWith('//')) return { kind: 'message', text: text.slice(1) }

  const space = text.indexOf(' ')
  const name = (space === -1 ? text.slice(1) : text.slice(1, space)).toLowerCase()
  const args = space === -1 ? '' : text.slice(space + 1)
  const command = findCommand(name)
  if (!command) return { kind: 'unknown', name }
  if (command.name === 'help') return { kind: 'help' }
  return { kind: 'command', command, args }
}

/** Commands whose name (or alias) begins with the typed fragment, for the popup.
 *  An empty fragment (just "/") returns the whole catalog. */
export function matchCommands(fragment: string): SlashCommand[] {
  const query = fragment.toLowerCase()
  if (!query) return COMMANDS
  return COMMANDS.filter(
    (command) =>
      command.name.startsWith(query) || (command.aliases ?? []).some((alias) => alias.startsWith(query))
  )
}
