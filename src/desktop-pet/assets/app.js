const state = {
  rows: new Map(),
  actionAssets: new Map(),
  ambientActions: ["idle", "running-right", "review", "waving"],
  atlas: null,
  action: "idle",
  frame: 0,
  frameTimer: 0,
  actionTimer: 0,
  snapshotTimer: 0,
  messageTimer: 0,
  speakTimer: 0,
  dragging: false,
  pendingAction: "",
  manualUntil: 0,
  statusAction: "idle",
  statusActions: [],
  statusMessage: "Ready to help",
  statusSignature: "",
  dragStartScreenX: 0,
  dragStartScreenY: 0,
  dragLastScreenX: 0,
  dragLastScreenY: 0,
  dragLastAction: "",
  dragReturnAction: "",
};

const defaultFrameDelayMs = 175;
const statusActionSwitchMs = 2600;
const ambientActionSwitchMs = 6200;

const actionFrameDelayMs = {
  "running-right": 165,
  "running-left": 165,
  running: 165,
  waving: 260,
  jumping: 190,
  failed: 230,
  waiting: 205,
  review: 200,
  "desk-work": 210,
  "checklist-review": 210,
  "idea-thinking": 220,
  "code-explain": 210,
  "tired-seated": 230,
  "side-sleep": 260,
  "plug-charging": 230,
  "alert-surprise": 210,
  "exercise-motion": 190,
};

const actionButtonLabels = {
  idle: "ID",
  "running-right": "R>",
  "running-left": "<L",
  waving: "~",
  jumping: "UP",
  failed: "!!",
  waiting: "...",
  running: "RUN",
  review: "RV",
  "desk-work": "WK",
  "checklist-review": "CK",
  "idea-thinking": "TH",
  "code-explain": "EX",
  "tired-seated": "LOW",
  "side-sleep": "ZZ",
  "plug-charging": "CH",
  "alert-surprise": "AL",
  "exercise-motion": "FIT",
};

function nativeBridgeAvailable() {
  return Boolean(window.webkit?.messageHandlers?.botmuxPetAction);
}

function postNative(action, payload = {}) {
  if (!nativeBridgeAvailable()) return;
  window.webkit.messageHandlers.botmuxPetAction.postMessage(Object.assign({ action }, payload));
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = value || "";
}

function petShell() {
  return document.querySelector('[data-region="pet-shell"]');
}

function sprite() {
  return document.querySelector('[data-region="sprite"]');
}

function actionPanel() {
  return document.querySelector('[data-region="actions"]');
}

function setMessage(message, ms = 2600) {
  const shell = petShell();
  setText('[data-bind="message"]', message || "");
  if (shell) shell.classList.toggle("has-message", Boolean(message));
  if (state.messageTimer) window.clearTimeout(state.messageTimer);
  if (!message || ms <= 0) {
    state.messageTimer = 0;
    return;
  }
  state.messageTimer = window.setTimeout(() => {
    setText('[data-bind="message"]', "Ready to help");
    petShell()?.classList.remove("has-message");
    state.messageTimer = 0;
  }, ms);
}

function speak(ms = 1800) {
  const shell = petShell();
  if (!shell) return;
  shell.classList.add("is-speaking");
  if (state.speakTimer) window.clearTimeout(state.speakTimer);
  if (ms <= 0) {
    state.speakTimer = 0;
    return;
  }
  state.speakTimer = window.setTimeout(() => {
    shell.classList.remove("is-speaking");
    state.speakTimer = 0;
  }, ms);
}

function paintFrame() {
  const row = state.rows.get(state.action) || state.rows.get("idle");
  if (!row) return;
  const frame = state.frame % row.frames;
  const el = sprite();
  if (!el) return;

  const actionAsset = state.actionAssets.get(row.state);
  if (actionAsset) {
    const frameWidth = actionAsset.frameWidth || 192;
    const frameHeight = actionAsset.frameHeight || 208;
    const frameStride = actionAsset.frameStride || frameWidth;
    const frameOffsetX = actionAsset.frameOffsetX || 0;
    document.documentElement.style.setProperty("--cell-w", `${frameWidth}px`);
    document.documentElement.style.setProperty("--cell-h", `${frameHeight}px`);
    el.style.setProperty("--sprite-url", `url("${actionAsset.image}")`);
    el.style.setProperty("--sprite-x", `${-(frame * frameStride + frameOffsetX)}px`);
    el.style.setProperty("--sprite-y", "0px");
    return;
  }

  if (!state.atlas) return;
  el.style.setProperty("--sprite-url", `url("${state.atlas.image}")`);
  el.style.setProperty("--sprite-x", `${-frame * state.atlas.cellWidth}px`);
  el.style.setProperty("--sprite-y", `${-row.row * state.atlas.cellHeight}px`);
}

