// Runtime bridge: execute Worker readers in Node without type-checking the Worker environment as DOM.
import { decodeWords } from "postal-mime";
import { PhraseLog, PhraseStream } from "../../src/checks/instruction-phrases.ts";
import { ooxmlText } from "../../src/checks/ooxml-text.ts";
import { pdfText } from "../../src/checks/pdf-text.ts";
export async function detect(row) {
  let text = row.payload;
  let location = "text";
  if (row.technique.startsWith("subject-")) {
    text = decodeWords(text.replace(/\r?\n[ \t]*/g, " "));
    location = "subject";
  }
  if (row.technique === "pdf" || row.technique === "docx") {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
      throw new Error("Invalid document base64");
    const bytes = Buffer.from(text, "base64");
    const read = row.technique === "pdf" ? await pdfText(bytes) : await ooxmlText(bytes);
    if (read.unread.length || ("encrypted" in read && read.encrypted) || !read.text.trim())
      throw new Error("Document extraction incomplete");
    text = read.text;
    location = `attachment:fixture.${row.technique}`;
  }
  const log = new PhraseLog();
  const stream = new PhraseStream(log, location, row.id, false);
  for (let i = 0; i < text.length; i += row.chunkSize) stream.feed(text.slice(i, i + row.chunkSize));
  stream.end();
  return {
    matches: log.matches.map(({ pattern, location }) => ({ pattern, location, severity: "high" })),
    runs: log.invisible.map(({ kind, severity, location }) => ({ kind, severity, location })),
  };
}
