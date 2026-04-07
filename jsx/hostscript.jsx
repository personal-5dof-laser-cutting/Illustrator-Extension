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
        var firstType = first.split("|")[0];
        // Check if all selected groups have the same type
        var sameType = true;
        for (var j = 1; j < taggedList.length; j++) {
            if (taggedList[j].note.indexOf(SVG5DOF_TAG + firstType + "|") !== 0) {
                sameType = false;
                break;
            }
        }
        var result2 = (sameType ? "multi:" : "mixed:") + taggedList.length + "|" + first;
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

        // Step 1: Snapshot current selection
        var selectedItems = [];
        for (var s = 0; s < sel.length; s++) {
            selectedItems.push(sel[s]);
        }

        // Step 2: For each selected item, recursively ungroup everything
        var ungroupedItems = [];
        for (var i = 0; i < selectedItems.length; i++) {
            var item = selectedItems[i];
            // First check if it's a tagged group - if so, unwrap it
            var tagged = findTaggedAncestor(item);
            if (tagged) {
                // Check if we've already processed this tagged group
                var alreadyProcessed = false;
                for (var p = 0; p < ungroupedItems.length; p++) {
                    if (ungroupedItems[p] === tagged) {
                        alreadyProcessed = true;
                        break;
                    }
                }
                if (!alreadyProcessed) {
                    var unwrapped = unwrapGroup(tagged);
                    if (unwrapped) {
                        ungroupedItems.push(unwrapped);
                    }
                }
            } else {
                ungroupedItems.push(item);
            }
        }

        // Step 3: Recursively ungroup all items until fully flattened
        var flattenedItems = [];
        for (var u = 0; u < ungroupedItems.length; u++) {
            var recursiveResult = recursiveUngroup(ungroupedItems[u]);
            for (var r = 0; r < recursiveResult.length; r++) {
                flattenedItems.push(recursiveResult[r]);
            }
        }

        // Step 4: Remove all non-black lines from flattened items
        var blackItems = [];
        for (var f = 0; f < flattenedItems.length; f++) {
            if (isBlackLine(flattenedItems[f])) {
                blackItems.push(flattenedItems[f]);
            } else {
                try {
                    flattenedItems[f].remove();
                } catch (e) {}
            }
        }

        if (blackItems.length === 0) return "No black lines to process.";

        // Step 5: Apply tool to each black line
        var params = paramsStr.split("|");
        var results = [];

        // Ensure nothing is selected before we start building
        deselectAll(doc);

        for (var b = 0; b < blackItems.length; b++) {
            var grp = rebuildJoint(doc, blackItems[b], type, params);
            if (grp) {
                grp.note = SVG5DOF_TAG + type + "|" + paramsStr;
                grp.name = "5DOF_" + type;
                results.push(grp);
                // Deselect everything after each rebuild to ensure clean state
                deselectAll(doc);
            }
        }

        // Step 6: Select all created groups at once
        // Build selection array and assign it to doc.selection
        doc.selection = results;
        app.redraw();

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

    // Remove original
    item.remove();

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

    // Remove original
    item.remove();

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
    } else if (mode === "outwards" || mode === "outward") {
        greyCopy = item.duplicate();
        greyCopy = applyOffset(greyCopy, "outward", widthPt);
        greyCopy.move(grp, ElementPlacement.PLACEATEND);
    } else {
        greyCopy = item.duplicate();
        greyCopy = applyOffset(greyCopy, "inward", widthPt);
        greyCopy.move(grp, ElementPlacement.PLACEATEND);
    }
    setAllStrokes(greyCopy, makeColor(grey, grey, grey));

    // #ccc copy at original position (behind)
    var cccCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(cccCopy, makeColor(204, 204, 204));

    // Remove original
    item.remove();

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
    outCopy = applyOffset(outCopy, "outward", outDist);
    outCopy.move(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(outCopy, makeColor(0, 0, 0));

    // Grey copy at original position (middle)
    var greyCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(greyCopy, makeColor(grey, grey, grey));

    // Black inward-offset copy (behind)
    var inCopy = item.duplicate();
    inCopy = applyOffset(inCopy, "inward", inDist);
    inCopy.move(grp, ElementPlacement.PLACEATEND);
    setAllStrokes(inCopy, makeColor(0, 0, 0));

    // Remove original
    item.remove();

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

        var taggedGroups = [];
        var seen = {};
        for (var i = 0; i < sel.length; i++) {
            var t = findTaggedAncestor(sel[i]);
            if (t) {
                var key = t.name + "|" + t.note;
                if (!seen[key]) {
                    seen[key] = true;
                    taggedGroups.push(t);
                }
            }
        }

        if (taggedGroups.length === 0) return "No 5DOF groups selected.";

        var results = [];
        for (var g = 0; g < taggedGroups.length; g++) {
            var original = unwrapGroup(taggedGroups[g]);
            if (original) results.push(original);
        }

        if (results.length > 0) {
            for (var r = 0; r < results.length; r++) {
                results[r].selected = true;
            }
            app.redraw();
            return "Reverted " + results.length + " object(s).";
        }
        return "No originals found.";
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

            // NEW: Even for updates, we ensure the original is cleaned
            var cleanedListU = prepareItem(original);

            var newParamsStr = params.join("|");
            for (var clu = 0; clu < cleanedListU.length; clu++) {
                var newGrp = rebuildJoint(doc, cleanedListU[clu], type, params);
                if (newGrp) {
                    newGrp.note = SVG5DOF_TAG + type + "|" + newParamsStr;
                    newGrp.name = "5DOF_" + type;
                    results.push(newGrp);
                    undoSteps++;
                }
            }
        }

        // Collapse extra undo steps: undo all, then redo as one
        if (undoSteps > 1) {
            // Undo all individual steps
            for (var u = 0; u < undoSteps; u++) {
                app.undo();
            }
            // Redo them all — Illustrator collapses consecutive redos
            for (var r = 0; r < undoSteps; r++) {
                app.redo();
            }
        }

        // Re-select all rebuilt groups (must be done AFTER undo/redo hack)
        // Selection should already be maintained; just ensure all results are selected
        if (results.length > 0) {
            for (var s = 0; s < results.length; s++) {
                results[s].selected = true;
            }
            app.redraw();
        }

        return "Updated " + results.length + " object(s).";
    } catch (e) {
        return "Error: " + e.message;
    }
}

