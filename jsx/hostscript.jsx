/**
 * ExtendScript for Adobe Illustrator — SVG 5DOF joint operations.
 *
 * checkSelection()              — returns selection state string for the panel.
 * applyJoint(type, paramsStr, compatibilityMode)   — wraps selected item in a tagged group.
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
            if ("normal" !== _lastCheckLog) {
                _log("checkSel → normal");
                _lastCheckLog = "normal";
            }
            return "normal";
        }

        if (taggedList.length === 1) {
            var result = "tagged:" + taggedList[0].note.substr(SVG5DOF_TAG.length);
            if (result !== _lastCheckLog) {
                _log("checkSel → " + result);
                _lastCheckLog = result;
            }
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
        if (result2 !== _lastCheckLog) {
            _log("checkSel → " + result2);
            _lastCheckLog = result2;
        }
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
        if (candidate.typename === "GroupItem" && candidate.note && candidate.note.indexOf(SVG5DOF_TAG) === 0) {
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

function applyJoint(type, paramsStr, compatibilityMode) {
    try {
        _log("Applying joint")
        if (app.documents.length === 0) return "No document open.";
        var doc = app.activeDocument;
        var sel = doc.selection;
        if (!sel || sel.length === 0) return "Nothing selected.";

        // Step 1: Snapshot current selection AND per-point selection states
        // We store snapshots alongside original item references so we can look
        // them up later after ungroup/flatten (items that survive unchanged keep
        // the same reference; unwrapped items from tagged groups won't match and
        // will be treated as fully selected).
        var selectedItems = [];
        var selSnapshots = [];   // parallel array of {points: [...]} or null
        for (var s = 0; s < sel.length; s++) {
            selectedItems.push(sel[s]);
            selSnapshots.push(snapshotPointSelection(sel[s]));
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

        // Step 4: Accept stroked paths of any color. Unrelated artwork is
        // skipped, never deleted just because it cannot become an edge profile.
        var edgeItems = [];
        for (var f = 0; f < flattenedItems.length; f++) {
            if (isStrokedPath(flattenedItems[f])) {
                edgeItems.push(flattenedItems[f]);
            }
        }

        if (edgeItems.length === 0) return "No stroked paths to process.";

        // Step 5: Apply the tool to each edge
        var params = paramsStr.split("|");
        var results = [];

        // Ensure nothing is selected before we start building
        deselectAll(doc);

        for (var b = 0; b < edgeItems.length; b++) {
            // Look up per-point selection snapshot for this item
            var ptSnap = null;
            for (var si = 0; si < selectedItems.length; si++) {
                if (selectedItems[si] === edgeItems[b]) {
                    ptSnap = selSnapshots[si];
                    break;
                }
            }
            var grp = rebuildJoint(doc, edgeItems[b], type, params, ptSnap, compatibilityMode);
            if (grp) {
                grp.note = SVG5DOF_TAG + type + "|" + paramsStr;
                grp.name = "5DOF_" + type;
                results.push(grp);
                // Deselect everything after each rebuild to ensure clean state
                deselectAll(doc);
            }
        }

        // Step 5.5: Post-process to align grey lines where black lines meet
        if (results.length > 1) {
            postProcessGreyLines(results);
        }

        // Step 6: Select all created groups at once
        // Build selection array and assign it to doc.selection
        doc.selection = results;
        app.redraw();

        return type.charAt(0).toUpperCase() + type.slice(1) + " applied to " + results.length + " object(s).";

    } catch (e) {
        return "Error: " + e.message;
    }
}

// ═══════════════════════════════════════════════
//  Post-processing: Align grey lines where black lines meet
// ═══════════════════════════════════════════════

/**
 * Post-process groups to make grey lines meet when black lines meet.
 * For each pair of groups, find intersection points between their black lines,
 * then extend/shorten the grey lines to meet at those same points.
 */
function postProcessGreyLines(groups) {

}

// ═══════════════════════════════════════════════
//  Slant
//  params: [angle, mode, thickness_mm, depth, direction]
// ═══════════════════════════════════════════════

