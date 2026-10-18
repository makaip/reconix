// Bridge between the `ask_user` MCP tool (runs in main, in the MCP server
// process context) and the renderer's interactive prompt. The tool's execute()
// calls requestQuestion(), which emits `copilot:question` to the renderer and
// awaits a matching `copilot:respond-question` IPC. A timeout auto-cancels.

import { randomUUID } from 'node:crypto'

export type QuestionRequest = {
  questionId: string
  header: string
  question: string
  options?: string[]
  multiple?: boolean
}

type Pending = {
  resolve: (answer: string | string[] | null) => void
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()
let sender: ((payload: QuestionRequest) => void) | null = null

export function setQuestionSender(fn: ((payload: QuestionRequest) => void) | null): void {
  sender = fn
}

export function requestQuestion(req: Omit<QuestionRequest, 'questionId'>, timeoutMs = 300000): Promise<string | string[] | null> {
  const questionId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(questionId)
      resolve(null)
    }, timeoutMs)
    pending.set(questionId, { resolve, timer })
    if (sender) sender({ questionId, ...req })
    else {
      clearTimeout(timer)
      pending.delete(questionId)
      resolve(null)
    }
  })
}

export function resolveQuestion(questionId: string, answer: string | string[] | null): boolean {
  const p = pending.get(questionId)
  if (!p) return false
  clearTimeout(p.timer)
  pending.delete(questionId)
  p.resolve(answer)
  return true
}
