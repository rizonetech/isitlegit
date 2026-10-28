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

// The message ids in a Message-ID, In-Reply-To or References value (RFC 5322 section 3.6.4): each <...>, read past
// comments and quoted phrases outside the angle brackets (a phrase or comment saying "<fake@x>" is not an id), and with
// quoted parts inside them kept as they are (the obsolete <"a(b"@x>).
export function messageIds(value: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === "(") {
      let depth = 0;
      for (; i < value.length; i++) {
        if (value[i] === "\\") i++;
        else if (value[i] === "(") depth++;
        else if (value[i] === ")" && --depth === 0) break;
      }
      i++;
    } else if (c === '"') {
      for (i++; i < value.length && value[i] !== '"'; i++) if (value[i] === "\\") i++;
      i++;
    } else if (c === "<") {
      let id = "<";
      let quoted = false;
      for (i++; i < value.length; i++) {
        const d = value[i] as string;
        if (d === "\\" && quoted) {
          id += d + (value[i + 1] ?? "");
          i++;
          continue;
        }
        if (d === '"') quoted = !quoted;
        if (!quoted && (d === ">" || d === "<")) break;
        id += d;
      }
      if (value[i] === ">" && id.length > 2 && !/^<\s|\s$/.test(id)) found.push(`${id}>`);
      i++;
    } else i++;
  }
  return found;
}
