import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import { createLogger } from '../../common/services/logger.service';
import { type WwebjsEngineHost } from './wwebjs-host';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';

/**
 * getMessageMedia is the route to an attachment the gateway never stored: one that arrived before
 * the session existed, or sits deeper than the 100-message media window of getChatHistory. The page
 * store answers by id only for a message it has loaded, so an old one has to be reached by walking
 * the chat back — and a miss at either step must not be reported before the other was tried.
 */
const logger = createLogger('wwebjs-message-media.spec');
const CHAT = '628999@c.us';
const MESSAGE_ID = 'false_628999@c.us_ABC';
const MEDIA = { mimetype: 'application/pdf', filename: 'invoice.pdf', data: 'JVBERg==' };

const message = (id: string, hasMedia = true) => ({ id: { _serialized: id }, hasMedia });
const filler = (count: number) => Array.from({ length: count }, (_, i) => message(`filler-${i}`, false));

function makeMessaging(client: Record<string, jest.Mock>) {
  const capInboundMediaFor = jest.fn().mockResolvedValue(MEDIA);
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    isPageTransportError: () => false,
    reportIfPageTransportError: jest.fn(),
    capInboundMediaFor,
    logger,
  } as unknown as WwebjsEngineHost;
  return { messaging: new WwebjsMessaging(host), capInboundMediaFor };
}

describe('getMessageMedia', () => {
  it('downloads straight from the page store when the message is already loaded', async () => {
    const target = message(MESSAGE_ID);
    const client = { getMessageById: jest.fn().mockResolvedValue(target), getChatById: jest.fn() };
    const { messaging, capInboundMediaFor } = makeMessaging(client);

    await expect(messaging.getMessageMedia(CHAT, MESSAGE_ID)).resolves.toEqual(MEDIA);
    expect(capInboundMediaFor).toHaveBeenCalledWith(target);
    expect(client.getChatById).not.toHaveBeenCalled();
  });

  it.each([
    ['resolves undefined', jest.fn().mockResolvedValue(undefined)],
    ['throws', jest.fn().mockRejectedValue(new Error('msg not in store'))],
  ])('walks the chat back when the page store %s, widening until the message appears', async (_, getMessageById) => {
    const target = message(MESSAGE_ID);
    const fetchMessages = jest
      .fn()
      .mockResolvedValueOnce(filler(100))
      .mockResolvedValueOnce([...filler(269), target, ...filler(230)]);
    const client = { getMessageById, getChatById: jest.fn().mockResolvedValue({ fetchMessages }) };
    const { messaging, capInboundMediaFor } = makeMessaging(client);

    await expect(messaging.getMessageMedia(CHAT, MESSAGE_ID)).resolves.toEqual(MEDIA);
    expect(fetchMessages.mock.calls).toEqual([[{ limit: 100 }], [{ limit: 500 }]]);
    expect(capInboundMediaFor).toHaveBeenCalledWith(target);
  });

  it('stops widening once a short page shows the chat has nothing earlier', async () => {
    const fetchMessages = jest.fn().mockResolvedValue(filler(40));
    const client = {
      getMessageById: jest.fn().mockResolvedValue(undefined),
      getChatById: jest.fn().mockResolvedValue({ fetchMessages }),
    };

    await expect(makeMessaging(client).messaging.getMessageMedia(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
    expect(fetchMessages).toHaveBeenCalledTimes(1);
  });

  it('throws MessageNotFoundError for a chat this account cannot see', async () => {
    const client = {
      getMessageById: jest.fn().mockResolvedValue(undefined),
      getChatById: jest.fn().mockResolvedValue(undefined),
    };
    await expect(makeMessaging(client).messaging.getMessageMedia(CHAT, MESSAGE_ID)).rejects.toBeInstanceOf(
      MessageNotFoundError,
    );
  });

  it('resolves undefined for a message that carries no media, without attempting a download', async () => {
    const client = { getMessageById: jest.fn().mockResolvedValue(message(MESSAGE_ID, false)), getChatById: jest.fn() };
    const { messaging, capInboundMediaFor } = makeMessaging(client);

    await expect(messaging.getMessageMedia(CHAT, MESSAGE_ID)).resolves.toBeUndefined();
    expect(capInboundMediaFor).not.toHaveBeenCalled();
  });
});
