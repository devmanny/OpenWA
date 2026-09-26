/**
 * Send the SERIALIZED media data into the outgoing message, not the media model itself.
 *
 * `window.WWebJS.sendMessage` builds the outgoing message object by spreading `mediaOptions` — the
 * value `window.WWebJS.processMediaData` returns — and then spreading its `toJSON()` on top:
 *
 *     ...mediaOptions,
 *     ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),
 *
 * `processMediaData` does not return a plain object. It returns the WhatsApp Web MediaData MODEL
 * (`prepRawMedia(...).waitForPrep()`, later mutated with `.set(...)` — both model API), so the first
 * spread copies the model's own internal bookkeeping into the message: `parent`, `collection`,
 * `mirror`, `_uiObservers`, `revisionNumber`, the `__x_*` accessor backing fields. The Msg model then
 * initializes over those, sender resolution (`getValidatedSender` -> `getSender`) reaches a memoized
 * collection getter with `undefined`, and the page throws
 *
 *     Data passed to getter must include an id property (it's how we memoize) but got undefined
 *
 * before anything is sent. On whatsapp-web.js 1.34.7 this kills EVERY media send — documents, images,
 * video, audio, stickers through the media path — and reaches the caller as a bare "Internal error"
 * from `MessageSendService`, naming neither media nor the page.
 *
 * Isolated in the live page on a running session, with the same upload already prepared:
 *   - `{...base, ...mediaOptions, ...mediaOptions.toJSON()}` (upstream) -> throws.
 *   - `{...base, ...mediaOptions}`                                      -> throws.
 *   - `{...base, ...mediaOptions.toJSON()}`                             -> document sent.
 *   - `{...base, ...mediaOptions.toJSON(), caption}`                    -> document and image sent,
 *     caption preserved.
 *
 * So the raw model spread is dropped and `toJSON()` becomes the only source of the media fields.
 * Two details make that a rewrite rather than a deletion:
 *
 *   - `caption` is NOT in `toJSON()`. `sendMessage` assigns it onto the model as an own property
 *     (`mediaOptions.caption = options.caption`) after `processMediaData` returns, so it lives
 *     outside the serialized shape and would be silently dropped with the model spread. It is
 *     re-added explicitly, and only when set, so an uncaptioned send does not gain a `caption:
 *     undefined` key it did not have before. `isViewOnce` is assigned the same way but DOES survive,
 *     because the model serializes it.
 *   - The `toJSON`-absent branch now falls back to the raw object instead of `{}`. The sticker path
 *     (`window.WWebJS.processStickerData`, chosen when `sendMediaAsSticker` is set outside channels
 *     and status) returns a plain object literal with no `toJSON`, so under the upstream shape its
 *     fields reached the message through the raw spread alone. Keeping that fallback is what stops
 *     this patch from turning a media bug into a sticker bug; a plain object carries no model
 *     internals, so it was never the failing case.
 *
 * Everything else that reads `mediaOptions` reads the value, not the message: `mediaOptions.preview`
 * and `mediaOptions.mediaHandle` are taken off the object directly, and the `isMedia` branches test
 * `Object.keys(mediaOptions).length`. None of them are affected.
 *
 * There is no upstream fix for this at the time of writing. A release that stops spreading the model
 * matches neither the find nor the replace below, so this patcher stops the build instead of standing
 * down, and retiring it means checking that upstream also carries `caption` across — dropping this
 * patch on an upstream that serializes without it trades a hard throw for silently captionless media.
 *
 * The source transform is deliberately exact and self-disabling. An unknown shape fails the
 * production image build instead of silently shipping without the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const UTILS_PATH = path.join('src', 'util', 'Injected', 'Utils.js');

/**
 * The surrounding spreads are part of the match on purpose. The two media lines alone are the whole
 * edit, but anchoring between `ephemeralFields` and `quotedMsgOptions` pins the edit to the outgoing
 * message literal in `sendMessage` rather than to any future object that happens to spread a media
 * value the same way.
 */
const MODEL_SPREAD = [
  '            ...ephemeralFields,',
  '            ...mediaOptions,',
  '            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : {}),',
  '            ...quotedMsgOptions,',
].join('\n');

const SERIALIZED_SPREAD = [
  '            ...ephemeralFields,',
  '            ...(mediaOptions.caption !== undefined ? { caption: mediaOptions.caption } : {}),',
  '            ...(mediaOptions.toJSON ? mediaOptions.toJSON() : mediaOptions),',
  '            ...quotedMsgOptions,',
].join('\n');

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

/**
 * The stand-down branch below as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, UTILS_PATH), 'utf8');
    return occurrences(source, SERIALIZED_SPREAD) === 1 && occurrences(source, MODEL_SPREAD) === 0;
  } catch {
    return true;
  }
}

function applyMediaModelSpreadFix(wwjsDir = DEFAULT_WWJS) {
  const utilsFile = path.join(wwjsDir, UTILS_PATH);
  if (!fs.existsSync(utilsFile)) {
    throw new Error(`whatsapp-web.js Utils.js not found at ${utilsFile}`);
  }

  const source = fs.readFileSync(utilsFile, 'utf8');
  const modelCount = occurrences(source, MODEL_SPREAD);
  const serializedCount = occurrences(source, SERIALIZED_SPREAD);

  if (modelCount === 0 && serializedCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already sends serialized media data instead of the model',
    };
  }
  if (modelCount !== 1 || serializedCount !== 0) {
    throw new Error(
      `unsupported Utils.js shape (model spreads: ${modelCount}, serialized spreads: ${serializedCount}); ` +
        're-evaluate the media model spread fix against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(utilsFile, source.replace(MODEL_SPREAD, SERIALIZED_SPREAD));
  return { skipped: false, note: 'outgoing media messages carry serialized media data, not the model' };
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyMediaModelSpreadFix();
    console.log(`patch-wwebjs-media-model-spread: ${result.skipped ? `skipped — ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-media-model-spread: skipped — ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-media-model-spread: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyMediaModelSpreadFix, isApplied, MODEL_SPREAD, SERIALIZED_SPREAD };