function buildSlant(doc, item, params, pointSelSnapshot, compatibilityMode) {
    var angle = parseFloat(params[0]) || 45;
    var mode = params[1] || "translate";
    var thickness = parseFloat(params[2]) || 5;
    var depth = (parseFloat(params[3]) || 100) / 100;
    var direction = parseFloat(params[4]) || 0;

    var dist = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;
    var depth_frac = depth; // Value between 0 and 1, 1 indicating 100% cut

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    try {
        // Grey copy (behind) — offset along the normal of the path
        var grey = item.duplicate();  // duplicate at document level for Offset Path
        grey = applyOffset(grey, mode, dist, direction, pointSelSnapshot);
        grey.move(grp, ElementPlacement.PLACEATEND);
        setDepth(grey, depth_frac, compatibilityMode);

        // front (copy of original)
        var front_line = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
        setDepth(front_line, 0, compatibilityMode);

        // Remove original
        item.remove();

        return grp;
    } catch (e) {
        grp.remove();
        throw e;
    }
}

// ═══════════════════════════════════════════════
//  Bevel
//  params: [angle, mode, thickness_mm, depth, direction]
// ═══════════════════════════════════════════════

function buildBevel(doc, item, params, pointSelSnapshot, compatibilityMode) {
    var angle = parseFloat(params[0]) || 45;
    var mode = params[1] || "inwards";
    var thickness = parseFloat(params[2]) || 5;
    var depth = (parseFloat(params[3]) || 50) / 100;
    var direction = parseFloat(params[4]) || 0;

    var dist = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    try {
        // Black copy at original position (front)
        var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
        setDepth(blackCopy, 0, compatibilityMode);

        // #ccc copy at offset position (behind)
        var cccCopy = item.duplicate();
        cccCopy = applyOffset(cccCopy, mode, dist, direction, pointSelSnapshot);
        cccCopy.move(grp, ElementPlacement.PLACEATEND);
        setDepth(cccCopy, 1, compatibilityMode);

        // copy at same offset position (in front of #ccc)
        // Marks the boundary: slanted (black→grey) vs vertical (grey→#ccc)
        var depthCopy = item.duplicate();
        depthCopy = applyOffset(depthCopy, mode, dist, direction, pointSelSnapshot);
        depthCopy.move(grp, ElementPlacement.PLACEATEND);
        setDepth(depthCopy, depth, compatibilityMode);

        // Remove original
        item.remove();

        return grp;
    } catch (e) {
        grp.remove();
        throw e;
    }
}

// ═══════════════════════════════════════════════
//  Slider
//  params: [angle, angle2, chained, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildSlider(doc, item, params, pointSelSnapshot, compatibilityMode) {
    var angle = parseFloat(params[0]) || 45;
    var angle2 = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var mode = params[3] || "inwards";
    var thickness = parseFloat(params[4]) || 5;
    var direction = parseFloat(params[5]) || 0;

    var widthPt = thickness * PT_PER_MM;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    try {
        // Black copy at original position (front)
        var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
        setDepth(blackCopy, 0, compatibilityMode)

        // Grey copy — inset/outset/translated (middle)
        const TO_RAD = Math.PI / 180
        var off_unscaled = Math.sin(TO_RAD * angle) * Math.sin(TO_RAD * angle2) / Math.sin(TO_RAD * (180 - (angle + angle2)))
        var off_px = off_unscaled * widthPt;
        var off_mm = off_unscaled * thickness;
        var line_depth_frac = (off_mm * Math.sin(TO_RAD * (90 - angle)) / Math.sin(TO_RAD * angle)) / thickness;

        var greyCopy = item.duplicate();
        greyCopy = applyOffset(greyCopy, mode, off_px, direction, pointSelSnapshot);
        greyCopy.move(grp, ElementPlacement.PLACEATEND);
        setDepth(greyCopy, line_depth_frac, compatibilityMode)

        // copy at original position (behind)
        var originalLine = item.duplicate(grp, ElementPlacement.PLACEATEND);
        setDepth(originalLine, 1, compatibilityMode)

        // Remove original
        item.remove();

        return grp;
    } catch (e) {
        grp.remove();
        throw e;
    }
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

