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
                } catch (e) {
                }
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
    try {
        _log("postProcessGreyLines: processing " + groups.length + " groups");

        // For each pair of groups
        for (var i = 0; i < groups.length; i++) {
            for (var j = i + 1; j < groups.length; j++) {
                var grp1 = groups[i];
                var grp2 = groups[j];

                // Extract black and grey lines from each group
                var lines1 = extractLinesFromGroup(grp1);
                var lines2 = extractLinesFromGroup(grp2);

                if (!lines1.black || !lines2.black) continue;

                // Find intersection points between black lines
                var intersections = [];
                for (var b1 = 0; b1 < lines1.black.length; b1++) {
                    for (var b2 = 0; b2 < lines2.black.length; b2++) {
                        var pts = findPathIntersections(lines1.black[b1], lines2.black[b2]);
                        if (pts && pts.length > 0) {
                            for (var p = 0; p < pts.length; p++) {
                                intersections.push(pts[p]);
                            }
                        }
                    }
                }

                if (intersections.length > 0) {
                    _log("Found " + intersections.length + " intersection(s) between groups");

                    // For each grey line in both groups, extend/shorten to meet at intersections
                    if (lines1.grey.length > 0 && lines2.grey.length > 0) {
                        alignGreyLines(lines1.grey, lines2.grey, intersections);
                    }
                }
            }
        }
    } catch (e) {
        _log("postProcessGreyLines error: " + e.message);
    }
}

/**
 * Extract black and grey lines from a group.
 * Returns {black: [PathItems], grey: [PathItems]}
 */
function extractLinesFromGroup(grp) {
    var blackLines = [];
    var greyLines = [];

    for (var i = 0; i < grp.pageItems.length; i++) {
        var item = grp.pageItems[i];
        if (isBlackLine(item)) {
            blackLines.push(item);
        } else if (item.typename === "GroupItem") {
            // Handle nested groups (from offset path expansion)
            var nested = extractLinesFromGroup(item);
            blackLines.push(nested.black);
            greyLines = greyLines.push(nested.grey);
        } else {
            greyLines.push(item);
        }
    }

    return {black: blackLines, grey: greyLines};
}

/**
 * Find intersection points between two paths.
 * Returns array of {x, y} points.
 */
function findPathIntersections(path1, path2) {
    var intersections = [];

    try {
        // Get path points
        var points1 = getPathEndpoints(path1);
        var points2 = getPathEndpoints(path2);

        if (!points1 || !points2) {
            _log("findPathIntersections: Could not get endpoints");
            return intersections;
        }

        // Check if endpoints are very close (within tolerance)
        var tolerance = 2.0; // Increased tolerance (about 0.7mm)

        var endpoints = [{p1: points1.start, p2: points2.start, name: "start-start"}, {
            p1: points1.start,
            p2: points2.end,
            name: "start-end"
        }, {p1: points1.end, p2: points2.start, name: "end-start"}, {
            p1: points1.end,
            p2: points2.end,
            name: "end-end"
        }];

        for (var i = 0; i < endpoints.length; i++) {
            var ep = endpoints[i];
            var dx = ep.p1.x - ep.p2.x;
            var dy = ep.p1.y - ep.p2.y;
            var dist = Math.sqrt(dx * dx + dy * dy);

            _log("Checking " + ep.name + ": dist=" + dist.toFixed(2));

            if (dist < tolerance) {
                // Found an intersection
                var avgX = (ep.p1.x + ep.p2.x) / 2;
                var avgY = (ep.p1.y + ep.p2.y) / 2;
                _log("Found intersection at (" + avgX.toFixed(2) + ", " + avgY.toFixed(2) + ")");
                intersections.push({x: avgX, y: avgY, endpoint1: ep.p1, endpoint2: ep.p2});
            }
        }
    } catch (e) {
        _log("findPathIntersections error: " + e.message);
    }

    return intersections;
}

/**
 * Get the start and end points of a path.
 */
function getPathEndpoints(item) {
    try {
        if (item.typename === "PathItem") {
            if (item.pathPoints.length >= 2) {
                var start = item.pathPoints[0].anchor;
                var end = item.pathPoints[item.pathPoints.length - 1].anchor;
                return {start: {x: start[0], y: start[1]}, end: {x: end[0], y: end[1]}};
            }
        } else if (item.typename === "CompoundPathItem") {
            if (item.pathItems.length > 0) {
                return getPathEndpoints(item.pathItems[0]);
            }
        }
    } catch (e) {
        _log("getPathEndpoints error: " + e.message);
    }
    return null;
}

