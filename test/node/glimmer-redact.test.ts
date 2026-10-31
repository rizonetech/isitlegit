import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeTextEntities,
  ENTITY_MODEL,
  ENTITY_PASS_ON,
  type EntityPass,
  entityText,
  hasImages,
  namePieces,
  openEntityPass,
  PLACEHOLDER,
  redact,
  redactWithEntities,
  skeleton,
  stripImages,
  unreadScript,
} from "../../scripts/glimmer/redact.ts";
import { decodeHtml } from "../../scripts/glimmer/source-pages.ts";

// scripts/glimmer/redact.ts (D03 T04 §7): every kind of personal detail in a synthetic fixture is replaced, in text
// and in HTML, however it is written, while brand names and link host names stay; and no image reaches a render.
const names = ["Acme Holdings", ...namePieces("Thandi van der Merwe", "thandi.vdmerwe@acme.co.za")];

describe("redact", () => {
  it("replaces addresses, recipient names, client names, phones, ID, account and card numbers", () => {
    const html = `<p>Dear Thandi Merwe,</p>
<p>Your FNB account 62812345678 at Acme Holdings is on hold. Call 082 555 1234, (011) 555 1234 or +27 11 555 0000.</p>
<p>ID 8001015009087, card 4111 1111 1111 1111, reply to thandi.vdmerwe@acme.co.za or visit acme.co.za</p>
<a href="https://fnb-secure-login.example.com/verify?u=thandi.vdmerwe@acme.co.za">Verify with FNB</a>
<p>Collect it at the Parkhurst branch.</p>`;
    const out = redact(html, names, ["acme.co.za"], ["Parkhurst"]);
    for (const kept of ["FNB", "fnb-secure-login.example.com", "Verify with FNB", "Dear"]) expect(out).toContain(kept);
    for (const gone of [
      "Thandi",
      "Merwe",
      "Acme Holdings",
      "62812345678",
      "082 555 1234",
      "(011) 555 1234",
      "+27 11 555 0000",
      "8001015009087",
      "4111 1111 1111 1111",
      "acme.co.za",
      "Parkhurst",
    ])
      expect(out, gone).not.toContain(gone);
    for (const placeholder of Object.values(PLACEHOLDER)) expect(out, placeholder).toContain(placeholder);
  });

  it("reads character references and hidden characters as what the render shows", () => {
    expect(decodeTextEntities("Th&#97;ndi &#x4D;erwe Caf&eacute; &lt;b&gt;")).toBe("Thandi Merwe Café &lt;b&gt;");
    const out = redact("<p>Dear Th&#97;ndi, Mer­we and Th​andi</p>", names);
    expect(out).not.toMatch(/thandi|merwe|th&#97;ndi/i);
  });

  it("finds a name or number written in look-alike letters or full-width digits, and keeps the letters elsewhere", () => {
    // A Cyrillic а in the name, full-width digits in the phone; a brand spelled with a Cyrillic і stays as written.
    const out = redact(
      "<p>Dear Th\u0430ndi, call \uff10\uff18\uff12 \uff15\uff15\uff15 \uff11\uff12\uff13\uff14. M\u0456crosoft</p>",
      names,
    );
    expect(out).toBe("<p>Dear [name], call [phone]. M\u0456crosoft</p>");
    expect(skeleton("Th\u0430ndi \uff10\uff18")).toBe("Thandi 08");
  });

  it("redacts a phone written with dots", () => {
    expect(redact("<p>Call 082.555.1234 or (011).555.1234</p>", [])).toBe("<p>Call [phone] or [phone]</p>");
    expect(redact("<p>Call 082/555/1234 about your invoice</p>", [])).toBe("<p>Call [phone] about your invoice</p>");
  });

  it("redacts numbers grouped with non-breaking spaces, written or as references", () => {
    const out = redact("<p>card 4111\u00A01111\u00A01111\u00A01111, ID 800101&nbsp;5009&nbsp;087</p>", []);
    expect(out).toBe("<p>card [number], ID [number]</p>");
  });

  it("takes a hyphenated name whole and by its parts, and no common word", () => {
    expect(namePieces("Anne-Marie Dlamini", "billing@x.co.za")).toEqual([
      "Anne-Marie Dlamini",
      "Anne-Marie",
      "Anne",
      "Marie",
      "Dlamini",
    ]);
    // A name made of common words is still a name, as a phrase.
    expect(namePieces("May Long", "ml@x.co.za")).toEqual(["May Long"]);
    expect(redact("<p>Dear May Long, your invoice</p>", namePieces("May Long", "ml@x.co.za"))).toBe(
      "<p>Dear [name], your invoice</p>",
    );
    expect(namePieces("The New Team", "info@x.co.za")).toEqual([]);
    // A display name written as an address or a domain gives no web words for names.
    expect(namePieces("accounts@acme.com", "accounts@acme.com")).toEqual([]);
    expect(namePieces("acme.co.za", "thandi@acme.co.za")).toEqual(["thandi"]);
  });

  it("takes a capitalised two-letter name, and no mailbox role, from the recipients", () => {
    expect(namePieces("Jo M. Dlamini", "jo.dlamini@x.co.za")).toEqual(["Jo", "Dlamini", "dlamini"]);
    expect(namePieces("Accounts Payable", "accounts_payable@x.co.za")).toEqual([]);
    expect(redact("<p>Dear Jo, your JOB is ready</p>", namePieces("Jo Dlamini", undefined))).toBe(
      "<p>Dear [name], your JOB is ready</p>",
    );
  });

  it("keeps a lure's link hosts and brand words, replacing names only outside URLs", () => {
    const pieces = [...namePieces("Accounts", "accounts@acme.co.za"), ...namePieces("Thandi", "thandi@acme.co.za")];
    const out = redact(
      `<a href="https://accounts.google.com/thandi">Google Accounts</a> for Thandi at https://thandi.example.com/`,
      pieces,
    );
    expect(out).toContain('href="https://accounts.google.com/thandi"');
    expect(out).toContain(">Google Accounts<");
    expect(out).toContain("https://thandi.example.com/");
    expect(out).toContain("for [name] at");
  });

  it("leaves an inline image's base64 alone and keeps amounts and dates", () => {
    const image = "data:image/png;base64,iVBORw0KGgo12345678901234AAAA";
    const out = redact(`<img src="${image}"><p>Pay R4,999.00 by 2026-10-31</p>`, names);
    expect(out).toContain(image);
    expect(out).toContain("R4,999.00 by 2026-10-31");
  });
});

describe("stripImages", () => {
  it("replaces every picture with a blank box of its size, so none reaches a screenshot", () => {
    const html = `<img src="data:image/png;base64,AAAA" width=200 height=50><img src="cid:logo1">
<div style="background:url(data:image/png;base64,BBBB) no-repeat">x</div><table background="sig.png"><tr><td>y</td></tr></table>
<svg><image href="data:image/png;base64,CCCC"/></svg><object data="x.pdf"></object><picture><source srcset="a.png"></picture>`;
    expect(hasImages(html)).toBe(true);
    const out = stripImages(html);
    expect(hasImages(out)).toBe(false);
    expect(out).toContain("width:200px;height:50px");
    expect(out).toContain("width:120px;height:40px");
    expect(out).not.toMatch(/AAAA|BBBB|CCCC|sig\.png|x\.pdf|a\.png/);
    // Vector artwork and CSS-generated text go too: neither is in the page text a post-render check reads.
    const drawn = stripImages(
      `<svg><path d="M0 0L9 9"/><text>Thandi</text></svg><style>.a::after{content:"Thandi 082 555 1234"}</style>`,
    );
    expect(drawn).not.toMatch(/path|Thandi|082/);
    expect(hasImages(drawn)).toBe(false);
    expect(hasImages('<style>.a::after{content:"x"}</style>')).toBe(true);
    // A quoted data URL in image-set(), an unquoted background attribute and a frame's own document go too.
    const more = stripImages(
      `<div style='background-image:image-set("data:image/png;base64,DDDD" 1x)'>x</div><table background=data:image/png;base64,EEEE><tr><td>y</td></tr></table><iframe srcdoc="&lt;img src=x&gt;"></iframe>`,
    );
    expect(more).not.toMatch(/DDDD|EEEE|iframe|data:image/);
    expect(hasImages(more)).toBe(false);
    expect(hasImages(`<p style='background:image-set("a.png" 1x)'>`)).toBe(true);
    // CSS escapes that spell url( and data: out of the picture rules' sight, and an imported stylesheet.
    const escaped = `<div style='width:300px;height:300px;background-image:\\75rl("data\\3a image/png;base64,FFFF")'></div><style>@import "data:text/css;base64,GGGG";.a{background:\\75rl(x.png)}</style>`;
    expect(hasImages(escaped)).toBe(true);
    const unescaped = stripImages(escaped);
    expect(unescaped).not.toMatch(/FFFF|GGGG|x\.png|@import/);
    expect(hasImages(unescaped)).toBe(false);
  });
});

describe("decodeHtml", () => {
  it("reads undeclared Windows-1252 bytes as Windows-1252, not as replacement characters", () => {
    expect(decodeHtml(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe("Café");
    expect(decodeHtml(new TextEncoder().encode("Café"))).toBe("Café");
  });
});

// The entity pass's contract (D03 T04 §19): `entities.py` is stood in for by a fake script in a temp dir, so each way
// the child process can fail is made to happen; every one refuses the page with a diagnostic naming the failure and
// holding none of the page's text.
describe("the entity pass", () => {
  const dir = mkdtempSync(join(tmpdir(), "glimmer-entities-"));
  const PINNED = ENTITY_MODEL.sha256;
  // A fake `entities.py`: `start` is what it prints first (null for the real ready line), `reply` the Python that
  // answers one request (`request` and `text` in scope; `answer(value)` prints a line).
  let n = 0;
  const fake = (reply: string, start: string | null = null) => {
    const script = join(dir, `fake-${n++}.py`);
    writeFileSync(
      script,
      `import json, sys, time
digest = sys.argv[sys.argv.index("--model-sha256") + 1]
def answer(value):
    print(json.dumps(value), flush=True)
${start ?? 'answer({"ready": True, "model": "en_core_web_lg", "model_sha256": digest, "language": "en"})'}
for line in sys.stdin:
    request = json.loads(line)
    text = request["text"]
${reply
  .split("\n")
  .map((l) => `    ${l}`)
  .join("\n")}
`,
    );
    return openEntityPass({ python: "python3", script, seconds: 2 });
  };
  // Answers each name or place it is told to find, by its code-point offsets, as spaCy does.
  const finder = fake(`spans = []
for word, label in (("Hendrik Grobbelaar", "person"), ("Parkhurst", "place")):
    at = text.find(word)
    if at >= 0:
        spans.append({"start": at, "end": at + len(word), "label": label})
answer({"spans": spans})`);
  const clean = fake('answer({"spans": []})');
  const page = "<p>Regards, Hendrik <b>Grobbelaar</b></p><p>Deliver to 14 Jacaranda Street, Parkhurst</p>";
  afterAll(() => {
    finder.close();
    clean.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const refusal = async (pass: EntityPass, html = page) => {
    const error = (await redactWithEntities(html, [], [], pass, true).then(
      () => null,
      (e: Error) => e,
    )) as Error | null;
    pass.close();
    expect(error, "the page was not refused").not.toBeNull();
    const message = error?.message ?? "";
    expect(message).toMatch(/^refused: the entity /);
    for (const content of ["Hendrik", "Grobbelaar", "Jacaranda", "Parkhurst", "يوسف"])
      expect(message).not.toContain(content);
    return message.replace(/^refused: the entity /, "");
  };

  it("replaces each person and place span it finds in the HTML, a name split by a tag included", async () => {
    const out = await redactWithEntities(
      `${page}<a href="https://parkhurst.example.com/">Track</a><input value="Hendrik Grobbelaar">`,
      [],
      [],
      finder,
      true,
    );
    expect(out).not.toMatch(/Hendrik|Grobbelaar|>[^<]*Parkhurst/);
    expect(out).toContain(`Regards, ${PLACEHOLDER.name} <b>${PLACEHOLDER.name}</b>`);
    expect(out).toContain(`14 Jacaranda Street, ${PLACEHOLDER.address}`);
    expect(out).toContain('value="[name]"');
    expect(out).toContain("https://parkhurst.example.com/");
    // Offsets are code points, as Python counts them: a character outside the BMP before the name moves nothing.
    expect(await redactWithEntities("<p>\u{1F600} Hendrik Grobbelaar</p>", [], [], finder, true)).toBe(
      "<p>\u{1F600} [name]</p>",
    );
  });

  it("refuses an Arabic-script or Cyrillic name, even when the pass answers clean", async () => {
    expect(unreadScript("Regards, يوسف المنصوري")).toBe("arabic");
    expect(unreadScript("Regards, Олена")).toBe("cyrillic");
    expect(unreadScript("Th\u0430ndi M\u043ek\u043e\u0435n\u0430")).toBeNull();
    expect(await refusal(fake('answer({"spans": []})'), "<p>Regards, يوسف المنصوري</p>")).toBe(
      "model does not read arabic script, and the page holds a name in it",
    );
    // And as `entities.py` refuses it, should a run slip past the check here.
    expect(await refusal(fake('answer({"refused": "a name in cyrillic script would go unread"})'))).toBe(
      "pass refused the page (a name in cyrillic script would go unread)",
    );
  });

  it("refuses when the model is missing or not the pinned one", async () => {
    expect(await refusal(fake("pass", 'answer({"refused": "the model is not installed"}); sys.exit(1)'))).toBe(
      "model is not installed",
    );
    expect(await refusal(fake("pass", 'answer({"refused": "the model is not the pinned one"}); sys.exit(1)'))).toBe(
      "model is not the pinned one",
    );
    expect(
      await refusal(
        fake(
          "pass",
          `answer({"ready": True, "model": "en_core_web_lg", "model_sha256": "${"0".repeat(64)}", "language": "en"})`,
        ),
      ),
    ).toBe("model is not the pinned one");
    expect(
      await refusal(
        fake("pass", 'answer({"ready": True, "model": "xx_ent_wiki_sm", "model_sha256": digest, "language": "en"})'),
      ),
    ).toBe("pass gave a malformed answer");
    expect(
      await refusal(openEntityPass({ python: join(dir, "no-such-python"), script: join(dir, "x.py"), sha256: PINNED })),
    ).toBe("pass could not start (ENOENT)");
  });

  it("refuses on a crash, a timeout and an answer over 1 MB", async () => {
    expect(await refusal(fake("sys.exit(3)"))).toBe("pass crashed (exit code 3)");
    expect(await refusal(fake("time.sleep(30)"))).toBe("pass took over 2 seconds");
    expect(await refusal(fake('sys.stdout.write("x" * (1024 * 1024 + 1)); sys.stdout.flush(); time.sleep(30)'))).toBe(
      "pass answered over 1048576 bytes",
    );
  });

  it("refuses a malformed answer: not JSON, off the schema, a span outside the text, or a reason it does not know", async () => {
    for (const reply of [
      'print("spans: none", flush=True)',
      'answer({"spans": [{"start": 0, "end": 5, "label": "org"}]})',
      'answer({"spans": [{"start": 0, "end": len(text) + 1, "label": "person"}]})',
      'answer({"spans": [{"start": 4, "end": 4, "label": "person"}]})',
      'answer({"spans": [{"start": 0.5, "end": 4, "label": "person"}]})',
      'answer({"spans": [], "note": "extra"})',
      'answer({"refused": "Hendrik Grobbelaar is named here"})',
    ])
      expect(await refusal(fake(reply)), reply).toBe("pass gave a malformed answer");
  });

  it("ends a pass that answers what was not asked, and starts a new one for the next page", async () => {
    const starts = join(dir, "starts");
    const pass = fake(
      'answer({"spans": []}); answer({"spans": []})',
      `open(${JSON.stringify(starts)}, "a").write("start\\n")
answer({"ready": True, "model": "en_core_web_lg", "model_sha256": digest, "language": "en"})`,
    );
    await expect(pass.find("one")).resolves.toEqual([]);
    await new Promise((done) => setTimeout(done, 300));
    await expect(pass.find("two")).resolves.toEqual([]);
    pass.close();
    expect(readFileSync(starts, "utf8")).toBe("start\nstart\n");
  });

  it("refuses a text over 200,000 characters without asking the pass", async () => {
    expect(await refusal(clean, `<p>${"word ".repeat(40_001)}</p>`)).toBe(
      "pass takes at most 200000 characters, and the page's text is longer",
    );
  });

  it("starts again after a failure ends it", async () => {
    const pass = fake('answer({"spans": []}) if text == "ok" else sys.exit(4)');
    await expect(pass.find("bad")).rejects.toThrow("pass crashed (exit code 4)");
    await expect(pass.find("ok")).resolves.toEqual([]);
    pass.close();
  });

  it("is skipped with the switch off, and the switch follows the benchmark's decision", async () => {
    const never: EntityPass = {
      find: () => Promise.reject(new Error("the pass was asked")),
      close: () => {},
    };
    expect(await redactWithEntities(page, ["Hendrik"], [], never, false)).toBe(redact(page, ["Hendrik"]));
    expect(await redactWithEntities(page, ["Hendrik"], [], null, false)).toBe(redact(page, ["Hendrik"]));
    await expect(redactWithEntities(page, [], [], null, true)).rejects.toThrow("refused: the entity pass is on");
    const measured = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../docs/glimmer/redaction-benchmark.json"), "utf8"),
    );
    expect(ENTITY_PASS_ON).toBe(measured.entityDecision.keepOn);
    if (!ENTITY_PASS_ON) await expect(redactWithEntities(page, [], [], never)).resolves.toBe(redact(page, []));
  });

  it("reads a page's text as it shows, form values included", () => {
    expect(
      entityText(
        '<p>Dear Hendrik Gro<b>bbelaar</b>,</p><style>.a{}</style><div>Thanks &amp; regards</div><input value="Nomvula Zungu">',
      ),
    ).toBe("\nDear Hendrik Grobbelaar,\n\n\nThanks & regards\n\nNomvula Zungu");
  });
});