function buildGroove(doc, item, params, pointSelSnapshot, compatibilityMode) {
    var angle1 = parseFloat(params[0]) || 45;
    var angle2 = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var thickness = parseFloat(params[3]) || 5;
    var depth = (parseFloat(params[4]) || 50) / 100;

    var inDist = Math.tan(angle1 * Math.PI / 180) * thickness * PT_PER_MM * depth;
    var outDist = Math.tan(angle2 * Math.PI / 180) * thickness * PT_PER_MM * depth;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    try {
        // Black outward-offset copy (front)
        var outCopy = item.duplicate();
        outCopy = applyOffset(outCopy, "outward", outDist, null, pointSelSnapshot);
        outCopy.move(grp, ElementPlacement.PLACEATEND);
        setDepth(outCopy, 0, compatibilityMode);

        // Grey copy at original position (middle)
        var greyCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
        setDepth(greyCopy, depth, compatibilityMode);

        // Black inward-offset copy (behind)
        var inCopy = item.duplicate();
        inCopy = applyOffset(inCopy, "inward", inDist, null, pointSelSnapshot);
        inCopy.move(grp, ElementPlacement.PLACEATEND);
        setDepth(inCopy, 0, compatibilityMode);

        // Remove original
        item.remove();

        return grp;
    } catch (e) {
        grp.remove();
        throw e;
    }
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
        try {
            item.remove();
        } catch (e) {
        }
    } else {
        result.push(item);
    }
    return result;
}

/**
 * A source edge is a stroked path, regardless of its color or color space.
 */
function isStrokedPath(item) {
    if (!item) return false;
    if (item.typename === "PathItem") return item.stroked && !item.guides && !item.clipping;
    if (item.typename === "CompoundPathItem") {
        for (var i = 0; i < item.pathItems.length; i++) {
            if (isStrokedPath(item.pathItems[i])) return true;
        }
    }
    return false;
}

/**
 * Check if an item is an "original" line — a depth-0 front line or a raw
 * user-drawn line that has never been processed.
 *
 * Returns true for items whose note contains 'depth-0.000%' (set by setDepth)
 * or items with no depth class in their note at all (raw lines).
 * Returns false for items tagged with a non-zero depth class (blurred copies).
 */
