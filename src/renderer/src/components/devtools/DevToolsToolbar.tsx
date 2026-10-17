import device from '../../assets/icons/device.svg'
import gear from '../../assets/icons/gear.svg'
import closeIcon from '../../assets/icons/close-devtools.svg'
import inspect from '../../assets/icons/inspect.svg'
import kebab from '../../assets/icons/kebab.svg'

const TABS = [
  'Elements',
  'Console',
  'Sources',
  'Network',
  'Performance',
  'Memory',
  'Application',
  '»'
]

type DevToolsToolbarProps = {
  inspecting: boolean
  onToggleInspect: () => void
}

function IconButton({
  icon,
  label,
  active,
  disabled,
  onClick
}: {
  icon: string
  label: string
  active?: boolean
  disabled?: boolean
  onClick?: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={active ? 'dt-icon-button dt-icon-button--active' : 'dt-icon-button'}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <img src={icon} width={15} height={15} alt="" />
    </button>
  )
}

function DevToolsToolbar({ inspecting, onToggleInspect }: DevToolsToolbarProps): JSX.Element {
  return (
    <div className="dt-toolbar" role="tablist">
      <IconButton icon={inspect} label="Select an element in the page" active={inspecting} onClick={onToggleInspect} />
      <IconButton icon={device} label="Toggle device toolbar" disabled />
      <span className="dt-toolbar__divider" />
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === 'Elements'}
          disabled={tab !== 'Elements'}
          className={tab === 'Elements' ? 'dt-tab dt-tab--active' : 'dt-tab'}
        >
          {tab}
        </button>
      ))}
      <span className="dt-toolbar__spacer" />
      <IconButton icon={gear} label="Settings" disabled />
      <IconButton icon={kebab} label="More options" disabled />
      <IconButton icon={closeIcon} label="Close DevTools" disabled />
    </div>
  )
}

export default DevToolsToolbar
