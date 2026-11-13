function recoverCompletedResult(saved, recorded, score) {
  if(typeof isContinuousReview!=='function' || !isContinuousReview()) return null;
  const fields=['score','maxCombo','avgTime','rpm','items','autoCompletePct','pointsPerRegion'];
  const valid=data=>data && fields.every(key=>Number.isFinite(data[key]) && data[key]>=0);
  if(saved?.run_id===reviewBatch.batch_id && valid(saved.data)) return {...saved,data:{...saved.data}};
  if(!recorded || score!==0 || !streamStats?.complete || !streamStats.items) return null;
  // Older checkpoints reset the game before retaining its result. Reuse an exact,
  // unique history record; never estimate a score from the retained crop window.
  const average=streamStats.time/streamStats.items;
  const matches=globalHistory.filter(row=>valid(row) && row.items===streamStats.items && row.avgTime===Math.round(average) && row.rpm===Number((60000/average).toFixed(1)));
  if(matches.length!==1) return null;
  return {run_id:reviewBatch.batch_id,data:Object.fromEntries(fields.map(key=>[key,matches[0][key]])),history_saved:true,source_history_timestamp:matches[0].timestamp};
}

async function showLabelingStats() {
  if(typeof updateStepperButtons==='function') updateStepperButtons();
  else if(typeof updateQueueControls==='function') updateQueueControls();
  document.getElementById("labeling-hud").classList.add("hidden");
  const statsCard = document.getElementById("labeling-stats-card");
  statsCard.classList.remove("hidden");
  statsCard.classList.remove("stats-card-gold");
  document.getElementById("stats-badge-container").innerHTML = "";
  
  const labeledItems = pool.filter(p => p.labelTime !== undefined && !p.discarded);
  const paged = typeof queueMode !== 'undefined' && queueMode;
  const continuous = typeof isContinuousReview==='function' && isContinuousReview();
  const batchOnly = !continuous && paged && (queueSummary?.total || 0)>pool.length;
  const completed = paged ? queueCompletedStats : {items:0,time:0};
  const sessionItems = completed.items+labeledItems.length;
  const totalItems = continuous ? streamStats?.items || 0 : batchOnly ? labeledItems.length : sessionItems;
  const times = labeledItems.map(p => p.labelTime);
  const totalTime = continuous ? streamStats?.time || 0 : times.reduce((a, b) => a + b, 0)+(batchOnly ? 0 : completed.time);
  const avgTime = totalItems ? totalTime / totalItems : 0;
  const rpm = avgTime > 0 ? (60000 / avgTime).toFixed(1) : 0;
  const autoCompPct = (continuous ? totalItems : sessionItems) ? Math.round((autoCompletes / (continuous ? totalItems : sessionItems)) * 100) : 0;
  const ppr = totalItems ? Math.round(sessionScore / totalItems) : 0;
  
  let sessionData = {
    score: sessionScore,
    maxCombo: maxCombo,
    avgTime: Math.round(avgTime),
    rpm: parseFloat(rpm),
    items: totalItems,
    autoCompletePct: autoCompPct,
    pointsPerRegion: ppr
  };

  if(window.CollectorBackgroundLists) { try { await refreshCompletionHistory(); } catch(error) { showToast(`History unavailable: ${error.message}`,"error");return; } }
  let resultSnapshot = null;
  if(continuous) {
    queueCompletedResult=recoverCompletedResult(queueCompletedResult,queueCompletionRecorded,sessionScore) || {
      run_id:reviewBatch.batch_id,data:{...sessionData},history_saved:false
    };
    resultSnapshot=queueCompletedResult;
    sessionData={...resultSnapshot.data};
    await saveSessionProgress(true);
  }

  // Save session history to backend (once)
  if (!batchOnly && sessionData.score > 0 && (continuous ? !resultSnapshot.history_saved : !highscoreAdded)) {
    try {
      if(continuous && !window.CollectorBackgroundLists) globalHistory=await (await datasetFetch('/api/get_session_history')).json();
      const existing=continuous && globalHistory.some(row=>row.review_run_id===reviewBatch.batch_id);
      if(!existing) await datasetFetch("/api/save_session_history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({...sessionData,...(continuous ? {review_run_id:reviewBatch.batch_id} : {})})
      });
      // Refresh global history
      if(window.CollectorBackgroundLists) await refreshCompletionHistory(null,false); else globalHistory = await (await datasetFetch("/api/get_session_history")).json();
      highscoreAdded = true;
      if(resultSnapshot) resultSnapshot.history_saved=true;
    } catch (e) { console.error("Failed to save history", e); if(window.CollectorBackgroundLists) {showToast("Could not save session history; retry to preserve the result.","error");return;} }
  }

  // Determine if it's a new high score
  const sortedHistory = [...globalHistory].sort((a, b) => b.score - a.score);
  
  // Deduplicate and filter: Only keep highest score for a given (items, rpm, score) signature
  const seenSignatures = new Set();
  const dedupedHistory = sortedHistory.filter(s => {
    if (s.score <= 0) return false;
    const sig = `${s.items}-${s.rpm}-${s.score}`;
    if (seenSignatures.has(sig)) return false;
    seenSignatures.add(sig);
    return true;
  });

  const isNewHighScore = !batchOnly && dedupedHistory.length > 0 && sessionData.score >= dedupedHistory[0].score && sessionData.score > 0;
  
  if (isNewHighScore) {
    statsCard.classList.add("stats-card-gold");
    document.getElementById("stats-badge-container").innerHTML = `<div class="highscore-badge um-game-highscore">New High Score!</div>`;
  }

  const statItems = [
    { label: batchOnly ? "Session Score" : "Final Score", val: sessionData.score.toLocaleString(), color: isNewHighScore ? "#f59e0b" : "var(--primary)" },
    { label: batchOnly ? "Batch Labeled" : "Regions Labeled", val: sessionData.items, color: "var(--text-main)" },
    { label: "Max Combo", val: `x${getComboMultiplier(sessionData.maxCombo)} (${sessionData.maxCombo})`, color: sessionData.maxCombo >= 10 ? "var(--warning)" : "var(--text-main)" },
    { label: "Speed (RPM)", val: sessionData.rpm, color: sessionData.rpm >= 40 ? "var(--primary)" : "var(--text-main)" },
    { label: "Avg Time", val: (sessionData.avgTime / 1000).toFixed(2) + "s", color: "var(--text-muted)" },
    { label: "Autocomplete", val: sessionData.autoCompletePct + "%", color: "var(--text-muted)" }
  ];

  document.getElementById("stats-container").innerHTML = statItems.map(s => `
    <div style="background:rgba(0,0,0,0.2); padding:12px; border-radius:8px; border:1px solid var(--border); display:flex; flex-direction:column; gap:4px">
      <span style="font-size:10px; color:var(--text-muted); text-transform:uppercase; letter-spacing:1px">${s.label}</span>
      <span style="font-size:18px; font-weight:900; color:${s.color}">${s.val}</span>
    </div>
  `).join('');

  // Render Rank List
  const hsEntries = document.getElementById("high-score-entries");
  if (hsEntries) {
    if(window.CollectorBackgroundLists) window.CollectorBackgroundLists.clear(hsEntries);
    // Show top 5 scores
    const topScores = dedupedHistory.slice(0, 5);
    hsEntries.innerHTML = topScores.map((s, i) => {
      const isCurrent = s.score === sessionData.score && s.items === sessionData.items && s.rpm === sessionData.rpm;
      let rowClass = "highscore-row";
      if (isCurrent && isNewHighScore) rowClass += " new-record";
      else if (isCurrent) rowClass += " current-session";
      
      return `
        <div class="${rowClass}">
          <span class="highscore-rank">${i + 1}.</span>
          <span class="highscore-date">${new Date(s.timestamp).toLocaleDateString()} <small style="opacity:0.5">${new Date(s.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</small></span>
          <span class="highscore-stats" style="flex:1; text-align:right; margin-right: 12px; font-size:11px; opacity:0.8">
            ${s.items} regions • ${s.rpm || '?'} rpm
          </span>
          <span class="highscore-score">${s.score.toLocaleString()}</span>
        </div>
      `;
    }).join('');
    
    if(window.CollectorBackgroundLists && topScores.length) {
      const nodes=[...hsEntries.children];hsEntries.replaceChildren();
      window.CollectorBackgroundLists.snapshot(hsEntries,{items:nodes.map((node,index)=>({id:String(index),node})),key:item=>item.id,card:item=>item.node,height:Math.min(250,nodes.length*50),rowHeight:48,minColumnWidth:1000});
    }
    if (topScores.length === 0) {
      hsEntries.innerHTML = `<div style="text-align:center; padding:10px; color:var(--text-muted); font-size:12px">No rankings yet. Complete your first session!</div>`;
    }
  }

  // Reset for next potential session
  if(batchOnly) {updateScoreDisplay();saveSessionProgress();return;}
  if(paged) {queueCompletedStats={items:0,time:0};queueCompletionRecorded=true;}
  sessionScore = 0;
  currentCombo = 0;
  maxCombo = 0;
  quickLabels = 0;
  autoCompletes = 0;
  highscoreAdded = false;
  updateScoreDisplay();
  if(typeof updateStepperButtons==='function') updateStepperButtons();
  if(!paged || typeof queueLoading==='undefined' || !queueLoading) await saveSessionProgress(true);
}

