import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Bypass strict input validation, length limits, or regex rules by mathematically solving constraints using Z3.",
  args: {
    maxLength: tool.schema.number().describe("Maximum allowed character length for the input field."),
    mustContain: tool.schema.string().optional().describe("A mandatory substring or payload fragment that must be included."),
    pattern: tool.schema.string().optional().describe("An optional regex pattern the input must satisfy."),
  },
  async execute(args, ctx) {
    const maxLen = args.maxLength ?? 50;
    const contain = args.mustContain ?? "";
    const patternArg = args.pattern ? `--pattern=${args.pattern}` : "";

    const result = await ctx.$`python .opencode/tools/z3_string_solver.py --max-len ${maxLen} --contain ${contain} ${patternArg}`
    
    return result.text()
  },
})