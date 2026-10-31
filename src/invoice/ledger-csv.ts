// The supplier ledger's CSV import, read and checked in full before anything is written (D06 T01 §4, corrections 5
// and 11): at most 1 MiB and 1,000 suppliers, RFC 4180 CSV with the header `name,domain,bank,branch_code,
// account_number,phone`, and every row valid or nothing imported. A problem names its row (1 is the first supplier
// under the header) and the column, and never echoes an account number; a domain is named, since the member typed it
// and must see which one is wrong.
import { canonicalAccount } from "../trust/bank";
import { AccountRefused } from "../trust/errors";
import { isConsumerMailbox } from "./mailboxes";

export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const IMPORT_COLUMNS = ["name", "domain", "bank", "branch_code", "account_number", "phone"] as const;
// The template the page offers: the header and one fictional row, a valid import of one supplier.
export const IMPORT_TEMPLATE = `${IMPORT_COLUMNS.join(",")}\r\nMossel Bay Couriers (fictional),mbcouriers.example,Kestrel Bank,250655,62004417731,044 690 3315\r\n`;

export type ImportRow = {
  row: number;
  name: string;
  domain: string;
  bank: string;
  branchCode: string;
  number: string;
  phone: string | null;
};
export type RowProblem = { row: number; problem: string };
export type ImportCheck = { ok: true; rows: ImportRow[] } | { ok: false; file: string | null; problems: RowProblem[] };

// RFC 4180 records: fields separated by commas, records by CRLF or LF, a field in double quotes may hold commas, line
// breaks and doubled quotes. A quote that never closes is a file error, never a guess at where the field ends.
export function parseCsv(text: string): { records: string[][] } | { error: string } {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let opened = false;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "" && !opened) {
      quoted = true;
      opened = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
      opened = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      opened = false;
    } else if (c === '"') return { error: `row ${records.length} has a quote inside a field that is not quoted` };
    else field += c;
  }
  if (quoted) return { error: "the file has a quoted field that never closes" };
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // A blank line (a lone empty field) is no record: spreadsheets often end a file with one.
  return { records: records.filter((r) => !(r.length === 1 && r[0]?.trim() === "")) };
}

const DIGITS = (s: string) => s.replace(/[\s-]+/g, "");
const PHONE = /^\+?[0-9 ()-]+$/;

// One row's problem, or the row read: the same rules the ledger applies (canonicalAccount for the number and branch
// code, a registrable domain that is not a consumer mailbox, a name and a bank of 1 to 120 characters).
function rowOf(fields: string[], row: number, siteOf: (domain: string) => string | null): ImportRow | RowProblem {
  if (fields.length !== IMPORT_COLUMNS.length)
    return { row, problem: `has ${fields.length} fields; a row has ${IMPORT_COLUMNS.length}` };
  const [name, domain, bank, branch, number, phone] = fields.map((f) => f.trim()) as string[];
  if (!name) return { row, problem: "name is empty" };
  if ((name as string).length > 120) return { row, problem: "name is longer than 120 characters" };
  if (!domain) return { row, problem: "domain is empty" };
  const site = siteOf(domain as string);
  const shown = (domain as string).slice(0, 60);
  if (!site) return { row, problem: `domain "${shown}" is not a domain, such as example.co.za` };
  if (isConsumerMailbox(site))
    return { row, problem: `domain "${shown}" is a free mail service, not a supplier domain` };
  if (!bank) return { row, problem: "bank is empty" };
  if ((bank as string).length > 120) return { row, problem: "bank is longer than 120 characters" };
  if (!branch) return { row, problem: "branch_code is empty" };
  if (!number) return { row, problem: "account_number is empty" };
  let canonical: { number: string; branchCode: string };
  try {
    canonical = canonicalAccount({ number, branchCode: branch });
  } catch (error) {
    if (!(error instanceof AccountRefused)) throw error;
    const digits = DIGITS(number as string);
    return /^\d{6}$/.test(DIGITS(branch as string))
      ? {
          row,
          problem: `account_number has ${/^\d+$/.test(digits) ? `${digits.length} digits` : "characters other than digits"}; an account number has 7 to 11 digits`,
        }
      : { row, problem: "branch_code must be 6 digits" };
  }
  let phoneValue: string | null = null;
  if (phone) {
    const value = (phone as string).replace(/\s+/g, " ");
    const digits = value.replace(/\D/g, "").length;
    if (!PHONE.test(value) || value.indexOf("+") > 0 || digits < 7 || digits > 15)
      return { row, problem: "phone is not 7 to 15 digits with an optional leading +" };
    phoneValue = value;
  }
  return {
    row,
    name: name as string,
    domain: site,
    bank: bank as string,
    branchCode: canonical.branchCode,
    number: canonical.number,
    phone: phoneValue,
  };
}

// The whole file checked: a file problem (size, header, quoting, no rows, too many) or every row's problem, or every
// row read. Nothing here writes.
export function checkImport(bytes: number, text: string, siteOf: (domain: string) => string | null): ImportCheck {
  if (bytes > MAX_IMPORT_BYTES) return { ok: false, file: "the file is larger than 1 MiB", problems: [] };
  const parsed = parseCsv(text);
  if ("error" in parsed) return { ok: false, file: parsed.error, problems: [] };
  const [header, ...rows] = parsed.records;
  const columns = (header ?? []).map((h) => h.trim().toLowerCase());
  if (columns.join(",") !== IMPORT_COLUMNS.join(","))
    return { ok: false, file: `the first row must be the columns ${IMPORT_COLUMNS.join(",")}`, problems: [] };
  if (rows.length === 0) return { ok: false, file: "the file has no suppliers under its header", problems: [] };
  if (rows.length > MAX_IMPORT_ROWS)
    return {
      ok: false,
      file: `the file has more than ${MAX_IMPORT_ROWS.toString().replace(/\B(?=(\d{3})+$)/g, ",")} suppliers`,
      problems: [],
    };
  const read: ImportRow[] = [];
  const problems: RowProblem[] = [];
  rows.forEach((fields, i) => {
    const r = rowOf(fields, i + 1, siteOf);
    if ("problem" in r) problems.push(r);
    else read.push(r);
  });
  return problems.length ? { ok: false, file: null, problems } : { ok: true, rows: read };
}
