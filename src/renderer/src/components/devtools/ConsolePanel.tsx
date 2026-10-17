import { useEffect, useRef, useState } from 'react'
import type { ConsoleEntry } from '../../../../shared/devtools'

type ConsolePanelProps = {
  entries: ConsoleEntry[]
  onEvaluate: (expression: string) => Promise<void>
}

const LEVEL_CLASS: Record<ConsoleEntry['level'], string> = {
  error: 'dt-console__entry--error',
  warning: 'dt-console__entry--warning',
  info: 'dt-console__entry--info',
  debug: 'dt-console__entry--debug',
  log: ''
}

function ConsolePanel({ entries, onEvaluate }: ConsolePanelProps): JSX.Element {
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [entries.length])

  return (
    <div className="dt-console">
      <div ref={listRef} className="dt-console__log" role="log" aria-label="Console output">
        {entries.length === 0 && <p className="dt-empty">Console is empty.</p>}
        {entries.map((entry) => (
          <div
            key={entry.id}
            className={`dt-console__entry ${LEVEL_CLASS[entry.level]}${
              entry.source === 'eval-command' ? ' dt-console__entry--command' : ''
            }`}
          >
            {entry.source === 'eval-command' && <span className="dt-console__prompt">{'>'}</span>}
            <span className="dt-console__text">{entry.text}</span>
          </div>
        ))}
      </div>
      <form
        className="dt-console__input-row"
        onSubmit={(event) => {
          event.preventDefault()
          const expression = input
          setInput('')
          void onEvaluate(expression)
        }}
      >
        <span className="dt-console__prompt">{'>'}</span>
        <input
          className="dt-console__input"
          type="text"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Evaluate JS in the target page"
          aria-label="Console input"
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </div>
  )
}

export default ConsolePanel
