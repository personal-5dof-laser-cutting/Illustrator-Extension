const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

function host() {
    const context = vm.createContext({
        RGBColor: function () {},
        ElementPlacement: { PLACEBEFORE: 0, PLACEATEND: 1, PLACEATBEGINNING: 2 }
    });
    vm.runInContext(readFileSync('jsx/hostscript.jsx', 'utf8'), context);
    context._log = function () {};
    return context;
}

function path() {
    return {
        typename: 'PathItem', stroked: true, filled: true, strokeWidth: 2, note: '', effects: [],
        applyEffect(xml) { this.effects.push(xml); },
        move() {}, remove() {}
    };
}

test('compatibility depth matches the spec and retains metadata for revert', () => {
    const ctx = host();
    for (const mode of [true, undefined]) {
        for (const [depth, value] of [[0, 0], [0.5, 102], [0.75, 153], [1, 204]]) {
            const item = path();
            ctx.setDepth(item, depth, mode);
            assert.deepEqual([item.strokeColor.red, item.strokeColor.green, item.strokeColor.blue],
                [value, value, value]);
            assert.equal(item.effects.length, 0);
            assert.equal(item.filled, false);
            assert.equal(item.strokeWidth, 2 * (1 + depth));
            assert.equal(ctx.isOriginalLine(item), depth === 0);
        }
    }
});

test('native blur initializes the Illustrator radius and scales with depth and stroke width', () => {
    const ctx = host();
    for (const width of [0.25, 2, 8]) {
        for (const depth of [0, 0.25, 0.5, 1]) {
            const item = path();
            item.strokeWidth = width;
            ctx.setDepth(item, depth, false);
            assert.equal(item.strokeColor.red, 0);
            assert.equal(item.effects.length, depth > 0 ? 1 : 0);
            assert.equal(item.strokeWidth, width);
            if (depth > 0) {
                assert.match(item.effects[0], /LiveEffect name="Adobe PSL Gaussian Blur"/);
                assert.ok(item.effects[0].includes('R blur ' + 6 * depth * width + ' '));
                assert.doesNotMatch(item.effects[0], /GBRd/);
            }
        }
    }
});

test('native blur uses compound appearance once and scales grouped paths independently', () => {
    const ctx = host();
    const thin = path();
    thin.strokeWidth = 0.5;
    const thick = path();
    thick.strokeWidth = 4;
    const compound = {
        typename: 'CompoundPathItem', pathItems: [path(), path()], effects: [],
        applyEffect(xml) { this.effects.push(xml); }
    };
    const group = { typename: 'GroupItem', pageItems: [thin, thick, compound] };
    ctx.setDepth(group, 0.5, false);
    assert.match(thin.effects[0], /R blur 1\.5 /);
    assert.match(thick.effects[0], /R blur 12 /);
    assert.equal(compound.effects.length, 1);
    assert.match(compound.effects[0], /R blur 6 /);
    assert.ok(compound.pathItems.every(item => item.effects.length === 0));
});

test('all joint builders propagate the option to every generated line', () => {
    const cases = [
        ['slant', ['45', 'translate', '5', '100', '0'], [0, 204]],
        ['bevel', ['45', 'translate', '5', '50', '0'], [0, 102, 204]],
        ['slider', ['45', '45', '1', 'translate', '5', '0'], [0, 102, 204]],
        ['groove', ['45', '45', '1', '5', '50'], [0, 0, 102]]
    ];
    for (const [type, params, expected] of cases) {
        for (const mode of [true, false]) {
            const ctx = host();
            const copies = [];
            const item = path();
            item.duplicate = () => { const copy = path(); copies.push(copy); return copy; };
            const doc = { groupItems: { add: () => ({ move() {} }) } };
            ctx.applyOffset = copy => copy;
            ctx.rebuildJoint(doc, item, type, params, null, mode);
            const colors = copies.map(copy => Math.round(copy.strokeColor.red)).sort((a, b) => a - b);
            assert.deepEqual(colors, mode ? expected : expected.map(() => 0), type);
            assert.equal(copies.filter(copy => copy.effects.length).length,
                mode ? 0 : expected.filter(value => value > 0).length, type);
        }
    }
});