function areAligned(line1, line2) {
    try {
        var tolerance = 0.5; // Default tolerance in points (~0.15mm)

        var points1 = getPathEndpoints(line1);
        var points2 = getPathEndpoints(line2);

        if (!points1 || !points2) {
            return false;
        }

        // Check all four endpoint combinations
        var endpoints = [
            {p1: points1.start, p2: points2.start},
            {p1: points1.start, p2: points2.end},
            {p1: points1.end, p2: points2.start},
            {p1: points1.end, p2: points2.end}
        ];

        for (var i = 0; i < endpoints.length; i++) {
            var ep = endpoints[i];
            var dx = ep.p1.x - ep.p2.x;
            var dy = ep.p1.y - ep.p2.y;
            var dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < tolerance) {
                return true;
            }
        }

        return false;
    } catch (e) {
        _log("areAligned error: " + e.message);
        return false;
    }
}

/**
 * Align grey lines to meet at intersection points.
 * Extends or shortens grey lines along their own direction so they meet.
 */
function alignGreyLines(greyLines1, greyLines2, intersections) {

    // Filter out grey lines that are already aligned with at least one line from the other group
    var filteredGreyLines1 = [];
    for (var i = 0; i < greyLines1.length; i++) {
        var isAligned = false;
        for (var j = 0; j < greyLines2.length; j++) {
            if (areAligned(greyLines1[i], greyLines2[j])) {
                _log("Removing aligned grey line from group 1");
                isAligned = true;
                break;
            }
        }
        if (!isAligned) {
            filteredGreyLines1.push(greyLines1[i]);
        }
    }

    var filteredGreyLines2 = [];
    for (var i = 0; i < greyLines2.length; i++) {
        var isAligned = false;
        for (var j = 0; j < greyLines1.length; j++) {
            if (areAligned(greyLines2[i], greyLines1[j])) {
                _log("Removing aligned grey line from group 2");
                isAligned = true;
                break;
            }
        }
        if (!isAligned) {
            filteredGreyLines2.push(greyLines2[i]);
        }
    }

    _log("Grey lines after filtering - Group 1: " + filteredGreyLines1.length + ", Group 2: " + filteredGreyLines2.length);

    try {
        for (var i = 0; i < intersections.length; i++) {
            var intersection = intersections[i];
            // Find where grey lines from both groups intersect if extended
            for (var g1 = 0; g1 < filteredGreyLines1.length; g1++) {
                for (var g2 = 0; g2 < filteredGreyLines2.length; g2++) {
                    var meetPoint = findGreyLineIntersection(filteredGreyLines1[g1], filteredGreyLines2[g2], intersection.endpoint1, intersection.endpoint2);
                    if (meetPoint) {
                        _log("Grey lines should meet at (" + meetPoint.x.toFixed(2) + ", " + meetPoint.y.toFixed(2) + ")");

                        // Extend/shorten grey line 1 to meet point
                        extendPathToPoint(filteredGreyLines1[g1], intersection.endpoint1, meetPoint);

                        // Extend/shorten grey line 2 to meet point
                        extendPathToPoint(filteredGreyLines2[g2], intersection.endpoint2, meetPoint);
                    }
                }
            }
        }
    } catch (e) {
        _log("alignGreyLines error: " + e.message);
    }
}

/**
 * Find where two grey lines would intersect if extended along their directions.
 * blackEndpoint1 and blackEndpoint2 are the corresponding black line endpoints.
 */
function findGreyLineIntersection(greyLine1, greyLine2, blackEndpoint1, blackEndpoint2) {
    try {
        // Get endpoints and directions for both grey lines
        var grey1Data = getPathEndpointAndDirection(greyLine1, blackEndpoint1);
        var grey2Data = getPathEndpointAndDirection(greyLine2, blackEndpoint2);

        if (!grey1Data || !grey2Data) return null;

        // Line 1: P1 + t * D1
        // Line 2: P2 + s * D2
        // Find intersection: P1 + t*D1 = P2 + s*D2

        var p1x = grey1Data.endpoint.x;
        var p1y = grey1Data.endpoint.y;
        var d1x = grey1Data.direction.x;
        var d1y = grey1Data.direction.y;

        var p2x = grey2Data.endpoint.x;
        var p2y = grey2Data.endpoint.y;
        var d2x = grey2Data.direction.x;
        var d2y = grey2Data.direction.y;

        // Solve: p1x + t*d1x = p2x + s*d2x
        //        p1y + t*d1y = p2y + s*d2y
        // Rearrange: t*d1x - s*d2x = p2x - p1x
        //            t*d1y - s*d2y = p2y - p1y

        var det = d1x * d2y - d1y * d2x;
        if (Math.abs(det) < 0.0001) {
            _log("Lines are parallel, no intersection");
            return null; // Lines are parallel
        }

        var dx = p2x - p1x;
        var dy = p2y - p1y;

        var t = (dx * d2y - dy * d2x) / det;

        var intersectX = p1x + t * d1x;
        var intersectY = p1y + t * d1y;

        return {x: intersectX, y: intersectY};
    } catch (e) {
        _log("findGreyLineIntersection error: " + e.message);
        return null;
    }
}

