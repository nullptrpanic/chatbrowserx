export interface SelectionRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface PageTextSelection {
  readonly text: string;
  readonly rect: SelectionRect;
  readonly pageUrl: string;
  readonly pageTitle: string;
}

export interface SelectionBubblePosition {
  readonly left: number;
  readonly top: number;
  readonly placement: 'above' | 'below';
}