test('compound paths scale shared stroke widths only once', () => {
    const ctx = host();
    let sharedWidth = 2;
    const paths = [path(), path()];
    for (const item of paths) Object.defineProperty(item, 'strokeWidth', {
        get: () => sharedWidth, set: value => { sharedWidth = value; }
    });
    ctx.setDepth({ typename: 'CompoundPathItem', pathItems: paths }, 1, true);
    assert.equal(sharedWidth, 4);
});

test('applying profiles accepts RGB, CMYK, gray, spot, and compound edges without deleting unrelated art', () => {
    for (const color of [
        { typename: 'RGBColor', red: 255, green: 0, blue: 0 },
        { typename: 'CMYKColor', cyan: 100, magenta: 0, yellow: 0, black: 0 },
        { typename: 'GrayColor', gray: 20 },
        { typename: 'SpotColor' }
    ]) {
        const ctx = host();
        const edge = path();
        edge.strokeColor = color;
        edge.remove = () => assert.fail('source should reach the builder, not be deleted');
        const compound = { typename: 'CompoundPathItem', pathItems: [edge] };
        const unrelated = { typename: 'TextFrameItem', remove: () => assert.fail('unrelated art removed') };
        const fillOnly = { ...path(), stroked: false, remove: () => assert.fail('fill-only art removed') };
        const doc = { selection: [edge, compound, unrelated, fillOnly] };
        ctx.app = { documents: [doc], activeDocument: doc, redraw() {} };
        const processed = [];
        ctx.rebuildJoint = (doc, item) => { processed.push(item); return {}; };
        assert.equal(ctx.applyJoint('slant', '45|translate|5|100|0', true), 'Slant applied to 2 object(s).');
        assert.deepEqual(processed, [edge, compound]);
    }
});

test('unsupported selection is retained when there are no stroked paths', () => {
    const ctx = host();
    const item = { ...path(), stroked: false, remove: () => assert.fail('unsupported item removed') };
    const doc = { selection: [item] };
    ctx.app = { documents: [doc], activeDocument: doc };
    assert.equal(ctx.applyJoint('slant', '45|translate|5|100|0', true), 'No stroked paths to process.');
    assert.equal(doc.selection[0], item);
});


test('non-compat mode styles the existing path without imports, replacement, or geometry changes', () => {
    const ctx = host();
    const item = path();
    item.pathPoints = [
        { anchor: [0, 0], leftDirection: [0, 0], rightDirection: [10, 5] },
        { anchor: [20, 0], leftDirection: [10, -5], rightDirection: [20, 0] }
    ];
    const geometry = JSON.stringify(item.pathPoints);
    item.remove = () => assert.fail('path was removed');
    item.move = () => assert.fail('path was moved');
    ctx.app = { open: () => assert.fail('a temporary document was opened') };
    ctx.File = function () { assert.fail('a temporary file was created'); };
    assert.equal(ctx.setDepth(item, 0.5, false), item);
    assert.equal(JSON.stringify(item.pathPoints), geometry);
    assert.equal(item.strokeWidth, 2);
    assert.equal(item.note, 'class="depth-50.000%"');
    assert.equal(item.effects.length, 1);
});

test('a rejected native blur effect retains the path and its depth metadata', () => {
    const ctx = host();
    const item = path();
    item.applyEffect = () => { throw new Error('Host effect failed'); };
    item.remove = () => assert.fail('path was removed');
    assert.equal(ctx.setDepth(item, 1, false), item);
    assert.equal(item.note, 'class="depth-100.000%"');
    assert.equal(item.strokeWidth, 2);
});