/**
 * NEW: Prepare an item by recursively ungrouping and removing non-black lines.
 */
function prepareItem(item) {
    // a) ungroup recursively
    var unwrapResult = recursiveUngroup(item);
    
    // b) remove all non-black lines
    // After ungrouping, we might have multiple items if it was a group.
    // recursiveUngroup returns an array of base items.
    for (var i = 0; i < unwrapResult.length; i++) {
        removeNonBlackLines(unwrapResult[i]);
    }
    
    // Filter out items that were removed by removeNonBlackLines
    var finalResult = [];
    for (var j = 0; j < unwrapResult.length; j++) {
        try {
            if (unwrapResult[j].typename) {
                finalResult.push(unwrapResult[j]);
            }
        } catch (e) {}
    }
    
    return finalResult;
}

function recursiveUngroup(item) {
    var result = [];

    if (item.typename === "GroupItem") {
        // Collect children first to avoid live iterator issues
        var children = [];
        for (var i = 0; i < item.pageItems.length; i++) {
            children.push(item.pageItems[i]);
        }
        for (var j = 0; j < children.length; j++) {
            var child = children[j];
            child.move(item, ElementPlacement.PLACEBEFORE);
            var subResults = recursiveUngroup(child);
            for (var k = 0; k < subResults.length; k++) {
                result.push(subResults[k]);
            }
        }
        try { item.remove(); } catch (e) {}
    } else {
        result.push(item);
    }
    return result;
}

/**
 * Check if an item is a black line (stroked path/compound path with black stroke)
 */
