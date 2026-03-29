/**
 * ExtendScript for Adobe Illustrator — SVG 5DOF joint operations.
 *
 * checkSelection()              — returns selection state string for the panel.
 * applyJoint(type, paramsStr)   — wraps selected item in a tagged group.
 * revertToStraight()            — unwraps a tagged group back to the original.
 *
 * Tag format stored in group.note:
 *   "SVG5DOF:slant|45|translate"
 *   "SVG5DOF:bevel|45|50|inwards"
 *   "SVG5DOF:slider|50|5"
 *   "SVG5DOF:groove|50|5"
 */

var SVG5DOF_TAG = "SVG5DOF:";
var PT_PER_MM = 2.834645669;

// ═══════════════════════════════════════════════
//  Selection polling
// ═══════════════════════════════════════════════

var _lastCheckLog = "";
function checkSelection() {
    try {
        if (app.documents.length === 0) return "none";
        var sel = app.activeDocument.selection;
        if (!sel || sel.length === 0) return "none";

        // Collect all unique tagged groups from selection
        var seen = {};
        var taggedList = [];
        for (var i = 0; i < sel.length; i++) {
            var t = findTaggedAncestor(sel[i]);
            if (t && !seen[t.name + t.note]) {
                seen[t.name + t.note] = true;
                taggedList.push(t);
            }
        }

        if (taggedList.length === 0) {
            if ("normal" !== _lastCheckLog) { _log("checkSel → normal"); _lastCheckLog = "normal"; }
            return "normal";
        }

        if (taggedList.length === 1) {
            var result = "tagged:" + taggedList[0].note.substr(SVG5DOF_TAG.length);
            if (result !== _lastCheckLog) { _log("checkSel → " + result); _lastCheckLog = result; }
            return result;
        }

        // Multiple tagged groups — return multi:count|first_type_params
        // so the UI can show params from the first item
        var first = taggedList[0].note.substr(SVG5DOF_TAG.length);
        var result2 = "multi:" + taggedList.length + "|" + first;
        if (result2 !== _lastCheckLog) { _log("checkSel → " + result2); _lastCheckLog = result2; }
        return result2;
    } catch (e) {
        return "none";
    }
}

// ═══════════════════════════════════════════════
//  Apply joint
// ═══════════════════════════════════════════════

/**
 * Walk up from an item to find a tagged 5DOF group ancestor.
 * Returns the tagged GroupItem, or null.
 */
function findTaggedAncestor(item) {
    var candidate = item;
    while (candidate) {
        if (candidate.typename === "GroupItem" && candidate.note &&
            candidate.note.indexOf(SVG5DOF_TAG) === 0) {
            return candidate;
        }
        if (candidate.parent && candidate.parent.typename === "GroupItem") {
            candidate = candidate.parent;
        } else {
            break;
        }
    }
    return null;
}

function applyJoint(type, paramsStr) {
    try {
        if (app.documents.length === 0) return "No document open.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) return "Nothing selected.";

        // Phase 1: collect unique tagged groups and normal items
        // (don't unwrap yet — unwrapping deletes children that may
        //  still appear later in sel[])
        var taggedGroups = [];
        var normalItems = [];
        var seen = {};
        for (var i = 0; i < sel.length; i++) {
            var tagged = findTaggedAncestor(sel[i]);
            if (tagged) {
                var key = tagged.name + "|" + tagged.note;
                if (!seen[key]) {
                    seen[key] = true;
                    taggedGroups.push(tagged);
                }
                // skip — this item belongs to a tagged group
            } else {
                normalItems.push(sel[i]);
            }
        }

        // Phase 2: unwrap all tagged groups (now safe — collection is done)
        var items = [];
        for (var g = 0; g < taggedGroups.length; g++) {
            var orig = unwrapGroup(taggedGroups[g]);
            if (orig) items.push(orig);
        }
        for (var n = 0; n < normalItems.length; n++) {
            items.push(normalItems[n]);
        }

        if (items.length === 0) return "Nothing to process.";

        var params = paramsStr.split("|");
        var results = [];

        for (var j = 0; j < items.length; j++) {
            var grp = rebuildJoint(doc, items[j], type, params);
            if (grp) {
                grp.note = SVG5DOF_TAG + type + "|" + paramsStr;
                grp.name = "5DOF_" + type;
                results.push(grp);
            }
        }

        // Select all rebuilt groups
        deselectAll(doc);
        if (results.length > 0) {
            doc.selection = results;
        }
        app.redraw();

        // Collapse undo steps for multi-object operations
        if (results.length > 1) {
            for (var u = 0; u < results.length; u++) app.undo();
            for (var r = 0; r < results.length; r++) app.redo();
        }

        return type.charAt(0).toUpperCase() + type.slice(1) +
               " applied to " + results.length + " object(s).";

    } catch (e) {
        return "Error: " + e.message;
    }
}

