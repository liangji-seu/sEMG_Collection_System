const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/scripts/template-config.js'), 'utf8');

class MiniInput {
    constructor(attrs) {
        this.dataset = { task: attrs['data-task'], param: attrs['data-param'], type: attrs['data-type'] };
        this.type = attrs.type || 'text';
        this.value = attrs.value || '';
        this.checked = Object.hasOwn(attrs, 'checked');
        this.listeners = {};
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    change(value) {
        if (this.type === 'checkbox') this.checked = value;
        else this.value = String(value);
        this.listeners.change({ target: this });
    }
}

class MiniContainer {
    set innerHTML(html) {
        this.html = html;
        this.inputs = [...html.matchAll(/<input\b([^>]*)>/g)].map(([, raw]) => {
            const attrs = {};
            for (const match of raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[match[1]] = match[2] ?? '';
            return new MiniInput(attrs);
        });
    }
    querySelectorAll(selector) { return selector === '.config-param-item input' ? this.inputs : []; }
    querySelector(selector) {
        const task = selector.match(/data-task="([^"]+)"/)?.[1];
        const param = selector.match(/data-param="([^"]+)"/)?.[1];
        return this.inputs.find(input => input.dataset.task === task && input.dataset.param === param) || null;
    }
}

function setup() {
    const container = new MiniContainer();
    const elements = { executionTabContent: container, timeEstimationContent: { innerHTML: '' } };
    const storage = {};
    const document = {
        addEventListener() {},
        getElementById(id) { return elements[id] || null; },
        querySelector(selector) { return container.querySelector(selector); }
    };
    const window = {};
    class TestFileReader {
        readAsText(file) {
            this.result = file.content;
            this.onload({ target: this });
        }
    }
    const context = { window, document, console, FileReader: TestFileReader, localStorage: { getItem(key) { return storage[key] ?? null; }, setItem(key, value) { storage[key] = value; } }, setTimeout, Math, Date };
    vm.runInNewContext(source, context, { filename: 'template-config.js' });
    const manager = new window.TemplateConfigManager();
    manager.showToast = (message, type) => { manager.lastToast = { message, type }; };
    manager.currentTemplate = {
        tasks: [
            { id: 'continual_gesture_1', name: '连续手势采集1', enabled: true },
            { id: 'continual_gesture_2', name: '连续手势采集2', enabled: true },
            { id: 'continual_gesture_3', name: '连续手势采集3', enabled: true }
        ],
        gestures: { discrete: [] },
        execution: {
            continual_gesture_1: { trialsPerStage: 5, stageTimeout: 120, expandDuration: 3, holdDuration: 1, contractDuration: 3, restBetweenTrials: 1, preparationTime: 3, speedLevels: [0.5, 1, 2], trialSpeedSequence: [] },
            continual_gesture_2: { trialsPerStage: 5, stageTimeout: 120, expandDuration: 3, holdDuration: 1, contractDuration: 3, restBetweenTrials: 1, preparationTime: 3, speedLevels: [0.5, 1, 2], trialSpeedSequence: [] },
            continual_gesture_3: { trialsPerStage: 5, stageTimeout: 120, guideSpeed: 0.15, guideSize: 0.15, holdDuration: 1, restBetweenTrials: 1, preparationTime: 3 }
        }
    };
    return { manager, container, storage, estimation: elements.timeEstimationContent };
}

