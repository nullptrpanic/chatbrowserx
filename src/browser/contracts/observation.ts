export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ViewportState {
  readonly width: number;
  readonly height: number;
  readonly scrollX: number;
  readonly scrollY: number;
}

export interface FrameSegment {
  readonly index: number;
  readonly name: string | null;
  readonly title: string | null;
  readonly origin: string | null;
}

export interface ShadowSegment {
  readonly hostRole: string | null;
  readonly hostName: string | null;
  readonly stableAttributes: Readonly<Record<string, string>>;
}

export interface ObservedElementState {
  readonly disabled: boolean;
  readonly checked: boolean | null;
  readonly selected: boolean | null;
  readonly expanded: boolean | null;
}

export interface ObservedElement {
  readonly observationRef: string;
  readonly framePath: readonly FrameSegment[];
  readonly shadowPath: readonly ShadowSegment[];
  readonly role: string;
  readonly name: string;
  readonly label: string | null;
  readonly text: string | null;
  readonly value: string | null;
  readonly stableAttributes: Readonly<Record<string, string>>;
  readonly ancestorHint: string | null;
  readonly state: ObservedElementState;
  readonly rect: Rect;
  readonly visible: boolean;
  readonly obscured: boolean;
  readonly backendNodeId: number | null;
  readonly cdpSessionId: string | null;
}

export interface TextRegion {
  readonly kind: string;
  readonly text: string;
  readonly framePath: readonly FrameSegment[];
  readonly rect: Rect;
}

export interface ObservedFrame {
  readonly path: readonly FrameSegment[];
  readonly name: string | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly accessible: boolean;
  readonly rect: Rect;
}

export interface PageObservation {
  readonly id: string;
  readonly capturedAt: number;
  readonly tabId: number;
  readonly url: string;
  readonly title: string;
  readonly viewport: ViewportState;
  readonly textRegions: readonly TextRegion[];
  readonly elements: readonly ObservedElement[];
  readonly frames: readonly ObservedFrame[];
  readonly truncated: boolean;
}