// ═══════════════════════════════════════════════
//  Slant
//  params: [angle, mode, thickness_mm]
// ═══════════════════════════════════════════════

function buildSlant(doc, item, params) {
    var angle     = parseFloat(params[0]) || 45;
    var mode      = params[1] || "translate";
    var thickness = parseFloat(params[2]) || 5;
    var dist      = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Grey copy (behind) — offset, translated, or path-offset
    var grey;
    if (mode === "translate") {
        grey = item.duplicate(grp, ElementPlacement.PLACEATEND);
        grey.translate(dist, -dist);
    } else {
        grey = item.duplicate();  // duplicate at document level for Offset Path
        grey = applyOffset(grey, mode, dist);
        grey.move(grp, ElementPlacement.PLACEATEND);
    }
    setAllStrokes(grey, makeColor(204, 204, 204));

    // Black copy (front)
    var black = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
    setAllStrokes(black, makeColor(0, 0, 0));

    // Stash original
    item.move(grp, ElementPlacement.PLACEATEND);
    item.hidden = true;

    return grp;
}

// ═══════════════════════════════════════════════
//  Bevel
//  params: [angle, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildBevel(doc, item, params) {
    var angle     = parseFloat(params[0]) || 45;
    var mode      = params[1] || "inwards";
    var thickness = parseFloat(params[2]) || 5;
    var depth     = parseFloat(params[3]) || 50;
    var dist      = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;
    var grey      = Math.round(204 * depth / 100);

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black copy at original position (front)
    var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
    setAllStrokes(blackCopy, makeColor(0, 0, 0));

    // #ccc copy at offset position (behind)
    var cccCopy;
    if (mode === "translate") {
        cccCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
        cccCopy.translate(dist, -dist);
    } else {
        cccCopy = item.duplicate();
        cccCopy = applyOffset(cccCopy, mode, dist);
        cccCopy.move(grp, ElementPlacement.PLACEATEND);
    }
    setAllStrokes(cccCopy, makeColor(204, 204, 204));

    // Depth-lerped copy at same offset position (in front of #ccc)
    // Marks the boundary: slanted (black→grey) vs vertical (grey→#ccc)
    var depthCopy;
    if (mode === "translate") {
        depthCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
        depthCopy.translate(dist, -dist);
    } else {
        depthCopy = item.duplicate();
        depthCopy = applyOffset(depthCopy, mode, dist);
        depthCopy.move(grp, ElementPlacement.PLACEATEND);
    }
    setAllStrokes(depthCopy, makeColor(grey, grey, grey));

    // Stash original
    item.move(grp, ElementPlacement.PLACEATEND);
    item.hidden = true;

    return grp;
}

// ═══════════════════════════════════════════════
//  Slider
//  params: [angle, angle2, chained, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildSlider(doc, item, params) {
    var angle     = parseFloat(params[0]) || 45;
    var angle2    = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var mode      = params[3] || "inwards";
    var thickness = parseFloat(params[4]) || 5;
    var depth     = parseFloat(params[5]) || 50;
    var widthPt   = thickness * PT_PER_MM;
    var grey      = Math.round(204 * depth / 100);

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black copy at original position (front)
    var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(blackCopy, makeColor(0, 0, 0));

    // Grey copy — inset/outset/translated (middle)
    var greyCopy;
    if (mode === "translate") {
        greyCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
        greyCopy.translate(widthPt, -widthPt);
    } else if (mode === "outwards") {
        greyCopy = item.duplicate();
        greyCopy = applyOffset(greyCopy, "outwards", widthPt);
        greyCopy.move(grp, ElementPlacement.PLACEATEND);
    } else {
        greyCopy = item.duplicate();
        greyCopy = applyOffset(greyCopy, "inwards", widthPt);
        greyCopy.move(grp, ElementPlacement.PLACEATEND);
    }
    setAllStrokes(greyCopy, makeColor(grey, grey, grey));

    // #ccc copy at original position (behind)
    var cccCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(cccCopy, makeColor(204, 204, 204));

    // Stash original
    item.move(grp, ElementPlacement.PLACEATEND);
    item.hidden = true;

    return grp;
}

// ═══════════════════════════════════════════════
//  Groove
//  params: [angle, angle2, chained, thickness_mm, depth]
//
//  Always uses path offset:
//    inward  dist = tan(angle1) * thickness * depth/100
//    outward dist = tan(angle2) * thickness * depth/100
//
//  Group contents:
//    [0] black outward-offset copy (front)
//    [1] grey copy at original position (middle)
//    [2] black inward-offset copy (behind)
//    [3] original (hidden)
// ═══════════════════════════════════════════════