test('continuous task form writes boolean toggles, validated values, and legacy speed sequence', () => {
    const { manager, container } = setup();
    manager.renderExecutionTab();
    const config = manager.currentTemplate.execution.continual_gesture_1;
    assert.equal(config.randomSpeedEnabled, undefined, 'legacy missing setting stays absent and therefore off');
    assert.equal(container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedEnabled"]').checked, false);

    container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedEnabled"]').change(true);
    assert.equal(config.randomSpeedEnabled, true);
    container.querySelector('[data-task="continual_gesture_1"][data-param="randomPauseEnabled"]').change(true);
    assert.equal(config.randomPauseEnabled, true);

    const maxSpeed = container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedMax"]');
    maxSpeed.change('0');
    assert.equal(config.randomSpeedMax, 2, 'invalid positive range value falls back to the task default');
    assert.equal(Number(maxSpeed.value), config.randomSpeedMax);
    assert.equal(manager.lastToast.type, 'warning');

    const minSpeed = container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedMin"]');
    minSpeed.change('3');
    assert.equal(config.randomSpeedMin, 2, 'reversed bounds are exchanged into a valid range');
    assert.equal(config.randomSpeedMax, 3);

    container.querySelector('[data-task="continual_gesture_1"][data-param="trialSpeedSequence"]').change('1, 3, 2');
    assert.deepEqual(Array.from(config.trialSpeedSequence), [1, 3, 2]);
    assert.deepEqual(Array.from(config.speedLevels), [0.5, 1, 2]);
    assert.equal(manager.isDirty, true);
});

test('continuous task trials accept large integers through 1000 and reject fractional or out of range values', () => {
    const { manager, container } = setup();
    manager.renderExecutionTab();
    const count = container.querySelector('[data-task="continual_gesture_2"][data-param="trialsPerStage"]');
    count.change('1000');
    assert.equal(manager.currentTemplate.execution.continual_gesture_2.trialsPerStage, 1000);
    count.change('1000.5');
    assert.equal(manager.currentTemplate.execution.continual_gesture_2.trialsPerStage, 1000);
    count.change('1001');
    assert.equal(manager.currentTemplate.execution.continual_gesture_2.trialsPerStage, 1000);
});
test('new defaults are present for both tasks and randomized timing is labeled as an estimate', () => {
    const { manager } = setup();
    manager.loadTemplate();
    for (const taskId of ['continual_gesture_1', 'continual_gesture_2']) {
        const config = manager.currentTemplate.execution[taskId];
        assert.equal(config.randomSpeedEnabled, false);
        assert.equal(config.randomSpeedMin, 0.5);
        assert.equal(config.randomSpeedMax, 2);
        assert.equal(config.speedChangeIntervalMin, 0.5);
        assert.equal(config.speedChangeIntervalMax, 1.5);
        assert.equal(config.randomPauseEnabled, false);
        assert.equal(config.pauseDurationMin, 0.3);
        assert.equal(config.pauseDurationMax, 1.2);
        assert.equal(config.pauseIntervalMin, 1);
        assert.equal(config.pauseIntervalMax, 3);
    }
    manager.currentTemplate.tasks = [{ id: 'continual_gesture_1', name: '连续手势采集1', enabled: true }];
    manager.currentTemplate.execution.continual_gesture_1.randomPauseEnabled = true;
    const estimate = manager.renderTimeEstimation();
    assert.match(estimate, /估算约/);
    assert.match(estimate, /Stage超时可能提前终止/);
});
test('continuous 1/2 remove hold controls and ignore legacy hold time in stage estimates; task 3 keeps endpoint hold', () => {
    const { manager, container, estimation } = setup();
    manager.ensureTemplateFields();
    manager.renderExecutionTab();
    for (const taskId of ['continual_gesture_1', 'continual_gesture_2']) {
        assert.equal(container.querySelector(`[data-task="${taskId}"][data-param="holdDuration"]`), null);
        assert.equal(manager.currentTemplate.execution[taskId].holdDuration, undefined);
    }
    assert.ok(container.querySelector('[data-task="continual_gesture_3"][data-param="holdDuration"]'));

    manager.currentTemplate.tasks = [{ id: 'continual_gesture_1', name: '连续手势采集1', enabled: true }];
    manager.currentTemplate.execution.continual_gesture_1 = {
        trialsPerStage: 5, preparationTime: 3, expandDuration: 3, contractDuration: 3,
        restBetweenTrials: 1, holdDuration: 999
    };
    const html = manager.renderTimeEstimation();
    assert.match(html, /37秒/, '5 x (3s expansion + 3s contraction), 4 between-trial rests, and 3s preparation');
    assert.match(html, /单次动作: 7秒/, 'single-trial estimate has no legacy hold duration');
});
test('random fields reject values below their minimum, above limits, and unsafe millisecond conversions', () => {
    const { manager, container } = setup();
    manager.renderExecutionTab();
    const invalidCases = [
        ['randomSpeedMin', '0.009'],
        ['randomSpeedMax', '100.01'],
        ['speedChangeIntervalMin', '0.09'],
        ['speedChangeIntervalMax', '86400.01'],
        ['pauseDurationMin', '0.009'],
        ['pauseDurationMax', '86400.01'],
        ['pauseIntervalMin', '0.09'],
        ['pauseIntervalMax', '86400.01']
    ];
    for (const [param, value] of invalidCases) {
        container.querySelector(`[data-task="continual_gesture_1"][data-param="${param}"]`).change(value);
        assert.equal(manager.currentTemplate.execution.continual_gesture_1[param], {
            randomSpeedMin: 0.5, randomSpeedMax: 2,
            speedChangeIntervalMin: 0.5, speedChangeIntervalMax: 1.5,
            pauseDurationMin: 0.3, pauseDurationMax: 1.2,
            pauseIntervalMin: 1, pauseIntervalMax: 3
        }[param], `${param}=${value} must fall back to its task default`);
    }
});

test('import normalization repairs invalid random values and reversed pairs without changing legacy speed sequences', () => {
    const { manager } = setup();
    const config = manager.currentTemplate.execution.continual_gesture_1;
    config.speedLevels = [0.25, 0.75, 1.5];
    config.trialSpeedSequence = [3, 1, 2];
    config.randomSpeedMin = 101;
    config.randomSpeedMax = 102;
    config.speedChangeIntervalMin = 'not-a-number';
    config.speedChangeIntervalMax = -1;
    config.pauseDurationMin = Infinity;
    config.pauseDurationMax = 0.009;
    config.pauseIntervalMin = 5;
    config.pauseIntervalMax = 2;
    delete config.randomSpeedEnabled;
    delete config.randomPauseEnabled;

    manager.ensureTemplateFields();

    assert.equal(config.randomSpeedEnabled, false);
    assert.equal(config.randomPauseEnabled, false);
    assert.equal(config.randomSpeedMin, 0.5);
    assert.equal(config.randomSpeedMax, 2);
    assert.equal(config.speedChangeIntervalMin, 0.5);
    assert.equal(config.speedChangeIntervalMax, 1.5);
    assert.equal(config.pauseDurationMin, 0.3);
    assert.equal(config.pauseDurationMax, 1.2);
    assert.equal(config.pauseIntervalMin, 2);
    assert.equal(config.pauseIntervalMax, 5);
    assert.deepEqual(Array.from(config.speedLevels), [0.25, 0.75, 1.5]);
    assert.deepEqual(Array.from(config.trialSpeedSequence), [3, 1, 2]);
});

test('editing an imported 101/102 random speed range to 100 leaves both values valid', () => {
    const { manager, container } = setup();
    manager.render = () => {};
    const imported = JSON.parse(JSON.stringify(manager.currentTemplate));
    imported.templateName = 'imported';
    imported.category1 = [];
    imported.execution.continual_gesture_1.randomSpeedMin = 101;
    imported.execution.continual_gesture_1.randomSpeedMax = 102;
    manager.importTemplate({ content: JSON.stringify(imported) });
    const config = manager.currentTemplate.execution.continual_gesture_1;
    manager.renderExecutionTab();

    const maxSpeed = container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedMax"]');
    maxSpeed.change('100');
    assert.equal(config.randomSpeedMin, 0.5);
    assert.equal(config.randomSpeedMax, 100);
    assert.ok(config.randomSpeedMax <= 100);
});

test('rejected random input echoes the effective legacy default and saves the same value', () => {
    const { manager, container, storage } = setup();
    const config = manager.currentTemplate.execution.continual_gesture_1;
    manager.renderExecutionTab();

    const minSpeed = container.querySelector('[data-task="continual_gesture_1"][data-param="randomSpeedMin"]');
    minSpeed.change('not-a-number');
    assert.equal(config.randomSpeedMin, 0.5);
    assert.equal(Number(minSpeed.value), 0.5);

    minSpeed.change('-1');
    assert.equal(config.randomSpeedMin, 0.5);
    assert.equal(Number(minSpeed.value), 0.5);
    manager.saveTemplate();
    assert.equal(JSON.parse(storage.emg_collection_template).execution.continual_gesture_1.randomSpeedMin, Number(minSpeed.value));
});
