// Collection watch is explicitly started and has at most one capture/claim chain.
// Backend leases and its durable inbox remain authoritative across closed pages.
(function (global) {
  'use strict';
  const CHOICES = Object.freeze({intervalSeconds:[1,2,5]});
  function create(options) {
    const schedule = options.schedule || ((callback, delay) => global.setTimeout(callback, delay));
    const cancel = options.cancel || (timer => global.clearTimeout(timer));
    let active = false, busy = false, detached = false, generation = 0, timer = null, lease = null, context = null;
    let added = 0, queued = 0, settings = null, release = Promise.resolve();
    let lastStatus = 'off', lastMessage = '';
    let idleWaiters = [];
    function idle() { const waiters=idleWaiters;idleWaiters=[];for(const resolve of waiters) resolve(); }
    function whenIdle() { return busy ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve(); }
    function snapshot(status, message) {
      return {active,busy,status,message,added,queued,lease,context,settings:settings && {...settings}};
    }
    function publish(status = lastStatus, message) { if (detached) return; if (message === undefined) message = status === lastStatus ? lastMessage : ''; lastStatus = status; lastMessage = message; options.onStatus?.(snapshot(status,message)); }
    function valid(token, capturedContext) {
      if (active && token === generation && !options.canRun(capturedContext)) stop('Collection changed');
      return active && token === generation;
    }
    function stop(reason = 'Stopped') {
      const closingLease = lease, closingContext = context;
      active = false; generation++;
      if (timer !== null) { cancel(timer); timer = null; }
      lease = null;
      publish('stopped',reason);
      if (closingLease) {
        release = Promise.resolve(options.close(closingLease,closingContext)).catch(() => {});
      }
      return release;
    }
    function next(token, capturedContext, delay) {
      if (!valid(token,capturedContext)) { if (active) stop('Collection changed'); return; }
      timer = schedule(() => { timer = null; void tick(token,capturedContext); },Math.max(1000,Math.min(delay,60000)));
    }
    async function tick(token, capturedContext) {
      if (!valid(token,capturedContext) || busy) return;
      busy = true; publish('checking');
      try {
        const result = await options.scan(lease,capturedContext);
        if (!valid(token,capturedContext)) return;
        const count = result.added_count ?? 0;
        if (!Number.isInteger(count) || count < 0 || count > 5) throw new Error('Capture admission exceeded the per-frame limit');
        queued = result.summary?.total ?? result.queued_count ?? queued;
        if (!Number.isInteger(queued) || queued < 0 || Number.isFinite(settings.queueLimit) && queued > settings.queueLimit) throw new Error('Capture queue exceeded its limit');
        if (count) {
          // Claiming never acknowledges/deletes the server's protected inbox.
          // A stop during this await prevents local merge, while reload can recover it.
          await options.onBatch(result,capturedContext,() => valid(token,capturedContext));
          if (!valid(token,capturedContext)) return;
          added += count;
        }
        if (Number.isFinite(settings.queueLimit) && queued >= settings.queueLimit || result.status === 'queue_full') { stop('Queue full'); return; }
        const status = count ? 'added' : 'waiting';
        publish(status);
        next(token,capturedContext,Math.max(settings.intervalSeconds * 1000,(result.retry_after_seconds || 0) * 1000));
      } catch (error) {
        if (valid(token,capturedContext)) { stop(`Watch stopped: ${error.message}`); publish('error',error.message); }
      } finally { busy = false; idle(); if (!active) publish(); }
    }
    function detach() {
      detached = true; active = false; generation++;
      if (timer !== null) { cancel(timer); timer = null; }
    }
    async function start(config, existingLease = null) {
      if (active || busy) return false;
      for (const key of Object.keys(CHOICES)) if (!CHOICES[key].includes(config[key])) throw new Error(`Unsupported watch setting: ${key}`);
      const capturedContext = options.getContext();
      if (!options.canRun(capturedContext)) return false;
      const startingGeneration = generation;
      await release;
      // Waiting for a previous lease close cannot authorize a changed context.
      if (startingGeneration !== generation || active || busy || !options.canRun(capturedContext)) return false;
      settings = {...config,queueLimit:config.queueMode==='paged' ? 5000 : config.queueLimit}; context = capturedContext; added = 0; queued = options.queuedCount?.() || 0;
      if (Number.isFinite(settings.queueLimit) && queued >= settings.queueLimit) { publish('stopped','Queue full'); return false; }
      const token = ++generation;
      detached = false; active = true; busy = true; publish('starting');
      try {
        const opened = existingLease ? {lease_id:existingLease} : await options.open(settings,capturedContext);
        if (!valid(token,capturedContext)) {
          if (opened.lease_id) await Promise.resolve(options.close(opened.lease_id,capturedContext)).catch(() => {});
          return false;
        }
        if (!opened.lease_id) throw new Error('Watch lease was not created');
        lease = opened.lease_id;
        queued = opened.summary?.total ?? opened.queued_count ?? queued;
        publish('recording');
      } catch (error) {
        if (valid(token,capturedContext)) { stop(`Watch stopped: ${error.message}`); publish('error',error.message); }
        return false;
      } finally { busy = false; idle(); if (!active) publish(); }
      if (!valid(token,capturedContext)) return false;
      await tick(token,capturedContext);
      return true;
    }
    return Object.freeze({start,stop,detach,isActive:() => active,isBusy:() => busy,whenIdle,getState:() => snapshot(lastStatus,lastMessage),recordQueued:count => { if (Number.isInteger(count) && count >= 0) { queued=count;publish(); } }});
  }
  global.CollectorWatchCapture = Object.freeze({create,choices:CHOICES});
})(typeof window === 'undefined' ? globalThis : window);
