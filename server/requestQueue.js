const config = require('./config');

/**
 * Small bounded admission queue.
 *
 * The gateway must not accept unlimited concurrent upstream requests: doing so
 * turns a burst into upstream 429s and long tail latencies. This queue is an
 * admission control layer, not a rate-limit bypass. When it is full or the wait
 * budget expires the caller receives a normal 429 with Retry-After.
 */
function intOr(value, fallback, min) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, parsed);
}

class RequestQueue {
  constructor() {
    this.active = 0;
    this.activeByKey = new Map();
    this.waiters = [];
    this.timer = null;
  }

  _limits() {
    return {
      maxConcurrent: intOr(config.get('queue_max_concurrent'), 8, 1),
      maxPerKey: intOr(config.get('queue_max_per_key'), 4, 1),
      maxQueue: intOr(config.get('queue_max_size'), 100, 0),
      maxWaitMs: intOr(config.get('queue_wait_ms'), 15000, 0)
    };
  }

  _keyActive(key) {
    return this.activeByKey.get(key) || 0;
  }

  _canStart(key, limits) {
    return this.active < limits.maxConcurrent && this._keyActive(key) < limits.maxPerKey;
  }

  _start(key) {
    this.active++;
    this.activeByKey.set(key, this._keyActive(key) + 1);
  }

  _finish(key) {
    this.active = Math.max(0, this.active - 1);
    const next = Math.max(0, this._keyActive(key) - 1);
    if (next === 0) this.activeByKey.delete(key);
    else this.activeByKey.set(key, next);
  }

  _drain() {
    if (this.waiters.length === 0) return;
    const limits = this._limits();
    for (let i = 0; i < this.waiters.length;) {
      const waiter = this.waiters[i];
      if (waiter.cancelled) {
        this.waiters.splice(i, 1);
        continue;
      }
      if (!this._canStart(waiter.key, limits)) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      if (waiter.timer) clearTimeout(waiter.timer);
      this._start(waiter.key);
      waiter.resolve(this._releaseFor(waiter.key));
    }
  }

  _releaseFor(key) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._finish(key);
      this._drain();
    };
  }

  /**
   * Acquire a slot. Returns a release function, or null when the queue is
   * saturated or the wait budget expires.
   */
  async acquire(key = 'anonymous', maxWaitMs = null) {
    const limits = this._limits();
    const waitMs = maxWaitMs === null ? limits.maxWaitMs : Math.max(0, maxWaitMs);

    if (this._canStart(key, limits)) {
      this._start(key);
      return this._releaseFor(key);
    }

    if (this.waiters.length >= limits.maxQueue) return null;

    return new Promise((resolve) => {
      const waiter = {
        key,
        resolve,
        timer: null,
        cancelled: false
      };

      if (waitMs > 0) {
        waiter.timer = setTimeout(() => {
          if (waiter.cancelled) return;
          waiter.cancelled = true;
          const idx = this.waiters.indexOf(waiter);
          if (idx !== -1) this.waiters.splice(idx, 1);
          resolve(null);
        }, waitMs);
        if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
      } else {
        waiter.cancelled = true;
        resolve(null);
        return;
      }

      this.waiters.push(waiter);
      this._drain();
    });
  }

  getStats() {
    const limits = this._limits();
    return {
      active: this.active,
      queued: this.waiters.length,
      activeByKey: Object.fromEntries(this.activeByKey),
      limits
    };
  }
}

const queue = new RequestQueue();
// Expose the class for isolated tests without changing the default singleton.
queue.RequestQueue = RequestQueue;
module.exports = queue;
