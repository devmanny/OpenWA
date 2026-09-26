import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging, parseMessageRef } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { type WwebjsEngineHost } from './wwebjs-host';

/**
 * whatsapp-web.js attaches a quote as a plain send option, orthogonal to the content kind:
 * `quotedMessageId` is copied into `internalOptions` (Client.js:1475) BEFORE the content-kind
 * dispatch that moves the payload into `.media` / `.location` / `.poll` / `.contactCard`, so a quote
 * never competes with what is being sent.
 *
 * The reason these tests assert `ignoreQuoteErrors: false` rather than just the id: the library
 * default is TRUE (Client.js:1383 documents `[ignoreQuoteErrors = true]`, applied at :1480), which
 * makes an unresolvable quote send the message ANYWAY, unquoted, and report success. A caller who
 * asked for a reply and got a loose message with a 201 has no way to detect it. Opting out turns
 * that into an error the caller can see.
 */

const logger = createLogger('wwebjs-quoted-send.spec');

const QUOTED = 'true_628111@c.us_3EB0ABCD';

function makeMessaging(): {
  messaging: WwebjsMessaging;
  client: { sendMessage: jest.Mock; getMessageById: jest.Mock; getChatById: jest.Mock };
} {
  const client = {
    sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 }),
    // The quoted message is already loaded in the page, so it is found by id with no history walk.
    getMessageById: jest.fn().mockResolvedValue({ id: { _serialized: QUOTED, id: '3EB0ABCD', fromMe: true } }),
    getChatById: jest.fn(),
  };
  const host = {
    ensureReady: jest.fn(),
    ensureNotChannelRecipient: jest.fn(),
    getClient: () => client as unknown as Client,
    logger,
    config: {},
    getNumberId: jest.fn(),
    capInboundMediaFor: jest.fn(),
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), client };
}

const optionsOf = (client: { sendMessage: jest.Mock }): Record<string, unknown> => {
  const [, , options] = client.sendMessage.mock.calls[0] as unknown[];
  return (options ?? {}) as Record<string, unknown>;
};

const CHAT = '628111@c.us';
// Base64 rather than a URL: a URL payload runs the real remote-media loader through the SSRF guard,
// so the test would exercise the network instead of the option plumbing it is about.
const IMAGE = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  mimetype: 'image/png',
};

