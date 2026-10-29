// The operator's notice when a Meta cap refuses a call (D03 T01 §2): one notice for each cap event, never one per
// refusal. The event is the day for the day cap (a new day is a new event), and the cap's own amount for the reserve and
// the total (raising either is a commit, and a new event). The event is the notice's send key, so `sendMail` sends it
// once however many refusals race or however many Worker instances see them; a failed send is claimed again by the next
// refusal; an uncertain one is settled by the reconciler (D01 T02 §5).
import { sendMail } from "../mail/smtp2go";
import { DAY_CAP_USD, RESERVE_USD, TOTAL_CAP_USD } from "./caps";
import type { Cap } from "./guard";

const ALERTS_FROM = "IsItLegit <alerts@isitlegit.co.za>";

export function capEvent(cap: Cap, day: string): string {
  if (cap === "day") return `budget:day:${day}`;
  return cap === "reserve" ? `budget:reserve:${TOTAL_CAP_USD - RESERVE_USD}` : `budget:total:${TOTAL_CAP_USD}`;
}

const WHAT: Record<Cap, string> = {
  day: `today's US$${DAY_CAP_USD} cap`,
  reserve: `the US$${TOTAL_CAP_USD - RESERVE_USD} spendable before the demo days (US$${RESERVE_USD} is held for 3 and 4 November)`,
  total: `the US$${TOTAL_CAP_USD} total`,
};

export type NoticeEnv = { DB: D1Database; SMTP2GO_API_KEY?: string; OPERATOR_EMAIL?: string };

export async function sendCapNotice(env: NoticeEnv, cap: Cap, model: string, day: string): Promise<void> {
  if (!env.OPERATOR_EMAIL) return;
  await sendMail(
    { db: env.DB, apiKey: env.SMTP2GO_API_KEY, operator: env.OPERATOR_EMAIL },
    {
      sendKey: capEvent(cap, day),
      kind: "alert",
      to: env.OPERATOR_EMAIL,
      from: ALERTS_FROM,
      subject: `IsItLegit: the Meta ${cap} cap refused a call`,
      text: [
        `A call to ${model} on ${day} (SAST) was refused: it would have gone past ${WHAT[cap]}.`,
        "",
        "Checks that need a model end partial, and members are told when checks resume. No call above the caps is made.",
        "The caps are in src/meta/caps.ts (design spec section 11); the spend is in the model_spend table.",
      ].join("\n"),
    },
  );
}
