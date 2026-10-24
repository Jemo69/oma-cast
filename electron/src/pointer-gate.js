// Port of Omarchy's qs.Ui PointerMoveGate (omacom/omarchy, MIT): filters
// synthetic hover churn from rows moving under a stationary pointer. Call
// reset() after keyboard/list mutations, then moved() from a row's
// mousemove before changing selection.
function createPointerGate(referenceRectFn) {
  var gate = { primed: false, initialSampleAllowed: false, lastX: 0, lastY: 0, threshold: 1 }

  gate.reset = function() {
    gate.primed = false
    gate.initialSampleAllowed = false
    gate.lastX = 0
    gate.lastY = 0
  }
  gate.allowInitialSample = function() { gate.reset(); gate.initialSampleAllowed = true }

  // point: {x, y} in reference coordinates (row position mapped to the card).
  gate.moved = function(point) {
    if (!point) { gate.reset(); return false }
    var firstSample = !gate.primed
    var didMove = !firstSample
      ? Math.abs(point.x - gate.lastX) > gate.threshold || Math.abs(point.y - gate.lastY) > gate.threshold
      : gate.initialSampleAllowed

    if (firstSample || didMove) {
      gate.lastX = point.x
      gate.lastY = point.y
    }
    gate.primed = true
    gate.initialSampleAllowed = false
    return didMove
  }
  return gate
}

if (typeof module !== "undefined") {
  module.exports = { createPointerGate: createPointerGate }
}
