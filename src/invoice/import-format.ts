// The supplier ledger import's format (D06 T01 §4, corrections 5 and 11), with no runtime dependencies so the page's
// view (drawn in Node by the browser tests as well as in the Worker) and the import's reader (./ledger-csv) share it.
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const IMPORT_COLUMNS = ["name", "domain", "bank", "branch_code", "account_number", "phone"] as const;
// The template the page offers: the header alone, a valid empty import, so an unchanged template never creates a
// supplier or a baseline account (completion review); the page shows an example row in its help instead.
export const IMPORT_TEMPLATE = `${IMPORT_COLUMNS.join(",")}\r\n`;
export const IMPORT_EXAMPLE = "Mossel Bay Couriers,mbcouriers.example,Kestrel Bank,250655,4011223344,044 690 3315";
// A row's problem, by its number (1 is the first supplier under the header) and in words.
export type RowProblem = { row: number; problem: string };
