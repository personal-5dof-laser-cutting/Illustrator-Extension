/*
 * SVG 5DOF Panel — UI logic.
 *
 * Polls Illustrator selection state. Shows/hides parameter sections
 * per joint type. Auto-re-applies when any parameter changes.
 */
(function () {
    "use strict";

    var csInterface = new CSInterface();

    // Load ExtendScript host file on startup.
    var extensionPath = csInterface.getSystemPath(SystemPath.EXTENSION);
    var jsxPath = extensionPath + "/jsx/hostscript.jsx";
    csInterface.evalScript('$.evalFile("' + jsxPath.replace(/\\/g, "/") + '")');

    // ── State ──
    var state = {
        joint: "straight",
        angle: 45,
        angle2: 45,
        chained: true,
        mode: "inward",
        thickness: 5,
        depth: 50,
        hasSelection: false,
        multiSelect: false,
        multiCount: 0,
        manuallySelected: false
    };

    // ── DOM refs ──
    var statusEl     = document.getElementById("status");
    var applyBtn     = document.getElementById("apply-btn");
    var jointButtons = document.querySelectorAll(".joint-btn");
    var paramSections = {
        slant:  document.getElementById("params-slant"),
        bevel:  document.getElementById("params-bevel"),
        slider: document.getElementById("params-slider"),
        groove: document.getElementById("params-groove")
    };

    // ── Suffixed input helpers ──

    var SUFFIXES = {
        angle: "\u00B0",
        angle2: "\u00B0",
        depth: "%",
        thickness: "mm"
    };

    function formatInput(input) {
        var param = input.dataset.param;
        var suffix = SUFFIXES[param] || "";
        input.value = state[param] + suffix;
    }

    function parseInput(input) {
        var param = input.dataset.param;
        var raw = parseFloat(input.value) || 0;

        if (param === "angle" || param === "angle2") raw = Math.round(raw);
        if (param === "depth") raw = Math.max(0, Math.min(100, Math.round(raw)));
        if (param === "thickness") raw = Math.max(0.1, Math.round(raw * 10) / 10);

        state[param] = raw;

        // If chained and this is angle, sync angle2
        if (param === "angle" && state.chained) {
            state.angle2 = raw;
        } else if (param === "angle2" && state.chained) {
            state.angle = raw;
        }

        formatInput(input);
    }

    // Attach to all param inputs
    var allInputs = document.querySelectorAll(".param-input");
    for (var k = 0; k < allInputs.length; k++) {
        (function (input) {
            formatInput(input);

            input.addEventListener("focus", function () {
                input.value = String(state[input.dataset.param]);
                input.select();
            });

            input.addEventListener("blur", function () {
                var param = input.dataset.param;
                parseInput(input);
                syncAllInputs();
            });

            input.addEventListener("keydown", function (e) {
                if (e.key === "Enter") input.blur();
            });
        })(allInputs[k]);
    }

    // ── Radio buttons ──

    var allRadios = document.querySelectorAll(".radio-input");
    for (var s = 0; s < allRadios.length; s++) {
        (function (radio) {
            radio.addEventListener("change", function () {
                state[radio.dataset.param] = radio.dataset.value;
            });
        })(allRadios[s]);
    }

    // ── Chain buttons ──

    var chainBtns = document.querySelectorAll(".js-chain");
    for (var ci = 0; ci < chainBtns.length; ci++) {
        (function (btn) {
            btn.addEventListener("click", function () {
                state.chained = !state.chained;
                syncChainButtons();
                if (state.chained) {
                    state.angle2 = state.angle;
                    syncAllInputs();
                }
            });
        })(chainBtns[ci]);
    }

    function syncChainButtons() {
        var btns = document.querySelectorAll(".js-chain");
        for (var i = 0; i < btns.length; i++) {
            if (state.chained) {
                btns[i].classList.add("active");
            } else {
                btns[i].classList.remove("active");
            }
        }
    }

    // ── Angle spinners ──

    function adjustAngle(param, delta) {
        var val = state[param] + delta;
        state[param] = val;
        if (state.chained) {
            state.angle = val;
            state.angle2 = val;
        }
        syncAllInputs();
    }

    // angle1 spinners
    var angleIncs = document.querySelectorAll(".js-angle-inc");
    var angleDecs = document.querySelectorAll(".js-angle-dec");
    for (var ai = 0; ai < angleIncs.length; ai++) {
        (function (btn) {
            btn.addEventListener("click", function () { adjustAngle("angle", 5); });
        })(angleIncs[ai]);
    }
    for (var ad = 0; ad < angleDecs.length; ad++) {
        (function (btn) {
            btn.addEventListener("click", function () { adjustAngle("angle", -5); });
        })(angleDecs[ad]);
    }

    // angle2 spinners
    var angle2Incs = document.querySelectorAll(".js-angle2-inc");
    var angle2Decs = document.querySelectorAll(".js-angle2-dec");
    for (var a2i = 0; a2i < angle2Incs.length; a2i++) {
        (function (btn) {
            btn.addEventListener("click", function () { adjustAngle("angle2", 5); });
        })(angle2Incs[a2i]);
    }
    for (var a2d = 0; a2d < angle2Decs.length; a2d++) {
        (function (btn) {
            btn.addEventListener("click", function () { adjustAngle("angle2", -5); });
        })(angle2Decs[a2d]);
    }

    // Sync all visible inputs to current state
    function syncAllInputs() {
        var inputs = document.querySelectorAll(".param-input");
        for (var i = 0; i < inputs.length; i++) {
            formatInput(inputs[i]);
        }
    }

    // ── Show/hide param sections ──

    function showParamsFor(jointId) {
        for (var key in paramSections) {
            if (paramSections[key]) {
                paramSections[key].hidden = (key !== jointId);
            }
        }
        var section = paramSections[jointId];
        if (section) {
            var inputs = section.querySelectorAll(".param-input");
            for (var i = 0; i < inputs.length; i++) {
                formatInput(inputs[i]);
            }
            var radios = section.querySelectorAll(".radio-input");
            for (var j = 0; j < radios.length; j++) {
                radios[j].checked = (radios[j].dataset.value === state[radios[j].dataset.param]);
            }
        }
        syncChainButtons();
        updateApplyButtonVisibility();
    }

    function updateApplyButtonVisibility() {
        if (!applyBtn) return;
        // Show apply button for any joint type except straight (revert) and thread (not implemented)
        var show = state.hasSelection && state.joint !== "straight" && state.joint !== "thread" && state.joint !== "";
        applyBtn.hidden = !show;
    }

    // ── Enable / disable all joint buttons ──

    function setButtonsEnabled(enabled) {
        for (var i = 0; i < jointButtons.length; i++) {
            if (enabled) {
                jointButtons[i].classList.remove("disabled");
            } else {
                jointButtons[i].classList.add("disabled");
                jointButtons[i].classList.remove("active");
            }
        }
    }

    // ── Highlight the active joint button ──

    function highlightJoint(jointId) {
        state.joint = jointId;
        // If the user clicks a specific joint, they've manually selected it.
        // We'll keep it active until the poll finds something tagged or selection is lost.
        if (jointId !== "straight" && jointId !== "") {
            state.manuallySelected = true;
        } else {
            state.manuallySelected = false;
        }

        for (var i = 0; i < jointButtons.length; i++) {
            var btn = jointButtons[i];
            if (btn.dataset.joint === jointId) {
                btn.classList.add("active");
            } else {
                btn.classList.remove("active");
            }
        }
        showParamsFor(jointId);
        updateApplyButtonVisibility();
    }

    // ── Poll selection state ──

    var lastSelResult = "";

    function pollSelection() {
        if (applying) return;
        csInterface.evalScript("checkSelection()", function (result) {
            if (result === lastSelResult) return;
            lastSelResult = result;

            if (!result || result === "none" || result === "EvalScript unavailable") {
                state.hasSelection = false;
                state.multiSelect = false;
                state.manuallySelected = false; // Reset on no selection
                setButtonsEnabled(false);
                showParamsFor("");
                updateApplyButtonVisibility();
            } else if (result.indexOf("multi:") === 0 || result.indexOf("mixed:") === 0) {
                // Multiple tagged groups selected
                var isMixed = result.indexOf("mixed:") === 0;
                state.hasSelection = true;
                state.multiSelect = true;
                state.manuallySelected = false; // Selection dictates tool
                var multiPayload = result.split(":")[1];

                var pipeIdx = multiPayload.indexOf("|");
                state.multiCount = parseInt(multiPayload.substr(0, pipeIdx), 10);
                // Parse first item's params to populate UI
                var firstData = multiPayload.substr(pipeIdx + 1);
                var firstParts = firstData.split("|");
                var firstType = firstParts[0];
                restoreParams(firstType, firstParts.slice(1));
                setButtonsEnabled(true);
                
                if (isMixed) {
                    // Mixed types: don't highlight any joint
                    showParamsFor(firstType);
                    for (var jb = 0; jb < jointButtons.length; jb++) {
                        jointButtons[jb].classList.remove("active");
                    }
                } else {
                    // Same type: highlight it!
                    highlightJoint(firstType);
                }
                state.joint = firstType; // keep for param section visibility
                updateApplyButtonVisibility();
            } else if (result.indexOf("tagged:") === 0) {
                state.hasSelection = true;
                state.multiSelect = false;
                state.manuallySelected = false; // Selection dictates tool
                setButtonsEnabled(true);
                var payload = result.substr(7);
                var parts = payload.split("|");
                var type = parts[0];
                restoreParams(type, parts.slice(1));
                highlightJoint(type);
                updateApplyButtonVisibility();
            } else {
                // "normal" — un-tagged selection
                state.hasSelection = true;
                state.multiSelect = false;
                setButtonsEnabled(true);
                
                if (state.manuallySelected) {
                    // User has clicked a tool, stay on it.
                    updateApplyButtonVisibility();
                } else {
                    // No manual tool, default to straight (revert)
                    highlightJoint("straight");
                    updateApplyButtonVisibility();
                }
            }
        });
    }

    // Restore state from tag params
    function restoreParams(type, parts) {
        if (type === "slant") {
            // angle|mode|thickness
            if (parts[0] !== undefined) state.angle = parseFloat(parts[0]) || 45;
            if (parts[1] !== undefined) state.mode = parts[1];
            if (parts[2] !== undefined) state.thickness = parseFloat(parts[2]) || 5;
        } else if (type === "bevel") {
            // angle|mode|thickness|depth
            if (parts[0] !== undefined) state.angle = parseFloat(parts[0]) || 45;
            if (parts[1] !== undefined) state.mode = parts[1];
            if (parts[2] !== undefined) state.thickness = parseFloat(parts[2]) || 5;
            if (parts[3] !== undefined) state.depth = parseFloat(parts[3]) || 50;
        } else if (type === "slider") {
            // angle|angle2|chained|mode|thickness|depth
            if (parts[0] !== undefined) state.angle = parseFloat(parts[0]) || 45;
            if (parts[1] !== undefined) state.angle2 = parseFloat(parts[1]) || 45;
            if (parts[2] !== undefined) state.chained = parts[2] === "1";
            if (parts[3] !== undefined) state.mode = parts[3];
            if (parts[4] !== undefined) state.thickness = parseFloat(parts[4]) || 5;
            if (parts[5] !== undefined) state.depth = parseFloat(parts[5]) || 50;
        } else if (type === "groove") {
            // angle|angle2|chained|thickness|depth
            if (parts[0] !== undefined) state.angle = parseFloat(parts[0]) || 45;
            if (parts[1] !== undefined) state.angle2 = parseFloat(parts[1]) || 45;
            if (parts[2] !== undefined) state.chained = parts[2] === "1";
            if (parts[3] !== undefined) state.thickness = parseFloat(parts[3]) || 5;
            if (parts[4] !== undefined) state.depth = parseFloat(parts[4]) || 50;
        }
    }

    setInterval(pollSelection, 500);
    pollSelection();

    // ── Apply / revert ──

    function buildParamString() {
        var type = state.joint;
        if (type === "slant") {
            return state.angle + "|" + state.mode + "|" + state.thickness;
        } else if (type === "bevel") {
            return state.angle + "|" + state.mode + "|" + state.thickness + "|" + state.depth;
        } else if (type === "slider") {
            return state.angle + "|" + state.angle2 + "|" + (state.chained ? "1" : "0") +
                   "|" + state.mode + "|" + state.thickness + "|" + state.depth;
        } else if (type === "groove") {
            return state.angle + "|" + state.angle2 + "|" + (state.chained ? "1" : "0") +
                   "|" + state.thickness + "|" + state.depth;
        }
        return "";
    }

    var applying = false;

    function applyJoint(jointId) {
        if (!state.hasSelection) return;
        if (applying) return;
        applying = true;

        highlightJoint(jointId);

        function done(result) {
            if (result && result !== "undefined" && result.indexOf("Error") !== 0) {
                showStatus(result);
            }
            lastSelResult = "";
            applying = false;
            pollSelection();
        }

        if (jointId === "straight") {
            csInterface.evalScript("revertToStraight()", done);
        } else if (jointId === "thread") {
            showStatus("Thread — coming soon");
            applying = false;
        } else {
            var params = buildParamString();
            var script = "applyJoint('" + jointId + "','" + params + "')";
            csInterface.evalScript(script, done);
        }
    }

    function _log(msg) {
        console.log("[DEBUG_LOG] " + msg);
        // Also send to ExtendScript log if possible, or just keep in console
    }


    for (var i = 0; i < jointButtons.length; i++) {
        (function (btn) {
            btn.addEventListener("click", function () {
                var jointId = btn.dataset.joint;
                highlightJoint(jointId);
                if (jointId === "straight") {
                    applyJoint("straight");
                }
            });
        })(jointButtons[i]);
    }

    // ── Apply button click ──
    applyBtn.addEventListener("click", function () {
        applyJoint(state.joint);
    });

    // ── Status message ──

    var statusTimer;
    function showStatus(msg) {
        statusEl.textContent = msg;
        statusEl.classList.add("visible");
        clearTimeout(statusTimer);
        statusTimer = setTimeout(function () {
            statusEl.classList.remove("visible");
        }, 2000);
    }

    // ── Theme sync ──

    function syncTheme() {
        try {
            var hostEnv = csInterface.getHostEnvironment();
            var bgColor = hostEnv.appSkinInfo.panelBackgroundColor.color;
            var r = Math.round(bgColor.red);
            var g = Math.round(bgColor.green);
            var b = Math.round(bgColor.blue);
            document.body.style.backgroundColor = "rgb(" + r + "," + g + "," + b + ")";

            var luminance = (0.299 * r + 0.587 * g + 0.114 * b);
            document.body.className = luminance > 128
                ? "spectrum spectrum--light"
                : "spectrum spectrum--darkest";
        } catch (e) {}
    }

    syncTheme();
    csInterface.addEventListener("com.adobe.csxs.events.ThemeColorChanged", syncTheme);

    // ── Initial state ──
    setButtonsEnabled(false);
    showParamsFor("");

})();
