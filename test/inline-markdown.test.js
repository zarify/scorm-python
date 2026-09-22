/**
 * Inline markdown rendering for student-facing strings (messages, hints,
 * instructions, feedback).
 *
 * The edges that matter are the ones a config author or a generated string can
 * produce: raw HTML that must never survive, backticks and asterisks that do
 * not form a pair, delimiters that span a newline, nested delimiters, and the
 * non-string values a missing config field yields (null, undefined, numbers).
 *
 * The renderer keeps no mutable module state, so tests import it directly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderInlineMarkdown } from '../src/shared/inline-markdown.js';

test('missing and non-string values render as text, not as a crash', () => {
  assert.equal(renderInlineMarkdown(null), '');
  assert.equal(renderInlineMarkdown(undefined), '');
  assert.equal(renderInlineMarkdown(''), '');
  assert.equal(renderInlineMarkdown(42), '42');
  assert.equal(renderInlineMarkdown(0), '0');
  assert.equal(renderInlineMarkdown(NaN), 'NaN');
  assert.equal(renderInlineMarkdown(false), 'false');
  assert.equal(renderInlineMarkdown({ toString: () => '<x>' }), '&lt;x&gt;');
});

test('raw markup is escaped so nothing can be injected', () => {
  assert.equal(
    renderInlineMarkdown('<script>alert("x")&\'y\'</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;',
  );
  assert.equal(renderInlineMarkdown('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
  assert.equal(renderInlineMarkdown('a > b'), 'a &gt; b');
  assert.equal(renderInlineMarkdown('a & b'), 'a &amp; b');
  assert.equal(renderInlineMarkdown('"quoted"'), '&quot;quoted&quot;');
  assert.equal(renderInlineMarkdown("it's"), 'it&#39;s');

  // Entities the author already wrote stay visible rather than being decoded.
  assert.equal(renderInlineMarkdown('a &lt; b'), 'a &amp;lt; b');
  assert.equal(renderInlineMarkdown('&amp;'), '&amp;amp;');
});

test('code spans render, and markup inside them is escaped rather than interpreted', () => {
  assert.equal(renderInlineMarkdown('`code`'), '<code>code</code>');
  assert.equal(renderInlineMarkdown('`<b>&amp;</b>`'), '<code>&lt;b&gt;&amp;amp;&lt;/b&gt;</code>');
  assert.equal(renderInlineMarkdown('`x` `y`'), '<code>x</code> <code>y</code>');
  assert.equal(renderInlineMarkdown('before `a*b*c` after'), 'before <code>a*b*c</code> after');
  assert.equal(renderInlineMarkdown('`**not bold**`'), '<code>**not bold**</code>');
});

test('unpaired and empty backticks stay literal', () => {
  assert.equal(renderInlineMarkdown('`x'), '`x');
  assert.equal(renderInlineMarkdown('x`'), 'x`');
  assert.equal(renderInlineMarkdown('``'), '``');
  assert.equal(renderInlineMarkdown('``x``'), '`<code>x</code>`');
  assert.equal(renderInlineMarkdown('` `'), '<code> </code>');
});

test('a code span does not cross a newline', () => {
  assert.equal(renderInlineMarkdown('`a\nb`'), '`a<br>b`');
  assert.equal(renderInlineMarkdown('`a\nb` c'), '`a<br>b` c');
});

test('bold renders only for a non-empty pair', () => {
  assert.equal(renderInlineMarkdown('**bold**'), '<strong>bold</strong>');
  assert.equal(renderInlineMarkdown('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(renderInlineMarkdown('**bold** and **more**'), '<strong>bold</strong> and <strong>more</strong>');
  assert.equal(renderInlineMarkdown('**unclosed'), '**unclosed');
});

test('italic renders only for a non-empty pair and does not swallow a single star', () => {
  assert.equal(renderInlineMarkdown('*italic*'), '<em>italic</em>');
  assert.equal(renderInlineMarkdown('a*b*c'), 'a<em>b</em>c');
  assert.equal(renderInlineMarkdown('a * b'), 'a * b');
  assert.equal(renderInlineMarkdown('*'), '*');
  assert.equal(renderInlineMarkdown('*unclosed'), '*unclosed');
});

test('empty and unbalanced delimiter runs render literally', () => {
  assert.equal(renderInlineMarkdown('**'), '**');
  assert.equal(renderInlineMarkdown('****'), '<em>*</em>*');
  assert.equal(renderInlineMarkdown('** **'), '<em>* </em>*');
  assert.equal(renderInlineMarkdown('**x*'), '<em>*x</em>');
  assert.equal(renderInlineMarkdown('***x***'), '<strong>*x</strong>*');
  assert.equal(renderInlineMarkdown('* *'), '* *');
});

test('emphasis nesting keeps the inner delimiter as text', () => {
  assert.equal(renderInlineMarkdown('**bold *ital***'), '<strong>bold *ital</strong>*');
  assert.equal(renderInlineMarkdown('**`code`**'), '<strong><code>code</code></strong>');
  assert.equal(renderInlineMarkdown('`code **not bold**`'), '<code>code **not bold**</code>');
  assert.equal(renderInlineMarkdown('**a *b* c**'), '<strong>a <em>b</em> c</strong>');
});

test('an emphasis pair may span a newline and renders the break inside it', () => {
  assert.equal(renderInlineMarkdown('**a\nb**'), '<strong>a<br>b</strong>');
  assert.equal(renderInlineMarkdown('*a\nb*'), '<em>a<br>b</em>');
});

test('a newline is a break, and other whitespace is left alone', () => {
  assert.equal(renderInlineMarkdown('line1\nline2'), 'line1<br>line2');
  assert.equal(renderInlineMarkdown('\n'), '<br>');
  assert.equal(renderInlineMarkdown('a\n\nb'), 'a<br><br>b');
  assert.equal(renderInlineMarkdown('a\r\nb'), 'a\r<br>b');
  assert.equal(renderInlineMarkdown('a\tb'), 'a\tb');
});

test('all three constructs work together in one string', () => {
  assert.equal(
    renderInlineMarkdown('**bold** and *ital* and `code`\nnext <line>'),
    '<strong>bold</strong> and <em>ital</em> and <code>code</code><br>next &lt;line&gt;',
  );
});
