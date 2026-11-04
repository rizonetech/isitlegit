import type { Case } from "./corpus.ts";
import type { Findings } from "./evaluate.ts";
export function detect(row: Case): Promise<Findings>;
