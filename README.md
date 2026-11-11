# SVG5DOF — Illustrator CEP Panel

A CEP (Common Extensibility Platform) panel for Adobe Illustrator that generates decorative joint geometry on selected objects. Each joint type creates a tagged group containing styled copies of the original path — representing material edges, offset surfaces, and cut lines for 5 types of mechanical joints.

## Installation

```bash
./install.sh
```

This enables unsigned CEP extensions and symlinks the project into Illustrator's extensions folder. Restart Illustrator, then open **Window > Extensions > SVG5DOF**.

Requires Illustrator CC 2020+ (CSXS 9.0).

## Compatibility Mode

**Compatibility Mode** is checked by default. Click **Apply** to create or rebuild selected joints with grayscale depth encoding instead of Illustrator's native Gaussian Blur live effect. Entry lines are black, exit lines are `#ccc`, and intermediate depths interpolate between them (50% depth is `#666`), following the [SVG5DOF specification](https://github.com/personal-5dof-laser-cutting/svg5dof/blob/main/specification.md#compatibility-mode).

Stroke width also increases linearly with depth: entry lines keep the source width, 50% depth uses 1.5×, and exit lines (20% darkness) use 2×.

Uncheck it before applying to use black strokes with the original width and Illustrator's native Gaussian Blur live effect. The blur radius is 6 × relative cutting depth × stroke width (in points): 50% depth on a 2pt stroke gives a 6pt radius, and 100% gives 12pt; entry lines at 0% stay sharp. This stronger native blur is inspired by the broad depth visualization in the [SVG5DOF demo models](https://github.com/personal-5dof-laser-cutting/svg5dof/tree/main/demo%20models). Changing the checkbox takes effect on the next Apply. Class-based SVG5DOF export is still a separate task.

Profiles can be applied to stroked paths of any color, including compound paths. Unsupported artwork is skipped rather than deleted.

## Joint Types

### Straight (revert)
Reverts a tagged group back to the original object. No parameters.

### Slant
An angled cut through the material.

| Parameter | Description |
|-----------|-------------|
| Angle | Cut angle (0–360°) |
| Mode | `outward` — Offset Path expands outward; `inward` — contracts inward; `translate` — diagonal shift |
| Thickness | Material thickness in mm (controls offset distance via `tan(angle) * thickness`) |

**Group structure:** black copy (original position) + #ccc copy (offset position) + hidden original.

### Bevel
A chamfered edge with depth control.

| Parameter | Description |
|-----------|-------------|
| Angle | Bevel angle |
| Mode | `outward` / `inward` only |
| Thickness | Material thickness in mm |
| Depth | Cutting depth 0–100% (controls grey color lerp: 0% = black, 100% = #ccc) |

**Group structure:** black copy (original position) + grey copy (offset, depth-lerped color) + #ccc copy (same offset as grey) + hidden original. The slanted bevel surface is implied between the black and grey/#ccc lines.

### Slider
A notch/tongue joint where the notch piece is offset from the walls.

| Parameter | Description |
|-----------|-------------|
| Angle 1/2 | Paired angles with chain toggle for symmetric/asymmetric notches |
| Mode | `outward` / `inward` / `translate` — determines how the grey (notch) copy is offset |
| Thickness | Material thickness in mm |
| Depth | Notch depth 0–100% (controls grey color) |

**Group structure:** black copy (original position) + grey copy (offset by mode) + #ccc copy (original position) + hidden original. Black and #ccc stay aligned (the walls); grey moves (the notch).

### Groove
A channel cut into the material with inward and outward offset paths.

| Parameter | Description |
|-----------|-------------|
| Angle 1 | Controls inward offset: `tan(angle1) * thickness * depth%` |
| Angle 2 | Controls outward offset: `tan(angle2) * thickness * depth%` |
| Thickness | Material thickness in mm |
| Depth | Groove depth 0–100% |

**Group structure:** black outward-offset copy + grey copy (original position) + black inward-offset copy + hidden original. Always uses Illustrator's Offset Path (no translate mode). Unchain angles for asymmetric grooves.

### Thread
Not yet implemented.

## Architecture

```
helloWorldIllustorCEP/
├── CSXS/
│   └── manifest.xml          CEP extension config (ID, panel size, host targets)
├── css/
│   ├── spectrum.css           Adobe Spectrum design tokens (dark/light themes)
│   └── panel.css              Panel layout, button grid, param rows, radios
├── js/
│   ├── CSInterface.js         Adobe CEP bridge library
│   └── main.js                Panel UI logic, selection polling, param handling
├── jsx/
│   └── hostscript.jsx         ExtendScript — runs inside Illustrator
├── index.html                 Panel HTML
├── install.sh                 Dev installation script
└── .debug                     CEP debug config
```

### Three-layer architecture

1. **HTML/CSS/JS** (CEP panel, runs in embedded Chromium)
   - Polls Illustrator selection every 500ms via `checkSelection()`
   - Shows/hides parameter sections per joint type
   - Auto-remakes geometry when any parameter changes
   - Sends commands to Illustrator via `csInterface.evalScript()`

2. **ExtendScript** (`hostscript.jsx`, runs inside Illustrator)
   - `checkSelection()` — returns selection state (`none`, `normal`, `tagged:...`, `multi:...`)
   - `applyJoint(type, paramsStr)` — creates tagged groups on all selected items
   - `updateParam(paramName, value)` — updates a single param on all selected tagged groups (preserves each group's type and other params)
   - `revertToStraight()` — unwraps tagged groups back to originals
   - Build functions: `buildSlant`, `buildBevel`, `buildSlider`, `buildGroove`
   - Offset Path via `applyEffect` (live effect XML) + `expandStyle`

3. **Tagged groups** (data stored in `groupItem.note`)
   - Format: `SVG5DOF:type|param1|param2|...`
   - Hidden original stashed as last child for non-destructive revert
   - `findTaggedAncestor()` walks up from any child to find the tagged group

### Selection handling

- **Single selection:** UI shows the item's type and params. Changing anything rebuilds the joint.
- **Multi-selection:** `checkSelection` returns `multi:N|first_params`. Changing a param calls `updateParam` which iterates all selected tagged groups and updates only the changed parameter — each group keeps its own type and mode.
- **Walk-up logic:** If a child inside a tagged group is selected (e.g., after Expand), both `checkSelection` and `applyJoint` walk up the parent chain to find the tagged group.

### Offset Path implementation

Inward/outward modes use Illustrator's built-in Offset Path via live effects:

```javascript
var xml = '<LiveEffect name="Adobe Offset Path">'
        + '<Dict data="R ofst ' + dist + ' I jntp 2 R mlim 4.0 "/>'
        + '</LiveEffect>';
item.applyEffect(xml);
app.executeMenuCommand("expandStyle");
```

- `jntp 2` = Bevel joins
- Effect is applied, then immediately expanded into real geometry
- Selection is cleaned up after expand to avoid interfering with group selection

### Diagnostic logging

Writes to `~/Desktop/svg5dof_log.txt` (append mode). Logs offset path operations, selection state changes, and group creation. Safe to delete at any time.

## UI Design

The panel follows Adobe Spectrum CSS guidelines:
- Dark theme tokens matching Illustrator's native UI
- Radio buttons: 14px circle, 2px border `#8a8a8a`, checked state uses 5px border `#dbdbdb` (donut effect)
- Input fields: `var(--spectrum-gray-100)` background
- Tabular layout: right-aligned labels at fixed width, inputs aligned
- Chain button for linked angle pairs (like W/H in Transform panel)
- Theme sync: auto-detects Illustrator dark/light theme via `appSkinInfo`
