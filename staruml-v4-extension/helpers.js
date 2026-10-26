function moveViewTo (view, x, y) {
  const diagram = view.getDiagram()
  const editor = app.diagrams.getHiddenEditor()

  editor.diagram = diagram

  app.engine.moveViews(
    editor,
    [view],
    x - view.left,
    y - view.top
  )

  editor.repaint()
  app.diagrams.repaint()
}

function findViewWorldwide (viewId) {
  const view = app.repository.get(viewId)

  if (
    !view ||
    typeof view.getDiagram !== 'function' ||
    !Number.isFinite(view.left) ||
    !Number.isFinite(view.top) ||
    !view.getDiagram()
  ) {
    return null
  }

  return view
}


module.exports = {
  moveViewTo,
  findViewWorldwide
}