function setAction(action, message = "", options = {}) {
  if (!state.rows.has(action)) action = "idle";
  if (options.manual) state.manualUntil = Date.now() + (options.manualMs || 3200);
  if (state.dragging && !options.duringDrag) {
    state.pendingAction = action;
    if (message) setMessage(message);
    return;
  }
  const previousAction = state.action;
  const nextRow = state.rows.get(action) || state.rows.get("idle");
  state.action = action;
  if (options.preserveFrame || previousAction === action) {
    state.frame = state.frame % Math.max(1, nextRow?.frames || 1);
  } else {
    state.frame = 0;
  }
  const shell = petShell();
  if (shell) shell.dataset.actionState = action;
  if (message) {
    setMessage(message);
    speak();
  }
  paintFrame();
}

function startFrameLoop() {
  if (state.frameTimer) window.clearTimeout(state.frameTimer);
  const tick = () => {
    const row = state.rows.get(state.action) || state.rows.get("idle");
    state.frame = (state.frame + 1) % Math.max(1, row?.frames || 1);
    paintFrame();
    state.frameTimer = window.setTimeout(tick, actionFrameDelayMs[state.action] || defaultFrameDelayMs);
  };
  state.frameTimer = window.setTimeout(tick, actionFrameDelayMs[state.action] || defaultFrameDelayMs);
}

function startActionLoop() {
  if (state.actionTimer) window.clearInterval(state.actionTimer);
  let index = 0;
  let lastAmbientAt = 0;
  let lastStatusAt = Date.now();
  state.actionTimer = window.setInterval(() => {
    if (state.dragging) return;
    if (Date.now() < state.manualUntil) return;
    const statusActions = state.statusActions.length > 0 ? state.statusActions : [state.statusAction].filter(Boolean);
    if (statusActions.length > 1) {
      if (Date.now() - lastStatusAt < statusActionSwitchMs) return;
      lastStatusAt = Date.now();
      let action = statusActions[index % statusActions.length];
      if (action === state.action) {
        index += 1;
        action = statusActions[index % statusActions.length];
      }
      index += 1;
      setAction(action, "", { preserveFrame: true });
      return;
    }
    if (state.statusAction && !state.ambientActions.includes(state.statusAction)) return;
    if (Date.now() - lastAmbientAt < ambientActionSwitchMs) return;
    lastAmbientAt = Date.now();
    const actions = state.ambientActions.length > 0 ? state.ambientActions : ["idle"];
    const action = actions[index % actions.length];
    index += 1;
    setAction(action, actionLabel(action));
    if (action !== "idle") {
      window.setTimeout(() => setAction("idle", "Ready to help"), 1800);
    }
  }, 500);
}

function actionLabel(action) {
  return ({
    "desk-work": "Working",
    "checklist-review": "Checking tasks",
    "idea-thinking": "Thinking",
    "code-explain": "Explaining",
    "tired-seated": "Low energy",
    "side-sleep": "Resting",
    "plug-charging": "Charging",
    "alert-surprise": "Heads up",
    "exercise-motion": "Stretching",
    "running-right": "Moving",
    "waving": "Hello",
    "waiting": "Standing by",
  })[action] || "Ready";
}

function renderActionButtons(rows) {
  const panel = actionPanel();
  if (!panel) return;
  const signature = rows.map((row) => row.state).join("|");
  if (panel.dataset.rowsSignature === signature) return;
  panel.dataset.rowsSignature = signature;
  panel.innerHTML = "";
  for (const row of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pet-btn";
    button.dataset.action = row.state;
    button.title = `${actionLabel(row.state)} (${row.state})`;
    button.textContent = actionButtonLabels[row.state] || row.state.slice(0, 3).toUpperCase();
    panel.appendChild(button);
  }
  const quit = document.createElement("button");
  quit.type = "button";
  quit.className = "pet-btn pet-btn-quit";
  quit.dataset.action = "quit";
  quit.title = "Close";
  quit.textContent = "X";
  panel.appendChild(quit);
}

