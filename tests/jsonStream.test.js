import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonItemStream, repairJson, parseObjectResponse } from '../server/src/lib/jsonStream.js';

const chunkify = (text, size) => {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

test('streams array items out one at a time', () => {
  const payload = { ideas: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] };
  const text = JSON.stringify(payload);
  const stream = new JsonItemStream({ arrayKey: 'ideas' });
  const got = [];
  for (const chunk of chunkify(text, 7)) got.push(...stream.push(chunk));
  got.push(...stream.finish());
  assert.deepEqual(got.map((g) => g.title), ['a', 'b', 'c']);
});

test('emits items before the stream is finished (the whole point of streaming)', () => {
  const stream = new JsonItemStream({ arrayKey: 'ideas' });
  stream.push('{"ideas":[{"title":"first","description":"x"}');
  assert.equal(stream.items.length, 1, 'first idea must be available while the rest is still generating');
  assert.equal(stream.items[0].title, 'first');
  stream.push(',{"title":"second"}]}');
  assert.equal(stream.items.length, 2);
});

test('survives every chunk boundary', () => {
  const payload = {
    ideas: [
      { title: 'Braces } and "quotes" inside strings', description: 'a,b,c', nested: { x: [1, 2, 3] } },
      { title: 'unicode ✓ and \\ backslash', description: 'line\nbreak' },
      { title: 'third' },
    ],
  };
  const text = JSON.stringify(payload);
  for (const size of [1, 2, 3, 5, 11, 17, 64, text.length]) {
    const stream = new JsonItemStream({ arrayKey: 'ideas' });
    const got = [];
    for (const chunk of chunkify(text, size)) got.push(...stream.push(chunk));
    got.push(...stream.finish());
    assert.equal(got.length, 3, `chunk size ${size} produced ${got.length} items`);
    assert.deepEqual(got, payload.ideas, `chunk size ${size}`);
  }
});

test('ignores the array key appearing inside a string value', () => {
  const text = JSON.stringify({ note: 'we want ideas here', ideas: [{ title: 'real' }] });
  const stream = new JsonItemStream({ arrayKey: 'ideas' });
  const got = [];
  for (const chunk of chunkify(text, 4)) got.push(...stream.push(chunk));
  got.push(...stream.finish());
  // the first match is `"ideas here"` which is not followed by `:` `[`, so it must be skipped
  assert.equal(got.length, 1);
  assert.equal(got[0].title, 'real');
});

test('top-level mode parses a single object response', () => {
  const stream = new JsonItemStream({ arrayKey: null });
  const obj = { factors: { novelty: 6 }, whyNotHigher: 'competition' };
  for (const chunk of chunkify(JSON.stringify(obj), 5)) stream.push(chunk);
  stream.finish();
  assert.deepEqual(stream.items[0], obj);
});

test('salvages a truncated stream', () => {
  const stream = new JsonItemStream({ arrayKey: 'ideas' });
  stream.push('{"ideas":[{"title":"complete"},{"title":"cut off mid-sen');
  const got = stream.finish();
  assert.ok(stream.items.length >= 1);
  assert.equal(stream.items[0].title, 'complete');
  assert.ok(got.length >= 0);
});

test('salvages a bare array with no wrapper key', () => {
  const stream = new JsonItemStream({ arrayKey: 'ideas' });
  stream.push('[{"title":"a"},{"title":"b"}]');
  stream.finish();
  assert.equal(stream.items.length, 2);
});

test('repairJson strips fences, prose and trailing commas', () => {
  assert.deepEqual(repairJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(repairJson('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.deepEqual(repairJson('{"a":1,"b":[1,2,],}'), { a: 1, b: [1, 2] });
  assert.deepEqual(repairJson('{"a":1'), { a: 1 });
  assert.equal(repairJson('no json at all'), null);
});

test('parseObjectResponse handles a well-formed response untouched', () => {
  const obj = { factors: { novelty: 7.2 }, priorArt: ['x'] };
  assert.deepEqual(parseObjectResponse(JSON.stringify(obj)), obj);
  assert.equal(parseObjectResponse(''), null);
});
