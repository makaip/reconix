import clipboard from '../../assets/icons/clipboard.svg'

type DropZoneProps = {
  /** True while a dragged node is hovering over the drop target. */
  over: boolean
}

function DropZone({ over }: DropZoneProps): JSX.Element {
  return (
    <div className={over ? 'drop-zone drop-zone--over' : 'drop-zone'}>
      <img src={clipboard} width={16} height={16} alt="" />
      <p className="drop-zone__title">Drop to attach as context</p>
    </div>
  )
}

export default DropZone
