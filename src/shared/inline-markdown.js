/**
 * Render a safe, limited subset of inline Markdown for student-facing strings.
 *
 * Supported syntax:
 * - `code`
 * - **bold**
 * - *italic*
 * - newline breaks
 */

export function renderInlineMarkdown(value) {
  return renderSegment(value == null ? '' : String(value));
}

function renderSegment(text) {
  let html = '';

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      html += '<br>';
      continue;
    }

    if (text[index] === '`') {
      const closingIndex = text.indexOf('`', index + 1);
      if (closingIndex > index + 1) {
        const codeContent = text.slice(index + 1, closingIndex);
        if (!codeContent.includes('\n')) {
          html += `<code>${escapeHtml(codeContent)}</code>`;
          index = closingIndex;
          continue;
        }
      }
    }

    if (text.startsWith('**', index)) {
      const closingIndex = findClosingDelimiter(text, index, '**');
      if (closingIndex !== -1) {
        html += `<strong>${renderSegment(text.slice(index + 2, closingIndex))}</strong>`;
        index = closingIndex + 1;
        continue;
      }
    }

    if (text[index] === '*') {
      const closingIndex = findClosingDelimiter(text, index, '*');
      if (closingIndex !== -1) {
        html += `<em>${renderSegment(text.slice(index + 1, closingIndex))}</em>`;
        index = closingIndex;
        continue;
      }
    }

    html += escapeHtml(text[index]);
  }

  return html;
}

function findClosingDelimiter(text, startIndex, delimiter) {
  let searchIndex = startIndex + delimiter.length;

  while (searchIndex < text.length) {
    const closingIndex = text.indexOf(delimiter, searchIndex);
    if (closingIndex === -1) {
      return -1;
    }

    const content = text.slice(startIndex + delimiter.length, closingIndex);
    if (content.trim()) {
      return closingIndex;
    }

    searchIndex = closingIndex + delimiter.length;
  }

  return -1;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
