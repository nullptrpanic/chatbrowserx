import { ProviderRegistry, registeredProviders, type ProviderHost } from './registry';

// Conventional entrypoints register themselves; the Agent never imports a concrete model.
import.meta.glob('./*/register.ts', { eager: true });

export async function createProviders(host: ProviderHost): Promise<ProviderRegistry> {
  const providers = new ProviderRegistry(registeredProviders(), host);
  await providers.initialize();
  return providers;
}
