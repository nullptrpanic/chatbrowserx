import { useEffect, useSyncExternalStore } from 'react';
import type { PanelClient } from './panel-client';

/** Connects and disposes one Panel client while exposing its immutable external-store state. */
export function usePanelStore(client: PanelClient) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    void client.connect();
    return () => client.dispose();
  }, [client]);
  return state;
}
