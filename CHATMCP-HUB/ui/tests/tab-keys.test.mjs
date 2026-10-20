import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTabIndex } from '../src/lib/tab-keys.ts';

// The keys of an ARIA tablist with automatic activation: the same behaviour in the work panel and in the Agents tab.

test('ArrowRight and ArrowLeft move one tab and wrap around the ends', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 3), 1);
  assert.equal(nextTabIndex('ArrowRight', 2, 3), 0);
  assert.equal(nextTabIndex('ArrowLeft', 2, 3), 1);
  assert.equal(nextTabIndex('ArrowLeft', 0, 3), 2);
});

test('Home and End jump to the first and the last tab', () => {
  assert.equal(nextTabIndex('Home', 2, 5), 0);
  assert.equal(nextTabIndex('End', 0, 5), 4);
});

test('any other key is left alone, and so is a tablist with nothing to move to', () => {
  for (const key of ['Enter', ' ', 'ArrowUp', 'ArrowDown', 'Tab', 'a', 'Escape']) assert.equal(nextTabIndex(key, 1, 3), null, key);
  assert.equal(nextTabIndex('ArrowRight', 0, 0), null);
  assert.equal(nextTabIndex('Home', 0, 0), null);
});

test('a single tab stays where it is', () => {
  assert.equal(nextTabIndex('ArrowRight', 0, 1), 0);
  assert.equal(nextTabIndex('ArrowLeft', 0, 1), 0);
});

test('a current tab that is not in the list (index -1) starts from the edge, never to a negative index', () => {
  assert.equal(nextTabIndex('ArrowRight', -1, 3), 0);
  assert.equal(nextTabIndex('ArrowLeft', -1, 3), 2);
});