async function fetchSnapshot() {
  const res = await fetch("./api/snapshot", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

function paintSnapshot(snapshot, options = {}) {
  const display = snapshot.display || {};
  const atlas = display.atlas || {};
  state.atlas = atlas;
  state.rows = new Map((atlas.rows || []).map((row) => [row.state, row]));
  renderActionButtons(atlas.rows || []);
  state.actionAssets = new Map(Object.entries(display.actions || {}));
  state.ambientActions = (display.ambientActions || state.ambientActions).filter((action) => state.rows.has(action));
  document.documentElement.style.setProperty("--cell-w", `${atlas.cellWidth || 192}px`);
  document.documentElement.style.setProperty("--cell-h", `${atlas.cellHeight || 208}px`);
  setText('[data-bind="name"]', display.name || "Robo Buddy");
  setText('[data-bind="title"]', display.title || "Botmux desktop pet");
  const botmux = display.botmux || {};
  state.statusAction = display.recommendedAction || botmux.action || "idle";
  state.statusActions = (display.statusActions || [state.statusAction]).filter((action) => state.rows.has(action));
  state.statusMessage = display.message || botmux.message || "Ready to help";
  const nextSignature = botmux.signature || `${state.statusAction}:${state.statusMessage}`;
  const changed = nextSignature !== state.statusSignature;
  state.statusSignature = nextSignature;
  if (options.force || changed || state.action === "idle") {
    if (Date.now() >= state.manualUntil || options.force) {
      setAction(state.statusAction, state.statusMessage);
    }
  }
}

async function loadSnapshot(options = {}) {
  const snapshot = await fetchSnapshot();
  paintSnapshot(snapshot, options);
}

function startSnapshotLoop() {
  if (state.snapshotTimer) window.clearInterval(state.snapshotTimer);
  state.snapshotTimer = window.setInterval(() => {
    loadSnapshot().catch(() => {
      state.statusAction = "side-sleep";
      state.statusMessage = "Botmux is offline";
      if (Date.now() >= state.manualUntil) setAction("side-sleep", "Botmux is offline");
    });
  }, 3600);
}

function attachDrag() {
  const shell = petShell();
  if (!shell) return;
  const screenPoint = (event) => ({
    x: Number.isFinite(event.screenX) ? event.screenX : event.clientX,
    y: Number.isFinite(event.screenY) ? event.screenY : event.clientY,
  });

  shell.addEventListener("pointerdown", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.preventDefault();
    const point = screenPoint(event);
    state.dragging = true;
    state.dragLastAction = "";
    state.dragReturnAction = state.action;
    state.dragStartScreenX = point.x;
    state.dragStartScreenY = point.y;
    state.dragLastScreenX = point.x;
    state.dragLastScreenY = point.y;
    shell.classList.add("is-dragging");
    shell.setPointerCapture?.(event.pointerId);
    postNative("drag_start");
  });

  shell.addEventListener("pointermove", (event) => {
    if (!state.dragging) return;
    event.preventDefault();
    const point = screenPoint(event);
    const dx = point.x - state.dragStartScreenX;
    const stepX = point.x - state.dragLastScreenX;
    state.dragLastScreenX = point.x;
    state.dragLastScreenY = point.y;
    if (Math.abs(stepX) >= 3) {
      const dragAction = stepX > 0 ? "running-right" : "running-left";
      if (dragAction !== state.dragLastAction) {
        state.dragLastAction = dragAction;
        setAction(dragAction, "", { duringDrag: true, preserveFrame: true });
      }
    }
    postNative("drag_move", {
      dx,
      dy: point.y - state.dragStartScreenY,
    });
  });

  const end = (event) => {
    if (!state.dragging) return;
    event.preventDefault();
    state.dragging = false;
    const returnAction = state.pendingAction || state.dragReturnAction || state.statusAction || "idle";
    state.dragLastAction = "";
    state.dragReturnAction = "";
    shell.classList.remove("is-dragging");
    shell.releasePointerCapture?.(event.pointerId);
    postNative("drag_end");
    if (state.pendingAction) {
      state.pendingAction = "";
    }
    setAction(returnAction, Date.now() < state.manualUntil ? actionLabel(returnAction) : "");
  };

  shell.addEventListener("pointerup", end);
  shell.addEventListener("pointercancel", end);
}

function attachButtons() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === "quit") {
      fetch("./api/quit", { method: "POST", credentials: "same-origin" }).catch(() => postNative("quit"));
      postNative("quit");
      return;
    }
    const manualMs = 7000;
    setAction(action, actionLabel(action), { manual: true, manualMs });
    window.setTimeout(() => {
      if (Date.now() >= state.manualUntil) {
        setAction(state.statusAction || "idle", state.statusMessage || "Ready to help");
      }
    }, manualMs + 100);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  attachDrag();
  attachButtons();
  try {
    await loadSnapshot({ force: true });
    startFrameLoop();
    startActionLoop();
    startSnapshotLoop();
    speak(1200);
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), 0);
  }
});
