import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
import {z} from 'zod';

const require = createRequire(import.meta.url);
const cliRequire = createRequire(require.resolve('@remotion/cli'));
const studioRequire = createRequire(cliRequire.resolve('@remotion/studio'));
const typesPath = studioRequire.resolve('@remotion/zod-types');
const typesRequire = createRequire(typesPath);
const {zColor, zMatrix, zTextarea} = studioRequire('@remotion/zod-types');

// GHSA-mrhx-c7xc-m3w5: bounded input proves early refusal without an OOM stress test.
test('oversized constrained arrays reject before visiting any element', () => {
  let visits = 0;
  const schema = z.array(z.string().superRefine(() => { visits++; })).max(2);
  const result = schema.safeParse(Array(8).fill('synthetic'));
  assert.equal(result.success, false);
  assert.equal(visits, 0);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
});

test('bounded arrays retain strict validation and error paths', () => {
  const schema = z.array(z.string()).max(2);
  assert.deepEqual(schema.parse(['one', 'two']), ['one', 'two']);
  const result = schema.safeParse(['one', 2]);
  assert.equal(result.success, false);
  assert.equal(result.error.issues[0].code, 'invalid_type');
  assert.deepEqual(result.error.issues[0].path, [1]);
});

test('actual Remotion color schema accepts colors and rejects invalid values', () => {
  const schema = zColor();
  assert.equal(schema.parse('#FF4A14'), '#FF4A14');
  const invalid = schema.safeParse('not-a-color');
  assert.equal(invalid.success, false);
  assert.match(invalid.error.issues[0].message, /Invalid color/);
  assert.equal(schema.safeParse(42).success, false);
});

test('actual Remotion matrix schema preserves shape and strict numeric validation', () => {
  const schema = zMatrix();
  assert.deepEqual(schema.parse([1, 0, 0, 1]), [1, 0, 0, 1]);
  const invalid = schema.safeParse([1, 0, 1]);
  assert.equal(invalid.success, false);
  assert.match(invalid.error.issues[0].message, /square matrix/);
  const wrongType = schema.safeParse(['1', 0, 0, 1]);
  assert.equal(wrongType.success, false);
  assert.equal(wrongType.error.issues[0].code, 'invalid_type');
});

test('actual Remotion textarea schema remains a strict string', () => {
  const schema = zTextarea();
  assert.equal(schema.parse('synthetic\ntext'), 'synthetic\ntext');
  const invalid = schema.safeParse(123);
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.issues[0].code, 'invalid_type');
});

test('media and actual schema consumer resolve the patched Zod instance', () => {
  assert.equal(require('zod/package.json').version, '4.6.7');
  assert.equal(typesRequire('zod/package.json').version, '4.6.7');
  assert.equal(typesRequire.resolve('zod'), require.resolve('zod'));
});
