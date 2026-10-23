const test = require('node:test');
const assert = require('node:assert/strict');
const { ContinuousGuideMotion, normalizeGuideMotionConfig } = require('../public/scripts/continuous-guide-motion');

function sequenceRandom(values) {
    let index = 0;
    const random = () => values[index++ % values.length];
    random.calls = () => index;
    return random;
}

test('disabled random options preserve elapsed-time progress and fallback speed', () => {
    const random = sequenceRandom([0.2]);
    const motion = new ContinuousGuideMotion({}, { random });
    motion.beginPhase(1000, 100, 1.5);
    assert.equal(motion.advance(300).progress, 0.3);
    assert.equal(motion.advance(500).progress, 0.6);
    assert.equal(motion.advance(900).progress, 1);
    assert.equal(motion.advance(1100).complete, true);
    assert.equal(random.calls(), 0);
});

test('pause freezes progress and timers, then resumes without a jump', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({
        randomPauseEnabled: true,
        pauseIntervalMin: 0.2,
        pauseIntervalMax: 0.2,
        pauseDurationMin: 0.3,
        pauseDurationMax: 0.3
    }, { random: sequenceRandom([0]), onEvent: event => events.push(event) });
    motion.beginPhase(1000, 0);
    assert.equal(motion.advance(200).progress, 0.2);
    assert.equal(motion.advance(200).paused, true);
    assert.equal(motion.advance(350).progress, 0.2);
    assert.equal(motion.advance(500).paused, false);
    assert.equal(motion.advance(500).progress, 0.2);
    assert.equal(motion.advance(600).progress, 0.3);
    assert.deepEqual(events.map(({ type, timeMs }) => [type, timeMs]), [
        ['pause_start', 200], ['pause_end', 500]
    ]);
});

test('random speeds stay within configured range and events carry event times', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({
        randomSpeedEnabled: true,
        randomSpeedMin: 0.5,
        randomSpeedMax: 1.5,
        speedChangeIntervalMin: 0.1,
        speedChangeIntervalMax: 0.1
    }, { random: sequenceRandom([0, 0, 1, 0, 0, 0]), onEvent: event => events.push(event) });
    const initial = motion.beginPhase(1000, 50, 20);
    assert.equal(initial.speedMultiplier, 0.5);
    assert.equal(motion.advance(250).progress, 0.2);
    assert.equal(motion.advance(350).progress, 0.25);
    assert.deepEqual(events.map(({ type, timeMs, speedMultiplier }) => [type, timeMs, speedMultiplier]), [
        ['speed_change', 50, 0.5],
        ['speed_change', 150, 1.5],
        ['speed_change', 250, 0.5],
        ['speed_change', 350, 0.5]
    ]);
    assert.ok(events.every(event => event.speedMultiplier >= 0.5 && event.speedMultiplier <= 1.5));
});

test('one large frame processes all events and preserves elapsed time', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({
        randomPauseEnabled: true,
        pauseIntervalMin: 0.1,
        pauseIntervalMax: 0.1,
        pauseDurationMin: 0.05,
        pauseDurationMax: 0.05
    }, { random: sequenceRandom([0]), onEvent: event => events.push(event) });
    motion.beginPhase(400, 10);
    const result = motion.advance(410);
    assert.equal(result.progress, 0.75);
    assert.deepEqual(events.map(({ type, timeMs }) => [type, timeMs]), [
        ['pause_start', 110], ['pause_end', 160], ['pause_start', 260], ['pause_end', 310], ['pause_start', 410]
    ]);
});

test('stop clears the phase and suppresses future progress and events', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({ randomSpeedEnabled: true }, {
        random: sequenceRandom([0.2]), onEvent: event => events.push(event)
    });
    motion.beginPhase(1000, 0);
    motion.stop();
    const eventCount = events.length;
    assert.deepEqual(motion.advance(500), { progress: 0, paused: false, speedMultiplier: 1, complete: false });
    assert.equal(events.length, eventCount);
});

