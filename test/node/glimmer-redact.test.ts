import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodeTextEntities,
  discoveredDetail,
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

// §19 completion review gap 3: the details spaCy reads past, found by rule with no model, every one invented.
describe("the rules beside the entity pass", () => {
  it("replaces a street address whole, in the forms a South African address takes", () => {
    for (const address of [
      "41 Wagtail Crescent, Bryanston, Sandton, 2191",
      "7 Kloof Nek Road, Tamboerskloof, Cape Town, 8001",
      "Unit 7, 23 Kingfisher Drive, Halfway House",
      "5A Baobab Way",
      "90-92 Umdoni Lane, Westville 3629",
      "16 Vergenoegstraat, Bellville",
      "12 Nooitgedacht Rylaan",
      "18 Stinkwood Ave.",
      "3 MARULA CLOSE, FAIRVIEW",
    ]) {
      const out = redact(`<p>Deliver to ${address}</p><p>Thank you.</p>`, []);
      expect(out, address).toBe(`<p>Deliver to ${PLACEHOLDER.address}</p><p>Thank you.</p>`);
    }
  });

  it("replaces a post box, a private bag or a PostNet suite with what follows it", () => {
    for (const box of [
      "PO Box 4471, Rivonia, 2128",
      "P.O. Box 52, Hatfield 0028",
      "Posbus 318, Stellenbosch, 7599",
      "Private Bag X9, Gqeberha, 6000",
      "PostNet Suite 112, Menlyn",
    ])
      expect(redact(`Write to ${box} today.`, []), box).toBe(`Write to ${PLACEHOLDER.address} today.`);
  });

  it("replaces a town and a postal code beside a town or a replaced place, and no other four digits", () => {
    expect(redact("Collect it from our Polokwane branch", [])).toBe(
      `Collect it from our ${PLACEHOLDER.address} branch`,
    );
    expect(redact("MBOMBELA 1200", [])).toBe(PLACEHOLDER.address);
    expect(redact("Somerset West, 7130", [])).toBe(PLACEHOLDER.address);
    // A code beside a place the pass already took.
    expect(redact("Morningside, 4001", [], [], ["Morningside"])).toBe(PLACEHOLDER.address);
    // A link host keeps its town; a year, an amount, a version and a step are not codes or streets.
    const kept =
      "Visit www.capetown.gov.za. Pay R 4 210.00 by 2026-10-31. Office 2019 and Windows 2000. Since 1998. Step 3 Click Here.";
    expect(redact(kept, [])).toBe(kept);
  });

  it("replaces a name signed under a closing, across tags, and keeps a business signing off", () => {
    for (const [html, out] of [
      ["Kind regards,</p><p>Lindiwe Maseko</p>", "Kind regards,</p><p>[name]</p>"],
      ["Regards, Anne-Marie van der Westhuizen", "Regards, [name]"],
      ["Thanks, Ruan O'Neill\nSenior Manager", "Thanks, [name]\nSenior Manager"],
      ["Groete<br>Ewan MacAllister", "Groete<br>[name]"],
      // The words after the name sign for a business, and stay; only the person goes.
      ["Yours faithfully, Pieter Swart Customer Care", "Yours faithfully, [name] Customer Care"],
      // A name the lists already took in part is taken whole.
      ["Regards, [name] Mahlangu", "Regards, [name]"],
    ])
      expect(redact(html as string, []), html).toBe(out);
    for (const kept of ["Kind regards, Standard Bank", "Regards, Customer Care Team", "Regards, FNB", "Thanks, Sipho"])
      expect(redact(kept, []), kept).toBe(kept);
  });

  it("names the kind it still finds in a rendered text, never the detail", () => {
    expect(discoveredDetail("Deliver to 41 Wagtail Crescent")).toBe("a street address");
    expect(discoveredDetail("Write to PO Box 4471")).toBe("a post box");
    expect(discoveredDetail("Our [address], 8001 branch")).toBe("a postal code");
    expect(discoveredDetail("Collect it in Mbombela")).toBe("a town");
    expect(discoveredDetail("Kind regards,\nLindiwe Maseko")).toBe("a signed name");
    expect(discoveredDetail("Deliver to [address]. Kind regards, [name]. Standard Bank, Office 2019.")).toBeNull();
  });

  // §19 round 2 finding 1: an address typed small or in mixed case is an address.
  it("replaces and finds a street address, post box, town and postal code in any case", () => {
    for (const address of [
      "7 kloof nek road",
      "41 wagtail crescent, bryanston, sandton, 2191",
      "12 Long street",
      "5a baobab way",
      "18 STINKWOOD avenue",
      "unit 4, 9 protea ave.",
      "16 vergenoegstraat, bellville, 7530",
      "22 Jakaranda laan",
      "3 kerk straat",
      "8 Hoog steeg",
    ]) {
      expect(redact(`<p>Deliver to ${address}</p><p>Thank you.</p>`, []), address).toBe(
        `<p>Deliver to ${PLACEHOLDER.address}</p><p>Thank you.</p>`,
      );
      expect(discoveredDetail(`Deliver to ${address}`), address).toBe("a street address");
    }
    expect(redact("Please deliver to 7 kloof nek road.", [])).toBe(`Please deliver to ${PLACEHOLDER.address}`);
    // A sentence that goes on after the address keeps its words: a part written small is the address's only before a
    // code or another comma.
    expect(redact("Deliver to 7 kloof nek road, and call us", [])).toBe(
      `Deliver to ${PLACEHOLDER.address}, and call us`,
    );
    for (const box of ["po box 4471, rivonia, 2128", "p.o. box 52", "posbus 318", "private bag x9, gqeberha, 6000"]) {
      expect(redact(`Write to ${box} today.`, []), box).toBe(`Write to ${PLACEHOLDER.address} today.`);
      expect(discoveredDetail(`Write to ${box}`), box).toBe("a post box");
    }
    expect(redact("collect it from our cape town branch", [])).toBe(
      `collect it from our ${PLACEHOLDER.address} branch`,
    );
    expect(redact("kempton park 1619", [])).toBe(PLACEHOLDER.address);
    expect(discoveredDetail("collect it in kempton park")).toBe("a town");
    expect(discoveredDetail("our [address], 8001 branch")).toBe("a postal code");
  });

  // §19 round 2 finding 2: after a closing, a capitalised name is a name, even when its words are ordinary words.
  it("replaces a signed name made of ordinary words, in capitals or after a title, and keeps a business signing off", () => {
    for (const [html, out] of [
      ["Kind regards,\nMay Long", "Kind regards,\n[name]"],
      ["Thanks,\nRose Hill", "Thanks,\n[name]"],
      ["Regards,\nWill Grant", "Regards,\n[name]"],
      ["Kind Regards,\nMay Long", "Kind Regards,\n[name]"],
      ["BEST REGARDS,\nLINDIWE MASEKO", "BEST REGARDS,\n[name]"],
      ["Regards, Dr Thandeka Mokoena", "Regards, [name]"],
      ["Regards, Jan De Villiers", "Regards, [name]"],
    ]) {
      expect(redact(html as string, []), html).toBe(out);
      expect(discoveredDetail(html as string), html).toBe("a signed name");
    }
    for (const kept of [
      "Kind regards,\nCustomer Care",
      "Kind regards,\nAccounts Team",
      "Regards,\nThe Accounts Team",
      "Regards,\nYour Online Banking Team",
      "Kind regards,\nStandard Bank",
      "Regards,\nFNB Connect",
      "Thanks,\nMr",
      "Regards, Mr [name]",
    ]) {
      expect(redact(kept, []), kept).toBe(kept);
      expect(discoveredDetail(kept), kept).toBeNull();
    }
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
  // In running text, where only the pass finds them: a signed name and a street line are the rules' (`SIGNED_NAME`,
  // `STREET_ADDRESS`), with no pass at all.
  const page = "<p>Please phone Hendrik <b>Grobbelaar</b> today.</p><p>Collect it in Parkhurst after five.</p>";
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
    expect(out).toContain(`Please phone ${PLACEHOLDER.name} <b>${PLACEHOLDER.name}</b> today.`);
    expect(out).toContain(`Collect it in ${PLACEHOLDER.address} after five.`);
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
    // Look-alike letters are letters of their script until folded; the pass folds them (`skeleton`) before it checks.
    expect(unreadScript("Th\u0430ndi M\u043ek\u043e\u0435n\u0430")).toBe("cyrillic");
    expect(unreadScript(skeleton("Th\u0430ndi M\u043ek\u043e\u0435n\u0430"))).toBeNull();
    expect(await refusal(fake('answer({"spans": []})'), "<p>Regards, يوسف المنصوري</p>")).toBe(
      "model does not read arabic script, and the page holds a name in it",
    );
    // And as `entities.py` refuses it, should a run slip past the check here.
    expect(await refusal(fake('answer({"refused": "a name in cyrillic script would go unread"})'))).toBe(
      "pass refused the page (a name in cyrillic script would go unread)",
    );
  });

  it("refuses any letter or mark of a script the model does not read, however short the name (§19 review gap 2)", async () => {
    // A two-character Chinese name, a Devanagari name whose vowel is a combining sign, and Gujarati.
    for (const [text, script] of [
      ["Regards, 王伟", "han"],
      ["Regards, रवि", "devanagari"],
      ["Regards, અજય", "gujarati"],
      ["Regards, \u093f", "devanagari"],
    ] as const) {
      expect(unreadScript(text)).toBe(script);
      expect(await refusal(fake('answer({"spans": []})'), `<p>${text}</p>`)).toBe(
        `model does not read ${script} script, and the page holds a name in it`,
      );
    }
    // Latin with its accents (a combining one included), digits, punctuation and symbols are read.
    expect(unreadScript("Regards, Zo\u00eb M\u00fcller, Rene\u0301 Ngcobo: R1 200, 20% off, \u00a9 2026")).toBeNull();
    // A canadian_aboriginal refusal from entities.py is to the schema too: script names keep their underscores.
    expect(await refusal(fake('answer({"refused": "a name in canadian_aboriginal script would go unread"})'))).toBe(
      "pass refused the page (a name in canadian_aboriginal script would go unread)",
    );
  });

  it("reads a look-alike name folded, and redacts it where the page writes it with the look-alikes", async () => {
    const asked: string[] = [];
    const folding = fake(`spans = []
at = text.find("Thandi Mokoena")
if at >= 0:
    spans.append({"start": at, "end": at + 14, "label": "person"})
answer({"spans": spans})`);
    const html = "<p>Regards, Th\u0430ndi M\u043ek\u043e\u0435n\u0430</p>";
    const out = await redactWithEntities(
      html,
      [],
      [],
      {
        find: (t) => {
          asked.push(t);
          return folding.find(t);
        },
        close: () => {},
      },
      true,
    );
    folding.close();
    expect(out).toBe("<p>Regards, [name]</p>");
    // And a listed name written with look-alikes is matched too: the list's terms are folded as the page is.
    expect(redact("<p>Dear Thandi</p>", ["Th\u0430ndi"])).toBe("<p>Dear [name]</p>");
    expect(asked).toHaveLength(1);
  });

  it("agrees with entities.py on every text, from one table built from the Unicode Script property", () => {
    const texts = [
      "Regards, 王伟",
      "Regards, रवि",
      "Regards, અજય",
      "Regards, Олена",
      "kеstrel and μ-law",
      "Th\u0430ndi",
      "Regards, Zo\u00eb Rene\u0301",
      "\u{1F600} plain",
      "ᐃᓄᒃᑎᑐᑦ",
      "\u{10400}",
    ];
    const script = join(import.meta.dirname, "../../scripts/glimmer");
    const python = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `import json, sys; sys.path.insert(0, ${JSON.stringify(script)}); import entities; print(json.dumps([entities.unread_script(t) for t in json.load(sys.stdin)]))`,
      ],
      { input: JSON.stringify(texts), encoding: "utf8" },
    );
    expect(python.status).toBe(0);
    expect(JSON.parse(python.stdout)).toEqual(texts.map(unreadScript));
    // The table is the one the running Node's Unicode data gives (`unread-scripts.ts --check` writes nothing).
    const check = spawnSync(process.execPath, [join(script, "unread-scripts.ts"), "--check"], { encoding: "utf8" });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
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
    // An environment its requirements file does not pin (`pins.py`, round 1 finding 2): refused by package and
    // versions, and any other wording is no reason the pass may give.
    const unpinned = "the environment does not match requirements-entities.txt (spacy is 3.9.0, pinned 3.8.18)";
    expect(await refusal(fake("pass", `answer({"refused": "${unpinned}"}); sys.exit(1)`))).toBe(
      "environment does not match requirements-entities.txt (spacy is 3.9.0, pinned 3.8.18)",
    );
    expect(
      await refusal(
        fake("pass", 'answer({"refused": "the environment does not match requirements-entities.txt (Hendrik)"})'),
      ),
    ).toBe("pass gave a malformed answer");
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

  it("can be rebuilt from pinned requirements and a documented digest check (§19 review gap 1)", () => {
    const root = resolve(import.meta.dirname, "../..");
    const pins = readFileSync(join(root, "scripts/glimmer/requirements-entities.txt"), "utf8");
    // Every line a pin: an exact version, or the model wheel by its URL and SHA-256.
    for (const line of pins.split("\n").filter((l) => l && !l.startsWith("#")))
      expect(line).toMatch(/^[A-Za-z0-9_.-]+==[0-9][^\s]*$|^en_core_web_lg @ https:\/\/\S+\.whl#sha256=[0-9a-f]{64}$/);
    expect(pins).toMatch(/^spacy==3\.8\.18$/m);
    expect(pins).toMatch(
      new RegExp(`^${ENTITY_MODEL.name} @ \\S+/${ENTITY_MODEL.name}-3\\.8\\.0-py3-none-any\\.whl#sha256=`, "m"),
    );
    for (const line of readFileSync(join(root, "scripts/glimmer/requirements-ocr.txt"), "utf8").split("\n"))
      if (line && !line.startsWith("#")) expect(line).toMatch(/^[A-Za-z0-9_.-]+==[0-9]\S*$/);
    const guide = readFileSync(join(root, "docs/glimmer/importing.md"), "utf8");
    expect(guide).toContain(ENTITY_MODEL.sha256);
    expect(guide).toContain("pip install --no-deps -r scripts/glimmer/requirements-entities.txt");
    expect(guide).toContain("entities.model_digest(entities.MODEL)");
  });

  it("reads a page's text as it shows, form values included", () => {
    expect(
      entityText(
        '<p>Dear Hendrik Gro<b>bbelaar</b>,</p><style>.a{}</style><div>Thanks &amp; regards</div><input value="Nomvula Zungu">',
      ),
    ).toBe("\nDear Hendrik Grobbelaar,\n\n\nThanks & regards\n\nNomvula Zungu");
  });
});