describe('WwebjsMessaging — a quote rides along with every content kind', () => {
  // Each of these builds its own options object (or, for location and poll, had none at all before
  // this change), so covering only the shared media funnel would leave the others silently unquoted.
  it.each([
    ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['document', (m: WwebjsMessaging) => m.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    ['sticker', (m: WwebjsMessaging) => m.sendStickerMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
    [
      'location',
      (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: QUOTED }),
    ],
    [
      'contact',
      (m: WwebjsMessaging) => m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: QUOTED }),
    ],
    [
      'poll',
      (m: WwebjsMessaging) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: QUOTED }),
    ],
    ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: QUOTED })],
  ])('%s send forwards the quoted id with quote errors made visible', async (_kind, send) => {
    const { messaging, client } = makeMessaging();

    await send(messaging);

    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
    // The library would otherwise send unquoted and report success on a bad id.
    expect(optionsOf(client).ignoreQuoteErrors).toBe(false);
  });

  // Known-negative control: without it an implementation that hardcoded the keys onto every send
  // would satisfy every assertion above while changing behaviour for unquoted callers too.
  it('adds no quote keys at all when no id is supplied', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, IMAGE);

    expect(optionsOf(client)).not.toHaveProperty('quotedMessageId');
    expect(optionsOf(client)).not.toHaveProperty('ignoreQuoteErrors');
  });

  it('keeps the caption and mentions it already sent alongside the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendImageMessage(CHAT, {
      ...IMAGE,
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });

    expect(optionsOf(client)).toMatchObject({
      caption: 'look',
      mentions: ['628222@c.us'],
      quotedMessageId: QUOTED,
    });
  });

  it('keeps sendMediaAsDocument, which shares the options object with the quote', async () => {
    const { messaging, client } = makeMessaging();

    await messaging.sendDocumentMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED });

    expect(optionsOf(client).sendMediaAsDocument).toBe(true);
    expect(optionsOf(client).quotedMessageId).toBe(QUOTED);
  });

  /**
   * Opting out of `ignoreQuoteErrors` only gets the caller an error; it does not decide WHICH error.
   * The page throws a bare `Error`, and two things ride on that being remapped: the caller sees the
   * same 404 the Baileys adapter returns for the identical request (and that `docs/06` publishes for
   * both engines), and `countsTowardSendBreaker` treats anything that is not an HttpException as an
   * account-standing failure — so an unmapped error let a caller's own stale id trip the send breaker.
   */
  describe('an id the page cannot resolve', () => {
    const pageError = (): Error => new Error('Evaluation failed: Error: Could not get the quoted message.');

    it.each([
      ['image', (m: WwebjsMessaging) => m.sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
      ['sticker', (m: WwebjsMessaging) => m.sendStickerMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })],
      [
        'location',
        (m: WwebjsMessaging) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: QUOTED }),
      ],
      [
        'contact',
        (m: WwebjsMessaging) =>
          m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: QUOTED }),
      ],
      [
        'poll',
        (m: WwebjsMessaging) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: QUOTED }),
      ],
      ['text', (m: WwebjsMessaging) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: QUOTED })],
    ])('is a 404 naming the id, not a bare 500, on a %s send', async (_kind, send) => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(pageError());

      // getStatus() rather than a `status` property: that is what NestJS exposes, and what
      // message-not-found.error.spec.ts already pins the 404 mapping on.
      await expect(send(messaging)).rejects.toBeInstanceOf(MessageNotFoundError);
      const err = (await send(messaging).catch((e: unknown) => e)) as MessageNotFoundError;
      expect(err.getStatus()).toBe(404);
      expect(err.message).toContain(QUOTED);
    });

    // Known-negative control: the remap keys off the id the caller supplied, so a send that asked
    // for no quote must still surface the page's own error rather than a fabricated not-found.
    it('leaves the error of an unquoted send untouched', async () => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(pageError());

      const err = (await messaging.sendImageMessage(CHAT, IMAGE).catch((e: unknown) => e)) as Error;
      expect(err).not.toBeInstanceOf(MessageNotFoundError);
      expect(err.message).toContain('Could not get the quoted message');
    });

    /**
     * The LID retry runs the send a SECOND time against a freshly resolved recipient, through its own
     * catch — which the first attempt's remap does not cover. Re-resolving the RECIPIENT says nothing
     * about the quoted message, so a send that gets past the stale id and only then fails on the quote
     * is the same caller fault. Without the second remap, one request answers 404 or 500 depending on
     * whether the recipient happened to need re-resolving.
     */
    it('is still a 404 when the quote fails on the LID retry rather than the first attempt', async () => {
      const { messaging, client } = makeMessaging();
      const host = (messaging as unknown as { host: { getNumberId: jest.Mock } }).host;
      // First resolve yields nothing (the send goes to the raw @c.us); after the LID failure the
      // re-resolve returns a DIFFERENT id, which is what makes sendResolved retry at all.
      host.getNumberId.mockResolvedValueOnce(undefined).mockResolvedValueOnce('999@lid');
      client.sendMessage
        .mockRejectedValueOnce(new Error('Evaluation failed: Error: No LID for user'))
        .mockRejectedValueOnce(pageError());

      const err = (await messaging
        .sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })
        .catch((e: unknown) => e)) as MessageNotFoundError;

      expect(client.sendMessage).toHaveBeenCalledTimes(2); // the retry really ran
      expect(err).toBeInstanceOf(MessageNotFoundError);
      expect(err.getStatus()).toBe(404);
      expect(err.message).toContain(QUOTED);
    });

    // Second control: an unrelated failure on a QUOTED send must not be relabelled not-found.
    it('does not relabel an unrelated send failure as a missing quote', async () => {
      const { messaging, client } = makeMessaging();
      client.sendMessage.mockRejectedValue(new Error('Evaluation failed: Error: something else broke'));

      const err = (await messaging
        .sendImageMessage(CHAT, { ...IMAGE, quotedMessageId: QUOTED })
        .catch((e: unknown) => e)) as Error;
      expect(err).not.toBeInstanceOf(MessageNotFoundError);
      expect(err.message).toContain('something else broke');
    });
  });
});

