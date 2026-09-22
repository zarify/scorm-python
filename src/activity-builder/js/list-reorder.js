/**
 * List Reorder — shared drag-and-drop reordering for builder list panels.
 *
 * Used by the tests list and the hints list so both behave identically.
 */

const DRAGGING_CLASS = 'dragging';
const DRAG_OVER_BEFORE_CLASS = 'drag-over-before';
const DRAG_OVER_AFTER_CLASS = 'drag-over-after';

/**
 * Enable drag-and-drop reordering of the list items inside a container.
 * Items must carry their index in `data-index` and the `list-item-reorderable`
 * class for the shared drag styling.
 * @param {HTMLElement} container - Element holding the list items
 * @param {{
 *   itemSelector: string,
 *   onMove: (fromIndex: number, targetIndex: number, position: 'before'|'after') => void,
 * }} options
 */
export function enableListReordering(container, { itemSelector, onMove }) {
  let draggedIndex = null;

  const clearDropIndicators = () => {
    container.querySelectorAll(itemSelector).forEach((item) => {
      item.classList.remove(DRAGGING_CLASS, DRAG_OVER_BEFORE_CLASS, DRAG_OVER_AFTER_CLASS);
    });
  };

  container.querySelectorAll(itemSelector).forEach((item) => {
    item.addEventListener('dragstart', (event) => {
      draggedIndex = getItemIndex(item);
      if (draggedIndex === null) return;
      item.classList.add(DRAGGING_CLASS);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(draggedIndex));
    });

    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (draggedIndex === null) return;
      const before = isPointerInTopHalf(item, event.clientY);
      item.classList.toggle(DRAG_OVER_BEFORE_CLASS, before);
      item.classList.toggle(DRAG_OVER_AFTER_CLASS, !before);
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove(DRAG_OVER_BEFORE_CLASS, DRAG_OVER_AFTER_CLASS);
    });

    item.addEventListener('drop', (event) => {
      event.preventDefault();
      if (draggedIndex === null) return;
      const targetIndex = getItemIndex(item);
      if (targetIndex === null) return;
      const position = isPointerInTopHalf(item, event.clientY) ? 'before' : 'after';
      onMove(draggedIndex, targetIndex, position);
      draggedIndex = null;
    });

    item.addEventListener('dragend', () => {
      draggedIndex = null;
      clearDropIndicators();
    });
  });
}

/**
 * Move an item inside an array.
 * @param {Array} items - Array mutated in place
 * @param {number} fromIndex
 * @param {number} targetIndex - Index of the item the pointer is over
 * @param {'before'|'after'} position - Where to drop relative to targetIndex
 * @returns {{ fromIndex: number, insertIndex: number, changed: boolean } | null} Null when the indices are out of range
 */
export function moveListItem(items, fromIndex, targetIndex, position) {
  if (!Array.isArray(items) || !isIndexInRange(items, fromIndex) || !isIndexInRange(items, targetIndex)) {
    return null;
  }
  if (fromIndex === targetIndex) {
    return { fromIndex, insertIndex: fromIndex, changed: false };
  }

  const [moved] = items.splice(fromIndex, 1);
  let insertIndex = targetIndex;
  if (fromIndex < targetIndex) {
    insertIndex -= 1;
  }
  if (position === 'after') {
    insertIndex += 1;
  }
  insertIndex = Math.max(0, Math.min(insertIndex, items.length));
  items.splice(insertIndex, 0, moved);

  return { fromIndex, insertIndex, changed: true };
}

/**
 * Track which item stays selected after a reorder.
 * @param {number} selectedIndex
 * @param {number} fromIndex
 * @param {number} insertIndex
 * @returns {number}
 */
export function getSelectionIndexAfterMove(selectedIndex, fromIndex, insertIndex) {
  if (selectedIndex === fromIndex) return insertIndex;
  if (fromIndex < selectedIndex && insertIndex >= selectedIndex) return selectedIndex - 1;
  if (fromIndex > selectedIndex && insertIndex <= selectedIndex) return selectedIndex + 1;
  return selectedIndex;
}

function getItemIndex(item) {
  const index = parseInt(item.dataset.index, 10);
  return Number.isInteger(index) ? index : null;
}

function isIndexInRange(items, index) {
  return Number.isInteger(index) && index >= 0 && index < items.length;
}

function isPointerInTopHalf(element, pointerY) {
  const rect = element.getBoundingClientRect();
  return pointerY < rect.top + rect.height / 2;
}