async function toggleDbStats(forceOpen = null) {
    if (forceOpen instanceof Event) forceOpen = null;
    const dashboard = document.getElementById("db-statistics-dashboard");
    const grid = document.getElementById("db-list");
    const pagination = document.getElementById("db-pagination");
    const gridControls = document.getElementById("db-grid-controls");
    const dashTitle = document.getElementById("db-dashboard-title");
    const btnStats = document.getElementById("btn-db-stats");
    const btnBack = document.getElementById("btn-db-back");
    const isDashboardHidden = dashboard.classList.contains("hidden");

    if (forceOpen === true && !isDashboardHidden) {
        await fetchAndRenderStats();
        return;
    }
    if (forceOpen === false && isDashboardHidden) return;

    if (forceOpen === true || (forceOpen === null && isDashboardHidden)) {
        // Switch to Dashboard
        datasetStorage.setItem("db_dashboard_open", "true");
        grid.classList.add("hidden");
        pagination.classList.add("hidden");
        gridControls.style.display = 'none';
        
        dashboard.classList.remove("hidden");
        dashTitle.classList.remove("hidden");
        btnBack.classList.remove("hidden");
        btnStats.classList.add("hidden");
        
        await fetchAndRenderStats();
    } else {
        // Switch to Grid
        datasetStorage.setItem("db_dashboard_open", "false");
        dashboard.classList.add("hidden");
        dashTitle.classList.add("hidden");
        btnBack.classList.add("hidden");
        
        grid.classList.remove("hidden");
        if(!window.CollectorBackgroundLists) pagination.classList.remove("hidden");
        gridControls.style.display = 'flex';
        btnStats.classList.remove("hidden");
    }
}