test('invalid values normalize safely and bounds are sorted', () => {
    const config = normalizeGuideMotionConfig({
        randomSpeedMin: Infinity,
        randomSpeedMax: 0,
        speedChangeIntervalMin: -4,
        speedChangeIntervalMax: 0.05,
        pauseIntervalMin: 4,
        pauseIntervalMax: 1
    });
    assert.equal(config.randomSpeedMin, 0.5);
    assert.equal(config.randomSpeedMax, 2);
    assert.equal(config.speedChangeIntervalMin, 0.1);
    assert.equal(config.speedChangeIntervalMax, 0.5);
    assert.equal(config.pauseIntervalMin, 1);
    assert.equal(config.pauseIntervalMax, 4);
    const clamped = normalizeGuideMotionConfig({
        randomSpeedMin: 1000,
        randomSpeedMax: 2000,
        pauseDurationMin: 0.001,
        pauseDurationMax: 90000,
        pauseIntervalMin: 0,
        pauseIntervalMax: Infinity
    });
    assert.equal(clamped.randomSpeedMin, 100);
    assert.equal(clamped.randomSpeedMax, 100);
    assert.equal(clamped.pauseDurationMin, 0.01);
    assert.equal(clamped.pauseDurationMax, 86400);
    assert.equal(clamped.pauseIntervalMin, 1);
    assert.equal(clamped.pauseIntervalMax, 3);

    const events = [];
    const motion = new ContinuousGuideMotion({ randomSpeedEnabled: true }, {
        random: () => 0, onEvent: event => events.push(event)
    });
    motion.beginPhase(NaN, NaN, Infinity);
    assert.equal(motion.advance(2).progress, 1);
    assert.equal(events.length, 1);
});

test('event guard completes simultaneous events and later advances can continue', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({
        randomSpeedEnabled: true,
        randomSpeedMin: 1,
        randomSpeedMax: 1,
        speedChangeIntervalMin: 0.1,
        speedChangeIntervalMax: 0.1,
        randomPauseEnabled: true,
        pauseIntervalMin: 0.1,
        pauseIntervalMax: 0.1,
        pauseDurationMin: 0.01,
        pauseDurationMax: 0.01
    }, { random: () => 0, onEvent: event => events.push(event) });
    motion.beginPhase(1e12, 0);
    motion.advance(1_000_000);
    assert.deepEqual(events.slice(-2).map(event => event.type), ['speed_change', 'pause_start']);
    const before = motion.advance(1_000_100).progress;
    const after = motion.advance(1_000_200).progress;
    assert.ok(after > before);
});

test('phase completes exactly without trailing random pause events', () => {
    const events = [];
    const motion = new ContinuousGuideMotion({
        randomPauseEnabled: true,
        pauseIntervalMin: 0.1,
        pauseIntervalMax: 0.1,
        pauseDurationMin: 1,
        pauseDurationMax: 1
    }, { random: sequenceRandom([0]), onEvent: event => events.push(event) });
    motion.beginPhase(100, 0);
    const result = motion.advance(1000);
    assert.equal(result.progress, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(events, []);
});

test('randomized schedules are invariant to frame timing across 500 seeded scenarios', () => {
    function rng(seed) {
        return () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
        };
    }
    for (let seed = 1; seed <= 500; seed++) {
        const input = rng(seed + 1000);
        const config = {
            randomSpeedEnabled: seed % 3 !== 0,
            randomPauseEnabled: seed % 4 !== 0,
            randomSpeedMin: 0.1 + input(), randomSpeedMax: 1.2 + input() * 3,
            speedChangeIntervalMin: 0.1 + input(), speedChangeIntervalMax: 1.5 + input(),
            pauseDurationMin: 0.01 + input() / 5, pauseDurationMax: 0.5 + input(),
            pauseIntervalMin: 0.1 + input(), pauseIntervalMax: 1.5 + input()
        };
        const duration = 500 + input() * 10000;
        const horizon = 1000 + input() * 20000;
        const fallback = 0.2 + input() * 3;
        const coarseEvents = [], fineEvents = [];
        const coarse = new ContinuousGuideMotion(config, { random: rng(seed), onEvent: e => coarseEvents.push(e) });
        const fine = new ContinuousGuideMotion(config, { random: rng(seed), onEvent: e => fineEvents.push(e) });
        coarse.beginPhase(duration, 0, fallback);
        fine.beginPhase(duration, 0, fallback);
        let previous = 0;
        for (let time = 17; time < horizon; time += 17) {
            const state = fine.advance(time);
            assert.ok(state.progress >= previous && state.progress <= 1, `seed ${seed}: monotonic progress`);
            previous = state.progress;
        }
        const actual = coarse.advance(horizon), expected = fine.advance(horizon);
        assert.ok(Math.abs(actual.progress - expected.progress) < 1e-9, `seed ${seed}: frame-dependent progress`);
        assert.equal(actual.paused, expected.paused, `seed ${seed}: paused state`);
        assert.equal(actual.complete, expected.complete, `seed ${seed}: completion`);
        assert.equal(coarseEvents.length, fineEvents.length, `seed ${seed}: event count`);
        for (let i = 0; i < coarseEvents.length; i++) {
            const a = coarseEvents[i], b = fineEvents[i];
            assert.equal(a.type, b.type, `seed ${seed}: event order`);
            assert.ok(Math.abs(a.timeMs - b.timeMs) < 1e-6, `seed ${seed}: event clock`);
            assert.equal(a.speedMultiplier, b.speedMultiplier, `seed ${seed}: speed`);
            assert.equal(a.durationMs, b.durationMs, `seed ${seed}: pause duration`);
        }
    }
});
