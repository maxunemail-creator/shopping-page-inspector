import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyProduct } from '../src/url.js';

test('parses JD product URL', () => {
  const p = identifyProduct('https://item.jd.com/10193770948879.html?foo=bar');
  assert.equal(p.site, 'jd');
  assert.equal(p.itemId, '10193770948879');
  assert.equal(p.canonicalUrl, 'https://item.jd.com/10193770948879.html');
});

test('parses Taobao product URL', () => {
  const p = identifyProduct('https://item.taobao.com/item.htm?id=744983869996&x=1');
  assert.equal(p.site, 'taobao');
  assert.equal(p.itemId, '744983869996');
});

test('parses Tmall product URL', () => {
  const p = identifyProduct('https://detail.tmall.com/item.htm?id=742902854135');
  assert.equal(p.site, 'tmall');
  assert.equal(p.itemId, '742902854135');
});