async function fetchAndRenderStats() {
    const container = document.querySelector("#db-statistics-dashboard .stats-grid");
    if(window.CollectorBackgroundLists) container.querySelectorAll("[data-stat-snapshot]").forEach(node=>window.CollectorBackgroundLists.clear(node));
    container.innerHTML = '<div style="grid-column: 1/-1; padding: 100px; display: flex; flex-direction: column; align-items: center; gap: 20px;"><div class="spinner"></div><div style="font-family: var(--font-mono); font-weight: 800; color: var(--primary); letter-spacing: 2px;">CALCULATING DATASET HEALTH...</div></div>';
    
    try {
        const response = await datasetFetch("/api/stats");
        const stats = await response.json();
        renderStatsDashboard(stats);
    } catch (e) {
        container.innerHTML = `<div style="grid-column: 1/-1; padding: 100px; text-align: center; color: var(--danger);">Failed to load statistics: ${e.message}</div>`;
    }
}

function renderStatsDashboard(stats) {
    const container = document.querySelector("#db-statistics-dashboard .stats-grid");
    if(window.CollectorBackgroundLists) container.querySelectorAll("[data-stat-snapshot]").forEach(node=>window.CollectorBackgroundLists.clear(node));
    container.innerHTML = "";

    // 1. Dataset Overview (Hero)
    const overviewCard = document.createElement("div");
    overviewCard.className = "stat-card";
    overviewCard.style.gridColumn = "1 / -1";
    overviewCard.innerHTML = `
        <div class="stat-card-title">Dataset overview <span data-stats-dataset-name></span></div>
        <div class="hero-stat">
            <div class="hero-item"><span class="val" style="color:var(--text-main)">${stats.overview.total}</span><span class="lab">Total Samples</span></div>
            <div class="hero-item"><span class="val" style="color:var(--primary)">${stats.overview.text}</span><span class="lab">Text Samples</span></div>
            <div class="hero-item"><span class="val" style="color:var(--text-muted)">${stats.overview.empty}</span><span class="lab">Empty/Background</span></div>
        </div>
    `;
    container.appendChild(overviewCard);
    overviewCard.querySelector('[data-stats-dataset-name]').textContent = datasets.find(dataset => dataset.id === activeDatasetId)?.name || 'Current dataset';

    // 3. Distributions (Labels)
    const labelDistCard = document.createElement("div");
    labelDistCard.className = "stat-card";
    const maxLabelCount = Math.max(...Object.values(stats.top_labels), 1);
    labelDistCard.innerHTML = `
        <div class="stat-card-title">TOP 10 LABELS <span>FREQUENCY</span></div>
        <div data-stat-snapshot style="display:flex; flex-direction:column; gap:10px">
            ${Object.entries(stats.top_labels).sort((a,b) => b[1] - a[1]).map(([label, count]) => `
                <div class="stat-bar-container">
                    <div class="stat-bar-label"><span>${label}</span><span>${count}</span></div>
                    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(count / maxLabelCount * 100)}%; background: var(--accent)"></div></div>
                </div>
            `).join('')}
        </div>
    `;
    container.appendChild(labelDistCard);

    // 4. Per-Region Analytics
    const regionCard = document.createElement("div");
    regionCard.className = "stat-card";
    const maxRegionCount = Math.max(...Object.values(stats.regions), 1);
    regionCard.innerHTML = `
        <div class="stat-card-title">REGION BALANCE <span>SAMPLES</span></div>
        <div data-stat-snapshot style="display:flex; flex-direction:column; gap:10px">
            ${Object.entries(stats.regions).sort((a,b) => b[1] - a[1]).map(([rid, count]) => `
                <div class="stat-bar-container">
                    <div class="stat-bar-label"><span>${rid}</span><span>${count}</span></div>
                    <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${(count / maxRegionCount * 100)}%"></div></div>
                </div>
            `).join('')}
        </div>
    `;
    container.appendChild(regionCard);

    // 5. Poker Domain
    const pokerCard = document.createElement("div");
    pokerCard.className = "stat-card";
    pokerCard.innerHTML = `
        <div class="stat-card-title">POKER DOMAIN <span>SPECIFIC</span></div>
        <div class="stat-row"><span>All-In Rate</span><span class="stat-value" style="color:var(--danger)">${stats.poker.all_in_rate}%</span></div>
        <div class="stat-bar-container">
            <div class="stat-bar-label"><span>CURRENCY DISTRIBUTION (G / S)</span><span>${stats.poker.currency.G} / ${stats.poker.currency.S}</span></div>
            <div class="stat-bar-track" style="display:flex">
                <div style="height:100%; background:var(--warning); width:${(stats.poker.currency.G / (stats.poker.currency.G + stats.poker.currency.S) * 100) || 0}%"></div>
                <div style="height:100%; background:var(--primary); flex:1"></div>
            </div>
        </div>
        <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; margin-top: 5px;">ACTION FREQUENCY</div>
        <div data-stat-snapshot style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px">
             ${Object.entries(stats.poker.actions).sort((a,b) => b[1] - a[1]).map(([a, c]) => `<div class="stat-row" style="font-size:11px"><span>${a}</span><span style="color:var(--text-main)">${c}</span></div>`).join('')}
        </div>
    `;
    container.appendChild(pokerCard);

    // 6. Model Training Specifics
    const trainingCard = document.createElement("div");
    trainingCard.className = "stat-card";
    trainingCard.innerHTML = `
        <div class="stat-card-title">TRAINING SPECIFICS <span>CROP / LABEL</span></div>
        <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; margin-top: 5px;">LABEL LENGTH</div>
        <div class="stat-row"><span>Min / Avg / Max</span><span class="stat-value" style="font-size:14px">${stats.lengths.min} / <span style="color:var(--accent)">${stats.lengths.avg}</span> / ${stats.lengths.max}</span></div>
        
        <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; margin-top: 5px;">CROP WIDTH</div>
        <div class="stat-row"><span>Min / Avg / Max</span><span class="stat-value" style="font-size:14px">${stats.crops.min_w} / <span style="color:var(--accent)">${stats.crops.avg_w}</span> / ${stats.crops.max_w}px</span></div>
        
        <div style="font-size: 10px; color: var(--text-muted); font-weight: 800; margin-top: 5px;">CROP HEIGHT</div>
        <div class="stat-row"><span>Min / Avg / Max</span><span class="stat-value" style="font-size:14px">${stats.crops.min_h} / <span style="color:var(--accent)">${stats.crops.avg_h}</span> / ${stats.crops.max_h}px</span></div>
    `;
    container.appendChild(trainingCard);

    // 7. Data Diversity (Small Multiples)
    const diversityCard = document.createElement("div");
    diversityCard.className = "stat-card";
    diversityCard.innerHTML = `
        <div class="stat-card-title">DIVERSITY <span>HAMMING / AR</span></div>
        <div data-stat-snapshot style="display:flex; flex-direction:column; gap:12px;">
            <div style="display:grid; grid-template-columns: 80px 1fr 60px; gap: 10px; font-size:10px; font-weight:800; color:var(--text-muted); text-transform:uppercase; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 6px;">
                <span>Region</span>
                <span style="text-align:right">Avg Hamming</span>
                <span style="text-align:right">Avg Asp Ratio</span>
            </div>
            ${Object.entries(stats.per_region).sort((a,b) => b[1].avg_dist - a[1].avg_dist).map(([rid, s]) => `
                <div style="display:grid; grid-template-columns: 80px 1fr 60px; gap: 10px; align-items:center; font-size:11px; font-family:var(--font-mono);">
                    <span style="color:var(--text-main); font-weight:bold; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${rid}">${rid}</span>
                    <span style="color:var(--primary); text-align:right;">${s.avg_dist}</span>
                    <span style="color:var(--accent); text-align:right;">${s.avg_ar}</span>
                </div>
            `).join('')}
        </div>
    `;
    container.appendChild(diversityCard);
    if(window.CollectorBackgroundLists) container.querySelectorAll('[data-stat-snapshot]').forEach(host=>{
      const rows=[...host.children];host.replaceChildren();
      if(rows.length) window.CollectorBackgroundLists.snapshot(host,{items:rows.map((node,index)=>({id:String(index),node})),key:item=>item.id,card:item=>item.node,height:Math.min(320,Math.max(44,rows.length*48)),rowHeight:48,minColumnWidth:1000});
    });
}