function isOriginalLine(item) {
    try {
        var note = "";
        if (item.typename === "PathItem" || item.typename === "CompoundPathItem") {
            note = item.note || "";
        } else {
            return false;
        }
        // If the note contains a depth class that is NOT depth-0, it's a copy
        if (note.indexOf("depth-") !== -1 && note.indexOf("depth-0.000%") === -1) {
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Helper: rebuild a joint from an original item, given type and params array.
 * pointSelSnapshot is an optional array of per-point selection states (from snapshotPointSelection).
 */
function rebuildJoint(doc, item, type, params, pointSelSnapshot, compatibilityMode) {
    if (type === "slant") return buildSlant(doc, item, params, pointSelSnapshot, compatibilityMode);
    if (type === "bevel") return buildBevel(doc, item, params, pointSelSnapshot, compatibilityMode);
    if (type === "slider") return buildSlider(doc, item, params, pointSelSnapshot, compatibilityMode);
    if (type === "groove") return buildGroove(doc, item, params, pointSelSnapshot, compatibilityMode);
    return null;
}

// ═══════════════════════════════════════════════
//  Helpers
// ═══════════════════════════════════════════════

/**
 * Calculate the normal (perpendicular) direction of a path.
 * Returns a normalized vector {x, y} pointing perpendicular to the path direction.
 * For horizontal lines: normal points up (0, 1)
 * For vertical lines: normal points right (1, 0)
 */
function calculatePathNormal(item) {
    try {
        var pathPoints = null;
        if (item.typename === "PathItem") {
            pathPoints = item.pathPoints;
        } else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
            pathPoints = item.pathItems[0].pathPoints;
        }

        if (!pathPoints || pathPoints.length < 2) return null;

        // Get first two points to determine direction
        var p1 = pathPoints[0].anchor;
        var p2 = pathPoints[1].anchor;

        // Calculate direction vector
        var dx = p2[0] - p1[0];
        var dy = p2[1] - p1[1];

        // Calculate length
        var length = Math.sqrt(dx * dx + dy * dy);
        if (length < 0.001) return null; // Too short to determine direction

        // Normalize direction vector
        dx /= length;
        dy /= length;

        // Calculate normal (perpendicular) by rotating 90 degrees counter-clockwise
        // (dx, dy) -> (-dy, dx)
        var normalX = -dy;
        var normalY = dx;

        // Normalize the normal to point right or up
        // If the path is more horizontal (|dx| > |dy|), ensure normal points up (normalY > 0)
        // If the path is more vertical (|dy| > |dx|), ensure normal points right (normalX > 0)
        if (Math.abs(dx) > Math.abs(dy)) {
            // More horizontal - ensure normal points up
            if (normalY < 0) {
                normalX = -normalX;
                normalY = -normalY;
            }
        } else {
            // More vertical - ensure normal points right
            if (normalX < 0) {
                normalX = -normalX;
                normalY = -normalY;
            }
        }


        return {x: normalX, y: normalY};
    } catch (e) {
        _log("calculatePathNormal error: " + e.message);
        return null;
    }
}

function directionToNormal(direction) {
    const radians = direction * Math.PI / 180;

    return {
        x: Math.cos(radians),
        y: Math.sin(radians)
    };
}

// ═══════════════════════════════════════════════
//  Per-point selection snapshot & partial offset
// ═══════════════════════════════════════════════

/**
 * Snapshot the per-point selection state of an item.
 * Returns an array of booleans (true = selected) for each pathPoint,
 * or null if the item is not a PathItem / has no points.
 *
 * A point counts as "selected" if its PathPointSelection is anything
 * other than NOSELECTION.
 */
function snapshotPointSelection(item) {
    var pp = null;
    if (item.typename === "PathItem") {
        pp = item.pathPoints;
    } else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
        pp = item.pathItems[0].pathPoints;
    }
    if (!pp || pp.length === 0) return null;

    var result = [];
    for (var i = 0; i < pp.length; i++) {
        result.push(pp[i].selected !== PathPointSelection.NOSELECTION);
    }
    return result;
}

/**
 * Check if a snapshot represents a *partial* selection on a closed path:
 * at least one point selected AND at least one point not selected.
 * Returns false for open paths, null snapshots, or all/none selected.
 */
function hasPartialSelection(item, snapshot) {
    if (!snapshot) return false;
    // Must be a closed path
    if (item.typename === "PathItem" && !item.closed) return false;
    if (item.typename === "CompoundPathItem") {
        if (item.pathItems.length === 0 || !item.pathItems[0].closed) return false;
    }

    var hasSel = false, hasUnsel = false;
    for (var i = 0; i < snapshot.length; i++) {
        if (snapshot[i]) hasSel = true;
        else hasUnsel = true;
        if (hasSel && hasUnsel) return true;
    }
    return false;
}

/**
 * Determine if a segment between point i and point i+1 (wrapping for closed paths)
 * is "selected" — i.e. both endpoints are selected.
 */
function isSegmentSelected(snapshot, i, n) {
    var j = (i + 1) % n;
    return snapshot[i] && snapshot[j];
}

/**
 * Compute the perpendicular normal of the segment from p1 to p2.
 * Returns a normalized {x, y} vector. The normal is rotated 90° CCW
 * from the segment direction (consistent with Illustrator's coordinate
 * system where Y points down in screen but up in AI coords).
 */
function segmentNormal(p1, p2) {
    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) return {x: 0, y: 1};
    // Normal perpendicular: rotate direction 90° CCW → (-dy, dx)
    return {x: -dy / len, y: dx / len};
}

/**
 * Intersect two infinite lines, each defined by a point and a direction vector.
 * Line 1: p1 + t * d1
 * Line 2: p2 + t * d2
 * Returns the intersection point [x, y], or null if parallel.
 */
