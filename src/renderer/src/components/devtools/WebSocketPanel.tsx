import { useState } from 'react'
import type { WsConnection } from '../../../../shared/tabs'

type WebSocketPanelProps = {
  connections: WsConnection[]
}

/** CDP opcode → short label. 1 text, 2 binary, 8 close, 9 ping, 10 pong. */
function opcodeLabel(opcode: number): string {
  switch (opcode) {
    case 1:
      return 'text'
    case 2:
      return 'binary'
    case 8:
      return 'close'
    case 9:
      return 'ping'
    case 10:
      return 'pong'
    default:
      return `op${opcode}`
  }
}

function connName(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return url
  }
}

function WebSocketPanel({ connections }: WebSocketPanelProps): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)

  if (connections.length === 0) {
    return <p className="dt-empty">No WebSocket connections captured on this page.</p>
  }

  return (
    <div className="dt-ws">
      {connections.map((conn) => {
        const open = openId === conn.requestId
        return (
          <div key={conn.requestId} className="dt-ws__conn">
            <button
              type="button"
              className="dt-ws__header"
              aria-expanded={open}
              onClick={() => setOpenId(open ? null : conn.requestId)}
            >
              <span className={conn.closedAt === undefined ? 'dt-ws__dot dt-ws__dot--live' : 'dt-ws__dot'} />
              <span className="dt-ws__url">{connName(conn.url)}</span>
              <span className="dt-ws__meta">
                {conn.frames.length} frame{conn.frames.length === 1 ? '' : 's'}
                {conn.framesTruncated ? '+' : ''}
                {conn.closedAt === undefined ? ' · open' : ' · closed'}
              </span>
            </button>
            {open && (
              <ol className="dt-ws__frames">
                {conn.frames.map((frame, i) => (
                  <li key={i} className={`dt-ws__frame dt-ws__frame--${frame.direction}`}>
                    <span className="dt-ws__dir" aria-hidden>
                      {frame.direction === 'sent' ? '▲' : '▼'}
                    </span>
                    <span className="dt-ws__op">{opcodeLabel(frame.opcode)}</span>
                    <code className="dt-ws__payload">
                      {frame.payload}
                      {frame.payloadTruncated ? '…' : ''}
                    </code>
                  </li>
                ))}
                {conn.frames.length === 0 && <li className="dt-ws__frame dt-empty">No frames yet.</li>}
              </ol>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default WebSocketPanel
