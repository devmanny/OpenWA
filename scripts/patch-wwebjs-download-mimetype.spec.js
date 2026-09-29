'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { applyBackport, isApplied, ANCHOR, PATCHED } = require('./patch-wwebjs-download-mimetype.js');

// Message.downloadMedia exactly as whatsapp-web.js 1.34.7 ships it, inside a stand-in module that
// supplies the two names it uses (MessageMedia and the page handle) so the spec can run it.
const DOWNLOAD_MEDIA = `    async downloadMedia() {
        if (!this.hasMedia) {
            return undefined;
        }

        const result = await this.client.pupPage.evaluate(async (msgId) => {
            const msg =
                window.require('WAWebCollections').Msg.get(msgId) ||
                (
                    await window
                        .require('WAWebCollections')
                        .Msg.getMessagesById([msgId])
                )?.messages?.[0];

            // REUPLOADING mediaStage means the media is expired and the download button is spinning, cannot be downloaded now
            if (
                !msg ||
                !msg.mediaData ||
                msg.mediaData.mediaStage === 'REUPLOADING'
            ) {
                return null;
            }
            if (msg.mediaData.mediaStage != 'RESOLVED') {
                // try to resolve media
                await msg.downloadMedia({
                    downloadEvenIfExpensive: true,
                    rmrReason: 1,
                });
            }

            if (
                msg.mediaData.mediaStage.includes('ERROR') ||
                msg.mediaData.mediaStage === 'FETCHING'
            ) {
                // media could not be downloaded
                return undefined;
            }

            try {
                const mockQpl = {
                    addAnnotations: function () {
                        return this;
                    },
                    addPoint: function () {
                        return this;
                    },
                };
                const decryptedMedia = await window
                    .require('WAWebDownloadManager')
                    .downloadManager.downloadAndMaybeDecrypt({
                        directPath: msg.directPath,
                        encFilehash: msg.encFilehash,
                        filehash: msg.filehash,
                        mediaKey: msg.mediaKey,
                        mediaKeyTimestamp: msg.mediaKeyTimestamp,
                        type: msg.type,
                        signal: new AbortController().signal,
                        downloadQpl: mockQpl,
                    });

                const data =
                    await window.WWebJS.arrayBufferToBase64Async(
                        decryptedMedia,
                    );

                return {
                    data,
                    mimetype: msg.mimetype,
                    filename: msg.filename,
                    filesize: msg.size,
                };
            } catch (e) {
                if (e.status && e.status === 404) return undefined;
                throw e;
            }
        }, this.id._serialized);

        if (!result) return undefined;
        return new MessageMedia(
            result.mimetype,
            result.data,
            result.filename,
            result.filesize,
        );
    }
`;

const MODULE = body => `'use strict';

class MessageMedia {
    constructor(mimetype, data, filename, filesize) {
        Object.assign(this, { mimetype, data, filename, filesize });
    }
}

class Message {
    constructor(client, serializedId) {
        this.client = client;
        this.hasMedia = true;
        this.id = { _serialized: serializedId };
    }

${body}}

module.exports = Message;
`;

// The allowlist check the September 2026 WhatsApp Web builds run before a download: a missing
// mimetype defaults to application/octet-stream, which no media type accepts.
const ALLOWED = { audio: new Set(['audio/ogg; codecs=opus', 'audio/mpeg']), image: new Set(['image/jpeg']) };

function fakePage(msg) {
  const calls = [];
  const window = {
    require(name) {
      if (name === 'WAWebCollections') return { Msg: { get: id => (id === msg.id ? msg : undefined) } };
      if (name === 'WAWebDownloadManager') {
        return {
          downloadManager: {
            async downloadAndMaybeDecrypt(args) {
              calls.push(args);
              const mimetype = args.mimetype ?? 'application/octet-stream';
              if (!ALLOWED[args.type].has(mimetype)) {
                const error = new Error(`Unexpected mimetype ${mimetype} for media type ${args.type}`);
                error.name = 'InvalidMediaFileType';
                throw error;
              }
              return Uint8Array.from([1, 2, 3]).buffer;
            },
          },
        };
      }
      throw new Error(`unexpected module ${name}`);
    },
    WWebJS: { arrayBufferToBase64Async: async buffer => Buffer.from(buffer).toString('base64') },
  };
  // Stands in for puppeteer's page.evaluate: the page function runs with the fake page as `window`.
  const pupPage = {
    async evaluate(fn, ...args) {
      const saved = globalThis.window;
      globalThis.window = window;
      try {
        return await fn(...args);
      } finally {
        globalThis.window = saved;
      }
    },
  };
  return { client: { pupPage }, calls };
}

