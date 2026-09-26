import { ensureGroupCreateModule } from './wwebjs-group-create';

describe('ensureGroupCreateModule', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  afterEach(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
    jest.useRealTimers();
  });

  const page = (modules: Record<string, unknown>) => {
    const require = jest.fn((name: string) => modules[name]);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { require } });
    return require;
  };

  it('leaves an already loaded module alone and never calls the group mutation', async () => {
    const createGroup = jest.fn();
    const require = page({ WAWebGroupCreateJob: { createGroup } });
    await ensureGroupCreateModule();
    expect(require).toHaveBeenCalledTimes(1);
    expect(createGroup).not.toHaveBeenCalled();
  });

  it.each([false, true])('loads a cold group module, including the default export shape (%s)', async wrapped => {
    const createGroup = jest.fn();
    const modules: Record<string, unknown> = {};
    const loadModules = jest.fn((_names: string[], callback: () => void) => {
      modules.WAWebGroupCreateJob = { createGroup };
      callback();
    });
    modules.Bootloader = wrapped ? { default: { loadModules } } : { loadModules };
    page(modules);
    await ensureGroupCreateModule();
    expect(loadModules).toHaveBeenCalledWith(['WAWebNewGroupFlow.react'], expect.any(Function), 'OpenWA');
    expect(createGroup).not.toHaveBeenCalled();
  });

  it('fails before any creation when the loaded bundle still has no job', async () => {
    page({ Bootloader: { loadModules: (_names: string[], callback: () => void) => callback() } });
    await expect(ensureGroupCreateModule()).rejects.toThrow('unavailable after loading');
  });

  it('bounds a stalled bundle download', async () => {
    jest.useFakeTimers();
    page({ Bootloader: { loadModules: jest.fn() } });
    const pending = expect(ensureGroupCreateModule()).rejects.toThrow('did not load');
    await jest.advanceTimersByTimeAsync(10000);
    await pending;
  });
});
