// Presentation only: admitted crops remain in the collector queue even if this
// animation is cancelled. Never starts capture or changes a label.
(function (global) {
  'use strict';
  let current = null;

  function projectRegion(width, height, box, rect) {
    const values = [width,height,box.left,box.top,box.width,box.height,rect.x,rect.y,rect.w,rect.h];
    if (!values.every(Number.isFinite) || width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0 || rect.w <= 0 || rect.h <= 0 || rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) return null;
    const scale = Math.min(box.width / width, box.height / height);
    return {left:box.left + (box.width - width * scale) / 2 + rect.x * scale,
      top:box.top + (box.height - height * scale) / 2 + rect.y * scale,
      width:rect.w * scale,height:rect.h * scale};
  }

  function paintTwice() {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; global.clearTimeout(timeout); resolve(); } };
      const timeout = global.setTimeout(finish, 200);
      if (global.document.hidden || !global.requestAnimationFrame) return finish();
      global.requestAnimationFrame(() => global.requestAnimationFrame(finish));
    });
  }

  function node(tag, className, text) {
    const element = global.document.createElement(tag);
    element.className = className;
    if (text) element.textContent = text;
    return element;
  }
  function place(element, box) {
    Object.assign(element.style, {left:`${box.left}px`,top:`${box.top}px`,width:`${box.width}px`,height:`${box.height}px`});
  }
  function wait(run, ms) {
    return new Promise(resolve => {
      const finish = () => { global.clearTimeout(timer); run.waits.delete(finish); resolve(); };
      const timer = global.setTimeout(finish, ms);
      run.waits.add(finish);
      if (run.cancelled) finish();
    });
  }
  function motion(run, element, frames, duration, delay = 0) {
    if (!element.animate) return wait(run, duration + delay);
    const animation = element.animate(frames, {duration,delay,easing:'cubic-bezier(.2,.75,.25,1)',fill:'both'});
    run.animations.push(animation);
    // A bounded fallback also covers browser animation cancellation/backgrounding.
    return Promise.race([animation.finished.catch(() => {}),wait(run,duration + delay + 100)]);
  }
  function cleanup(run) {
    if (run.cleaned) return;
    run.cleaned = true;
    for (const animation of run.animations) { try { animation.cancel(); } catch {} }
    for (const finish of [...run.waits]) finish();
    for (const [element, visibility] of run.hiddenTargets) element.style.visibility = visibility;
    run.root?.remove();
    if (current === run) current = null;
  }
  function cancel() {
    if (!current) return;
    current.cancelled = true;
    cleanup(current);
  }
  function loadFrame(run, url) {
    return new Promise(resolve => {
      const image = new global.Image();
      let done = false;
      const finish = success => {
        if (done) return;
        done = true;
        global.clearTimeout(timeout);
        image.onload = image.onerror = null;
        run.waits.delete(abort);
        resolve(success ? image : null);
      };
      const abort = () => { finish(false); image.removeAttribute('src'); };
      const timeout = global.setTimeout(abort, 3000);
      run.waits.add(abort);
      image.onload = () => finish(image.naturalWidth > 0 && image.naturalHeight > 0);
      image.onerror = () => finish(false);
      image.src = url;
      if (image.complete && image.naturalWidth) finish(true);
    });
  }

  async function present({frame,regions,targets,prepareTargets,isCurrent = () => true}) {
    if (!frame || !Array.isArray(regions) || !regions.length || !frame.image_url || !isCurrent()) return {shown:false};
    cancel();
    const run = {cancelled:false,cleaned:false,root:null,animations:[],waits:new Set(),hiddenTargets:new Map()};
    current = run;
    const valid = () => !run.cancelled && isCurrent() && !global.document.hidden;
    let shown = false;
    let prepared = false;
    const destinations = () => {
      prepared = true;
      return new Map((prepareTargets ? prepareTargets() : targets || []).map(target => [target.sampleKey,target.element]));
    };
    try {
      const image = await loadFrame(run,frame.image_url);
      if (!image || !valid()) return {shown:false};
      const width = frame.frame_width || image.naturalWidth;
      const height = frame.frame_height || image.naturalHeight;
      if (width !== image.naturalWidth || height !== image.naturalHeight) return {shown:false,reason:'geometry-changed'};
      const reduced = !!global.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const root = node('div','capture-arrival');
      root.setAttribute('aria-label','New capture');
      const backdrop = node('div','capture-arrival-backdrop');
      const panel = node('section','capture-arrival-panel');
      const header = node('div','capture-arrival-header');
      header.append(node('strong','',frame.game_id || 'New capture'),node('span','',`${regions.length} new ${regions.length === 1 ? 'crop' : 'crops'}`));
      const stage = node('div','capture-arrival-stage');
      image.className = 'capture-arrival-frame'; image.alt = 'Full admitted capture';
      stage.appendChild(image); panel.append(header,stage); root.append(backdrop,panel);
      run.root = root;
      global.document.body.appendChild(root);
      await paintTwice();
      if (!valid()) return {shown:false};
      shown = true;
      if (reduced) { destinations(); await wait(run,300); return {shown:true,reducedMotion:true}; }
      await motion(run,panel,[{opacity:0,transform:'translateY(8px) scale(.99)'},{opacity:1,transform:'none'}],130);
      if (!valid()) return {shown};
      const imageBox = image.getBoundingClientRect();
      const flash = node('div','capture-arrival-flash');
      flash.setAttribute('aria-hidden','true');
      place(flash,projectRegion(width,height,imageBox,{x:0,y:0,w:width,h:height}));
      root.appendChild(flash);
      await motion(run,flash,[{opacity:0},{opacity:.42,offset:.2},{opacity:0}],150);
      flash.remove();
      if (!valid()) return {shown};
      const entries = [];
      for (const region of regions.slice(0,128)) {
        const box = region.rect && projectRegion(width,height,imageBox,region.rect);
        if (!box) continue;
        const outline = node('div','capture-arrival-region');
        outline.setAttribute('aria-hidden','true'); place(outline,box); root.appendChild(outline);
        const key = region.sample_key || `${region.id}:${region.phash || ''}:${region.source || frame.source || ''}`;
        if (!region.image_url && !region.base64_image) continue;
        const ghost = node('img','capture-arrival-crop');
        ghost.src = region.image_url || `data:image/png;base64,${region.base64_image}`;
        ghost.alt = ''; ghost.setAttribute('aria-hidden','true'); place(ghost,box);
        root.appendChild(ghost);
        entries.push({ghost,key,region,box,outline});
      }
      await wait(run,180);
      if (!valid()) return {shown};
      // Insert the new cards only now, so their FLIP pushdown happens together
      // with the crop flight rather than before the preview has even appeared.
      const byKey = destinations();
      // Fade the source away as the already-cropped pixels travel to their cards.
      const flights = [motion(run,panel,[{opacity:1},{opacity:0}],280),motion(run,backdrop,[{opacity:1},{opacity:0}],380)];
      entries.forEach(({ghost,key,region,box,outline},index) => {
        outline.remove();
        const card = byKey.get(key);
        const destination = card?.matches?.('img') ? card : card?.querySelector('img');
        const targetBox = destination && projectRegion(region.rect.w,region.rect.h,destination.getBoundingClientRect(),{x:0,y:0,w:region.rect.w,h:region.rect.h});
        if (!targetBox) { ghost.remove(); return; }
        run.hiddenTargets.set(destination,destination.style.visibility);
        destination.style.visibility = 'hidden';
        flights.push(motion(run,ghost,[{transform:'none',opacity:1},{transform:`translate(${targetBox.left-box.left}px,${targetBox.top-box.top}px) scale(${targetBox.width/box.width},${targetBox.height/box.height})`,opacity:1}],480,Math.min(index*55,220)).then(() => {
          if (!run.cancelled) destination.style.visibility = run.hiddenTargets.get(destination) || '';
          ghost.remove();
        }));
      });
      await Promise.all(flights);
      return {shown};
    } catch {
      // A presentation failure must never discard an admitted sample or strand Stop.
      return {shown,reason:'presentation-unavailable'};
    } finally {
      cleanup(run);
      if (!prepared && isCurrent() && !global.document.hidden) {
        try { destinations(); } catch {}
      }
      // The caller schedules its next screenshot only after the overlay is gone
      // and two compositor frames have had a chance to paint the real table.
      await paintTwice();
    }
  }
  global.CollectorCaptureAnimation = Object.freeze({present,cancel,projectRegion});
})(typeof window === 'undefined' ? globalThis : window);
