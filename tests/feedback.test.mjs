import assert from 'node:assert/strict';
import test from 'node:test';

import { runButtonAction } from '../ui/feedback.mjs';

function fakeButton(text = '保存') {
  const classes = new Set();
  return {
    textContent: text,
    disabled: false,
    attributes: new Map(),
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

test('button action shows a disabled busy state and visible success feedback', async () => {
  const button = fakeButton();
  const notices = [];
  let finish;
  let restore;
  const operation = new Promise((resolve) => { finish = resolve; });

  const pending = runButtonAction(button, () => operation, {
    busyText: '保存中', successText: '已保存', successMessage: 'Skill 已保存',
    notify: (...args) => notices.push(args), setTimer: (callback) => { restore = callback; },
  });

  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '保存中');
  assert.equal(button.classList.contains('action-busy'), true);
  assert.equal(button.attributes.get('aria-busy'), 'true');

  finish('saved');
  const result = await pending;
  assert.deepEqual(result, { ok: true, value: 'saved' });
  assert.equal(button.classList.contains('action-success'), true);
  assert.equal(button.textContent, '已保存');
  assert.deepEqual(notices, [['Skill 已保存', 'success']]);

  restore();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '保存');
  assert.equal(button.classList.contains('action-success'), false);
  assert.equal(button.attributes.has('aria-busy'), false);
});

test('button action shows error feedback and restores the control', async () => {
  const button = fakeButton('使用');
  const notices = [];
  let restore;

  const result = await runButtonAction(button, async () => { throw new Error('复制失败'); }, {
    busyText: '复制中', errorText: '失败',
    notify: (...args) => notices.push(args), setTimer: (callback) => { restore = callback; },
  });

  assert.equal(result.ok, false);
  assert.equal(button.classList.contains('action-error'), true);
  assert.equal(button.textContent, '失败');
  assert.deepEqual(notices, [['复制失败', 'error']]);
  restore();
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, '使用');
});
