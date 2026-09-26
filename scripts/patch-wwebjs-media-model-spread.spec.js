'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  applyMediaModelSpreadFix,
  isApplied,
  MODEL_SPREAD,
  SERIALIZED_SPREAD,
} = require('./patch-wwebjs-media-model-spread.js');

/**
 * The failure this guards is total and silent about its cause: on an unpatched tree every media send
 * throws `Data passed to getter must include an id property` inside the page and surfaces as a bare
 * "Internal error". A patcher that half-applied (or stood down against a changed upstream) would ship
 * an image whose media sending is still dead, so the unrecognised-shape branches matter as much as
 * the transform.
 */
function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-media-model-spread-'));
  const utils = path.join(root, 'src', 'util', 'Injected', 'Utils.js');
  fs.mkdirSync(path.dirname(utils), { recursive: true });
  fs.writeFileSync(utils, source);
  return { root, utils };
}

test('replaces the media model spread with the serialized one', () => {
  const { root, utils } = makeDependency(`before\n${MODEL_SPREAD}\nafter\n`);

  const result = applyMediaModelSpreadFix(root);

  assert.deepEqual(result, {
    skipped: false,
    note: 'outgoing media messages carry serialized media data, not the model',
  });
  assert.equal(fs.readFileSync(utils, 'utf8'), `before\n${SERIALIZED_SPREAD}\nafter\n`);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(`before\n${MODEL_SPREAD}\nafter\n`);

  assert.equal(isApplied(root), false);

  applyMediaModelSpreadFix(root);

  assert.equal(isApplied(root), true);
});

test('is idempotent when the serialized spread is already present', () => {
  const { root, utils } = makeDependency(`before\n${SERIALIZED_SPREAD}\nafter\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.deepEqual(applyMediaModelSpreadFix(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already sends serialized media data instead of the model',
  });
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, utils } = makeDependency('exports.LoadUtils = () => {};\n');
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyMediaModelSpreadFix(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('rejects a half-patched tree carrying both shapes without changing it', () => {
  const { root, utils } = makeDependency(`${MODEL_SPREAD}\n${SERIALIZED_SPREAD}\n`);
  const original = fs.readFileSync(utils, 'utf8');

  assert.throws(() => applyMediaModelSpreadFix(root), /unsupported Utils\.js shape/);
  assert.equal(fs.readFileSync(utils, 'utf8'), original);
});

test('reports a missing whatsapp-web.js rather than pretending to patch it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-media-model-spread-empty-'));

  assert.throws(() => applyMediaModelSpreadFix(root), /Utils\.js not found/);
  assert.equal(isApplied(root), true, 'a tree we cannot read is not evidence of a broken one');
});

/**
 * The exit-code contract both consumers stand on: postinstall passes `--best-effort` and must not
 * fail an install it cannot help, while the Docker production stage runs the patcher bare so an
 * upstream shape change fails the image build instead of shipping media sending dead.
 */
test('CLI: unrecognised tree exits 1 bare and 0 under --best-effort', () => {
  const { spawnSync } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-media-model-spread-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'patch-wwebjs-media-model-spread.js');
  fs.copyFileSync(path.join(__dirname, 'patch-wwebjs-media-model-spread.js'), script);
  const utilsDir = path.join(root, 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected');
  fs.mkdirSync(utilsDir, { recursive: true });
  fs.writeFileSync(path.join(utilsDir, 'Utils.js'), 'exports.LoadUtils = () => {};\n');

  const bare = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bare.status, 1, 'the production image build must fail on a tree the patcher cannot repair');
  assert.match(bare.stderr, /unsupported Utils\.js shape/);

  const bestEffort = spawnSync(process.execPath, [script, '--best-effort'], { encoding: 'utf8' });
  assert.equal(bestEffort.status, 0, 'postinstall must not fail an install the patcher cannot help');
  assert.match(bestEffort.stderr, /skipped/);
});

/**
 * Shape assertions on the replacement itself. Both are things the live page proved matter and that a
 * later tidy-up would quietly undo: dropping the caption re-add trades a hard throw for silently
 * captionless media, and narrowing the `toJSON`-absent fallback back to `{}` moves the breakage onto
 * the sticker path, whose `processStickerData` returns a plain object with no `toJSON`.
 */
test('the replacement carries the caption the model spread used to supply', () => {
  assert.ok(
    SERIALIZED_SPREAD.includes("mediaOptions.caption !== undefined ? { caption: mediaOptions.caption } : {}"),
    'toJSON() omits caption — sendMessage assigns it onto the model after processMediaData returns',
  );
});

test('the replacement keeps the raw object fallback for the sticker path', () => {
  assert.ok(
    SERIALIZED_SPREAD.includes('mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions'),
    'processStickerData returns a plain object with no toJSON; an empty fallback would drop it',
  );
  assert.equal(
    SERIALIZED_SPREAD.includes('...mediaOptions,'),
    false,
    'the unconditional model spread is what copies the model internals that make the page throw',
  );
});

test('matches the message shape the installed whatsapp-web.js ships', () => {
  const installed = path.join(
    __dirname,
    '..',
    'node_modules',
    'whatsapp-web.js',
    'src',
    'util',
    'Injected',
    'Utils.js',
  );
  const source = fs.readFileSync(installed, 'utf8');

  assert.ok(
    source.includes(MODEL_SPREAD) || source.includes(SERIALIZED_SPREAD),
    'installed Utils.js matches neither the upstream message shape nor the patched one',
  );
});
