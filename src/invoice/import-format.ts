// The supplier ledger import's format (D06 T01 §4, corrections 5 and 11), with no runtime dependencies so the page's
// view (drawn in Node by the browser tests as well as in the Worker) and the import's reader (./ledger-csv) share it.
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
export const IMPORT_COLUMNS = ["name", "domain", "bank", "branch_code", "account_number", "phone"] as const;
// The template the page offers: the header and one fictional row, a valid import of one supplier.
export const IMPORT_TEMPLATE = `${IMPORT_COLUMNS.join(",")}\r\nMossel Bay Couriers (fictional),mbcouriers.example,Kestrel Bank,250655,62004417731,044 690 3315\r\n`;
// A row's problem, by its number (1 is the first supplier under the header) and in words.
export type RowProblem = { row: number; problem: string };
