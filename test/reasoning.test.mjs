import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reasoningText } from '../lib/reasoning.js';
import { classify, chineseShare } from '../lib/index.js';

test('leading signature metadata cannot change prose classification or language', () => {
  for (const prose of [
    "I'll inspect this conversation before deciding whether to keep it.",
    'Let me inspect this conversation before deciding whether to keep it.',
    '我需要仔细检查这个会话中的推理内容然后再决定是否应该保留这个会话。',
  ]) {
    for (const metadata of ['Let me discard this.', "I'll keep this.", '中文'.repeat(100)]) {
      const prepared = reasoningText(`<signature>${metadata}</signature>\r\n\n${prose}`);
      assert.equal(prepared, prose);
      for (const final of [false, true]) assert.deepEqual(classify(prepared, final), classify(prose, final));
      assert.equal(chineseShare(prepared), chineseShare(prose));
    }
  }
});

test('every stream split withholds metadata and publishes prose without retracting CRLF', () => {
  const prefix = '<signature>opaque\nLet me ignore this.</signature>\r\n\n';
  const prose = "I'll preserve the first prose opening.";
  const raw = prefix + prose;
  let previous = '';
  for (let end = 0; end <= raw.length; end++) {
    const value = reasoningText(raw.slice(0, end));
    assert.equal(value, prose.slice(0, Math.max(0, end - prefix.length)));
    assert.ok(value.startsWith(previous), 'Prepared stream must be append-only');
    previous = value;
  }
});

test('plain text, other markup and later signatures remain prose', () => {
  for (const raw of ['', 'ordinary prose', '<note>reasoning</note>', '<signatures>prose',
    ' \n<signature>not a leading envelope</signature>',
    "I'll quote <signature>inside prose</signature>.",
    '<signature>first</signature><signature>second is prose</signature>']) {
    assert.equal(reasoningText(raw), raw.startsWith('<signature>first')
      ? '<signature>second is prose</signature>' : raw);
  }
  assert.equal(reasoningText('<signature>unfinished metadata'), '');
  assert.equal(reasoningText('<signature>metadata</signature>\rtext'), '\rtext');
});
