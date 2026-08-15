export interface SelectionLabels {
  readonly translate: string;
  readonly askAi: string;
  readonly dialog: string;
  readonly translating: string;
  readonly copy: string;
  readonly copied: string;
  readonly close: string;
  readonly questionPlaceholder: string;
  readonly sendToPanel: string;
  readonly sending: string;
  readonly sent: string;
  readonly failed: string;
  readonly retry: string;
}

export const ZH_CN_SELECTION_LABELS: SelectionLabels = {
  translate: '翻译',
  askAi: 'Ask AI',
  dialog: '选中文本操作',
  translating: '正在翻译…',
  copy: '复制',
  copied: '已复制',
  close: '关闭',
  questionPlaceholder: '针对选中文本提问…',
  sendToPanel: '发送到侧栏',
  sending: '正在发送…',
  sent: '已发送到侧栏',
  failed: '操作失败，请重试',
  retry: '重试',
};

const EN_SELECTION_LABELS: SelectionLabels = {
  translate: 'Translate',
  askAi: 'Ask AI',
  dialog: 'Selected text actions',
  translating: 'Translating…',
  copy: 'Copy',
  copied: 'Copied',
  close: 'Close',
  questionPlaceholder: 'Ask about the selected text…',
  sendToPanel: 'Send to Side Panel',
  sending: 'Sending…',
  sent: 'Sent to Side Panel',
  failed: 'Could not complete the action',
  retry: 'Retry',
};

const JA_SELECTION_LABELS: SelectionLabels = {
  translate: '翻訳',
  askAi: 'Ask AI',
  dialog: '選択テキストの操作',
  translating: '翻訳中…',
  copy: 'コピー',
  copied: 'コピー済み',
  close: '閉じる',
  questionPlaceholder: '選択テキストについて質問…',
  sendToPanel: 'サイドパネルへ送信',
  sending: '送信中…',
  sent: 'サイドパネルへ送信しました',
  failed: '操作を完了できませんでした',
  retry: '再試行',
};

/** Resolves page-overlay labels from the browser locale without reading trusted settings. */
export function resolveSelectionLabels(language: string): SelectionLabels {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('zh')) return ZH_CN_SELECTION_LABELS;
  if (normalized.startsWith('ja')) return JA_SELECTION_LABELS;
  return EN_SELECTION_LABELS;
}
