import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  assertConsent,
  CONSENT_HEADING,
  checkShown,
  labelOf,
  leakCheck,
  leaks,
  messageFiles,
  messageParts,
  parseCsv,
  partNames,
  personalDetail,
  readClientNames,
  readManifest,
  renderRedacted,
  runImport,
} from "../../scripts/glimmer/import-samples.ts";
import {
  type EntityPass,
  type EntitySpan,
  entityTerms,
  openConfiguredPass,
  survivingEntities,
} from "../../scripts/glimmer/redact.ts";
import { openStore } from "../../scripts/glimmer/store.ts";
import {
  dir,
  finding,
  misses,
  noText,
  reader,
  render,
  samplesDir,
  useSamples,
  words,
} from "./helpers/glimmer-samples.ts";

// scripts/glimmer/import-samples.ts (D03 T04 §7), on synthetic mail only: nothing is read without the consent and the
// client's names; every message is accounted for; what is rendered holds no image and no client detail; stored pages
// read back redacted under opaque ids, with labels reconciled across identical pages; a changed redaction makes every
// page again, and an interrupted rebuild never stands as done.
useSamples();

describe("the sample importer's inputs", () => {
  it("reads nothing without the consent extension or the client's names", () => {
    writeFileSync(join(dir, "pilot-consent.md"), "# Consent\n\nMeta Model API only.\n");
    expect(() => assertConsent(dir)).toThrow(/refused/);
    writeFileSync(join(dir, "pilot-consent.md"), `# Consent\n\n## ${CONSENT_HEADING}\n`);
    expect(() => assertConsent(dir)).not.toThrow();
    expect(() => readClientNames(dir)).toThrow(/client-names\.txt is missing/);
    writeFileSync(join(dir, "client-names.txt"), "# nobody\n");
    expect(() => readClientNames(dir)).toThrow(/names no one/);
  });

  it("refuses a manifest with an unknown label or a file that is not a message", () => {
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/a.eml,maybe\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/not attack or genuine/);
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/b.eml,attack\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/names no message/);
    writeFileSync(join(dir, "manifest.csv"), "file,label\nclient/a.eml,attack\nclient/a.eml,genuine\n");
    expect(() => readManifest(dir, ["client/a.eml"])).toThrow(/already labelled attack/);
    writeFileSync(join(dir, "manifest.csv"), 'file,label\n"client/a, b.eml",attack\n');
    expect(readManifest(dir, ["client/a, b.eml"]).get("client/a, b.eml")).toBe("attack");
    expect(partNames("Content-Type: text/html; charset=x; name*0*=utf-8''a%20; name*1*=b.html")).toContain("a b.html");
    expect(partNames('Content-Type: text/html; name="=?utf-8?B?0J/RgNC40LLQtdGC?=.html"')).toContain("Привет.html");
    expect(parseCsv('a,"b ""c"", d"\r\n\r\n1,2\n')).toEqual([
      ["a", 'b "c", d'],
      ["1", "2"],
    ]);
  });

  it("labels by the manifest or the verdict, and gives Spam, Bulk and the unlabelled a reason", () => {
    const manifest = new Map([["client/g.eml", "genuine"]]);
    expect(labelOf("client/g.eml", manifest)).toMatchObject({ lure: false, source: "ground-truth" });
    expect(labelOf("client/1_HighConfPhish.eml", manifest)).toMatchObject({ lure: true, source: "ground-truth" });
    expect(labelOf("client/1_Phish.eml", manifest)).toMatchObject({ lure: true, source: "unverified" });
    expect(labelOf("client/1_Spam.eml", manifest)).toEqual({ excluded: "a Spam verdict: neither a lure nor benign" });
    expect(labelOf("client/1_Bulk.eml", manifest)).toEqual({ excluded: "a Bulk verdict: neither a lure nor benign" });
    expect(labelOf("client/1_Malware.eml", manifest)).toEqual({ excluded: "an unknown verdict" });
    expect(labelOf("client/x.eml", manifest)).toEqual({ excluded: "no label" });
  });

  it("finds every message at any depth and in any case, and reads a manifest saved with a byte-order mark", () => {
    mkdirSync(join(dir, "client", "archive"), { recursive: true });
    for (const name of ["1.eml", "client/2.EML", "client/archive/3.eml", "client/.hidden.eml", "client/notes.txt"])
      writeFileSync(join(dir, name), "x");
    expect(messageFiles(dir)).toEqual(["1.eml", "client/2.EML", "client/archive/3.eml"]);
    writeFileSync(join(dir, "manifest.csv"), "\uFEFFfile,label\n1.eml,attack\n");
    expect(readManifest(dir, ["1.eml"]).get("1.eml")).toBe("attack");
  });

  it("decodes two attachments with one name each by its own MIME charset", async () => {
    const parts = [
      "--b",
      "Content-Type: text/html; charset=windows-1251; name=invoice.html",
      "Content-Disposition: attachment; filename=invoice.html",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]).toString("base64"),
      "--b",
      "Content-Type: text/html; charset=utf-8; name=invoice.html",
      "Content-Disposition: attachment; filename=invoice.html",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Привет", "utf-8").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    const raw = `Content-Type: multipart/mixed; boundary="b"\r\n\r\n${parts}`;
    expect(messageParts(await PostalMime.parse(raw), raw).attachments).toEqual(["Привет", "Привет"]);
  });

  it("matches a name as a whole word and an address or domain anywhere, and sees a joined-up detail", () => {
    expect(leaks([{ id: "p", text: "Announcement for everyone" }], ["Ann"])).toEqual([]);
    expect(leaks([{ id: "p", text: "Dear Ann," }], ["Ann"])).toHaveLength(1);
    // A name written with a look-alike letter is the same name on the screen.
    expect(leaks([{ id: "p", text: "Dear \u0410nn," }], ["Ann"])).toHaveLength(1);
    expect(leaks([{ id: "p", text: "see www.acme.co.za/x" }], ["acme.co.za"])).toHaveLength(1);
    expect(personalDetail("Call 082 555 1234 now")).toBe("a phone number");
    expect(personalDetail("Pay R 4 210.00 by 2026-10-31")).toBeNull();
  });
});

