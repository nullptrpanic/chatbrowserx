import type { BrowserActionRequest } from '../browser/contracts/action';
import type { ElementTarget } from '../browser/contracts/target';

const irreversibleActionPattern =
  /\b(?:submit|send|publish|delete|remove|purchase|pay|payment|transfer|checkout)\b|\b(?:confirm|place)\s+order\b|\bbuy\s+now\b/i;
const accountChangePattern =
  /\b(?:change|reset|update|disable|close|delete)\b.{0,32}\b(?:password|passcode|email|account|security|2fa|two[- ]factor)\b/i;
const irreversibleCjkPattern =
  /(?:提交|发送|发布|删除|移除|购买|支付|付款|转账|下单|确认订单|立即购买|送信|公開|投稿|削除|購入|支払|振込|注文(?:を)?確定|注文する)/;
const accountChangeCjkPattern =
  /(?:(?:修改|更改|重置|更新|停用|关闭|删除|変更|リセット|更新|無効|閉鎖|削除).{0,32}(?:密码|口令|邮箱|账户|账号|安全|两步验证|双重验证|パスワード|メール|アカウント|セキュリティ|二要素認証)|(?:密码|口令|邮箱|账户|账号|安全|两步验证|双重验证|パスワード|メール|アカウント|セキュリティ|二要素認証).{0,32}(?:修改|更改|重置|更新|停用|关闭|删除|変更|リセット|無効|閉鎖|削除))/;

/** Collects bounded semantic metadata from a target without including typed user content. */
function targetSemantics(target: ElementTarget | null): string {
  if (target === null) return '';
  const stableAttributes = Object.entries(target.stableAttributes).flatMap(([key, value]) => [
    key,
    value,
  ]);
  return [
    target.role,
    target.name,
    target.label,
    target.text,
    target.ancestorHint,
    ...stableAttributes,
  ]
    .filter((value): value is string => value !== null)
    .join(' ')
    .slice(0, 4_000);
}

/** Returns policy risk while allowing planner hints only to raise, never lower, the result. */
export function classifyActionRisk(action: BrowserActionRequest): 'low' | 'high' {
  if (action.risk === 'high') return 'high';

  const primary = 'target' in action ? action.target : null;
  const destination = action.type === 'drag' ? action.destination : null;
  const semantics = `${targetSemantics(primary)} ${targetSemantics(destination)}`;
  return irreversibleActionPattern.test(semantics) ||
    accountChangePattern.test(semantics) ||
    irreversibleCjkPattern.test(semantics) ||
    accountChangeCjkPattern.test(semantics)
    ? 'high'
    : 'low';
}
