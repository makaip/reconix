import { useEffect, useRef, useState } from 'react'
import urlLock from '../../assets/icons/url-lock.svg'
import { scope } from '../../mock/data'

function splitUrl(url: string): { scheme: string; host: string; rest: string; hostname: string } | null {
  try {
    const parsed = new URL(url)
    return {
      scheme: `${parsed.protocol}//`,
      host: parsed.host,
      rest: `${parsed.pathname}${parsed.search}${parsed.hash}`,
      hostname: parsed.hostname
    }
  } catch {
    return null
  }
}

function UrlBar({ url, disabled }: { url: string; disabled?: boolean }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const parts = splitUrl(url)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  // a new page replaces whatever navigation error was showing
  useEffect(() => setError(null), [url])

  const startEditing = (): void => {
    if (disabled) return
    setDraft(url)
    setError(null)
    setEditing(true)
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    setEditing(false)
    if (!text || text === url) return
    const result = await window.reconix.target.navigate(text)
    if (result && !result.ok) setError(result.error)
  }

  return (
    <div className={error ? 'url-bar url-bar--error' : 'url-bar'} title={error ?? undefined}>
      {parts?.scheme === 'https://' && <img src={urlLock} width={14} height={14} alt="Secure connection" />}

      {editing ? (
        <input
          ref={inputRef}
          className="url-bar__input"
          type="text"
          autoFocus
          spellCheck={false}
          aria-label="Address"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            else if (event.key === 'Escape') setEditing(false)
          }}
        />
      ) : (
        <button
          type="button"
          className="url-bar__display"
          aria-label="Address"
          disabled={disabled}
          title={disabled ? 'Waiting for the AI engine to finish starting…' : undefined}
          onClick={startEditing}
        >
          {parts ? (
            <>
              <span className="url-bar__muted">{parts.scheme}</span>
              <span className="url-bar__host">{parts.host}</span>
              <span className="url-bar__muted">{parts.rest}</span>
            </>
          ) : (
            <span className="url-bar__muted">Search or enter address</span>
          )}
        </button>
      )}

      {parts && scope.hosts.includes(parts.hostname) && <span className="url-bar__scope">In scope</span>}
    </div>
  )
}

export default UrlBar
