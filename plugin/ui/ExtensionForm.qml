import QtQuick
import QtQuick.Controls
import "../core/ExtensionForm.js" as ExtForm

// Extension Form view: renders every field kind from the render-tree
// schema (ref 03 §2.4) — TextField, PasswordField, TextArea, Checkbox,
// DatePicker, Dropdown, TagPicker, FilePicker, Separator, Description.
// Pure shaping lives in core/ExtensionForm.js; this file only lays out
// controls and emits {fieldId: value} through onSubmit/onChange.
Column {
  id: root
  property var form: ({ kind: "Form", items: [] })
  property var values: ({})
  property var errors: ({})
  // Loaded field controls (those with forceActiveFocus), in item order,
  // for focusFirst/focusNext keyboard flow, plus their field shapes for
  // focus-aware paste. [D]
  property var inputs: []
  property var inputFields: []
  // Advanced rows (item.advanced) hide until the user expands this. [D]
  property bool showAdvanced: false
  // Theme palette, set by the host (defaults suit a dark card). [D]
  property color foreground: "white"
  property color dim: "#a8a8a8"
  property color accent: "#7aa2f7"
  property color error: "#e06c75"
  property color fieldBackground: Qt.rgba(1, 1, 1, 0.06)
  property color fieldBorder: Qt.rgba(1, 1, 1, 0.18)
  property color popupBackground: "#23232e"
  // Set by the host before setForm when the first field should take
  // focus; consumed by onLoaded so no retry race remains. [D]
  property bool focusRequested: false
  signal submitted(var values)
  signal fieldChanged(string fieldId, var value)

  function setForm(raw) {
    root.inputs = []
    root.inputFields = []
    root.focusRequested = false
    root.form = ExtForm.normalizeForm(raw)
    var v = ExtForm.initialValues(root.form)
    var out = {}
    for (var k in v) out[k] = v[k]
    root.values = out
    root.errors = {}
  }

  function setField(id, value) {
    var v = {}
    for (var k in root.values) v[k] = root.values[k]
    v[id] = value
    root.values = v
  }

  // Typing reached the window with no field focused (card background was
  // clicked): put it in the first text field instead of dropping it. [D]
  function typeIntoFirst(text) {
    var first = null
    for (var i = 0; i < root.form.items.length; i++) {
      var it = root.form.items[i]
      if (it.kind === "TextField" || it.kind === "PasswordField" || it.kind === "TextArea") { first = it; break }
    }
    if (!first) return
    setField(first.id, String(root.values[first.id] || "") + String(text))
    focusFirst()
  }

  function chompFirst() {
    for (var i = 0; i < root.form.items.length; i++) {
      var it = root.form.items[i]
      if (it.kind === "TextField" || it.kind === "PasswordField" || it.kind === "TextArea") {
        setField(it.id, String(root.values[it.id] || "").slice(0, -1))
        focusFirst()
        return
      }
    }
  }

  function focusFirst() {
    if (root.inputs.length) root.inputs[0].forceActiveFocus()
  }

  function hasAdvanced() {
    for (var i = 0; i < root.form.items.length; i++) if (root.form.items[i].advanced) return true
    return false
  }

  function focusNext(direction) {
    // Hidden advanced rows stay instantiated: skip them in the tab order. [D]
    var order = []
    for (var i = 0; i < root.inputFields.length; i++) {
      var e = root.inputFields[i]
      if (e.field.advanced && !root.showAdvanced) continue
      order.push(e.target)
    }
    if (!order.length) return
    var at = -1
    for (var j = 0; j < order.length; j++) {
      if (order[j].activeFocus) { at = j; break }
    }
    var next = at < 0 ? (direction > 0 ? 0 : order.length - 1)
      : Math.max(0, Math.min(order.length - 1, at + direction))
    order[next].forceActiveFocus()
  }

  function fieldError(id) {
    return (root.errors && root.errors[id]) || ""
  }

  function focusedField() {
    for (var i = 0; i < root.inputFields.length; i++) {
      if (root.inputFields[i].target.activeFocus) return root.inputFields[i].field
    }
    return null
  }

  function hasFieldFocus() {
    return !!root.focusedField()
  }

  // Ctrl+V is stolen by the window key handler, so focused fields never
  // see a native paste: insert into the focused value here instead. [D]
  function pasteIntoFocused(text) {
    var f = root.focusedField()
    if (!f) { root.typeIntoFirst(text); return }
    var t = String(text === undefined || text === null ? "" : text).replace(/[\r\n\u2028\u2029]+/g, " ")
    if (!t) return
    if (f.kind === "TagPicker" || f.kind === "FilePicker") {
      var cur = Array.isArray(root.values[f.id]) ? root.values[f.id].slice() : []
      var add = t.split(",").map(function (s) { return s.trim() }).filter(function (s) { return s !== "" })
      for (var i = 0; i < add.length; i++) if (cur.indexOf(add[i]) < 0) cur.push(add[i])
      root.setField(f.id, cur)
      root.fieldChanged(f.id, cur)
      return
    }
    if (f.kind === "Dropdown" || f.kind === "Checkbox" || f.kind === "Separator" || f.kind === "Description") {
      root.typeIntoFirst(t)
      return
    }
    var v = {}
    for (var k in root.values) v[k] = root.values[k]
    v[f.id] = String(root.values[f.id] || "") + t
    root.values = v
    root.fieldChanged(f.id, v[f.id])
  }

  function submit() {
    var errs = ExtForm.validateForm(root.values, root.form)
    var out = {}
    for (var k in errs) out[k] = errs[k]
    root.errors = out
    if (Object.keys(errs).length === 0) root.submitted(ExtForm.unwrappedValues(root.values, root.form))
  }

  spacing: 10
  Repeater {
    id: repeater
    model: root.form.items || []
    delegate: Loader {
      width: root.width
      // Advanced rows hide (but stay instantiated, keeping values) until
      // the user expands the toggle below. [D]
      visible: !(modelData && modelData.advanced && !root.showAdvanced)
      property var field: modelData
      // Ternary chain: binding scripts cannot use return statements. [D]
      sourceComponent: (modelData && (modelData.kind === "TextField" || modelData.kind === "PasswordField")) ? textFieldComp
        : (modelData && modelData.kind === "TextArea") ? textAreaComp
        : (modelData && modelData.kind === "Checkbox") ? checkboxComp
        : (modelData && modelData.kind === "DatePicker") ? datePickerComp
        : (modelData && modelData.kind === "Dropdown") ? dropdownComp
        : (modelData && modelData.kind === "TagPicker") ? tagPickerComp
        : (modelData && modelData.kind === "FilePicker") ? filePickerComp
        : (modelData && modelData.kind === "Separator") ? separatorComp
        : descriptionComp
      onLoaded: {
        if (item) {
          item.field = field
          if (item.focusTarget) {
            root.inputs = root.inputs.slice().concat([item.focusTarget])
            root.inputFields = root.inputFields.slice().concat([{ target: item.focusTarget, field: field }])
            // First field in focuses it at once: no Loader/focus race. [D]
            if (root.focusRequested && root.inputs.length === 1) {
              root.focusRequested = false
              item.focusTarget.forceActiveFocus()
            }
          }
        }
      }
    }
  }

  // Visible affordance for the hidden advanced rows, below the fields. [D]
  Item {
    width: root.width
    height: toggleText.implicitHeight
    visible: root.hasAdvanced()
    Text {
      id: toggleText
      textFormat: Text.PlainText
      text: root.showAdvanced ? "Hide advanced" : "Show advanced"
      color: root.dim
      font.pixelSize: 13
    }
    MouseArea {
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: root.showAdvanced = !root.showAdvanced
    }
  }

  Component {
    id: textFieldComp
    Column {
      width: root.width
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: (field && field.placeholder) || ""
        echoMode: (field && field.isSecure) ? TextInput.Password : TextInput.Normal
        selectByMouse: true
        color: root.foreground
        placeholderTextColor: root.dim
        background: Rectangle { color: root.fieldBackground; border.color: root.fieldBorder; border.width: 1; radius: 6 }
        text: (field && root.values[field.id] !== undefined) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
        onAccepted: root.submit()
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
      Text { visible: !!root.fieldError(field ? field.id : ""); text: root.fieldError(field ? field.id : ""); textFormat: Text.PlainText; color: root.error }
    }
  }
  Component {
    id: textAreaComp
    Column {
      width: root.width
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      TextArea {
        id: input
        objectName: "addFormField"
        width: parent.width
        placeholderText: (field && field.placeholder) || ""
        selectByMouse: true
        color: root.foreground
        placeholderTextColor: root.dim
        background: Rectangle { color: root.fieldBackground; border.color: root.fieldBorder; border.width: 1; radius: 6 }
        text: (field && root.values[field.id] !== undefined) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
    }
  }
  Component {
    id: checkboxComp
    CheckBox {
      width: root.width
      property var field
      property var focusTarget: box
      id: box
      objectName: "addFormField"
      text: (field && (field.checkboxTitle || field.title)) || ""
      checked: !!(field && root.values[field.id])
      onToggled: if (field) { root.setField(field.id, checked); root.fieldChanged(field.id, checked) }
      contentItem: Text {
        text: box.text
        color: root.foreground
        verticalAlignment: Text.AlignVCenter
        leftPadding: box.indicator.width + box.spacing
        elide: Text.ElideRight
      }
    }
  }
  Component {
    id: datePickerComp
    Column {
      width: root.width
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        // Plain text, not a mask: stored and displayed text stay
        // identical, and the core flags bad shapes on submit. [D]
        placeholderText: "YYYY-MM-DD"
        selectByMouse: true
        color: root.foreground
        placeholderTextColor: root.dim
        background: Rectangle { color: root.fieldBackground; border.color: root.fieldBorder; border.width: 1; radius: 6 }
        text: (field && root.values[field.id] != null) ? String(root.values[field.id]) : ""
        onTextChanged: if (field && text !== String(root.values[field.id] || "")) { root.setField(field.id, text); root.fieldChanged(field.id, text) }
        onAccepted: root.submit()
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
      Text { visible: !!root.fieldError(field ? field.id : ""); text: root.fieldError(field ? field.id : ""); textFormat: Text.PlainText; color: root.error }
    }
  }
  Component {
    id: dropdownComp
    Column {
      width: root.width
      property var field
      property var focusTarget: combo
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      ComboBox {
        id: combo
        objectName: "addFormField"
        width: parent.width
        function titles() {
          var out = []
          var secs = (field && field.sections) || []
          for (var i = 0; i < secs.length; i++) for (var j = 0; j < secs[i].items.length; j++) out.push(secs[i].items[j].title)
          return out
        }
        function optionValues() {
          var vals = []
          var secs = (field && field.sections) || []
          for (var i = 0; i < secs.length; i++) for (var j = 0; j < secs[i].items.length; j++) vals.push(String(secs[i].items[j].value))
          return vals
        }
        // Reactive: Component.onCompleted runs before Loader assigns
        // field, so an imperative sync there always exits early. The
        // binding re-evaluates once field/values arrive; a user pick
        // replaces the binding, so it never fights back. [D]
        function syncedIndex() {
          if (!field) return 0
          var at = optionValues().indexOf(String(root.values[field.id]))
          return at >= 0 ? at : 0
        }
        model: titles()
        currentIndex: syncedIndex()
        contentItem: Text {
          leftPadding: 8
          rightPadding: combo.indicator.width + 8
          text: combo.displayText
          color: root.foreground
          verticalAlignment: Text.AlignVCenter
          elide: Text.ElideRight
        }
        background: Rectangle {
          color: root.fieldBackground
          border.color: root.fieldBorder
          border.width: 1
          radius: 6
        }
        indicator: Text {
          x: combo.width - width - 10
          y: (combo.availableHeight - height) / 2
          text: "\u25be"
          color: root.dim
          font.pixelSize: 12
        }
        delegate: ItemDelegate {
          width: combo.width
          highlighted: combo.highlightedIndex === index
          contentItem: Text {
            text: modelData
            color: highlighted ? "white" : root.foreground
            elide: Text.ElideRight
            verticalAlignment: Text.AlignVCenter
          }
          background: Rectangle { color: highlighted ? root.accent : "transparent"; radius: 4 }
        }
        popup: Popup {
          y: combo.height + 4
          width: combo.width
          padding: 4
          contentItem: ListView {
            clip: true
            implicitHeight: contentHeight
            model: combo.delegateModel
          }
          background: Rectangle {
            color: root.popupBackground
            border.color: root.fieldBorder
            border.width: 1
            radius: 6
          }
        }
        onActivated: {
          if (!field) return
          var vals = optionValues()
          if (index >= 0 && index < vals.length) { root.setField(field.id, vals[index]); root.fieldChanged(field.id, vals[index]) }
        }
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
    }
  }
  Component {
    id: tagPickerComp
    Column {
      width: root.width
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        color: root.foreground
        placeholderTextColor: root.dim
        background: Rectangle { color: root.fieldBackground; border.color: root.fieldBorder; border.width: 1; radius: 6 }
        selectByMouse: true
        placeholderText: (field && field.placeholder) || "Comma-separated values"
        text: (field && Array.isArray(root.values[field.id])) ? root.values[field.id].join(", ") : ""
        onTextChanged: {
          if (!field) return
          var arr = text.split(",").map(function (s) { return s.trim() }).filter(function (s) { return s !== "" })
          // Content compare: typing "a, " parses back to ["a"], and
          // rewriting the field would eat the separator mid-typing. [D]
          var cur = Array.isArray(root.values[field.id]) ? root.values[field.id] : []
          if (String(arr) !== String(cur)) { root.setField(field.id, arr); root.fieldChanged(field.id, arr) }
        }
        onAccepted: root.submit()
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
    }
  }
  Component {
    id: filePickerComp
    Column {
      width: root.width
      property var field
      property var focusTarget: input
      spacing: 2
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; color: root.foreground }
      TextField {
        id: input
        objectName: "addFormField"
        width: parent.width
        color: root.foreground
        placeholderTextColor: root.dim
        background: Rectangle { color: root.fieldBackground; border.color: root.fieldBorder; border.width: 1; radius: 6 }
        selectByMouse: true
        placeholderText: "/path/to/file"
        text: (field && Array.isArray(root.values[field.id])) ? root.values[field.id].join(", ") : ""
        onTextChanged: {
          if (!field) return
          var arr = text.split(",").map(function (s) { return s.trim() }).filter(function (s) { return s !== "" })
          var cur = Array.isArray(root.values[field.id]) ? root.values[field.id] : []
          if (String(arr) !== String(cur)) { root.setField(field.id, arr); root.fieldChanged(field.id, arr) }
        }
        onAccepted: root.submit()
      }
      Text { visible: !!(field && field.info); text: (field && field.info) || ""; textFormat: Text.PlainText; color: root.dim; wrapMode: Text.Wrap }
    }
  }
  Component { id: separatorComp; Rectangle { property var field; property var focusTarget: null; height: 1; width: parent.width; opacity: 0.3 } }
  Component {
    id: descriptionComp
    Column {
      width: root.width
      property var field
      property var focusTarget: null
      Text { text: (field && field.title) || ""; textFormat: Text.PlainText; font.bold: true; color: root.foreground }
      Text { text: (field && field.text) || ""; textFormat: Text.PlainText; wrapMode: Text.Wrap; color: root.foreground }
    }
  }
}
