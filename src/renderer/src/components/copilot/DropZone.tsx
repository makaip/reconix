type DropZoneProps = {
  /** True while a dragged node is hovering over the drop target. */
  over: boolean
}

function DropZone({ over }: DropZoneProps): JSX.Element {
  return (
    <div className={over ? 'drop-zone drop-zone--over' : 'drop-zone'}>
      <p className="drop-zone__title">Drop to attach as context</p>
      <p className="drop-zone__hint">
        DOM nodes bring outerHTML, selector and computed styles. Source and sitemap files
        bring their URL.
      </p>
    </div>
  )
}

export default DropZone
