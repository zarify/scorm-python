/**
 * Hints Tab — hint list panel plus per-hint editor.
 *
 * Conditions are edited exclusively through the shared condition builder
 * (condition-builder.js), which renders the six Python config condition types.
 * Every mutation goes through `getConfig()` + `notifyChange()`.
 */

import {
  getConfig,
  getPythonEngine,
  notifyChange,
  onConfigChange,
} from './builder-app.js';
import {
  VALID_HINT_DISPLAY_MODES,
  VALID_HINT_EVENTS,
  VALID_HINT_STYLES,
} from '../../shared/config-validator.js';
import { createDefaultCondition, renderConditionEditor } from './condition-builder.js';
import {
  enableListReordering,
  getSelectionIndexAfterMove,
  moveListItem,
} from './list-reorder.js';

let selectedHintIndex = -1;
let lastConfigRef = null;

const HINT_DISPLAY_MODE_LABELS = {
  triggered: 'Hidden until triggered',
  checklist: 'Always visible checklist item',
};

const TRIGGER_EVENT_LABELS = {
  code_change: 'Code changes',
  test_fail: 'Test run fails',
  manual: 'Student requests hint',
};

const HINT_STYLE_LABELS = {
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

/** Key for the pattern-validation call — errors come back keyed by this. */
const HINT_PATTERN_KEY = 'hint';

// Option lists derive from the shared validator enums so the dropdowns cannot
// drift from what the config validator accepts.
const HINT_DISPLAY_MODE_OPTIONS = VALID_HINT_DISPLAY_MODES.map((value) => ({
  value,
  label: HINT_DISPLAY_MODE_LABELS[value] || value,
}));

const HINT_TRIGGER_EVENT_OPTIONS = VALID_HINT_EVENTS.map((value) => ({
  value,
  label: TRIGGER_EVENT_LABELS[value] || value,
}));

const HINT_STYLE_OPTIONS = [
  { value: '', label: 'Default' },
  ...VALID_HINT_STYLES.map((value) => ({ value, label: HINT_STYLE_LABELS[value] || value })),
];

export function initHintsTab() {
  const addButton = document.getElementById('btn-add-hint');
  if (addButton) addButton.addEventListener('click', addHint);

  lastConfigRef = getConfig();
  onConfigChange(() => {
    const config = getConfig();
    if (config === lastConfigRef) return;
    // Claim the config before rendering: rendering can notify again and must
    // not re-enter this handler.
    lastConfigRef = config;

    const hints = config.hints || [];
    if (selectedHintIndex >= hints.length) {
      selectedHintIndex = hints.length - 1;
    }

    renderHintList();
    renderHintEditor();
  });

  renderHintList();
  renderHintEditor();
}

function addHint() {
  const cfg = getConfig();
  if (!Array.isArray(cfg.hints)) cfg.hints = [];

  cfg.hints.push({
    id: createHintId(cfg.hints),
    trigger: {
      event: 'code_change',
      conditions: createDefaultCondition('source_empty'),
    },
    display_mode: 'triggered',
    message: 'New hint — edit the message and conditions.',
    priority: cfg.hints.length + 1,
    delay_seconds: 0,
    show_once: false,
  });

  selectedHintIndex = cfg.hints.length - 1;
  notifyChange();
  renderHintList();
  renderHintEditor();
}

/** Auto-generated unique hint id — the config validator requires a non-empty id. */
function createHintId(hints) {
  const taken = new Set(hints.map((hint) => hint?.id));
  const base = `hint_${Date.now().toString(36)}`;
  let id = base;
  let suffix = 2;
  while (taken.has(id)) {
    id = `${base}_${suffix}`;
    suffix += 1;
  }
  return id;
}

function removeHint(index) {
  const cfg = getConfig();
  cfg.hints.splice(index, 1);
  if (selectedHintIndex >= cfg.hints.length) {
    selectedHintIndex = cfg.hints.length - 1;
  }
  notifyChange();
  renderHintList();
  renderHintEditor();
}

function renderHintList() {
  const container = document.getElementById('hint-list');
  if (!container) return;

  const hints = getConfig().hints || [];

  container.innerHTML = hints.map((hint, i) => `
    <div class="list-item hint-list-item list-item-reorderable ${i === selectedHintIndex ? 'selected' : ''}" data-index="${i}" draggable="true">
      <span class="list-item-title">${getHintListTitle(hint)}</span>
      <button class="list-item-remove" data-index="${i}" title="Remove hint">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.list-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      selectedHintIndex = parseInt(el.dataset.index, 10);
      renderHintList();
      renderHintEditor();
    });
  });

  enableListReordering(container, {
    itemSelector: '.hint-list-item',
    onMove: moveHint,
  });

  container.querySelectorAll('.list-item-remove').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      removeHint(parseInt(el.dataset.index, 10));
    });
  });
}

function moveHint(fromIndex, targetIndex, position) {
  const moved = moveListItem(getConfig().hints || [], fromIndex, targetIndex, position);
  if (!moved) return;
  if (!moved.changed) {
    renderHintList();
    return;
  }

  selectedHintIndex = getSelectionIndexAfterMove(
    selectedHintIndex,
    moved.fromIndex,
    moved.insertIndex,
  );

  notifyChange();
  renderHintList();
  renderHintEditor();
}

function renderHintEditor() {
  const container = document.getElementById('hint-editor-content');
  if (!container) return;

  const hints = getConfig().hints || [];
  if (selectedHintIndex < 0 || selectedHintIndex >= hints.length) {
    container.innerHTML = '<p class="placeholder-text">Select a hint to edit, or add a new one.</p>';
    return;
  }

  const hint = hints[selectedHintIndex];
  if (!hint.trigger || typeof hint.trigger !== 'object') {
    hint.trigger = { event: 'code_change' };
  }

  const event = getTriggerEvent(hint);
  const displayMode = getHintDisplayMode(hint);
  // code_change requires conditions; guarantee them the moment they are needed
  // so the config stays valid whatever path the author took to get here.
  if (event === 'code_change' && hint.trigger.conditions == null) {
    hint.trigger.conditions = createDefaultCondition('source_empty');
  }
  const hasConditions = hint.trigger.conditions != null;

  const conditionSection = hasConditions ? `
    <div class="form-group">
      <label>Trigger Conditions</label>
      <div id="hint-condition-host"></div>
      ${event === 'code_change' ? '' : '<button type="button" id="hint-remove-conditions" class="btn btn-small btn-secondary">Remove conditions</button>'}
    </div>
  ` : `
    <div class="form-group">
      <label>Trigger Conditions</label>
      <p class="placeholder-text">No conditions — this hint fires on every "${getTriggerEventLabel(event)}" event.</p>
      <button type="button" id="hint-add-conditions" class="btn btn-small btn-secondary">+ Add condition</button>
    </div>
  `;

  container.innerHTML = `
    <div class="form-group">
      <label>Hint ID</label>
      <input type="text" id="hint-id" value="${escapeAttr(hint.id)}">
    </div>
    <div class="form-group">
      <label>Message</label>
      <textarea id="hint-message" rows="3">${escapeHtml(hint.message)}</textarea>
    </div>
    <div class="form-group">
      <label>Display Mode</label>
      <select id="hint-display-mode">
        ${HINT_DISPLAY_MODE_OPTIONS.map((mode) => `<option value="${mode.value}" ${displayMode === mode.value ? 'selected' : ''}>${mode.label}</option>`).join('')}
      </select>
      <small>${displayMode === 'checklist'
        ? 'Checklist items stay visible in the sidebar and tick off once triggered.'
        : 'Triggered hints stay hidden until their trigger conditions fire.'}</small>
    </div>
    <div class="form-group">
      <label>Trigger Event</label>
      <select id="hint-trigger-event">
        ${HINT_TRIGGER_EVENT_OPTIONS.map((option) => `<option value="${option.value}" ${event === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
      </select>
    </div>
    ${conditionSection}
    <div class="form-row">
      <div class="form-group" style="flex:1">
        <label>Priority</label>
        <input type="number" id="hint-priority" value="${hint.priority || 1}" min="1">
      </div>
      <div class="form-group" style="flex:1">
        <label>Delay (seconds)</label>
        <input type="number" id="hint-delay" value="${hint.delay_seconds || 0}" min="0">
      </div>
      <div class="form-group" style="flex:1">
        <label>After N fails</label>
        <input type="number" id="hint-after-attempts" value="${hint.trigger.after_attempts || 0}" min="0">
      </div>
    </div>
    <div class="form-row" style="margin-top:8px">
      <div class="form-group" style="flex:1">
        <label>Style</label>
        <select id="hint-style">
          ${HINT_STYLE_OPTIONS.map((option) => `<option value="${option.value}" ${(hint.style || '') === option.value ? 'selected' : ''}>${option.label}</option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="flex:1">
        <label>Auto-invalidate</label>
        <label class="checkbox-label" style="display:block;margin-top:6px">
          <input type="checkbox" id="hint-invalidate-on-false" ${hint.trigger.invalidate_on_condition_false ? 'checked' : ''}>
          Hide again when condition becomes false
        </label>
      </div>
    </div>
    <label class="checkbox-label">
      <input type="checkbox" id="hint-show-once" ${hint.show_once ? 'checked' : ''} ${displayMode === 'checklist' ? 'disabled' : ''}>
      ${displayMode === 'checklist'
        ? 'Show once does not apply to checklist items'
        : "Show once (don't re-show after it has been used)"}
    </label>
  `;

  if (hasConditions) {
    renderConditionEditor({
      container: document.getElementById('hint-condition-host'),
      condition: hint.trigger.conditions,
      onChange: (newCondition) => {
        hint.trigger.conditions = newCondition;
        notifyChange();
      },
      validatePattern: validateHintPattern,
    });

    const removeButton = document.getElementById('hint-remove-conditions');
    if (removeButton) {
      removeButton.addEventListener('click', () => {
        delete hint.trigger.conditions;
        notifyChange();
        renderHintEditor();
      });
    }
  } else {
    const addConditionButton = document.getElementById('hint-add-conditions');
    addConditionButton.addEventListener('click', () => {
      hint.trigger.conditions = createDefaultCondition('source_empty');
      notifyChange();
      renderHintEditor();
    });
  }

  bindField('hint-id', (v) => { hint.id = v; });
  bindField('hint-message', (v) => {
    hint.message = v;
    updateHintListTitle(selectedHintIndex, hint);
  });
  bindField('hint-display-mode', (v) => {
    hint.display_mode = v === 'checklist' ? 'checklist' : 'triggered';
    if (hint.display_mode === 'checklist') {
      hint.show_once = false;
    }
    renderHintEditor();
  });
  bindField('hint-trigger-event', (v) => {
    hint.trigger.event = v;
    if (v === 'code_change' && hint.trigger.conditions == null) {
      hint.trigger.conditions = createDefaultCondition('source_empty');
    }
    renderHintEditor();
  });
  bindField('hint-priority', (v) => {
    hint.priority = Math.max(1, parseInt(v, 10) || 1);
    updateHintListTitle(selectedHintIndex, hint);
  });
  bindField('hint-delay', (v) => {
    hint.delay_seconds = Math.max(0, parseInt(v, 10) || 0);
  });
  bindField('hint-after-attempts', (v) => {
    hint.trigger.after_attempts = Math.max(0, parseInt(v, 10) || 0);
  });
  bindField('hint-style', (v) => {
    if (v) hint.style = v;
    else delete hint.style;
  });
  bindCheckboxField('hint-invalidate-on-false', (v) => {
    hint.trigger.invalidate_on_condition_false = v;
  });
  bindCheckboxField('hint-show-once', (v) => { hint.show_once = v; });
}

/**
 * Validate one AST pattern through the builder's own Python engine.
 * Rejected (not resolved) in file:// mode so the editor shows why.
 */
async function validateHintPattern(pattern) {
  const engine = getPythonEngine();
  if (!engine) {
    throw new Error('Pattern validation requires HTTP — serve this folder with npm run dev.');
  }
  const errors = await engine.validatePatterns({ patterns: [{ key: HINT_PATTERN_KEY, pattern }] });
  return errors.hint || null;
}

function bindField(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  const event = el.tagName === 'SELECT' ? 'change' : 'input';
  el.addEventListener(event, (e) => {
    setter(e.target.value);
    notifyChange();
  });
}

function bindCheckboxField(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', (e) => {
    setter(e.target.checked);
    notifyChange();
  });
}

function getHintPriority(hint) {
  return hint?.priority || 1;
}

function getHintTitleText(hint) {
  const message = typeof hint?.message === 'string' ? hint.message : String(hint?.message ?? '');
  const snippet = `${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`;
  return `P${getHintPriority(hint)} — ${snippet}`;
}

function getHintListTitle(hint) {
  return escapeHtml(getHintTitleText(hint));
}

function updateHintListTitle(index, hint) {
  const title = document.querySelector(`#hint-list .list-item[data-index="${index}"] .list-item-title`);
  if (!title) return;
  title.textContent = getHintTitleText(hint);
}

function getHintDisplayMode(hint) {
  return hint?.display_mode === 'checklist' ? 'checklist' : 'triggered';
}

function getTriggerEvent(hint) {
  const event = hint?.trigger?.event;
  return VALID_HINT_EVENTS.includes(event) ? event : VALID_HINT_EVENTS[0];
}

function getTriggerEventLabel(event) {
  return TRIGGER_EVENT_LABELS[event] || event;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