describe('parseMessageRef', () => {
  it.each([
    ['false_10000000000001@lid_3A00AA', { fromMe: false, remote: '10000000000001@lid', key: '3A00AA' }],
    ['true_5210000000001@c.us_3EB0BB', { fromMe: true, remote: '5210000000001@c.us', key: '3EB0BB' }],
    [
      'false_120363000000000001@g.us_3A00CC_10000000000002@lid',
      { fromMe: false, remote: '120363000000000001@g.us', key: '3A00CC', participant: '10000000000002@lid' },
    ],
  ])('splits the serialized id %s', (id, expected) => {
    expect(parseMessageRef(id)).toEqual(expected);
  });

  it.each(['3A00AA', 'maybe_3A00AA_x'])('takes %s as a bare key', id => {
    expect(parseMessageRef(id)).toEqual({ key: id });
  });
});

/**
 * The page resolves a quote only from what it has loaded, and the reply path used to search the last
 * 100 messages only. A message 107 messages back in a `@lid` chat — present in the gateway's own
 * history and reachable by a deep history read — therefore failed as not-found on every shape of its
 * id: the full `@lid` id, the pre-migration `@c.us` id stored with older rows, and the bare key.
 */
describe('WwebjsMessaging — quoting a message the page has not loaded', () => {
  const LID_CHAT = '10000000000001@lid';
  const PHONE_CHAT = '5210000000001@c.us';
  const KEY = '3A00000000000000AAAA';
  const LID_ID = `false_${LID_CHAT}_${KEY}`;
  const PHONE_ID = `false_${PHONE_CHAT}_${KEY}`;

  const msg = (serialized: string, key: string, fromMe = false) => ({
    id: { _serialized: serialized, id: key, fromMe },
  });
  const filler = (count: number) =>
    Array.from({ length: count }, (_, i) => msg(`true_${LID_CHAT}_F${i}`, `F${i}`, true));

  function harness(opts: {
    loaded?: Record<string, ReturnType<typeof msg>>;
    pages?: Array<Array<ReturnType<typeof msg>>>;
    chats?: Record<string, boolean>;
    resolvesTo?: string;
  }) {
    const fetchMessages = jest.fn();
    for (const page of opts.pages ?? []) fetchMessages.mockResolvedValueOnce(page);
    fetchMessages.mockResolvedValue([]);
    const client = {
      sendMessage: jest.fn().mockResolvedValue({ id: { _serialized: 'OUT' }, timestamp: 1 }),
      getMessageById: jest.fn((id: string) => Promise.resolve(opts.loaded?.[id] ?? null)),
      getChatById: jest.fn((id: string) =>
        Promise.resolve((opts.chats ?? { [LID_CHAT]: true })[id] ? { fetchMessages } : undefined),
      ),
    };
    const host = {
      ensureReady: jest.fn(),
      ensureNotChannelRecipient: jest.fn(),
      getClient: () => client as unknown as Client,
      logger,
      config: {},
      getNumberId: jest.fn().mockResolvedValue(opts.resolvesTo ?? null),
      capInboundMediaFor: jest.fn(),
      isPageTransportError: () => false,
      reportIfPageTransportError: jest.fn(),
    } as unknown as WwebjsEngineHost;
    return { messaging: new WwebjsMessaging(host), client, fetchMessages };
  }

  it('walks the chat back past the last 100 messages and replies quoting it', async () => {
    const target = msg(LID_ID, KEY);
    const { messaging, client, fetchMessages } = harness({
      pages: [filler(100), [...filler(393), target, ...filler(106)]],
    });

    await messaging.replyToMessage(LID_CHAT, LID_ID, 'hola');

    expect(fetchMessages.mock.calls).toEqual([[{ limit: 100 }], [{ limit: 500 }]]);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    expect(client.sendMessage).toHaveBeenCalledWith(LID_CHAT, 'hola', {
      quotedMessageId: LID_ID,
      ignoreQuoteErrors: false,
    });
  });

  it('does the same for a text send that carries quotedMessageId', async () => {
    const { messaging, client } = harness({ pages: [filler(100), [msg(LID_ID, KEY), ...filler(200)]] });

    await messaging.sendTextMessage(LID_CHAT, 'hola', undefined, { quotedMessageId: LID_ID });

    expect(optionsOf(client)).toEqual({ quotedMessageId: LID_ID, ignoreQuoteErrors: false });
  });

  it('quotes by the id the page uses when the caller has the pre-migration @c.us form', async () => {
    const { messaging, client } = harness({ loaded: { [LID_ID]: msg(LID_ID, KEY) } });

    await messaging.replyToMessage(LID_CHAT, PHONE_ID, 'hola');

    // Re-addressed to the chat being searched: found by id, no history walk.
    expect(client.getChatById).not.toHaveBeenCalled();
    expect(optionsOf(client).quotedMessageId).toBe(LID_ID);
  });

  it('quotes by the full id when the caller has only the bare key', async () => {
    const { messaging, client } = harness({ loaded: { [LID_ID]: msg(LID_ID, KEY) } });

    await messaging.sendTextMessage(LID_CHAT, 'hola', undefined, { quotedMessageId: KEY });

    expect(optionsOf(client).quotedMessageId).toBe(LID_ID);
  });

  it('finds a group message by its bare key, participant suffix and all', async () => {
    const group = '120363000000000001@g.us';
    const groupId = `false_${group}_${KEY}_10000000000002@lid`;
    const { messaging, client } = harness({
      chats: { [group]: true },
      pages: [[msg(groupId, KEY), ...filler(20)]],
    });

    await messaging.sendTextMessage(group, 'hola', undefined, { quotedMessageId: KEY });

    expect(optionsOf(client).quotedMessageId).toBe(groupId);
  });

  it('searches the @lid chat when the caller addressed the contact by phone', async () => {
    const { messaging, client } = harness({
      chats: { [LID_CHAT]: true },
      resolvesTo: LID_CHAT,
      pages: [[msg(LID_ID, KEY), ...filler(20)]],
    });

    await messaging.replyToMessage(PHONE_CHAT, PHONE_ID, 'hola');

    expect(client.sendMessage).toHaveBeenCalledWith(LID_CHAT, 'hola', {
      quotedMessageId: LID_ID,
      ignoreQuoteErrors: false,
    });
  });

  // docs/06 (Quoted sends): the send-* routes pass a cross-chat id through, a reply refuses it.
  describe('a quoted message that lives in another chat', () => {
    const OTHER_ID = `false_10000000000009@lid_${KEY}`;
    const loaded = { [OTHER_ID]: msg(OTHER_ID, KEY) };

    it('is passed through on a send with quotedMessageId', async () => {
      const { messaging, client } = harness({ loaded });

      await messaging.sendTextMessage(LID_CHAT, 'hola', undefined, { quotedMessageId: OTHER_ID });

      expect(optionsOf(client).quotedMessageId).toBe(OTHER_ID);
    });

    it('is a 404 on a reply, which quotes only inside its own chat', async () => {
      const { messaging, client } = harness({ loaded, pages: [filler(30)] });

      await expect(messaging.replyToMessage(LID_CHAT, OTHER_ID, 'hola')).rejects.toBeInstanceOf(MessageNotFoundError);
      expect(client.getMessageById).not.toHaveBeenCalledWith(OTHER_ID);
      expect(client.sendMessage).not.toHaveBeenCalled();
    });
  });

  it('does not take a message the other way round for the one named', async () => {
    // Same key, opposite direction: the caller named an incoming message, this one is ours.
    const { messaging, client } = harness({ pages: [[msg(`true_${LID_CHAT}_${KEY}`, KEY, true)]] });

    await expect(messaging.replyToMessage(LID_CHAT, LID_ID, 'hola')).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('is a 404 naming the id, and sends nothing, when the message is nowhere in the chat', async () => {
    const { messaging, client, fetchMessages } = harness({ pages: [filler(100), filler(500), filler(1200)] });

    const err = (await messaging
      .sendTextMessage(LID_CHAT, 'hola', undefined, { quotedMessageId: LID_ID })
      .catch((e: unknown) => e)) as MessageNotFoundError;

    expect(err).toBeInstanceOf(MessageNotFoundError);
    expect(err.getStatus()).toBe(404);
    expect(err.message).toContain(LID_ID);
    // The short third page shows the chat has nothing earlier, so the walk stops there.
    expect(fetchMessages).toHaveBeenCalledTimes(3);
    // Never the loose, unquoted message the caller did not ask for.
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('fails a media send on a missing quote before fetching the media', async () => {
    const { messaging, client } = harness({ chats: {} });

    await expect(
      messaging.sendImageMessage(LID_CHAT, { ...IMAGE, data: 'https://example.com/a.png', quotedMessageId: LID_ID }),
    ).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});