function lineLineIntersect(p1, d1, p2, d2) {
    var cross = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(cross) < 1e-10) return null; // parallel
    var dx = p2[0] - p1[0];
    var dy = p2[1] - p1[1];
    var t = (dx * d2[1] - dy * d2[0]) / cross;
    return [p1[0] + t * d1[0], p1[1] + t * d1[1]];
}

/**
 * Partially offset a closed polyline (straight segments only).
 *
 * Selected segments are moved by `dist` along their outward normal.
 * Non-selected segments stay in place but are extended/trimmed so the
 * path remains closed.
 *
 * `snapshot` is the boolean array from snapshotPointSelection().
 * `dist` is signed: positive = outward, negative = inward.
 *
 * The item is mutated in place and returned.
 */
function partialOffsetClosedPath(item, dist, snapshot) {
    var path;
    if (item.typename === "PathItem") {
        path = item;
    } else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
        path = item.pathItems[0];
    } else {
        return item;
    }

    var pp = path.pathPoints;
    var n = pp.length;
    if (n < 3) return item;

    // Build array of original anchor positions
    var orig = [];
    for (var i = 0; i < n; i++) {
        orig.push([pp[i].anchor[0], pp[i].anchor[1]]);
    }

    // For each segment, decide if it's selected (both endpoints selected)
    var segSel = [];
    for (var s = 0; s < n; s++) {
        segSel.push(isSegmentSelected(snapshot, s, n));
    }

    // Compute the offset line for each segment:
    //   - selected segments: shifted by dist along the segment normal
    //   - non-selected segments: stay at original position
    // Each segment i goes from orig[i] to orig[(i+1)%n].
    // We store each as {p: point-on-line, d: direction-vector}.
    var segLines = [];
    for (var si = 0; si < n; si++) {
        var i0 = si;
        var i1 = (si + 1) % n;
        var dx = orig[i1][0] - orig[i0][0];
        var dy = orig[i1][1] - orig[i0][1];
        if (segSel[si]) {
            var norm = segmentNormal(orig[i0], orig[i1]);
            var shiftedP = [orig[i0][0] + norm.x * dist, orig[i0][1] + norm.y * dist];
            segLines.push({p: shiftedP, d: [dx, dy]});
        } else {
            segLines.push({p: [orig[i0][0], orig[i0][1]], d: [dx, dy]});
        }
    }

    // Compute new vertices: each vertex i is the intersection of
    // segment (i-1) and segment i.
    var newPts = [];
    for (var vi = 0; vi < n; vi++) {
        var prevSeg = (vi - 1 + n) % n;
        var curSeg = vi;
        var pt = lineLineIntersect(
            segLines[prevSeg].p, segLines[prevSeg].d,
            segLines[curSeg].p, segLines[curSeg].d
        );
        if (pt) {
            newPts.push(pt);
        } else {
            // Parallel segments (shouldn't happen in well-formed polygons)
            // — fall back to shifted original point
            if (segSel[curSeg]) {
                var norm2 = segmentNormal(orig[curSeg], orig[(curSeg + 1) % n]);
                newPts.push([orig[vi][0] + norm2.x * dist, orig[vi][1] + norm2.y * dist]);
            } else {
                newPts.push([orig[vi][0], orig[vi][1]]);
            }
        }
    }

    // Apply new positions to path points (straight segments: handles = anchor)
    for (var ai = 0; ai < n; ai++) {
        pp[ai].anchor = newPts[ai];
        pp[ai].leftDirection = newPts[ai];
        pp[ai].rightDirection = newPts[ai];
    }

    return item;
}

/**
 * Check whether an item is an open path (a line, not a closed shape).
 * Returns true for open PathItems and CompoundPathItems whose first sub-path is open.
 */
function isOpenPath(item) {
    if (item.typename === "PathItem") {
        return !item.closed;
    }
    if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
        return !item.pathItems[0].closed;
    }
    return false;
}

/**
 * Extend (or shorten) an open-path line along its own direction.
 *   dist > 0 → each endpoint moves outward by dist (line grows by 2*dist).
 *   dist < 0 → each endpoint moves inward by |dist| (line shrinks by 2*|dist|).
 *
 * Works on both PathItem and CompoundPathItem (operates on every sub-path).
 * Returns the same item (mutated in place).
 */
