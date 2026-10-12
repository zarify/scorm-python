/**
 * Condition Builder — recursive form editor for the six config condition
 * types, shared by the Hints and Tests tabs.
 *
 * Serialization format is the schema condition object verbatim: the editor
 * mutates the object in place and calls `onChange(condition)` after each edit.
 */

import { VALID_CONDITION_TYPES } from '../../shared/config-validator.js';
import { enableListReordering } from './list-reorder.js';
import { basicSetup } from 'codemirror';
import { EditorView, placeholder as cmPlaceholder } from '@codemirror/view';
import { python } from '@codemirror/lang-python';

const CONDITION_TYPE_LABELS = {
  ast_pattern: 'AST pattern (Python source)',
  source_regex: 'Source matches regex',
  source_empty: 'Source is empty',
  all: 'All of… (AND)',
  any: 'Any of… (OR)',
  none: 'None of… (NOT)',
};

const collapsedConditions = new WeakSet();

function nodeSummaryText(condition) {
  if (['all', 'any', 'none'].includes(condition.type)) {
    const count = (condition.conditions ?? []).length;
    return `${count} sub-condition${count === 1 ? '' : 's'}`;
  }

  const snippet = [condition.pattern, condition.block_type, condition.upper_type]
    .find((value) => value != null && String(value).trim());
  if (snippet == null) return '';

  const normalized = String(snippet).trim().replace(/\s+/g, ' ');
  return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized;
}

function updateSummary(node, condition) {
  const summary = node.querySelector('.condition-node-summary');
  if (summary) summary.textContent = nodeSummaryText(condition);
}

function setConditionNodeExpanded(toggle, expanded) {
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', expanded ? 'Collapse condition' : 'Expand condition');
}

/** A valid default condition object for the given type. */
export function createDefaultCondition(type = 'ast_pattern') {
  switch (type) {
    case 'source_regex':
      return { type, pattern: '', case_sensitive: true, regex_flags: '' };
    case 'source_empty':
      return { type };
    case 'all':
    case 'any':
    case 'none':
      return { type, conditions: [createDefaultCondition('ast_pattern')] };
    case 'ast_pattern':
    default:
      return { type: 'ast_pattern', pattern: '', min_count: 1 };
  }
}

/**
 * Tear down CodeMirror instances under `container` before its DOM is wiped.
 * Re-renders replace innerHTML; without this the views would leak.
 */
export function destroyConditionEditors(container) {
  if (!container) return;
  container.querySelectorAll('.cond-pattern').forEach((host) => {
    host.condPatternView?.destroy();
    host.condPatternView = null;
  });
}

/**
 * Render a condition editor into `container`.
 * @param {{
 *   container: HTMLElement,
 *   condition: object,
 *   onChange: (condition: object) => void,
 *   validatePattern?: (pattern: string) => Promise<string|null>,
 *   depth?: number,
 *   onRemove?: () => void,
 * }} options
 */
export function renderConditionEditor({ container, condition, onChange, validatePattern, depth = 0, onRemove }) {
  destroyConditionEditors(container);
  container.innerHTML = '';
  const rerender = () => renderConditionEditor({
    container, condition, onChange, validatePattern, depth, onRemove,
  });

  const wrapper = document.createElement('div');
  const isComposite = ['all', 'any', 'none'].includes(condition.type);
  wrapper.className = `condition-node${isComposite ? ` condition-node--${condition.type}` : ''}`;

  const header = document.createElement('div');
  header.className = 'condition-node-header';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'condition-node-toggle';
  toggle.textContent = '▾';
  toggle.addEventListener('click', () => {
    const collapsed = !collapsedConditions.has(condition);
    if (collapsed) collapsedConditions.add(condition);
    else collapsedConditions.delete(condition);
    wrapper.classList.toggle('is-collapsed', collapsed);
    setConditionNodeExpanded(toggle, !collapsed);
    if (!collapsed) {
      wrapper.querySelectorAll('.cond-pattern').forEach((host) => host.condPatternView?.requestMeasure());
    }
  });

  const title = document.createElement('span');
  title.className = 'condition-node-title';
  title.textContent = CONDITION_TYPE_LABELS[condition.type] ?? condition.type;

  const summary = document.createElement('span');
  summary.className = 'condition-node-summary';
  summary.textContent = nodeSummaryText(condition);

  header.append(toggle, title, summary);
  if (onRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'condition-remove';
    removeBtn.title = 'Remove this condition';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', onRemove);
    header.appendChild(removeBtn);
  }

  const body = document.createElement('div');
  body.className = 'condition-node-body';
  body.append(renderTypeRow(condition, onChange, rerender));
  body.append(renderTypeFields(condition, onChange, validatePattern, depth, () => updateSummary(wrapper, condition)));
  wrapper.append(header, body);

  const hasEmbeddedEditor = [...body.querySelectorAll('.cond-pattern')]
    .some((host) => host.closest('.condition-node') === wrapper);
  const restoreCollapse = collapsedConditions.has(condition) && !hasEmbeddedEditor;
  wrapper.classList.toggle('is-collapsed', restoreCollapse);
  setConditionNodeExpanded(toggle, !restoreCollapse);
  container.appendChild(wrapper);
}

