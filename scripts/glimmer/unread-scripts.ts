// The scripts the entity pass's English model does not read (D03 T04 §19), as code point ranges, for `unreadScript()`
// in `redact.ts` and `unread_script()` in `entities.py`, which both read `unread-scripts.json` so the two refuse the
// same text. Derived from the Unicode Script property (UAX #24) as the running Node's ICU data holds it: every letter
// or mark (General_Category L or M) whose Script is not Latin, Common or Inherited, each range named by its script. A
// Latin letter, a digit, punctuation and a combining accent on a Latin letter are read; a letter or a vowel sign of any
// other script, however short the word it is in, is not (a two-character Chinese name, a Devanagari name whose vowel
// is a combining sign). `--check` builds afresh and exits non-zero when the committed table is missing or differs,
// writing nothing; `test/node/glimmer-redact.test.ts` runs it.
//
//   node scripts/glimmer/unread-scripts.ts [--check]
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TABLE = join(import.meta.dirname, "unread-scripts.json");

// The Script property's values (PropertyValueAliases.txt, `sc`), long names, through Unicode 17. A name the running
// Node does not know is passed over; every unread letter must still fall in a named script, or the build refuses.
const SCRIPTS =
  "Adlam Ahom Anatolian_Hieroglyphs Arabic Armenian Avestan Balinese Bamum Bassa_Vah Batak Bengali Beria_Erfe Bhaiksuki Bopomofo Brahmi Braille Buginese Buhid Canadian_Aboriginal Carian Caucasian_Albanian Chakma Cham Cherokee Chisoi Chorasmian Coptic Cuneiform Cypriot Cypro_Minoan Cyrillic Deseret Devanagari Dives_Akuru Dogra Duployan Egyptian_Hieroglyphs Elbasan Elymaic Ethiopic Garay Georgian Glagolitic Gothic Grantha Greek Gujarati Gunjala_Gondi Gurmukhi Gurung_Khema Han Hangul Hanifi_Rohingya Hanunoo Hatran Hebrew Hiragana Imperial_Aramaic Inscriptional_Pahlavi Inscriptional_Parthian Javanese Kaithi Kannada Katakana Kawi Kayah_Li Kharoshthi Khitan_Small_Script Khmer Khojki Khudawadi Kirat_Rai Lao Lepcha Limbu Linear_A Linear_B Lisu Lycian Lydian Mahajani Makasar Malayalam Mandaic Manichaean Marchen Masaram_Gondi Medefaidrin Meetei_Mayek Mende_Kikakui Meroitic_Cursive Meroitic_Hieroglyphs Miao Modi Mongolian Mro Multani Myanmar Nabataean Nag_Mundari Nandinagari New_Tai_Lue Newa Nko Nushu Nyiakeng_Puachue_Hmong Ogham Ol_Chiki Ol_Onal Old_Hungarian Old_Italic Old_North_Arabian Old_Permic Old_Persian Old_Sogdian Old_South_Arabian Old_Turkic Old_Uyghur Oriya Osage Osmanya Pahawh_Hmong Palmyrene Pau_Cin_Hau Phags_Pa Phoenician Psalter_Pahlavi Rejang Runic Samaritan Saurashtra Sharada Shavian Siddham Sidetic SignWriting Sinhala Sogdian Sora_Sompeng Soyombo Sundanese Sunuwar Syloti_Nagri Syriac Tagalog Tagbanwa Tai_Le Tai_Tham Tai_Viet Tai_Yo Takri Tamil Tangsa Tangut Telugu Thaana Thai Tibetan Tifinagh Tirhuta Todhri Tolong_Siki Toto Tulu_Tigalari Ugaritic Vai Vithkuqi Wancho Warang_Citi Yezidi Yi Zanabazar_Square".split(
    " ",
  );

export type UnreadTable = { unicode: string; source: string; ranges: [number, number, string][] };

// The table afresh: consecutive code points of one unread script joined into one range.
export function buildTable(): UnreadTable {
  const unread = /(?![\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}])[\p{L}\p{M}]/u;
  const known = SCRIPTS.flatMap((name) => {
    try {
      return [{ name: name.toLowerCase(), rule: new RegExp(`^\\p{Script=${name}}$`, "u") }];
    } catch {
      return [];
    }
  });
  const ranges: [number, number, string][] = [];
  for (let code = 0; code <= 0x10ffff; code++) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const char = String.fromCodePoint(code);
    if (!unread.test(char)) continue;
    const script = known.find(({ rule }) => rule.test(char))?.name;
    if (!script) throw new Error(`U+${code.toString(16).toUpperCase()} is in no script this build names`);
    const last = ranges.at(-1);
    if (last && last[1] === code - 1 && last[2] === script) last[1] = code;
    else ranges.push([code, code, script]);
  }
  return {
    unicode: process.versions.unicode ?? "unknown",
    source: "the Unicode Script property in Node's ICU data: letters and marks not Latin, Common or Inherited",
    ranges,
  };
}

const serialise = (table: UnreadTable) =>
  `{"unicode": ${JSON.stringify(table.unicode)}, "source": ${JSON.stringify(table.source)}, "ranges": [\n${table.ranges.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;

if (import.meta.filename === process.argv[1]) {
  const table = buildTable();
  const text = serialise(table);
  if (process.argv.includes("--check")) {
    const same = existsSync(TABLE) && readFileSync(TABLE, "utf8") === text;
    if (!same)
      console.error(`unread-scripts: ${TABLE} is missing or stale: run node scripts/glimmer/unread-scripts.ts`);
    process.exit(same ? 0 : 1);
  }
  writeFileSync(`${TABLE}.tmp`, text);
  renameSync(`${TABLE}.tmp`, TABLE);
  console.log(`unread-scripts: ${table.ranges.length} ranges written to ${TABLE}`);
}
