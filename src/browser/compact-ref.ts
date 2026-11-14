const MAX_PASSTHROUGH_REF_CHARACTERS = 16;
const FNV_64_OFFSET = 0xcbf29ce484222325n;
const FNV_64_PRIME = 0x100000001b3n;

/** Shortens opaque identifiers; the owning store must check uniqueness and resolve exact matches. */
export function compactRef(value: string, prefix: string): string {
  if (value.length <= MAX_PASSTHROUGH_REF_CHARACTERS && /^[a-z0-9_-]+$/i.test(value)) {
    return value;
  }
  let hash = FNV_64_OFFSET;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * FNV_64_PRIME);
  }
  return `${prefix}${hash.toString(36)}`;
}
