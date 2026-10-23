'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(task, template = {}) {
    let now = 0;
    let nextTimer = 1;
    const timers = new Map();
    const sent = [];
    const window = {
        addEventListener() {},
        collectionController: { sendToRealtimeEngine: (type, data) => sent.push({ type, ...data }) }
    };
    const context = vm.createContext({
        window, performance: { now: () => now }, Date, Math,
        console: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => JSON.stringify({ execution: { [`continual_gesture_${task}`]: template } }) },
        setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
        clearTimeout: id => timers.delete(id), requestAnimationFrame() {}, cancelAnimationFrame() {}
    });
    context.window = context;
    context.collectionController = window.collectionController;
    for (const file of ['continuous-guide-motion.js', `continual-gesture-${task}-animation.js`]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/scripts', file), 'utf8'), context);
    }
    const animation = context[`continualGesture${task}Animation`];
    animation.canvas = { style: {}, focus() {}, addEventListener() {}, removeEventListener() {} };
    animation.resizeCanvas = () => {};
    animation.animate = () => {};
    return {
        animation, timers, sent,
        advance(time) { now = time; animation.updateGuideRadius(); },
        runTrial() {
            const id = animation._trialTimer;
            const callback = timers.get(id).callback;
            timers.delete(id);
            callback();
        }
    };
}

for (const task of [1, 2]) {
    test(`gesture ${task}: legacy holdDuration is ignored and expansion joins contraction at max radius`, () => {
        const h = load(task, { expandDuration: 20, randomSpeedEnabled: true, randomSpeedMin: 99 });
        let completed = 0;
        const params = { trialsPerStage: 1, expandDuration: 4, holdDuration: 999,
            contractDuration: 4, speedLevels: [2], trialSpeedSequence: [1] };
        h.animation.start({ name: 'test' }, () => completed++, () => {}, params);
        assert.equal(h.animation.baseExpandDuration, 4000);
        assert.equal(h.animation.guideMotionParams.randomSpeedEnabled, undefined);
        h.runTrial();
        h.advance(1000);
        assert.ok(Math.abs(h.animation.guideRadius - h.animation.maxRadius / 2) < 1e-8);
        h.advance(2000);
        assert.equal(h.animation.phase, 'contract');
        assert.equal(h.animation.guideRadius, h.animation.maxRadius, 'the transition frame reaches the maximum radius');
        h.advance(2001);
        assert.ok(h.animation.guideRadius < h.animation.maxRadius, 'contraction starts on the next frame');
        h.advance(3000);
        assert.ok(Math.abs(h.animation.guideRadius - h.animation.maxRadius / 2) < 1e-8);
        h.advance(4000);
        assert.equal(completed, 1);
        assert.equal(h.animation.isRunning, false);
        assert.deepEqual(h.sent.filter(p => p.type === 'prompt').map(p => p.name), ['start', 'end']);
    });

    test(`gesture ${task}: random pause freezes guide while input and collection remain active`, () => {
        const h = load(task);
        h.animation.start({ name: 'test' }, () => {}, () => {}, {
            trialsPerStage: 2, expandDuration: 4, holdDuration: 0, contractDuration: 4,
            randomSpeedEnabled: true, randomSpeedMin: 2, randomSpeedMax: 2,
            speedChangeIntervalMin: 1, speedChangeIntervalMax: 1,
            randomPauseEnabled: true, pauseIntervalMin: 0.5, pauseIntervalMax: 0.5,
            pauseDurationMin: 1, pauseDurationMax: 1
        });
        h.runTrial();
        h.advance(500);
        const radius = h.animation.guideRadius;
        h.advance(1000);
        assert.equal(h.animation.guideRadius, radius);
        assert.equal(h.animation._guidePaused, true);
        assert.equal(h.animation.isRunning, true);
        h.advance(1500);
        assert.equal(h.animation.guideRadius, radius);
        h.advance(1600);
        assert.ok(h.animation.guideRadius > radius);
        // Continue through both motion phases, including the random freezes.
        let time = 1600;
        while (h.animation.phase === 'expand' && time < 30000) {
            time += 500;
            h.advance(time);
        }
        assert.equal(h.animation.phase, 'contract');
        while (h.animation.phase === 'contract' && time < 60000) {
            time += 500;
            h.advance(time);
        }
        assert.equal(h.animation.phase, 'rest', 'finishing contraction advances the Trial into its inter-trial rest');
        const events = h.sent.filter(p => p.name?.startsWith('guide_motion:'));
        const details = events.map(p => JSON.parse(p.name.slice('guide_motion:'.length)));
        assert.ok(details.some(p => p.type === 'speed_change' && p.speedMultiplier === 2 && p.phase === 'expand'));
        assert.ok(details.some(p => p.type === 'pause_start' && p.durationMs === 1000 && p.phase === 'expand'));
        assert.ok(details.some(p => p.type === 'pause_end' && p.phase === 'expand'));
        assert.ok(details.some(p => p.type === 'speed_change' && p.phase === 'contract'));
        assert.ok(details.some(p => p.type === 'pause_start' && p.phase === 'contract'));
        assert.ok(details.some(p => p.type === 'pause_end' && p.phase === 'contract'));
        assert.ok(events.every(p => Number.isFinite(p.timestamp)));
        assert.ok(h.sent.every(p => p.type === 'prompt'));
        h.animation.stop();
    });

    test(`gesture ${task}: stop cancels pending trials and stage timeout, restart does not inherit old motion`, () => {
        const h = load(task);
        const params = { trialsPerStage: 2, expandDuration: 1, holdDuration: 0,
            contractDuration: 1, restBetweenTrials: 0 };
        h.animation.start({ name: 'first' }, () => {}, () => {}, params);
        assert.equal(h.timers.size, 2);
        h.animation.stop();
        assert.equal(h.timers.size, 0);
        h.animation.startTrial();
        assert.equal(h.sent.length, 0);
        h.animation.start({ name: 'second' }, () => {}, () => {}, params);
        h.runTrial();
        h.advance(1000); h.advance(1000); h.advance(2000);
        assert.equal(h.animation.phase, 'rest');
        assert.equal(h.timers.get(h.animation._trialTimer).delay, 0);
        h.animation.stop();
        assert.equal(h.timers.size, 0);
    });
}
