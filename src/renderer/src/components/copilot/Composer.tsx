import send from '../../assets/icons/send.svg'
import { composerContext } from '../../mock/data'
import Badge from '../Badge'

function Composer(): JSX.Element {
  return (
    <form className="composer" onSubmit={(event) => event.preventDefault()}>
      <div className="composer__context">
        <span className="composer__context-label">Context:</span>
        {composerContext.map((label) => (
          <Badge key={label}>{label}</Badge>
        ))}
      </div>
      <div className="composer__field">
        <input
          className="composer__input"
          type="text"
          placeholder="Ask about this target, or type / for commands"
          aria-label="Message Copilot"
        />
        <button type="submit" className="composer__send" aria-label="Send">
          <img src={send} width={14} height={14} alt="" />
        </button>
      </div>
    </form>
  )
}

export default Composer