function extendLine(item, dist) {
    var paths = [];
    if (item.typename === "PathItem") {
        paths.push(item);
    } else if (item.typename === "CompoundPathItem") {
        for (var i = 0; i < item.pathItems.length; i++) {
            paths.push(item.pathItems[i]);
        }
    }

    for (var p = 0; p < paths.length; p++) {
        var pp = paths[p].pathPoints;
        if (pp.length < 2) continue;

        // --- First endpoint: extend away from second point ---
        var a0 = pp[0].anchor;
        var a1 = pp[1].anchor;
        var dx0 = a0[0] - a1[0];
        var dy0 = a0[1] - a1[1];
        var len0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
        if (len0 > 0.001) {
            var ux0 = dx0 / len0;
            var uy0 = dy0 / len0;
            pp[0].anchor = [a0[0] + ux0 * dist, a0[1] + uy0 * dist];
            // Move control handles by the same amount to preserve curvature
            var ld0 = pp[0].leftDirection;
            var rd0 = pp[0].rightDirection;
            pp[0].leftDirection  = [ld0[0] + ux0 * dist, ld0[1] + uy0 * dist];
            pp[0].rightDirection = [rd0[0] + ux0 * dist, rd0[1] + uy0 * dist];
        }

        // --- Last endpoint: extend away from second-to-last point ---
        var last = pp.length - 1;
        var aL = pp[last].anchor;
        var aP = pp[last - 1].anchor;
        var dxL = aL[0] - aP[0];
        var dyL = aL[1] - aP[1];
        var lenL = Math.sqrt(dxL * dxL + dyL * dyL);
        if (lenL > 0.001) {
            var uxL = dxL / lenL;
            var uyL = dyL / lenL;
            pp[last].anchor = [aL[0] + uxL * dist, aL[1] + uyL * dist];
            var ldL = pp[last].leftDirection;
            var rdL = pp[last].rightDirection;
            pp[last].leftDirection  = [ldL[0] + uxL * dist, ldL[1] + uyL * dist];
            pp[last].rightDirection = [rdL[0] + uxL * dist, rdL[1] + uyL * dist];
        }
    }

    return item;
}

/**
 * Apply positional offset based on mode.
 *   translate:  move the copy by (dist, dist) in direction of normal
 *   outwards:   Illustrator Offset Path by +dist  (or extend line for open paths)
 *   inwards:    Illustrator Offset Path by -dist  (or shorten line for open paths)
 *
 * For open paths (lines) in inward/outward mode, the line is extended or
 * shortened along its own direction instead of creating parallel offset paths.
 *
 * For closed paths with partial point selection (Direct Selection tool),
 * only the selected segments are offset; non-selected segments extend/trim
 * to keep the path closed.
 *
 * For inwards/outwards the item is replaced in-place by the offset result.
 * Returns the (possibly new) item.
 *
 * pointSelSnapshot is an optional array of per-point booleans from
 * snapshotPointSelection(), or null/undefined for full-path behaviour.
 */
