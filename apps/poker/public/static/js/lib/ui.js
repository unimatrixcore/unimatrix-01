function showToast(msg, type = "error") {
  const t = document.createElement("div"); t.className = `toast ${type}`; t.textContent = msg; 
  document.getElementById("toast-container").appendChild(t);
  setTimeout(() => { t.classList.add("fade-out"); setTimeout(() => t.remove(), 300); }, 3000);
}

function showLoading(show, text = "Loading...") {
  if (show && window.pokerStartupTimedOut) return;
  if (!show) window.pokerStartupTimedOut = false;
  const overlay = document.getElementById("loading-overlay");
  const loadingText = document.getElementById("loading-text");
  const bar = document.getElementById("loading-progress-bar");
  loadingText.textContent = text;
  if (!show) bar.style.width = "0%";
  overlay.classList.toggle("active", show);
}

function updateLoadingProgress(text, progress) {
  document.getElementById("loading-text").textContent = text;
  document.getElementById("loading-progress-bar").style.width = progress + "%";
}

let closeActiveConfirm = null;
function showConfirmModal(title, message, confirmText = "Confirm", isDangerous = true) {
  closeActiveConfirm?.(false);
  return new Promise((resolve) => {
    const overlay = document.getElementById("modal-overlay");
    const titleEl = document.getElementById("modal-title");
    const msgEl = document.getElementById("modal-message");
    const confirmBtn = document.getElementById("btn-modal-confirm");
    const cancelBtn = document.getElementById("btn-modal-cancel");
    const previousFocus = document.activeElement;
    let settled = false;
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle('btn-danger', isDangerous);
    confirmBtn.classList.toggle('btn-primary', !isDangerous);
    // Keep the mounted shared Button's size/focus classes while changing its tone.
    confirmBtn.style.backgroundColor = isDangerous ? 'color-mix(in oklab, var(--destructive) 10%, transparent)' : 'var(--primary)';
    confirmBtn.style.color = isDangerous ? 'var(--destructive)' : 'var(--primary-foreground)';
    
    const cleanup = (val) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove("active");
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      overlay.removeEventListener('keydown', containKeys);
      document.removeEventListener('keydown', modalKeys, true);
      document.removeEventListener('focusin', containFocus);
      closeActiveConfirm = null;
      if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
      resolve(val);
    };
    const containKeys = event => event.stopPropagation();
    const containFocus = event => {
      if (!overlay.contains(event.target)) cancelBtn.focus({preventScroll:true});
    };
    const modalKeys = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); cleanup(false);
      } else if (event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation();
        const buttons = [cancelBtn, confirmBtn].filter(button => !button.disabled);
        const current = buttons.indexOf(document.activeElement);
        const next = current < 0 ? 0 : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus({preventScroll:true});
      }
    };
    
    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.onclick = event => { if (event.target === overlay) cleanup(false); };
    overlay.classList.add("active");
    overlay.addEventListener('keydown', containKeys);
    document.addEventListener('keydown', modalKeys, true);
    document.addEventListener('focusin', containFocus);
    closeActiveConfirm = cleanup;
    cancelBtn.focus({preventScroll:true});
  });
}
