// Text helpers for the DOM port of Qt's Text elide modes.
//
// Text.ElideLeft: keep the tail, mark the cut with "…" in front. The DOM
// port cannot use the usual `direction: rtl` + `text-align: left` CSS
// trick — it flips the paragraph direction, and the bidi algorithm then
// reorders any text whose first strong character is not LTR: "1 rem to
// px" rendered as "rem to px 1". So the elide is done here, on the logical
// string, and the element stays LTR. [D]
//
// measure(text) returns the rendered width for the element's current font.

function elideLeft(text, maxWidth, measure) {
  var s = String(text === undefined || text === null ? "" : text)
  if (!s || !(maxWidth > 0)) return ""
  if (measure(s) <= maxWidth) return s

  var mark = "…"
  if (measure(mark) > maxWidth) return mark

  // Smallest cut index whose tail (with the mark) still fits. measure()
  // is monotonic in the tail length, so binary search is safe.
  var lo = 1, hi = s.length, best = s.length
  while (lo <= hi) {
    var mid = Math.floor((lo + hi) / 2)
    if (measure(mark + s.slice(mid)) <= maxWidth) { best = mid; hi = mid - 1 }
    else lo = mid + 1
  }
  return mark + s.slice(best)
}

if (typeof module !== "undefined") {
  module.exports = { elideLeft: elideLeft }
}
