// One card renderer for OCR collection/review/database and gameplay browsing.
// State-specific OCR history and persistence remain in their owning controller.
(function (global, document) {
  'use strict';
  function createCard({imageSrc, fullResSrc, label, id, filename, isSelected, isIgnored, isBlank, isUnreviewed, isEditing, onToggle, onEdit, onRemove, removeLabel, onSave, onKeydown, originalIdx, isLoading, isError, dataId, alt, onOpen, openLabel, secondaryText}) {
    const div = document.createElement("div");
    div.className = (isIgnored ? "card ignored" : "card") + (isSelected ? " selected" : "") + (isError ? " invalid-state" : "");
    if (dataId) div.setAttribute("data-id", dataId);
    if (originalIdx !== undefined) div.setAttribute("data-original-idx", originalIdx);
    if (filename) div.setAttribute("data-filename", filename);

    if (isError) {
      div.style.borderColor = "var(--danger)";
      div.innerHTML = `<div style="height:110px; display:flex; align-items:center; justify-content:center; background:rgba(239,68,68,0.1);"><span style="color:var(--danger); font-size:40px; font-weight:100;">✕</span></div><div class="card-info"><div class="card-label" style="color:var(--danger)">NO GAME FOUND!</div><div class="card-meta"><span>ERROR</span></div></div>`;
      return div;
    }

    if (isLoading) {
      div.innerHTML = `<div style="height:110px; display:flex; align-items:center; justify-content:center; background:#000;"><div class="spinner" style="width:20px; height:20px; border-width:2px;"></div></div><div class="card-info"><div class="card-label" style="color:var(--text-muted)">CAPTURING...</div><div class="card-meta"><span>PLEASE WAIT</span></div></div>`;
      return div;
    }

    if (onToggle) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "card-checkbox";
      cb.setAttribute('aria-label', `Select ${id} crop`);
      cb.checked = isSelected;
      cb.onchange = onToggle;
      div.appendChild(cb);

      div.onclick = (e) => {
        if (!e.target.closest('button, input, details, summary')) {
          onToggle();
        }
      };
    }

    // Gameplay opens a card with a native button, keeping keyboard activation
    // and focus behavior without putting buttons inside other action controls.
    let content = div;
    if (onOpen) {
      if (onToggle || isEditing || onEdit || onRemove) throw new Error('Open cards cannot contain editing or selection actions');
      content = document.createElement('button');
      content.type = 'button';content.className = 'capture-card-open';
      content.setAttribute('aria-label', openLabel || `Open ${id}`);
      content.onclick = onOpen;div.appendChild(content);
    }
    if (imageSrc !== undefined && imageSrc !== null) {
      const img = document.createElement("img");
      img.src = imageSrc;
      img.alt = alt || `Original ${id} crop`;
      img.loading = 'lazy';img.decoding = 'async';
      if (fullResSrc) img.setAttribute("data-full-res", fullResSrc);
      content.appendChild(img);
    }

    const infoDiv = document.createElement("div");
    infoDiv.className = "card-info";
    content.appendChild(infoDiv);

    if (isEditing) {
      const input = document.createElement("input");
      input.type = "text";
      input.id = "edit-input-" + originalIdx;
      input.className = "card-label";
      input.setAttribute('aria-label', `Label for ${id}`);
      input.setAttribute("list", "edit-datalist");
      input.value = label || '';
      input.style = "width:100%;background:var(--bg-input);border:1px solid var(--primary)";
      if (onKeydown) input.onkeydown = onKeydown;
      infoDiv.appendChild(input);
    } else if (!isUnreviewed) {
      const labelDiv = document.createElement("div");
      labelDiv.className = "card-label";
      labelDiv.textContent = isIgnored ? 'Skipped' : isBlank ? 'No text (blank)' : (label || 'Not reviewed');
      infoDiv.appendChild(labelDiv);
    }

    const metaDiv = document.createElement("div");
    metaDiv.className = "card-meta";
    infoDiv.appendChild(metaDiv);

    const idSpan = document.createElement("span");
    idSpan.textContent = id;
    metaDiv.appendChild(idSpan);

    if (secondaryText !== undefined && secondaryText !== null) {
      const secondary = document.createElement('span');
      secondary.className = 'card-secondary';secondary.textContent = secondaryText;
      metaDiv.appendChild(secondary);
    }
    const btnContainer = document.createElement("div");
    btnContainer.style = "display:flex;gap:4px";
    metaDiv.appendChild(btnContainer);

    if (onEdit && onSave) {
      const editBtn = document.createElement("button");
      editBtn.type = "button";editBtn.className = "btn-ghost";
      editBtn.style.color = "var(--accent)";
      editBtn.textContent = isEditing ? 'Save' : 'Edit';
      editBtn.onclick = isEditing ? onSave : onEdit;
      btnContainer.appendChild(editBtn);
    }

    if (onRemove) {
      const rmBtn = document.createElement("button");
      rmBtn.type = "button";rmBtn.className = "btn-ghost";
      rmBtn.style.color = "var(--danger)";
      rmBtn.textContent = removeLabel || 'Remove';
      rmBtn.onclick = onRemove;
      btnContainer.appendChild(rmBtn);
    }

    return div;
  }
  global.PokerLabList = Object.freeze({ createCard });
})(window, document);
