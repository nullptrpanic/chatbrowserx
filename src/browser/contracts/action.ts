import type { ElementTarget } from './target';
import type { ExpectedCondition } from '../verify/expected-condition';

interface ActionBase<TType extends string> {
  readonly actionId: string;
  readonly tabId: number;
  readonly type: TType;
  readonly risk: 'low' | 'high';
  readonly expected: ExpectedCondition;
}

export type BrowserActionRequest =
  | (ActionBase<'click'> & { readonly target: ElementTarget })
  | (ActionBase<'type'> & {
      readonly target: ElementTarget;
      readonly text: string;
      readonly replace: boolean;
    })
  | (ActionBase<'clear'> & { readonly target: ElementTarget })
  | (ActionBase<'select'> & { readonly target: ElementTarget; readonly value: string })
  | (ActionBase<'check'> & { readonly target: ElementTarget; readonly checked: boolean })
  | (ActionBase<'hover'> & { readonly target: ElementTarget })
  | (ActionBase<'pressKey'> & { readonly target: ElementTarget | null; readonly key: string })
  | (ActionBase<'scroll'> & {
      readonly target: ElementTarget | null;
      readonly deltaX: number;
      readonly deltaY: number;
    })
  | (ActionBase<'drag'> & {
      readonly target: ElementTarget;
      readonly destination: ElementTarget;
    })
  | (ActionBase<'waitFor'> & { readonly timeoutMs: number });