/**
 * Get the endpoint nearest to blackEndpoint and the direction from that endpoint.
 */
function getPathEndpointAndDirection(item, blackEndpoint) {
    try {
        if (item.typename === "PathItem" && item.pathPoints.length >= 2) {
            var start = item.pathPoints[0].anchor;
            var end = item.pathPoints[item.pathPoints.length - 1].anchor;

            // Calculate distance from start and end to blackEndpoint
            var distStart = Math.sqrt(Math.pow(start[0] - blackEndpoint.x, 2) + Math.pow(start[1] - blackEndpoint.y, 2));
            var distEnd = Math.sqrt(Math.pow(end[0] - blackEndpoint.x, 2) + Math.pow(end[1] - blackEndpoint.y, 2));

            var endpoint, otherPoint;
            if (distStart < distEnd) {
                // Start is closer to black endpoint
                endpoint = {x: start[0], y: start[1]};
                otherPoint = {x: item.pathPoints[1].anchor[0], y: item.pathPoints[1].anchor[1]};
            } else {
                // End is closer to black endpoint
                endpoint = {x: end[0], y: end[1]};
                var prevIdx = item.pathPoints.length - 2;
                otherPoint = {x: item.pathPoints[prevIdx].anchor[0], y: item.pathPoints[prevIdx].anchor[1]};
            }

            // Calculate direction from otherPoint to endpoint (extending outward)
            var dx = endpoint.x - otherPoint.x;
            var dy = endpoint.y - otherPoint.y;
            var length = Math.sqrt(dx * dx + dy * dy);

            if (length < 0.001) return null;

            // Normalize direction
            dx /= length;
            dy /= length;

            return {
                endpoint: endpoint, direction: {x: dx, y: dy}, isStart: distStart < distEnd
            };
        } else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
            return getPathEndpointAndDirection(item.pathItems[0], blackEndpoint);
        }
    } catch (e) {
        _log("getPathEndpointAndDirection error: " + e.message);
    }
    return null;
}

/**
 * Extend or shorten a path to reach targetPoint along its direction.
 */
function extendPathToPoint(item, blackEndpoint, targetPoint) {
    try {
        var tolerance = 50;

        if (item.typename === "PathItem" && item.pathPoints.length >= 2) {
            var start = item.pathPoints[0].anchor;
            var end = item.pathPoints[item.pathPoints.length - 1].anchor;

            // Determine which endpoint is closer to blackEndpoint
            var distStart = Math.sqrt(Math.pow(start[0] - blackEndpoint.x, 2) + Math.pow(start[1] - blackEndpoint.y, 2));
            var distEnd = Math.sqrt(Math.pow(end[0] - blackEndpoint.x, 2) + Math.pow(end[1] - blackEndpoint.y, 2));

            if (distStart < distEnd && distStart < tolerance) {
                // Adjust start point
                _log("Extending start from (" + start[0].toFixed(2) + "," + start[1].toFixed(2) + ") to (" + targetPoint.x.toFixed(2) + "," + targetPoint.y.toFixed(2) + ")");
                item.pathPoints[0].anchor = [targetPoint.x, targetPoint.y];
            } else if (distEnd < tolerance) {
                // Adjust end point
                _log("Extending end from (" + end[0].toFixed(2) + "," + end[1].toFixed(2) + ") to (" + targetPoint.x.toFixed(2) + "," + targetPoint.y.toFixed(2) + ")");
                item.pathPoints[item.pathPoints.length - 1].anchor = [targetPoint.x, targetPoint.y];
            }
        } else if (item.typename === "CompoundPathItem" && item.pathItems.length > 0) {
            extendPathToPoint(item.pathItems[0], blackEndpoint, targetPoint);
        }
    } catch (e) {
        _log("extendPathToPoint error: " + e.message);
    }
}

// ═══════════════════════════════════════════════
//  Slant
//  params: [angle, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildSlant(doc, item, params) {
    var angle = parseFloat(params[0]) || 45;
    var mode = params[1] || "translate";
    var thickness = parseFloat(params[2]) || 5;
    var depth = (parseFloat(params[3]) || 100) / 100;
    var dist = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;
    var depth_frac = depth; // Value between 0 and 1, 1 indicating 100% cut

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Grey copy (behind) — offset along the normal of the path
    var grey = item.duplicate();  // duplicate at document level for Offset Path
    grey = applyOffset(grey, mode, dist);
    grey.move(grp, ElementPlacement.PLACEATEND);
    setDepth(grey, depth_frac);

    // front (copy of original)
    var front_line = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
    setDepth(front_line, 0);

    // Remove original
    item.remove();

    return grp;
}

