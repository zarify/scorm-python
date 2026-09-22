/**
 * Config Tab — metadata, instructions, and UI settings.
 */

import { getConfig, notifyChange, onConfigChange } from './builder-app.js';
import { SUSPEND_DATA_DEFAULT_LIMIT } from '../../shared/config-normalizer.js';

let lastConfigRef = null;

export function initConfigTab() {
  lastConfigRef = getConfig();

  // Bind metadata fields
  bindInput('cfg-title', (val) => {
    const cfg = getConfig();
    cfg.metadata.title = val;
    cfg.metadata.activity_id = slugify(val);
    document.getElementById('cfg-activity-id').value = cfg.metadata.activity_id;
  });

  bindInput('cfg-version', (val) => { getConfig().metadata.version = val; });
  bindInput('cfg-description', (val) => { getConfig().metadata.description = val; });

  // Instructions
  bindInput('cfg-instructions-main', (val) => { getConfig().instructions.main = val; });
  initStepsList();

  // UI settings
  bindCheckbox('cfg-show-hints', (val) => { getConfig().ui_settings.show_hint_panel = val; });
  bindInput('cfg-suspend-data-limit', (val) => {
    getConfig().ui_settings.suspend_data_limit = val
      ? Math.max(512, parseInt(val, 10))
      : SUSPEND_DATA_DEFAULT_LIMIT;
  });
  bindCheckbox('cfg-require-previous-test-pass', (val) => {
    getConfig().evaluation.require_previous_test_pass = val;
  });
  bindInput('cfg-feedback-on-all-pass', (val) => {
    getConfig().evaluation.feedback_on_all_pass = val;
  });

  onConfigChange((newCfg) => {
    if (newCfg === lastConfigRef) return;
    populateFromConfig(newCfg);
    lastConfigRef = newCfg;
  });
}

function populateFromConfig(cfg) {
  document.getElementById('cfg-title').value = cfg.metadata?.title || '';
  document.getElementById('cfg-activity-id').value = cfg.metadata?.activity_id || '';
  document.getElementById('cfg-version').value = cfg.metadata?.version || '1.0';
  document.getElementById('cfg-description').value = cfg.metadata?.description || '';
  document.getElementById('cfg-instructions-main').value = cfg.instructions?.main || '';
  document.getElementById('cfg-show-hints').checked = cfg.ui_settings?.show_hint_panel !== false;
  document.getElementById('cfg-suspend-data-limit').value = cfg.ui_settings?.suspend_data_limit || '';
  document.getElementById('cfg-require-previous-test-pass').checked = cfg.evaluation?.require_previous_test_pass !== false;
  document.getElementById('cfg-feedback-on-all-pass').value = cfg.evaluation?.feedback_on_all_pass || '';
  renderSteps(cfg.instructions?.steps || []);
}

function initStepsList() {
  document.getElementById('btn-add-step').addEventListener('click', () => {
    const cfg = getConfig();
    if (!cfg.instructions.steps) cfg.instructions.steps = [];
    cfg.instructions.steps.push('');
    renderSteps(cfg.instructions.steps);
    notifyChange();
  });
  renderSteps(getConfig().instructions?.steps || []);
}

function renderSteps(steps) {
  const container = document.getElementById('instruction-steps-list');
  container.innerHTML = '';
  steps.forEach((step, i) => {
    const div = document.createElement('div');
    div.className = 'step-item';
    div.innerHTML = `
      <span style="color:#999;font-size:12px;width:20px">${i + 1}.</span>
      <input type="text" value="${escapeAttr(step)}" placeholder="Step ${i + 1}...">
      <button class="step-remove" title="Remove step">✕</button>
    `;
    div.querySelector('input').addEventListener('input', (e) => {
      getConfig().instructions.steps[i] = e.target.value;
      notifyChange();
    });
    div.querySelector('.step-remove').addEventListener('click', () => {
      getConfig().instructions.steps.splice(i, 1);
      renderSteps(getConfig().instructions.steps);
      notifyChange();
    });
    container.appendChild(div);
  });
}

function bindInput(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => {
    setter(e.target.value);
    notifyChange();
  });
}

function bindCheckbox(id, setter) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', (e) => {
    setter(e.target.checked);
    notifyChange();
  });
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 50);
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
