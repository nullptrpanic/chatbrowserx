import type { Server } from 'node:http';

/** Stops accepting requests and terminates browser keep-alive connections during fixture cleanup. */
export async function closeHttpFixtureServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}
