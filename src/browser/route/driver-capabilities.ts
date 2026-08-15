export type DriverKind = 'dom' | 'cdp';

export type DriverCapability =
  | 'semantic_dom'
  | 'cross_origin_frame'
  | 'real_pointer'
  | 'real_keyboard'
  | 'navigation_lifecycle'
  | 'synthetic_drag'
  | 'cdp_drag';

export const DRIVER_CAPABILITIES: Readonly<Record<DriverKind, ReadonlySet<DriverCapability>>> = {
  dom: new Set(['semantic_dom', 'synthetic_drag']),
  cdp: new Set([
    'semantic_dom',
    'cross_origin_frame',
    'real_pointer',
    'real_keyboard',
    'navigation_lifecycle',
    'cdp_drag',
  ]),
};

/** Returns whether one driver satisfies every hard capability required by the scenario. */
export function supportsCapabilities(
  driver: DriverKind,
  required: readonly DriverCapability[],
): boolean {
  const capabilities = DRIVER_CAPABILITIES[driver];
  return required.every((capability) => capabilities.has(capability));
}
