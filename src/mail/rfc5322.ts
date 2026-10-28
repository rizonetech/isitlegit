// RFC 5322's comments, the parenthesised notes a header may carry beside its values (section 3.2.2): removed, nested and
// with their \-escapes, before a value is read, so nothing inside one is taken for the value (D01 T02 §3).
export function withoutComments(value: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && depth > 0) {
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (depth === 0) out += c;
  }
  return out;
}
