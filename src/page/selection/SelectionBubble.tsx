import { useLayoutEffect, useRef, useState } from 'react';
import { computeBubblePosition } from './read-selection';
import { SelectionResult } from './SelectionResult';
import type { PageTextSelection, SelectionBubblePosition } from './selection-types';
import { ZH_CN_SELECTION_LABELS, type SelectionLabels } from './selection-i18n';

export interface SelectionBubbleProps {
  readonly selection: PageTextSelection;
  readonly onTranslate: () => Promise<string>;
  readonly onAsk: (question: string) => Promise<void>;
  readonly onClose: () => void;
  readonly view?: Window;
  readonly labels?: SelectionLabels;
}

type BubbleState =
  | { readonly mode: 'actions' }
  | { readonly mode: 'translating' }
  | { readonly mode: 'result'; readonly text: string }
  | { readonly mode: 'asking' }
  | { readonly mode: 'sending'; readonly question: string }
  | { readonly mode: 'sent' }
  | { readonly mode: 'error'; readonly operation: 'translate' | 'ask' };

const INITIAL_POSITION: SelectionBubblePosition = { left: 8, top: 8, placement: 'below' };

/** Renders the isolated translate/Ask AI interaction anchored to selected page text. */
export function SelectionBubble({
  selection,
  onTranslate,
  onAsk,
  onClose,
  view = window,
  labels = ZH_CN_SELECTION_LABELS,
}: SelectionBubbleProps) {
  const bubble = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BubbleState>({ mode: 'actions' });
  const [question, setQuestion] = useState('');
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState(INITIAL_POSITION);

  useLayoutEffect(() => {
    const element = bubble.current;
    if (element === null) return;
    const bounds = element.getBoundingClientRect();
    setPosition(
      computeBubblePosition(
        selection.rect,
        { width: view.innerWidth, height: view.innerHeight },
        {
          width: Math.max(1, bounds.width || 280),
          height: Math.max(1, bounds.height || (state.mode === 'result' ? 180 : 44)),
        },
      ),
    );
  }, [selection.rect, state.mode, view]);

  /** Starts a translation and exposes only a normalized result or retryable error. */
  async function translate(): Promise<void> {
    setState({ mode: 'translating' });
    try {
      const text = await onTranslate();
      setState({ mode: 'result', text });
    } catch {
      setState({ mode: 'error', operation: 'translate' });
    }
  }

  /** Sends one optional question together with the immutable captured selection. */
  async function ask(): Promise<void> {
    const submittedQuestion = question.trim();
    setState({ mode: 'sending', question: submittedQuestion });
    try {
      await onAsk(submittedQuestion);
      setState({ mode: 'sent' });
    } catch {
      setState({ mode: 'error', operation: 'ask' });
    }
  }

  return (
    <>
      <style>{`
        :host { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        *, *::before, *::after { box-sizing: border-box; }
        .cbx-selection-bubble { position: fixed; z-index: 2147483647; width: max-content; max-width: min(320px, calc(100vw - 16px)); color: #eef2ff; border: 1px solid rgba(255,255,255,.12); border-radius: 12px; background: #161b26; box-shadow: 0 12px 34px rgba(0,0,0,.28); pointer-events: auto; overflow: hidden; }
        .cbx-selection-actions { display: flex; align-items: center; gap: 4px; padding: 5px; }
        button { min-height: 32px; padding: 5px 10px; color: inherit; border: 0; border-radius: 8px; background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
        button:hover, button:focus-visible { background: rgba(255,255,255,.1); outline: none; }
        button:disabled { opacity: .55; cursor: default; }
        .cbx-selection-result { width: min(320px, calc(100vw - 16px)); }
        .cbx-selection-result p { max-height: 220px; margin: 0; padding: 12px 14px 8px; overflow: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.55; }
        .cbx-selection-form { display: grid; width: min(300px, calc(100vw - 16px)); gap: 6px; padding: 8px; }
        textarea { width: 100%; min-height: 68px; resize: vertical; padding: 9px 10px; color: inherit; border: 1px solid rgba(255,255,255,.14); border-radius: 8px; outline: 0; background: rgba(255,255,255,.06); font: inherit; font-size: 13px; }
        textarea:focus { border-color: #78a6ff; box-shadow: 0 0 0 2px rgba(120,166,255,.18); }
        .cbx-selection-status { margin: 0; padding: 10px 12px; font-size: 13px; }
      `}</style>
      <div
        ref={bubble}
        className="cbx-selection-bubble"
        role="dialog"
        aria-label={labels.dialog}
        data-placement={position.placement}
        style={{ left: position.left, top: position.top }}
      >
        {state.mode === 'actions' ? (
          <div className="cbx-selection-actions">
            <button type="button" onClick={() => void translate()}>
              {labels.translate}
            </button>
            <button type="button" onClick={() => setState({ mode: 'asking' })}>
              {labels.askAi}
            </button>
          </div>
        ) : null}
        {state.mode === 'translating' ? (
          <p className="cbx-selection-status">{labels.translating}</p>
        ) : null}
        {state.mode === 'result' ? (
          <SelectionResult
            text={state.text}
            copied={copied}
            onCopy={() => {
              void navigator.clipboard.writeText(state.text).then(() => setCopied(true));
            }}
            onAsk={() => setState({ mode: 'asking' })}
            onClose={onClose}
            labels={labels}
          />
        ) : null}
        {state.mode === 'asking' || state.mode === 'sending' ? (
          <form
            className="cbx-selection-form"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <textarea
              autoFocus
              maxLength={4_000}
              placeholder={labels.questionPlaceholder}
              value={state.mode === 'sending' ? state.question : question}
              disabled={state.mode === 'sending'}
              onChange={(event) => setQuestion(event.currentTarget.value)}
            />
            <div className="cbx-selection-actions">
              <button type="submit" disabled={state.mode === 'sending'}>
                {state.mode === 'sending' ? labels.sending : labels.sendToPanel}
              </button>
              <button type="button" onClick={onClose}>
                {labels.close}
              </button>
            </div>
          </form>
        ) : null}
        {state.mode === 'sent' ? <p className="cbx-selection-status">{labels.sent}</p> : null}
        {state.mode === 'error' ? (
          <div className="cbx-selection-actions" role="alert">
            <span>{labels.failed}</span>
            <button
              type="button"
              onClick={() => {
                if (state.operation === 'translate') void translate();
                else setState({ mode: 'asking' });
              }}
            >
              {labels.retry}
            </button>
            <button type="button" onClick={onClose}>
              {labels.close}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