function applyOffset(item, mode, dist, direction, pointSelSnapshot) {
    if (mode === "translate") {
        var normal;
        if (!direction)
            normal = calculatePathNormal(item);
        else normal = directionToNormal(direction);
        item.translate(normal.x * dist, normal.y * dist);
        return item;
    }

    // For open paths (lines): extend/shorten along line direction
    if (isOpenPath(item)) {
        var lineDist = (mode === "inwards" || mode === "inward") ? -dist : dist;
        return extendLine(item, lineDist);
    }

    // For closed paths with partial selection: offset only selected segments
    if (hasPartialSelection(item, pointSelSnapshot)) {
        var partialDist = (mode === "inwards" || mode === "inward") ? -dist : dist;
        return partialOffsetClosedPath(item, partialDist, pointSelSnapshot);
    }

    // For closed paths (fully selected or no snapshot): use Illustrator Offset Path as before
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
    var xml = '<LiveEffect name="Adobe Offset Path">' + '<Dict data="R ofst ' + dist + ' I jntp 2 R mlim 4.0 "/>' + '</LiveEffect>';

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

    // Now recursively ungroup all children and filter to original (depth-0) lines only
    var allFlattened = [];
    for (var k = 0; k < children.length; k++) {
        var flattened = recursiveUngroup(children[k]);
        for (var f = 0; f < flattened.length; f++) {
            allFlattened.push(flattened[f]);
        }
    }

    // Delete non-original lines (blurred depth copies)
    var originals = [];
    for (var b = 0; b < allFlattened.length; b++) {
        if (isOriginalLine(allFlattened[b])) {
            originals.push(allFlattened[b]);
        } else {
            try {
                allFlattened[b].remove();
            } catch (e) {
            }
        }
    }

    // Return the first original line (or null if none found)
    // Clear the depth note so it behaves as a fresh line for reprocessing
    if (originals.length > 0) {
        try { originals[0].note = ""; } catch (e) {}
        return originals[0];
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
function setAllStrokes(item, color, widthScale) {
    if (widthScale === undefined) widthScale = 1;
    if (item.typename === "PathItem") {
        if (item.stroked) {
            item.strokeColor = color;
            item.strokeWidth *= widthScale;
        }
        item.filled = false;
    } else if (item.typename === "CompoundPathItem") {
        // Compound paths can share appearance: snapshot widths before changing any.
        var widths = [];
        for (var p = 0; p < item.pathItems.length; p++) widths.push(item.pathItems[p].strokeWidth);
        for (var i = 0; i < item.pathItems.length; i++) {
            if (item.pathItems[i].stroked) {
                item.pathItems[i].strokeColor = color;
                item.pathItems[i].strokeWidth = widths[i] * widthScale;
            }
            item.pathItems[i].filled = false;
        }
    } else if (item.typename === "GroupItem") {
        for (var j = 0; j < item.pageItems.length; j++) {
            setAllStrokes(item.pageItems[j], color, widthScale);
        }
    }
}

function setDepth(item, depth_frac, compatibilityMode) {
    // SVG5DOF compatibility: darkness = 100% - 80% * depth.
    // Default to compatibility mode even for callers without the new argument.
    var compatible = compatibilityMode !== false;
    setAllStrokes(item, compatible ? makeDepthColor(depth_frac) : makeColor(0, 0, 0),
                  compatible ? 1 + depth_frac : 1);
    if (!compatible && depth_frac > 0) {
        applyBlur(item, depth_frac * 3.0);
    }
    // Notes are internal metadata for revert/rebuild, not exported SVG classes.
    setCSSClass(item, "depth-" + (depth_frac * 100).toFixed(3) + "%");
    return item;
}

/**
 * Apply a Gaussian Blur live effect to an item.
 * The blur remains as a non-destructive appearance effect.
 */
function applyBlur(item, radiusPx) {
    var xml = '<LiveEffect name="Adobe PSL Gaussian Blur">'
            + '<Dict data="R GBRd ' + radiusPx + ' "/>'
            + '</LiveEffect>';
    try {
        item.applyEffect(xml);
        _log("applyBlur " + radiusPx + "px OK");
    } catch (e) {
        _log("applyBlur FAILED: " + e.message);
    }
}

function makeDepthColor(depth_frac) {
    var grey = 204 * depth_frac;
    return makeColor(grey, grey, grey);
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

/**
 * Set a CSS class attribute on a path item.
 * In Illustrator, we store this in the item's note property as a CSS class.
 */
function setCSSClass(item, className) {
    try {
        if (item.typename === "PathItem") {
            item.note = "class=\"" + className + "\"";
            _log("Set CSS class on PathItem: " + className);
        } else if (item.typename === "CompoundPathItem") {
            item.note = "class=\"" + className + "\"";
            _log("Set CSS class on CompoundPathItem: " + className);
        } else if (item.typename === "GroupItem") {
            // For groups, set it on all child paths
            for (var i = 0; i < item.pageItems.length; i++) {
                setCSSClass(item.pageItems[i], className);
            }
        }
    } catch (e) {
        _log("setCSSClass error: " + e.message);
    }
}