const VOICE_NOTE = {
  id: 'false_100000000000001@lid_3A00000000000000000A',
  type: 'audio',
  mimetype: 'audio/ogg; codecs=opus',
  filename: undefined,
  size: 3,
  mediaData: { mediaStage: 'RESOLVED' },
  directPath: '/v/t62.7117-24/1',
  encFilehash: 'enc',
  filehash: 'hash',
  mediaKey: 'key',
  mediaKeyTimestamp: 1700000000,
};

function makeDependency(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-download-mimetype-'));
  const message = path.join(root, 'src', 'structures', 'Message.js');
  fs.mkdirSync(path.dirname(message), { recursive: true });
  fs.writeFileSync(message, source);
  return { root, message };
}

function download(messageFile, msg) {
  const Message = require(messageFile);
  const { client, calls } = fakePage(msg);
  return { calls, result: new Message(client, msg.id).downloadMedia() };
}

test('the 1.34.7 download fails on the mimetype check it does not satisfy', async () => {
  // The regression itself: without the patch every download is refused by the page.
  const { message } = makeDependency(MODULE(DOWNLOAD_MEDIA));

  const { calls, result } = download(message, VOICE_NOTE);

  await assert.rejects(result, {
    name: 'InvalidMediaFileType',
    message: /application\/octet-stream for media type audio/,
  });
  assert.equal(calls[0].mimetype, undefined);
});

test('forwards the message mimetype so the download passes the check', async () => {
  const { root, message } = makeDependency(MODULE(DOWNLOAD_MEDIA));

  assert.deepEqual(applyBackport(root), {
    skipped: false,
    note: 'message mimetype forwarded to the media download',
  });
  const { calls, result } = download(message, VOICE_NOTE);

  const media = await result;
  assert.equal(calls[0].mimetype, 'audio/ogg; codecs=opus');
  assert.equal(media.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(media.data, Buffer.from([1, 2, 3]).toString('base64'));
});

test('is idempotent once the fix is present', () => {
  const { root, message } = makeDependency(MODULE(DOWNLOAD_MEDIA.replace(ANCHOR, PATCHED)));
  const original = fs.readFileSync(message, 'utf8');

  assert.deepEqual(applyBackport(root), {
    skipped: true,
    reason: 'installed whatsapp-web.js already forwards the mimetype to the media download',
  });
  assert.equal(fs.readFileSync(message, 'utf8'), original);
});

test('reports the patch as applied only once the transform has run', () => {
  const { root } = makeDependency(MODULE(DOWNLOAD_MEDIA));

  assert.equal(isApplied(root), false);
  applyBackport(root);
  assert.equal(isApplied(root), true);
});

test('rejects an unknown dependency shape without changing it', () => {
  const { root, message } = makeDependency('class Message { async downloadMedia() {} }\n');
  const original = fs.readFileSync(message, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Message\.js shape/);
  assert.equal(fs.readFileSync(message, 'utf8'), original);
});

test('rejects an ambiguous dependency shape without changing it', () => {
  const { root, message } = makeDependency(`${ANCHOR}${ANCHOR}`);
  const original = fs.readFileSync(message, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Message\.js shape/);
  assert.equal(fs.readFileSync(message, 'utf8'), original);
});

// The patch stands down when the fix is already there, so a shape carrying both the fix and a
// second, unpatched call is not one it understands either.
test('rejects a fix present alongside a second anchor', () => {
  const { root, message } = makeDependency(`${PATCHED}${ANCHOR}`);
  const original = fs.readFileSync(message, 'utf8');

  assert.throws(() => applyBackport(root), /unsupported Message\.js shape/);
  assert.equal(fs.readFileSync(message, 'utf8'), original);
});