function isBlackLine(item) {
    try {
        if (!item) return false;

        if (item.typename === "PathItem") {
            if (!item.stroked) return false;
            var c = item.strokeColor;
            if (c.typename === "RGBColor") {
                return (c.red === 0 && c.green === 0 && c.blue === 0);
            } else if (c.typename === "GrayColor") {
                return (c.gray === 100);
            } else if (c.typename === "CMYKColor") {
                return (c.cyan === 0 && c.magenta === 0 && c.yellow === 0 && c.black === 100);
            }
            return false;
        } else if (item.typename === "CompoundPathItem") {
            if (!item.pathItems || item.pathItems.length === 0) return false;
            var p = item.pathItems[0];
            if (!p.stroked) return false;
            var cc = p.strokeColor;
            if (cc.typename === "RGBColor") {
                return (cc.red === 0 && cc.green === 0 && cc.blue === 0);
            } else if (cc.typename === "GrayColor") {
                return (cc.gray === 100);
            } else if (cc.typename === "CMYKColor") {
                return (cc.cyan === 0 && cc.magenta === 0 && cc.yellow === 0 && cc.black === 100);
            }
            return false;
        }
        return false;
    } catch (e) {
        return false;
    }
}

function removeNonBlackLines(item) {
    try {
        if (!item) return;
        if (item.typename === "PathItem") {
            if (item.stroked) {
                var c = item.strokeColor;
                var isBlack = false;
                if (c.typename === "RGBColor") {
                    isBlack = (c.red === 0 && c.green === 0 && c.blue === 0);
                } else if (c.typename === "GrayColor") {
                    isBlack = (c.gray === 100);
                } else if (c.typename === "CMYKColor") {
                    // Check for standard CMYK black or Rich Black
                    // In many cases, we just want K=100
                    isBlack = (c.cyan === 0 && c.magenta === 0 && c.yellow === 0 && c.black === 100);
                    // Also accept rich black if it's very dark? No, keep it simple.
                }
                
                if (!isBlack) {
                    item.remove();
                    return;
                }
            }
        } else if (item.typename === "CompoundPathItem") {
            var isBlackComp = true;
            if (item.pathItems && item.pathItems.length > 0) {
                var p = item.pathItems[0];
                if (p.stroked) {
                    var cc = p.strokeColor;
                    if (cc.typename === "RGBColor") {
                        if (cc.red !== 0 || cc.green !== 0 || cc.blue !== 0) isBlackComp = false;
                    } else if (cc.typename === "GrayColor") {
                        if (cc.gray !== 100) isBlackComp = false;
                    } else if (cc.typename === "CMYKColor") {
                        if (cc.cyan !== 0 || cc.magenta !== 0 || cc.yellow !== 0 || cc.black !== 100) isBlackComp = false;
                    } else {
                        isBlackComp = false;
                    }
                }
            }
            if (!isBlackComp) item.remove();
        }
    } catch (e) {
        _log("Error in removeNonBlackLines: " + e.message);
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

    var offsetDist = (mode === "inwards" || mode === "inward") ? -dist : dist;
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
 * Unwrap a tagged group: recursively ungroup all children and keep only black lines.
 * Since we no longer stash hidden originals, we extract all black lines from the group.
 */
function unwrapGroup(grp) {
    _log("unwrapGroup: children=" + grp.pageItems.length);

    // Collect all children first
    var children = [];
    for (var i = 0; i < grp.pageItems.length; i++) {
        children.push(grp.pageItems[i]);
    }

    // Move all children out of the group
    for (var j = 0; j < children.length; j++) {
        children[j].move(grp, ElementPlacement.PLACEBEFORE);
    }

    // Remove the empty group
    grp.remove();

    // Now recursively ungroup all children and filter to black lines only
    var allFlattened = [];
    for (var k = 0; k < children.length; k++) {
        var flattened = recursiveUngroup(children[k]);
        for (var f = 0; f < flattened.length; f++) {
            allFlattened.push(flattened[f]);
        }
    }

    // Delete non-black lines
    var blackOnly = [];
    for (var b = 0; b < allFlattened.length; b++) {
        if (isBlackLine(allFlattened[b])) {
            blackOnly.push(allFlattened[b]);
        } else {
            try {
                allFlattened[b].remove();
            } catch (e) {}
        }
    }

    // Return the first black line (or null if none found)
    return blackOnly.length > 0 ? blackOnly[0] : null;
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
