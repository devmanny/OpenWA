/**
 * Forward the message's declared mimetype to WhatsApp Web's media download.
 *
 * `Message.downloadMedia` fetches and decrypts the blob through the page's
 * `WAWebDownloadManager.downloadManager.downloadAndMaybeDecrypt`, passing the media coordinates and
 * `type` but not the mimetype. The WhatsApp Web builds rolled out in September 2026 (first seen here
 * on 2.3000.1048653945) read `mimetype` from that argument, default a missing one to
 * `application/octet-stream`, and check it against the allowlist for the media type before
 * downloading. No media type allows `application/octet-stream`, so every download the library makes
 * throws `InvalidMediaFileType: Unexpected mimetype application/octet-stream for media type audio`
 * (or image, video, ...), which reaches Node as the minified `t: t`. Inbound media is then emitted
 * without its bytes, and a later MessageDownloadMedia can never fetch it. WhatsApp Web's own
 * download path passes the message's mimetype, which is what this adds (whatsapp-web.js issue
 * #201908; upstream's PR #201914 targets the unreleased main branch, and there is no release after
 * 1.34.7).
 *
 * The source transform is deliberately exact and self-disabling, like the sibling patchers. An
 * unknown shape fails the production image build instead of silently shipping without the fix, and
 * the patch stands down once the installed tree carries the line itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_WWJS = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js');
const MESSAGE_PATH = path.join('src', 'structures', 'Message.js');

// The tail of the downloadAndMaybeDecrypt argument in Message.downloadMedia, unique in the file.
const ANCHOR = `                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        signal: new AbortController().signal,
`;
const PATCHED = `                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        mimetype: msg.mimetype,
                        signal: new AbortController().signal,
`;

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function applyBackport(wwjsDir = DEFAULT_WWJS) {
  const messageFile = path.join(wwjsDir, MESSAGE_PATH);
  if (!fs.existsSync(messageFile)) {
    throw new Error(`whatsapp-web.js Message.js not found at ${messageFile}`);
  }

  const source = fs.readFileSync(messageFile, 'utf8');
  const anchorCount = occurrences(source, ANCHOR);
  const patchedCount = occurrences(source, PATCHED);

  if (anchorCount === 0 && patchedCount === 1) {
    return {
      skipped: true,
      reason: 'installed whatsapp-web.js already forwards the mimetype to the media download',
    };
  }
  if (anchorCount !== 1 || patchedCount !== 0) {
    throw new Error(
      `unsupported Message.js shape (anchors: ${anchorCount}, patched: ${patchedCount}); ` +
        're-evaluate the download mimetype backport against the installed whatsapp-web.js',
    );
  }

  fs.writeFileSync(messageFile, source.replace(ANCHOR, PATCHED));
  return { skipped: false, note: 'message mimetype forwarded to the media download' };
}

/**
 * The stand-down branch above as a predicate, for the startup guard (engine-patch-status.ts).
 * Unreadable reads as applied: a tree we cannot inspect is not evidence of a broken one.
 */
function isApplied(wwjsDir = DEFAULT_WWJS) {
  try {
    const source = fs.readFileSync(path.join(wwjsDir, MESSAGE_PATH), 'utf8');
    return occurrences(source, ANCHOR) === 0 && occurrences(source, PATCHED) === 1;
  } catch {
    return true;
  }
}

function run() {
  const bestEffort = process.argv.includes('--best-effort');
  try {
    const result = applyBackport();
    console.log(`patch-wwebjs-download-mimetype: ${result.skipped ? `skipped: ${result.reason}` : result.note}`);
  } catch (error) {
    if (bestEffort) {
      console.warn(`patch-wwebjs-download-mimetype: skipped: ${error.message}`);
      return;
    }
    console.error(`patch-wwebjs-download-mimetype: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) run();

module.exports = { applyBackport, isApplied, ANCHOR, PATCHED };