function renderTypeRow(condition, onChange, rerender) {
  const row = document.createElement('div');
  row.className = 'condition-type-row';

  const label = document.createElement('label');
  label.textContent = 'Condition type';

  const select = document.createElement('select');
  select.className = 'cond-type-select';
  for (const type of VALID_CONDITION_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = CONDITION_TYPE_LABELS[type] || type;
    option.selected = condition.type === type;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const replacement = createDefaultCondition(select.value);
    if (select.value === condition.type) return;
    // Preserve children when switching between composites.
    if (Array.isArray(condition.conditions)
      && Array.isArray(replacement.conditions)
      && condition.conditions.length > 0) {
      replacement.conditions = condition.conditions;
    }
    applyReplacement(condition, replacement);
    collapsedConditions.delete(condition);
    onChange(condition);
    rerender();
  });

  row.append(label, select);
  return row;
}

function applyReplacement(target, replacement) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, replacement);
}

function renderTypeFields(condition, onChange, validatePattern, depth, updateNodeSummary) {
  const fields = document.createElement('div');
  fields.className = 'condition-fields';

  switch (condition.type) {
    case 'ast_pattern':
      fields.appendChild(renderAstPatternFields(condition, onChange, validatePattern));
      break;
    case 'source_regex':
      fields.appendChild(renderRegexFields(condition, onChange));
      break;
    case 'source_empty': {
      const note = document.createElement('p');
      note.className = 'condition-note';
      note.textContent = 'Passes while the editor content is empty (only whitespace counts as empty).';
      fields.appendChild(note);
      break;
    }
    case 'all':
    case 'any':
    case 'none':
      fields.appendChild(renderCompositeFields(condition, onChange, validatePattern, depth, updateNodeSummary));
      break;
    default:
  }
  return fields;
}

function renderAstPatternFields(condition, onChange, validatePattern) {
  const fragment = document.createDocumentFragment();

  const hint = document.createElement('p');
  hint.className = 'condition-note';
  hint.innerHTML = 'Python source with wildcards: <code>_</code> matches any expression, '
    + '<code>_name</code> binds one name consistently, <code>…</code> matches any statements '
    + 'or call arguments. By default a pattern matches construct variants '
    + '(an <code>if</code> also matches <code>if-else</code>); tick “Strict clause matching” '
    + 'to require exactly the clauses written.';
  fragment.appendChild(hint);

  const host = document.createElement('div');
  host.className = 'cond-pattern mono';
  fragment.appendChild(host);
  const view = new EditorView({
    doc: condition.pattern ?? '',
    parent: host,
    extensions: [
      basicSetup,
      python(),
      EditorView.lineWrapping,
      cmPlaceholder('e.g. _x = input(...)\n...\nprint(_x)'),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          condition.pattern = view.state.doc.toString();
          onChange(condition);
        }
      }),
    ],
  });
  host.condPatternView = view;

  const counts = document.createElement('div');
  counts.className = 'condition-counts';

  const minLabel = document.createElement('label');
  minLabel.textContent = 'Min matches';
  const minInput = document.createElement('input');
  minInput.type = 'number';
  minInput.min = '1';
  minInput.value = String(Math.max(1, Number(condition.min_count) || 1));
  minInput.addEventListener('input', () => {
    const value = Math.max(1, Math.trunc(Number(minInput.value) || 1));
    condition.min_count = value;
    if (typeof condition.max_count === 'number' && condition.max_count < value) {
      condition.max_count = value;
    }
    onChange(condition);
  });

  const maxLabel = document.createElement('label');
  maxLabel.textContent = 'Max matches';
  const maxInput = document.createElement('input');
  maxInput.type = 'number';
  maxInput.min = '1';
  maxInput.placeholder = '∞';
  maxInput.value = condition.max_count != null ? String(condition.max_count) : '';
  maxInput.addEventListener('input', () => {
    if (maxInput.value === '') {
      delete condition.max_count;
    } else {
      const floor = Math.max(1, Number(condition.min_count) || 1);
      condition.max_count = Math.max(floor, Math.trunc(Number(maxInput.value) || floor));
    }
    onChange(condition);
  });

  counts.append(minLabel, minInput, maxLabel, maxInput);

  if (typeof validatePattern === 'function') {
    const validateBtn = document.createElement('button');
    validateBtn.type = 'button';
    validateBtn.className = 'btn btn-small btn-secondary cond-validate';
    validateBtn.textContent = '✓ Validate';
    const result = document.createElement('span');
    result.className = 'cond-validate-result';
    validateBtn.addEventListener('click', async () => {
      validateBtn.disabled = true;
      result.textContent = 'Checking…';
      result.classList.remove('is-error', 'is-ok');
      try {
        const errorMessage = await validatePattern(condition.pattern ?? '');
        if (errorMessage) {
          result.textContent = errorMessage;
          result.classList.add('is-error');
        } else {
          result.textContent = '✓ Pattern is valid';
          result.classList.add('is-ok');
        }
      } catch (err) {
        result.textContent = err?.message || String(err);
        result.classList.add('is-error');
      } finally {
        validateBtn.disabled = false;
      }
    });
    counts.append(validateBtn, result);
  }

  fragment.appendChild(counts);

  const strictLabel = document.createElement('label');
  strictLabel.className = 'checkbox-label';
  const strictBox = document.createElement('input');
  strictBox.type = 'checkbox';
  strictBox.className = 'cond-strict';
  strictBox.checked = condition.strict === true;
  strictBox.addEventListener('change', () => {
    condition.strict = strictBox.checked;
    onChange(condition);
  });
  strictLabel.append(strictBox, ' Strict clause matching');
  fragment.appendChild(strictLabel);
  return fragment;
}

