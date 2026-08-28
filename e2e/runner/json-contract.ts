import { readFile } from 'node:fs/promises';
import type { ZodIssue, ZodType } from 'zod';

export type JsonRecord = Readonly<Record<string, unknown>>;

export function jsonRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function issuePath(issue: ZodIssue, extra?: PropertyKey): string {
  const path = extra === undefined ? issue.path : [...issue.path, extra];
  return path.reduce<string>(
    (current, part) =>
      typeof part === 'number'
        ? `${current}[${String(part)}]`
        : current.length === 0
          ? String(part)
          : `${current}.${String(part)}`,
    '',
  );
}

/** Parses one strict current JSON contract and emits a bounded field-oriented error. */
export function parseJsonContract<Output>(
  schema: ZodType<Output>,
  value: unknown,
  owner: string,
): Output {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  if (issue === undefined) throw new Error(`${owner} is invalid.`);
  if (issue.code === 'unrecognized_keys') {
    const key = issue.keys[0];
    throw new Error(`${owner} ${issuePath(issue, key)} is not supported.`);
  }
  const path = issuePath(issue);
  throw new Error(`${owner}${path.length === 0 ? '' : ` ${path}`} ${issue.message}`);
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read JSON ${path}: ${message}`, { cause: error });
  }
}
