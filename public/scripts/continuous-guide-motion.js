(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.ContinuousGuideMotion = api.ContinuousGuideMotion;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DEFAULTS = {
        randomSpeedEnabled: false,
        randomSpeedMin: 0.5,
        randomSpeedMax: 2,
        speedChangeIntervalMin: 0.5,
        speedChangeIntervalMax: 1.5,
        randomPauseEnabled: false,
        pauseDurationMin: 0.3,
        pauseDurationMax: 1.2,
        pauseIntervalMin: 1,
        pauseIntervalMax: 3
    };
    const MAX_EVENTS_PER_ADVANCE = 10000;

    function finiteOr(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function orderedPair(config, minKey, maxKey, fallbackMin, fallbackMax, floor, ceiling) {
        const sanitize = (value, fallback) => {
            if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) value = fallback;
            return Math.min(ceiling, Math.max(floor, value));
        };
        let min = sanitize(config[minKey], fallbackMin);
        let max = sanitize(config[maxKey], fallbackMax);
        if (min > max) [min, max] = [max, min];
        return [min, max];
    }

    function normalizeGuideMotionConfig(input = {}) {
        const source = input && typeof input === 'object' ? input : {};
        const result = {
            randomSpeedEnabled: source.randomSpeedEnabled === true,
            randomPauseEnabled: source.randomPauseEnabled === true
        };
        [result.randomSpeedMin, result.randomSpeedMax] = orderedPair(source, 'randomSpeedMin', 'randomSpeedMax', DEFAULTS.randomSpeedMin, DEFAULTS.randomSpeedMax, 0.01, 100);
        [result.speedChangeIntervalMin, result.speedChangeIntervalMax] = orderedPair(source, 'speedChangeIntervalMin', 'speedChangeIntervalMax', DEFAULTS.speedChangeIntervalMin, DEFAULTS.speedChangeIntervalMax, 0.1, 86400);
        [result.pauseDurationMin, result.pauseDurationMax] = orderedPair(source, 'pauseDurationMin', 'pauseDurationMax', DEFAULTS.pauseDurationMin, DEFAULTS.pauseDurationMax, 0.01, 86400);
        [result.pauseIntervalMin, result.pauseIntervalMax] = orderedPair(source, 'pauseIntervalMin', 'pauseIntervalMax', DEFAULTS.pauseIntervalMin, DEFAULTS.pauseIntervalMax, 0.1, 86400);
        return result;
    }

    class ContinuousGuideMotion {
        constructor(params = {}, { random = Math.random, onEvent = () => {} } = {}) {
            this.config = normalizeGuideMotionConfig(params);
            this.random = typeof random === 'function' ? random : Math.random;
            this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
            this.stop();
        }

        _sample(min, max) {
            let value;
            try { value = this.random(); } catch (_) { value = 0.5; }
            value = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
            return min + (max - min) * value;
        }

        _emit(event, timeMs = this.lastNowMs) {
            try { this.onEvent({ ...event, timeMs }); } catch (_) { /* Logging must not interrupt animation. */ }
        }

        _sampleSpeed(emit = true, timeMs = this.lastNowMs) {
            this.speedMultiplier = this.config.randomSpeedEnabled
                ? this._sample(this.config.randomSpeedMin, this.config.randomSpeedMax)
                : this.fallbackMultiplier;
            if (emit && this.config.randomSpeedEnabled) {
                this._emit({ type: 'speed_change', speedMultiplier: this.speedMultiplier }, timeMs);
            }
            if (this.config.randomSpeedEnabled) {
                this.speedRemainingMs = this._sample(this.config.speedChangeIntervalMin, this.config.speedChangeIntervalMax) * 1000;
            } else {
                this.speedRemainingMs = Infinity;
            }
        }

        _samplePauseInterval() {
            this.pauseRemainingMs = this.config.randomPauseEnabled
                ? this._sample(this.config.pauseIntervalMin, this.config.pauseIntervalMax) * 1000
                : Infinity;
        }

        beginPhase(baseDurationMs, nowMs, fallbackMultiplier = 1) {
            const duration = finiteOr(baseDurationMs, 1);
            const now = finiteOr(nowMs, 0);
            this.active = true;
            this.complete = false;
            this.progressWorkMs = 0;
            this.baseDurationMs = Math.min(Number.MAX_SAFE_INTEGER, Math.max(Number.EPSILON, duration));
            this.lastNowMs = now;
            const fallback = finiteOr(fallbackMultiplier, 1);
            this.fallbackMultiplier = fallback > 0 ? Math.min(100, Math.max(0.01, fallback)) : 1;
            this.paused = false;
            this.pauseLeftMs = 0;
            this._sampleSpeed(true, now);
            this._samplePauseInterval();
            return this.advanceResult();
        }

        advanceResult() {
            return {
                progress: this.baseDurationMs ? Math.min(1, this.progressWorkMs / this.baseDurationMs) : 0,
                paused: this.active && this.paused,
                speedMultiplier: this.speedMultiplier,
                complete: this.complete
            };
        }

        advance(nowMs) {
            if (!this.active) return this.advanceResult();
            const now = finiteOr(nowMs, this.lastNowMs);
            let remainingWallMs = Math.max(0, now - this.lastNowMs);
            const frameStartMs = this.lastNowMs;
            this.lastNowMs = Math.max(this.lastNowMs, now);
            let eventCount = 0;

            const currentTimeMs = () => frameStartMs + (Math.max(0, now - frameStartMs) - remainingWallMs);

            while (this.active && remainingWallMs > 0) {
                if (this.paused) {
                    const step = Math.min(remainingWallMs, this.pauseLeftMs);
                    this.pauseLeftMs -= step;
                    remainingWallMs -= step;
                    if (this.pauseLeftMs <= 1e-9) {
                        this.paused = false;
                        this._emit({ type: 'pause_end', speedMultiplier: this.speedMultiplier }, currentTimeMs());
                        this._samplePauseInterval();
                        if (++eventCount >= MAX_EVENTS_PER_ADVANCE) break;
                    }
                    continue;
                }

                const workLeft = this.baseDurationMs - this.progressWorkMs;
                const toComplete = workLeft / this.speedMultiplier;
                const toSpeed = this.config.randomSpeedEnabled ? this.speedRemainingMs : Infinity;
                const toPause = this.config.randomPauseEnabled ? this.pauseRemainingMs : Infinity;
                const step = Math.min(remainingWallMs, toComplete, toSpeed, toPause);
                if (!(step > 0)) break;

                const work = step * this.speedMultiplier;
                this.progressWorkMs = Math.min(this.baseDurationMs, this.progressWorkMs + work);
                remainingWallMs -= step;
                if (this.config.randomSpeedEnabled) this.speedRemainingMs -= step;
                if (this.config.randomPauseEnabled) this.pauseRemainingMs -= step;

                // Completion wins ties: a phase ending cannot start a trailing pause/change.
                if (this.progressWorkMs >= this.baseDurationMs - 1e-9) {
                    this.progressWorkMs = this.baseDurationMs;
                    this.active = false;
                    this.complete = true;
                    this.paused = false;
                    break;
                }

                if (this.config.randomSpeedEnabled && this.speedRemainingMs <= 1e-9) {
                    this._sampleSpeed(true, currentTimeMs());
                    eventCount++;
                }
                if (this.config.randomPauseEnabled && this.pauseRemainingMs <= 1e-9) {
                    const durationMs = this._sample(this.config.pauseDurationMin, this.config.pauseDurationMax) * 1000;
                    this.paused = true;
                    this.pauseLeftMs = durationMs;
                    this._emit({ type: 'pause_start', speedMultiplier: this.speedMultiplier, durationMs }, currentTimeMs());
                    eventCount++;
                }
                // Finish all events at this timestamp before applying the guard. Otherwise a
                // coincident pause timer could remain at zero and stall the next advance.
                if (eventCount >= MAX_EVENTS_PER_ADVANCE) break;
            }

            // The event guard intentionally drops any unprocessed part of this frame to bound work.
            return this.advanceResult();
        }

        stop() {
            this.active = false;
            this.complete = false;
            this.paused = false;
            this.progressWorkMs = 0;
            this.baseDurationMs = 0;
            this.lastNowMs = 0;
            this.speedMultiplier = 1;
            this.fallbackMultiplier = 1;
            this.speedRemainingMs = Infinity;
            this.pauseRemainingMs = Infinity;
            this.pauseLeftMs = 0;
        }
    }

    return { ContinuousGuideMotion, normalizeGuideMotionConfig };
});