// ═══════════════════════════════════════════════
//  Bevel
//  params: [angle, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildBevel(doc, item, params) {
    var angle = parseFloat(params[0]) || 45;
    var mode = params[1] || "inwards";
    var thickness = parseFloat(params[2]) || 5;
    var depth = (parseFloat(params[3]) || 50) / 100;
    var dist = Math.tan(angle * Math.PI / 180) * thickness * PT_PER_MM;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black copy at original position (front)
    var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATBEGINNING);
    setAllStrokes(blackCopy, makeColor(0, 0, 0));

    // #ccc copy at offset position (behind)
    var cccCopy = item.duplicate();
    cccCopy = applyOffset(cccCopy, mode, dist);
    cccCopy.move(grp, ElementPlacement.PLACEATEND);
    setDepth(cccCopy, 1);

    // copy at same offset position (in front of #ccc)
    // Marks the boundary: slanted (black→grey) vs vertical (grey→#ccc)
    var depthCopy = item.duplicate();
    depthCopy = applyOffset(depthCopy, mode, dist);
    depthCopy.move(grp, ElementPlacement.PLACEATEND);
    setDepth(depthCopy, depth);

    // Remove original
    item.remove();

    return grp;
}

// ═══════════════════════════════════════════════
//  Slider
//  params: [angle, angle2, chained, mode, thickness_mm, depth]
// ═══════════════════════════════════════════════

function buildSlider(doc, item, params) {
    var angle = parseFloat(params[0]) || 45;
    var angle2 = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var mode = params[3] || "inwards";
    var thickness = parseFloat(params[4]) || 5;
    var widthPt = thickness * PT_PER_MM;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black copy at original position (front)
    var blackCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setDepth(blackCopy, 0)

    // Grey copy — inset/outset/translated (middle)
    const TO_RAD = Math.PI / 180
    var off_unscaled = Math.sin(TO_RAD * angle) * Math.sin(TO_RAD * angle2) / Math.sin(TO_RAD * (180 - (angle + angle2)))
    var off_px = off_unscaled * widthPt;
    var off_mm = off_unscaled * thickness;
    var line_depth_frac = (off_mm * Math.sin(TO_RAD * (90 - angle)) / Math.sin(TO_RAD * angle)) / thickness;

    var greyCopy = item.duplicate();
    greyCopy = applyOffset(greyCopy, mode, off_px);
    greyCopy.move(grp, ElementPlacement.PLACEATEND);
    setDepth(greyCopy, line_depth_frac)

    // copy at original position (behind)
    var originalLine = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setDepth(originalLine, 1)

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
    var angle1 = parseFloat(params[0]) || 45;
    var angle2 = parseFloat(params[1]) || 45;
    // params[2] = chained flag (UI only)
    var thickness = parseFloat(params[3]) || 5;
    var depth = (parseFloat(params[4]) || 50) / 100;

    var inDist = Math.tan(angle1 * Math.PI / 180) * thickness * PT_PER_MM * depth;
    var outDist = Math.tan(angle2 * Math.PI / 180) * thickness * PT_PER_MM * depth;

    var grp = doc.groupItems.add();
    grp.move(item, ElementPlacement.PLACEBEFORE);

    // Black outward-offset copy (front)
    var outCopy = item.duplicate();
    outCopy = applyOffset(outCopy, "outward", outDist);
    outCopy.move(grp, ElementPlacement.PLACEATEND);
    setDepth(outCopy, 0);

    // Grey copy at original position (middle)
    var greyCopy = item.duplicate(grp, ElementPlacement.PLACEATEND);
    setDepth(greyCopy, depth);

    // Black inward-offset copy (behind)
    var inCopy = item.duplicate();
    inCopy = applyOffset(inCopy, "inward", inDist);
    inCopy.move(grp, ElementPlacement.PLACEATEND);
    setDepth(inCopy, 0);

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

/**
 * Apply positional offset based on mode.
 *   translate:  move the copy by (dist, dist) in direction of normal
 *   outwards:   Illustrator Offset Path by +dist
 *   inwards:    Illustrator Offset Path by -dist
 *
 * For inwards/outwards the item is replaced in-place by the offset result.
 * Returns the (possibly new) item.
 */
function applyOffset(item, mode, dist) {
    if (mode === "translate") {
        var normal = calculatePathNormal(item);
        item.translate(normal.x * dist, normal.y * dist);
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
            } catch (e) {
            }
        }
    }

    // Return the first black line (or null if none found)
    return blackOnly.length > 0 ? blackOnly[0] : null;
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

function setDepth(item, depth_frac) {
    setAllStrokes(item, makeDepthColor(depth_frac));
    setCSSClass(item, "depth-" + (depth_frac * 100).toFixed(3) + "%");
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
