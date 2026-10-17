import dotGrey from '../../assets/icons/dot-grey.svg'
import dotRed from '../../assets/icons/dot-red.svg'
import navLeft from '../../assets/icons/nav-left.svg'
import navReload from '../../assets/icons/nav-reload.svg'
import navRight from '../../assets/icons/nav-right.svg'
import toolbarChat from '../../assets/icons/toolbar-chat.svg'
import UrlBar from './UrlBar'

type ToolbarProps = {
  url: string
  canGoBack: boolean
  canGoForward: boolean
  copilotOpen: boolean
  onToggleCopilot: () => void
}

type NavButtonProps = {
  label: string
  icon: string
  flip?: boolean
  disabled?: boolean
  onClick: () => void
}

function NavButton({ label, icon, flip, disabled, onClick }: NavButtonProps): JSX.Element {
  return (
    <button type="button" className="nav-button" aria-label={label} disabled={disabled} onClick={onClick}>
      <img src={icon} width={16} height={16} alt="" className={flip ? 'nav-button__flip' : undefined} />
    </button>
  )
}

function Toolbar({ url, canGoBack, canGoForward, copilotOpen, onToggleCopilot }: ToolbarProps): JSX.Element {
  const { target } = window.reconix

  return (
    <div className="toolbar">
      {/* the design only draws the left arrow enabled and the right one disabled, so each state mirrors one of them */}
      <NavButton
        label="Back"
        icon={canGoBack ? navLeft : navRight}
        flip={!canGoBack}
        disabled={!canGoBack}
        onClick={() => void target.back()}
      />
      <NavButton
        label="Forward"
        icon={canGoForward ? navLeft : navRight}
        flip={canGoForward}
        disabled={!canGoForward}
        onClick={() => void target.forward()}
      />
      <NavButton label="Reload" icon={navReload} onClick={() => void target.reload()} />

      <UrlBar url={url} />

      {/* interception and recording aren't built yet, so these are inert */}
      <button type="button" className="toolbar-button toolbar-button--muted" title="Not implemented yet">
        <img src={dotGrey} width={7} height={7} alt="" />
        Intercept
      </button>
      <button type="button" className="toolbar-button" title="Not implemented yet">
        <img src={dotRed} width={7} height={7} alt="" />
        Recorder
      </button>
      <button
        type="button"
        className="toolbar-button toolbar-button--strong"
        aria-pressed={copilotOpen}
        onClick={onToggleCopilot}
      >
        <img src={toolbarChat} width={14} height={14} alt="" />
        Copilot
      </button>
    </div>
  )
}

export default Toolbar
