import type { ElementTarget } from '../contracts/target';

export type ExpectedCondition =
  | { readonly type: 'url.changed'; readonly from: string }
  | { readonly type: 'url.matches'; readonly pattern: string }
  | { readonly type: 'element.value'; readonly target: ElementTarget; readonly equals: string }
  | { readonly type: 'element.visible'; readonly target: ElementTarget; readonly visible: boolean }
  | { readonly type: 'element.checked'; readonly target: ElementTarget; readonly checked: boolean }
  | { readonly type: 'text.contains'; readonly text: string }
  | {
      readonly type: 'element.count';
      readonly target: ElementTarget;
      readonly operator: 'eq' | 'gt' | 'lt';
      readonly value: number;
    }
  | { readonly type: 'tab.opened'; readonly openerTabId: number }
  | { readonly type: 'page.stable'; readonly quietMs: number };
