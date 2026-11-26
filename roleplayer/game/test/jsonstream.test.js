"use strict";
/* Ported from the plugin's tests/test-jsonstream.php, with checks of partialLine(). */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Jsonstream } = require("../jsonstream.js");

const doc = '{"npcs":[{"name":"Velal","gender":"Male"}],"lines":[{"speaker_id":"science","line":"A \\"quoted\\" thing, with } and ] inside."},{"speaker_id":"computer","line":"Second\\\\"}],"channel":{"open":true,"with":null},"scan":null,"canon":[]}';

const split = (s, n) => { const out = []; for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n)); return out; };

test("array elements are reported, whatever the chunk size", () => {
  const seen = {};
  for (const size of [1, 3, 7, 1000]) {
    const got = [];
    const js = new Jsonstream((key, obj) => got.push([key, obj]));
    for (const chunk of split(doc, size)) js.feed(chunk);
    seen[size] = got;
  }
  assert.equal(seen[1].length, 3, "three array elements are reported");
  assert.deepEqual(seen[1][0], ["npcs", { name: "Velal", gender: "Male" }], "the npc comes first, with its key");
  assert.equal(seen[1][1][1].line, 'A "quoted" thing, with } and ] inside.', "braces and quotes inside a string do not confuse it");
  assert.equal(seen[1][2][1].line, "Second\\", "a trailing escaped backslash is read correctly");
  assert.ok([3, 7, 1000].every(n => JSON.stringify(seen[n]) === JSON.stringify(seen[1])), "the result does not depend on how the text is cut up");
});

test("an element is reported as soon as it closes, before the rest arrives", () => {
  const got = [];
  const js = new Jsonstream((key, obj) => got.push(obj));
  js.feed('{"lines":[{"line":"one"},{"line":"tw');
  assert.deepEqual(got, [{ line: "one" }], "the first line is out while the second is still being written");
  js.feed('o"}');
  assert.equal(got.length, 2, "the second follows when it closes");
});

test("the element being written is passed to the partial callback", () => {
  const parts = [];
  const js = new Jsonstream(() => {}, (key, raw) => parts.push([key, raw]));
  js.feed('{"lines":[{"speaker_id":"helm","line":"Course la');
  assert.deepEqual(parts.at(-1), ["lines", '{"speaker_id":"helm","line":"Course la']);
});

test("partialLine reads a line that is still being written", () => {
  assert.deepEqual(Jsonstream.partialLine('{"speaker_id":"helm","line":"Course laid'), { head: { speaker_id: "helm" }, text: "Course laid" });
  assert.equal(Jsonstream.partialLine('{"speaker_id":"helm"'), null, "no line yet");
  assert.deepEqual(Jsonstream.partialLine('{"a":1,"line":"done","b":2}'), { head: { a: 1 }, text: "done" }, "stops at the closing quote");
  assert.deepEqual(Jsonstream.partialLine('{"a":1,"line":"half an escape \\'), { head: { a: 1 }, text: "half an escape " }, "an unfinished escape is held back");
  assert.deepEqual(Jsonstream.partialLine('{"a":1,"line":"x\\u00'), { head: { a: 1 }, text: "x" }, "an unfinished \\u escape is held back");
  assert.deepEqual(Jsonstream.partialLine('{"a":1,"line":"smile \\ud83d'), { head: { a: 1 }, text: "smile " }, "half a surrogate pair is held back");
  assert.deepEqual(Jsonstream.partialLine('{"a":1,"line":"smile \\ud83d\\ude00'), { head: { a: 1 }, text: "smile \u{1F600}" }, "a whole pair is shown");
  assert.equal(Jsonstream.partialLine('{"a":,"line":"x'), null, "a broken head gives nothing");
});
