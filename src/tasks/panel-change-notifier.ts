import type { Clock } from '../shared/time';
import type { PanelStateChangedNotification } from '../shared/protocol/message-types';

export interface PanelChangeNotifierDependencies {
  readonly clock: Clock;
  readonly publish: (notification: PanelStateChangedNotification) => Promise<void>;
}

/** Owns one process-wide monotonic panel version and coalesces synchronous change bursts. */
export class PanelChangeNotifier {
  readonly #dependencies: PanelChangeNotifierDependencies;
  #version = 0;
  #publicationQueued = false;

  constructor(dependencies: PanelChangeNotifierDependencies) {
    this.#dependencies = dependencies;
  }

  getVersion(): number {
    return this.#version;
  }

  changed(): void {
    this.#version = Math.max(this.#version + 1, this.#dependencies.clock.now());
    if (this.#publicationQueued) return;
    this.#publicationQueued = true;
    queueMicrotask(() => {
      this.#publicationQueued = false;
      void this.#dependencies
        .publish({ version: 1, type: 'panel.stateChanged', stateVersion: this.#version })
        .catch(() => undefined);
    });
  }
}
