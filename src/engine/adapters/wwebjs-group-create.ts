/**
 * Runs in the WhatsApp page. Recent builds put group creation in the NewGroupFlow
 * bundle, which a headless session may never load. Fetch its code before calling
 * Client.createGroup; loading the component does not open UI or create a group.
 */
export async function ensureGroupCreateModule(): Promise<void> {
  type Module = { createGroup?: unknown; loadModules?: Bootloader['loadModules']; default?: Bootloader };
  interface Bootloader {
    loadModules(components: string[], callback: () => void, context: string): void;
  }
  const w = window as unknown as { require: (name: string) => Module | undefined };
  const read = (name: string): Module | undefined => {
    try {
      return w.require(name);
    } catch {
      return undefined;
    }
  };
  if (typeof read('WAWebGroupCreateJob')?.createGroup === 'function') return;

  const module = read('Bootloader');
  const bootloader = typeof module?.loadModules === 'function' ? (module as Bootloader) : module?.default;
  if (!bootloader?.loadModules) throw new Error('WhatsApp group creation module is unavailable');

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WhatsApp group creation module did not load')), 10000);
    try {
      bootloader.loadModules(
        ['WAWebNewGroupFlow.react'],
        () => {
          clearTimeout(timer);
          resolve();
        },
        'OpenWA',
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  if (typeof read('WAWebGroupCreateJob')?.createGroup !== 'function') {
    throw new Error('WhatsApp group creation module is unavailable after loading its bundle');
  }
}