function renderRegexFields(condition, onChange) {
  const fragment = document.createDocumentFragment();

  const patternLabel = document.createElement('label');
  patternLabel.textContent = 'Regex pattern';
  const patternInput = document.createElement('input');
  patternInput.type = 'text';
  patternInput.className = 'cond-regex-pattern mono';
  patternInput.spellcheck = false;
  patternInput.placeholder = 'e.g. for \\w+ in range\\(len\\(\\w+\\)\\):';
  patternInput.value = condition.pattern ?? '';
  patternInput.addEventListener('input', () => {
    condition.pattern = patternInput.value;
    onChange(condition);
  });

  const options = document.createElement('div');
  options.className = 'condition-regex-options';

  const caseLabel = document.createElement('label');
  caseLabel.className = 'checkbox-label';
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.checked = condition.case_sensitive !== false;
  caseBox.addEventListener('change', () => {
    condition.case_sensitive = caseBox.checked;
    onChange(condition);
  });
  caseLabel.append(caseBox, ' Case sensitive');
  options.appendChild(caseLabel);

  for (const flag of ['i', 'm', 's']) {
    const label = document.createElement('label');
    label.className = 'checkbox-label';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = (condition.regex_flags || '').includes(flag);
    box.addEventListener('change', () => {
      const current = new Set((condition.regex_flags || '').split(''));
      if (box.checked) current.add(flag); else current.delete(flag);
      condition.regex_flags = ['i', 'm', 's'].filter((f) => current.has(f)).join('');
      onChange(condition);
    });
    label.append(box, ` ${flag}`);
    options.appendChild(label);
  }

  const flagNote = document.createElement('p');
  flagNote.className = 'condition-note';
  flagNote.innerHTML = 'Python <code>re</code> syntax — the engine runs <code>re.search</code> over the raw '
    + 'source, so groups and backreferences like <code>(\\w+) \\1</code> work. '
    + '<code>i</code> is controlled by the case-sensitive checkbox. '
    + '<code>m</code> = multiline anchors, <code>s</code> = dot matches newline.';

  fragment.append(patternLabel, patternInput, options, flagNote);
  return fragment;
}

function renderCompositeFields(condition, onChange, validatePattern, depth, updateNodeSummary) {
  const fragment = document.createDocumentFragment();
  if (!Array.isArray(condition.conditions)) condition.conditions = [];

  const list = document.createElement('div');
  list.className = 'condition-children';

  const renderChildren = () => {
    destroyConditionEditors(list);
    list.innerHTML = '';
    condition.conditions.forEach((child, index) => {
      const card = document.createElement('div');
      card.className = 'condition-card list-item-reorderable';
      card.dataset.index = String(index);

      const host = document.createElement('div');
      host.setAttribute('data-condition-host', '');
      card.appendChild(host);
      list.appendChild(card);

      renderConditionEditor({
        container: host,
        condition: child,
        onChange: () => onChange(condition),
        validatePattern,
        depth: depth + 1,
        onRemove: () => {
          condition.conditions.splice(index, 1);
          onChange(condition);
          renderChildren();
        },
      });
    });

    enableListReordering(list, {
      itemSelector: '.condition-card',
      onMove: (fromIndex, targetIndex, position) => {
        const insertIndex = position === 'before' ? targetIndex : targetIndex + 1;
        const adjusted = fromIndex < insertIndex ? insertIndex - 1 : insertIndex;
        const [moved] = condition.conditions.splice(fromIndex, 1);
        condition.conditions.splice(adjusted, 0, moved);
        onChange(condition);
        renderChildren();
      },
    });
    updateNodeSummary();
  };
  renderChildren();

  const addChild = document.createElement('button');
  addChild.type = 'button';
  addChild.className = 'btn btn-small btn-secondary add-sub-condition';
  addChild.textContent = '+ Add sub-condition';
  addChild.addEventListener('click', () => {
    condition.conditions.push(createDefaultCondition('ast_pattern'));
    onChange(condition);
    renderChildren();
  });

  fragment.append(list, addChild);
  return fragment;
}