describe("a sample render", () => {
  it("refuses a page whose render still shows a person or place the entity pass finds (§19)", async () => {
    // In running text, which only the pass reads (a signed name is the rules' own, `signatureSpans`).
    const html = `<p>${words}</p><p>Please phone Hendrik Grobbelaar today.</p>`;
    // The pass misses the name in the HTML and finds it in the render: the page is refused, by kind.
    let calls = 0;
    const late: EntityPass = {
      find: async (text) => (calls++ === 0 ? [] : finding(["Hendrik Grobbelaar"]).find(text)),
      close: () => {},
    };
    await expect(renderRedacted(render, html, [], [], [], { pass: late, on: true })).rejects.toThrow(
      /^refused: a person's name survived redaction$/,
    );
    expect(calls).toBe(2);
    // A place it finds only in the render, the same.
    calls = 0;
    const place: EntityPass = {
      find: async (text) => (calls++ === 0 ? [] : finding(["Parkhurst"], "place").find(text)),
      close: () => {},
    };
    await expect(
      renderRedacted(render, `<p>${words}</p><p>Collect it in Parkhurst</p>`, [], [], [], { pass: place, on: true }),
    ).rejects.toThrow(/^refused: a place survived redaction$/);
    // A pass that finds it in the HTML redacts it, and the render it reads again shows only the placeholder.
    const page = await renderRedacted(render, html, [], [], [], { pass: finding(["Hendrik Grobbelaar"]), on: true });
    expect(page.text).toContain("Please phone [name] today.");
    // A street line split by a tag slips the HTML rule; the render joins it up and the rule refuses it there, with a
    // pass that finds nothing: what admission refuses on does not rest on the model (§19 completion review gap 3).
    await expect(
      renderRedacted(render, `<p>${words}</p><p>Deliver to 41 Wagtail <b>Crescent</b>, Bryanston</p>`, [], [], [], {
        pass: finding([]),
        on: true,
      }),
    ).rejects.toThrow(/^refused: a street address survived redaction$/);
    // A pass that refuses refuses the page; with the switch on and no pass, nothing renders.
    const refusing: EntityPass = {
      find: async () => Promise.reject(new Error("refused: the entity pass crashed (exit code 3)")),
      close: () => {},
    };
    await expect(renderRedacted(render, html, [], [], [], { pass: refusing, on: true })).rejects.toThrow(
      /^refused: the entity pass crashed/,
    );
    await expect(renderRedacted(render, html, [], [], [], { pass: null, on: true })).rejects.toThrow(
      /^refused: the entity pass is on but was not started$/,
    );
    // What counts as left: a placeholder is not, a title before one is not, a name piece beside one is.
    const text = "Dear [name], Mr [name] and [name] Grobbelaar, the [address]";
    const span = (word: string, label: EntitySpan["label"] = "person") => ({
      start: text.indexOf(word),
      end: text.indexOf(word) + word.length,
      label,
    });
    expect(survivingEntities(text, [span("[name],"), span("Mr [name]"), span("the [address]", "place")])).toEqual([]);
    expect(survivingEntities(text, [span("[name] Grobbelaar")])).toHaveLength(1);
  });

  // §19 round 2: an address typed small and a signed name of ordinary words are redacted, and refused unredacted at
  // admission, with a pass that finds nothing.
  it("redacts and refuses a lowercase address and a signed name made of ordinary words, with no model", async () => {
    for (const [text, kept, kind] of [
      ["Please deliver to 7 kloof nek road.", "Please deliver to [address]", "a street address"],
      ["Please deliver to 16 vergenoegstraat, bellville, 7530", "Please deliver to [address]", "a street address"],
      ["Write to po box 4471 today.", "Write to [address] today.", "a post box"],
      ["Kind regards,\nMay Long", "[name]", "a signed name"],
      ["Thanks,\nRose Hill", "[name]", "a signed name"],
      ["Regards,\nWill Grant", "[name]", "a signed name"],
    ]) {
      const html = `<p>${words}</p><p>${(text as string).replace("\n", "</p><p>")}</p>`;
      const page = await renderRedacted(render, html, [], [], [], { pass: finding([]), on: true });
      expect(page.text, text).toContain(kept);
      expect(page.text, text).not.toMatch(/kloof|vergenoeg|4471|May Long|Rose Hill|Will Grant/);
      await expect(checkShown(text as string, [], { pass: finding([]), on: true }), text).rejects.toThrow(
        `refused: ${kind} survived redaction`,
      );
    }
    // A business signing off is no person, and admission keeps it.
    const page = await renderRedacted(render, `<p>${words}</p><p>Kind regards,</p><p>Customer Care</p>`, [], [], [], {
      pass: finding([]),
      on: true,
    });
    expect(page.text).toContain("Customer Care");
    await expect(checkShown(page.text, [], { pass: finding([]), on: true })).resolves.toBeUndefined();
  });

  // §19 round 3: a signed name is redacted and refused unredacted whatever its words mean; only a line that signs for a
  // business taken whole (a team phrase, a known brand, a title alone) is kept, and the brand on a mixed line stays.
  it("redacts and refuses a signed name of business or direction words, and keeps a business signing off, with no model", async () => {
    for (const name of [
      "May West",
      "Will West",
      "Rose North",
      "Grace East",
      "June Bank",
      "Mark Price",
      "LINDIWE MASEKO",
      "Dr Thandeka Mokoena",
    ]) {
      const page = await renderRedacted(render, `<p>${words}</p><p>Kind Regards,</p><p>${name}</p>`, [], [], [], {
        pass: finding([]),
        on: true,
      });
      expect(page.text, name).toContain("[name]");
      expect(page.text, name).not.toContain(name);
      await expect(checkShown(page.text, [], { pass: finding([]), on: true }), name).resolves.toBeUndefined();
      await expect(checkShown(`Kind Regards,\n${name}`, [], { pass: finding([]), on: true }), name).rejects.toThrow(
        "refused: a signed name survived redaction",
      );
    }
    for (const signed of ["Customer Care", "The Accounts Team", "Standard Bank", "Mr"]) {
      const page = await renderRedacted(render, `<p>${words}</p><p>Kind regards,</p><p>${signed}</p>`, [], [], [], {
        pass: finding([]),
        on: true,
      });
      expect(page.text, signed).toContain(signed);
      await expect(checkShown(page.text, [], { pass: finding([]), on: true }), signed).resolves.toBeUndefined();
    }
    const mixed = await renderRedacted(render, `<p>${words}</p><p>Regards, May West, Standard Bank</p>`, [], [], [], {
      pass: finding([]),
      on: true,
    });
    expect(mixed.text).toContain("Regards, [name], Standard Bank");
    await expect(checkShown(mixed.text, [], { pass: finding([]), on: true })).resolves.toBeUndefined();
  });

  // §19 round 1 finding 1: a person the model finds is that person, whatever the header parser makes of the name.
  it("redacts and refuses a detected person the header parser would drop: an apostrophe, a common word, two capitals", () => {
    const text = "O\u2019Neil and O'Neil asked Long and LI; Mr [name], the Accounts Team and [name].";
    const span = (word: string) => ({
      start: text.indexOf(word),
      end: text.indexOf(word) + word.length,
      label: "person" as const,
    });
    const named = ["O\u2019Neil", "O'Neil", "Long", "LI"].map(span);
    expect(entityTerms(text, named).names).toEqual(expect.arrayContaining(["O\u2019Neil", "O'Neil", "Long", "LI"]));
    expect(survivingEntities(text, named)).toEqual(named);
    // A title before a placeholder, a mailbox role signing for a business, and a placeholder name no one.
    const none = ["Mr [name]", "the Accounts Team", "[name]."].map(span);
    expect(survivingEntities(text, none)).toEqual([]);
    expect(entityTerms(text, none.slice(0, 2)).names).toEqual([]);
  });

  // WORKAROUND: the entity pass's model is a 600 MB local install in its own venv, which no CI host carries.
  it.skipIf(!existsSync(join(homedir(), ".venvs", "presidio", "bin", "python")))(
    "with the pinned model, redacts O’Neil, Long and LI, and refuses them unredacted at admission and in the leak check",
    async () => {
      const pass = openConfiguredPass();
      try {
        const texts = [
          "O\u2019Neil said that the invoice was paid. Please ask O'Neil for confirmation.",
          "Long said that the invoice was paid. Please ask Long for confirmation.",
          "LI said that the invoice was paid. Please ask LI for confirmation.",
        ];
        for (const text of texts) {
          const page = await renderRedacted(render, `<p>${words}</p><p>${text}</p>`, [], [], [], { pass, on: true });
          expect(page.text).toContain("[name] said that the invoice was paid. Please ask [name] for confirmation.");
          expect(page.text).not.toMatch(/Neil|\bLong\b|\bLI\b/);
          await expect(checkShown(text, [], { pass, on: true })).rejects.toThrow(
            /^refused: a person's name survived redaction$/,
          );
        }
        // The leak check, with the same model, fails a stored page whose screenshot shows each name unredacted.
        const samples = samplesDir(["1_", "4_"]);
        for (const name of ["9_HighConfPhish.eml", "14_HighConfPhish.eml", "6_HighConfPhish.eml"])
          rmSync(join(samples, "client", name), { recursive: true, force: true });
        const store = openStore(join(dir, "store"));
        expect((await runImport({ entities: misses, samples, store, render })).code).toBe(0);
        const first = store.manifest().filter((p) => p.origin === "samples")[0]?.id as string;
        const blank = await leakCheck({ entities: { pass }, samples, store, ocr: noText });
        expect(blank.failures.filter((f) => f.representation === "OCR")).toEqual([]);
        for (const text of texts) {
          const shown = await leakCheck({
            entities: { pass },
            samples,
            store,
            ocr: async (shots) => shots.map((_, i) => (i === 0 ? text : "")),
          });
          expect(shown.code).toBe(1);
          expect(shown.failures.filter((f) => f.representation === "OCR")).toEqual([
            {
              id: first,
              representation: "OCR",
              reason: "the entity pass found a person's name that is not a placeholder",
            },
          ]);
        }
      } finally {
        pass.close();
      }
    },
    300_000,
  );

  it("refuses a name the page draws in a form value, however its letters are written", async () => {
    // `&acy;` is a Cyrillic а the redactor's own table does not know; the browser decodes it and draws the name.
    const html = `<p>${words}</p><input value="Th&acy;ndi" style="font-size:24px"><input placeholder="Dear Thandi">`;
    await expect(renderRedacted(render, html, [], ["Thandi"], [], misses)).rejects.toThrow(/a client detail survived/);
    // A phone in a placeholder is redacted before the render, and the drawn text shows the placeholder.
    const page = await renderRedacted(
      render,
      `<p>${words}</p><input placeholder="082 555 1234">`,
      [],
      ["Thandi"],
      [],
      misses,
    );
    expect(page.drawn).toBe("[phone]");
  });

  it("draws no picture however the page writes it, by the browser's own reading", async () => {
    const red = (
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer()
    ).toString("base64");
    // An unquoted style hiding url( and data: in escapes, a pseudo-element's picture marked !important by an id rule,
    // and a plain image: each a solid red block where the screenshot would show it.
    const escaped = `\\000075rl(data\\00003aimage/png;base64,${red})`;
    const html = `<style>#p::before{content:"";display:block;width:300px;height:100px;background-image:url(data:image/png;base64,${red})!important;background-size:cover}</style>
<div style=width:300px;height:100px;background-size:cover;background-image:${escaped}></div><div id=p></div><img src="data:image/png;base64,${red}" width=300 height=100>
<p>${words}</p>`;
    let shot: Uint8Array | undefined;
    try {
      shot = (await reader.renderHtml(html, { pictures: false })).screenshot;
    } catch (error) {
      expect(String(error)).toMatch(/refused: a picture survived/);
      return;
    }
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    let reds = 0;
    for (let i = 0; i < data.length; i += info.channels)
      if ((data[i] as number) > 200 && (data[i + 1] as number) < 60 && (data[i + 2] as number) < 60) reds++;
    expect(reds).toBe(0);
    // Without the rule the same page shows its pictures: the test can see red when red is drawn.
    const plain = (await reader.renderHtml(html)).screenshot;
    const raw = await sharp(plain).raw().toBuffer({ resolveWithObject: true });
    let shown = 0;
    for (let i = 0; i < raw.data.length; i += raw.info.channels)
      if ((raw.data[i] as number) > 200 && (raw.data[i + 1] as number) < 60 && (raw.data[i + 2] as number) < 60)
        shown++;
    expect(shown).toBeGreaterThan(1000);
  });
});

describe("the pilot-client rule", () => {
  it("allows redacted sample mail into Fireworks training lines and keeps every other restriction", () => {
    const rule =
      readFileSync(join(import.meta.dirname, "../../AGENTS.md"), "utf-8")
        .split("\n")
        .find((line) => line.startsWith("- Never send real client mail to the Meta Model API")) ?? "";
    expect(rule).toMatch(/Redacted, it may also go into Fireworks training lines for Loupe/);
    expect(rule).toMatch(/unredacted, it goes only to the Meta Model API/);
    expect(rule).toMatch(/never enters a tracked file/);
    expect(rule).toMatch(/stays under the git-ignored `samples\/`/);
  });
});
