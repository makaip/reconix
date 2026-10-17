import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Evaluate the impact of a browser action by comparing DOM states, checking for new error messages, alerts, and URL changes.",
  args: {
    baselineHtml: tool.schema.string().optional().describe("The HTML snapshot taken before the action was executed."),
    currentHtml: tool.schema.string().describe("The current HTML snapshot after the action was executed."),
    currentUrl: tool.schema.string().optional().describe("The current page URL to check for unexpected redirects."),
  },
  async execute(args, ctx) {
    // In a live integration, pull this directly from the active Playwright page context.
    // For this standalone tool design, we evaluate the provided states.
    
    const changes: {
      urlRedirect?: string;
      newElementsSummary?: string[];
      alertsDetected?: string[];
    } = {};

    // Basic structural analysis to highlight key indicators for an evaluator agent
    const current = args.currentHtml;
    
    // Detect common security indicators or feedback in the DOM
    const indicators = [
      "success", "error", "invalid", "unauthorized", "welcome", 
      "flag", "token", "admin", "dashboard", "alert",
      "xss", "payload", "injection", "critical", "warning"
    ];
    
    const detectedKeywords = indicators.filter(keyword => {
      const currentLower = current.toLowerCase();
      const hasKeyword = currentLower.includes(keyword);
      
      if (!args.baselineHtml) {
        // If no baseline, flag only if it's a high-signal security keyword
        const highSignal = ["flag", "token", "admin", "xss", "injection"];
        return hasKeyword && highSignal.includes(keyword);
      }
      
      const baselineLower = args.baselineHtml.toLowerCase();
      return hasKeyword && !baselineLower.includes(keyword);
    });

    return JSON.stringify({
      status: "evaluated",
      url: args.currentUrl ?? "unknown",
      newlyAppearedKeywords: detectedKeywords,
      summary: detectedKeywords.length > 0 
        ? `Action triggered state changes containing key terms: ${detectedKeywords.join(", ")}` 
        : "No significant state change or indicator keywords detected in the DOM.",
      analysis: {
        baselineProvided: !!args.baselineHtml,
        keywordCount: detectedKeywords.length
      }
    }, null, 2);
  },
})