function buildGroove(doc, item, params) {
    var angle1    = parseFloat(params[0]) || 45;
    var angle2    = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var thickness = parseFloat(params[3]) || 5;
    var depth     = parseFloat(params[4]) || 50;

    var inDist  = Math.tan(angle1 * Math.PI / 180) * thickness * PT_PER_MM * (depth / 100);
    var outDist = Math.tan(angle2 * Math.PI / 180) * thickness * PT_PER_MM * (depth / 100);
    var grey    = Math.round(204 * depth / 100);

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black outward-offset copy (front)
    var outCopy = item.duplicate();
    outCopy = applyOffset(outCopy, "outwards", outDist);
    outCopy.move(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(outCopy, makeColor(0, 0, 0));

    // Grey copy at original position (middle)
    var greyCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(greyCopy, makeColor(grey, grey, grey));

    // Black inward-offset copy (behind)
    var inCopy = item.duplicate();
    inCopy = applyOffset(inCopy, "inwards", inDist);
    inCopy.move(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(inCopy, makeColor(0, 0, 0));

    // Stash original
    item.move(grp, ElementPlacement.PLACEATEND);
    item.hidden = true;

    return grp;
}

// ═══════════════════════════════════════════════
//  Revert to straight
// ═══════════════════════════════════════════════

function revertToStraight() {
    try {
        if (app.documents.length === 0) return "No document open.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) return "Nothing selected.";

        var tagged = findTaggedAncestor(sel[0]);
        if (!tagged) return "Not a 5DOF group.";

        var original = unwrapGroup(tagged);
        if (original) {
            doc.selection = [original];
            app.redraw();
            return "Reverted.";
        }
        return "Error: no original found.";
    } catch (e) {
        return "Error: " + e.message;
    }
}

// ═══════════════════════════════════════════════
//  Update a single param on ALL selected tagged groups
//  Each group keeps its own type and other params.
// ═══════════════════════════════════════════════

// Param name → index per type
var PARAM_INDEX = {
    slant:  { angle: 0, mode: 1, thickness: 2 },
    bevel:  { angle: 0, mode: 1, thickness: 2, depth: 3 },
    slider: { angle: 0, angle2: 1, chained: 2, mode: 3, thickness: 4, depth: 5 },
    groove: { angle: 0, angle2: 1, chained: 2, thickness: 3, depth: 4 }
};

function updateParam(paramName, paramValue) {
    try {
        if (app.documents.length === 0) return "No document open.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) return "Nothing selected.";

        // Snapshot the current undo count by doing a trivial change
        // so we can collapse everything into one undo step at the end.
        var undoSteps = 0;

        // Collect unique tagged groups (snapshot references before modifying)
        var seen = {};
        var taggedNotes = [];
        var taggedRefs = [];
        for (var i = 0; i < sel.length; i++) {
            var t = findTaggedAncestor(sel[i]);
            if (t) {
                var key = t.name + "|" + t.note;
                if (!seen[key]) {
                    seen[key] = true;
                    taggedNotes.push(t.note);
                    taggedRefs.push(t);
                }
            }
        }

        if (taggedRefs.length === 0) return "No 5DOF groups selected.";

        // Process each group: unwrap, update param, rebuild
        var results = [];
        for (var g = 0; g < taggedRefs.length; g++) {
            var grpOld = taggedRefs[g];
            var noteData = grpOld.note.substr(SVG5DOF_TAG.length);
            var parts = noteData.split("|");
            var type = parts[0];
            var params = parts.slice(1);

            var idx = PARAM_INDEX[type] ? PARAM_INDEX[type][paramName] : undefined;
            if (idx === undefined) continue;

            params[idx] = String(paramValue);

            var original = unwrapGroup(grpOld);
            if (!original) continue;

            var newParamsStr = params.join("|");
            var newGrp = rebuildJoint(doc, original, type, params);

            if (newGrp) {
                newGrp.note = SVG5DOF_TAG + type + "|" + newParamsStr;
                newGrp.name = "5DOF_" + type;
                results.push(newGrp);
                undoSteps++;
            }
        }

        // Re-select all rebuilt groups
        if (results.length > 0) {
            deselectAll(doc);
            doc.selection = results;
            app.redraw();
        }

        // Collapse extra undo steps: undo all, then redo as one
        if (undoSteps > 1) {
            // Store final state references
            var finalSel = doc.selection;
            // Undo all individual steps
            for (var u = 0; u < undoSteps; u++) {
                app.undo();
            }
            // Redo them all — Illustrator collapses consecutive redos
            for (var r = 0; r < undoSteps; r++) {
                app.redo();
            }
        }

        return "Updated " + results.length + " object(s).";
    } catch (e) {
        return "Error: " + e.message;
    }
}

/**
 * Helper: rebuild a joint from an original item, given type and params array.
 */
function rebuildJoint(doc, item, type, params) {
    if (type === "slant") return buildSlant(doc, item, params);
    if (type === "bevel") return buildBevel(doc, item, params);
    if (type === "slider") return buildSlider(doc, item, params);
    if (type === "groove") return buildGroove(doc, item, params);
    return null;
}

// ═══════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════

/**
 * Apply positional offset based on mode.
 *   translate:  move the copy by (dist, -dist)
 *   outwards:   Illustrator Offset Path by +dist
 *   inwards:    Illustrator Offset Path by -dist
 *
 * For inwards/outwards the item is replaced in-place by the offset result.
 * Returns the (possibly new) item.
 */
function applyOffset(item, mode, dist) {
    if (mode === "translate") {
        item.translate(dist, -dist);
        return item;
    }

    var offsetDist = (mode === "inwards") ? -dist : dist;
    return runOffsetPath(item, offsetDist);
}

/**
 * Diagnostic logger — writes to ~/Desktop/svg5dof_log.txt
 */
function _log(msg) {
    var f = new File(Folder.desktop + "/svg5dof_log.txt");
    f.open("a");
    f.writeln(new Date().toLocaleTimeString() + "  " + msg);
    f.close();
}

/**
 * Run Illustrator's built-in Offset Path on `item` using a live effect
 * + Expand Appearance. No action files needed.
 *
 * Returns the resulting item (may be a new object if Expand replaced it).
 * The source `item` is consumed in the process.
 */
function runOffsetPath(item, dist) {
    var doc = app.activeDocument;

    _log("--- runOffsetPath (live effect) ---");
    _log("item.typename = " + item.typename);
    _log("dist = " + dist);

    // 1) Apply Offset Path as a live effect
    //    jntp: 0=Miter, 1=Round, 2=Bevel
    var xml = '<LiveEffect name="Adobe Offset Path">'
            + '<Dict data="R ofst ' + dist + ' I jntp 2 R mlim 4.0 "/>'
            + '</LiveEffect>';

    try {
        item.applyEffect(xml);
        _log("applyEffect OK");
    } catch (e1) {
        _log("applyEffect FAILED: " + e1.message);
        return item;
    }

    // 2) Select and Expand Appearance to bake the effect into geometry
    doc.selection = null;
    item.selected = true;
    app.redraw();

    try {
        app.executeMenuCommand("expandStyle");
        _log("expandStyle OK");
    } catch (e2) {
        _log("expandStyle FAILED: " + e2.message);
        return item;
    }

    // 3) After expand, the result is selected. Return it as-is
    //    (may be a PathItem or GroupItem — both are fine inside our 5DOF group).
    var sel = doc.selection;
    var result = (sel && sel.length > 0) ? sel[0] : item;
    _log("offsetPath result: " + result.typename);

    // Clean up selection so it doesn't interfere with the caller
    deselectAll(doc);

    return result;
}

/**
 * Unwrap a tagged group: restore the hidden original, delete the rest.
 * Searches recursively for the hidden item (expand can nest groups).
 */
function unwrapGroup(grp) {
    var original = findHidden(grp);

    _log("unwrapGroup: found=" + (original ? original.typename : "NULL") +
         " children=" + grp.pageItems.length);

    if (!original) {
        // Fallback: if no hidden item found, just delete the group entirely
        _log("unwrapGroup: no hidden original found, removing group");
        grp.remove();
        return null;
    }

    original.move(grp, ElementPlacement.PLACEBEFORE);
    original.hidden = false;
    grp.remove();

    return original;
}

function findHidden(container) {
    for (var i = container.pageItems.length - 1; i >= 0; i--) {
        var child = container.pageItems[i];
        if (child.hidden) return child;
        // Search inside nested groups (but not the hidden original's contents)
        if (child.typename === "GroupItem") {
            var found = findHidden(child);
            if (found) return found;
        }
    }
    return null;
}

/**
 * Deselect all items in the document.
 */
function deselectAll(doc) {
    doc.selection = null;
}

/**
 * Recursively set all strokes to the given colour and remove fills.
 */
function setAllStrokes(item, color) {
    if (item.typename === "PathItem") {
        if (item.stroked) item.strokeColor = color;
        item.filled = false;
    } else if (item.typename === "CompoundPathItem") {
        for (var i = 0; i < item.pathItems.length; i++) {
            if (item.pathItems[i].stroked) {
                item.pathItems[i].strokeColor = color;
            }
            item.pathItems[i].filled = false;
        }
    } else if (item.typename === "GroupItem") {
        for (var j = 0; j < item.pageItems.length; j++) {
            setAllStrokes(item.pageItems[j], color);
        }
    }
}

/**
 * Create an RGB colour.
 */
function makeColor(r, g, b) {
    var c = new RGBColor();
    c.red = r;
    c.green = g;
    c.blue = b;
    return c;
}
