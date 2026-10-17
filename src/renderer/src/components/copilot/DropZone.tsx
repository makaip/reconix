function DropZone(): JSX.Element {
  return (
    <div className="drop-zone">
      <p className="drop-zone__title">Drop to attach as context</p>
      <p className="drop-zone__hint">
        From DevTools: outerHTML, CSS selector and computed styles of the node.
      </p>
    </div>
  )
}

export default DropZone
