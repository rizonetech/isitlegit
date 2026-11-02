// The Impersonation monitor page (D05 T04 §5; design/SPEC.md M6, board `Monitor`): the business's
// findings with status, first seen, a takedown pack download and dismiss with a reason. Only a
// confirmed finding is called a fake site; an unconfirmed one lists without that claim and a
// partial one as incomplete. Nothing here contacts a registrar or host: the pack is the member's
// to send.
import type { Finding } from "../../monitor/findings";
import { AppShell, type MemberShellProps } from "../components/AppShell";
import { Button } from "../components/Button";
import { Document } from "../components/Document";
import { Pill, type PillVariant } from "../components/Pill";
import { EmptyState } from "../components/States";

export type MonitorOutcome = "dismissed" | "restored" | "refused" | "failed" | "gone";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Johannesburg",
  day: "numeric",
  month: "short",
  year: "numeric",
});
export const sastDay = (iso: string) => dateFormat.format(Date.parse(iso));

const STATUS: Record<Finding["status"], { label: string; pill: PillVariant }> = {
  new: { label: "New, live", pill: "malicious" },
  watching: { label: "Watching", pill: "suspicious" },
  offline: { label: "Taken offline", pill: "safe" },
  dismissed: { label: "Dismissed", pill: "neutral" },
};

export function outcomeWords(outcome: Finding["outcome"]): string {
  if (outcome === "confirmed") return "Confirmed fake site";
  if (outcome === "unconfirmed") return "Not confirmed as impersonation";
  return "Investigation incomplete";
}

export function MonitorPage(props: {
  shell: Omit<MemberShellProps, "children">;
  findings: Finding[];
  evidence?: Record<string, string[]>;
  shots?: Record<string, boolean>;
  selected?: string | null;
  lastRunDay: string | null;
  partialRun: boolean;
  outcome?: MonitorOutcome | null;
  dismissError?: string | null;
}) {
  const { findings } = props;
  const counts = {
    live: findings.filter((f) => f.status === "new" && f.outcome === "confirmed").length,
    watching: findings.filter((f) => f.status === "watching").length,
    offline: findings.filter((f) => f.status === "offline").length,
    dismissed: findings.filter((f) => f.status === "dismissed").length,
  };
  return (
    <Document title="Impersonation monitor">
      <AppShell {...props.shell} active="monitor">
        <main id="content" class="mx-auto w-full max-w-960 px-16 py-24 md:px-24">
          <h1 class="text-28 font-semibold">Impersonation monitor</h1>
          <p class="mt-8 text-14 text-muted">
            {props.lastRunDay
              ? `Last run ${props.lastRunDay} · next run tomorrow at 03:00 SAST`
              : "Not yet monitored: the first daily run has not happened."}
          </p>
          {props.partialRun && (
            <p class="mt-8 text-14 text-alert" role="status">
              The last run finished only partly, so this list may be missing new lookalikes.
            </p>
          )}
          {props.outcome === "dismissed" && (
            <p class="mt-8 text-14" role="status">
              Finding dismissed. It stays dismissed across later captures unless a new confirmed capture appears.
            </p>
          )}
          {props.outcome === "restored" && (
            <p class="mt-8 text-14" role="status">
              Finding restored to watching.
            </p>
          )}
          {(props.outcome === "refused" || props.outcome === "failed") && (
            <p class="mt-8 text-14 text-alert" role="alert">
              That change could not be made. Nothing was changed; try again.
            </p>
          )}
          <div class="mt-16 grid grid-cols-2 gap-12 md:grid-cols-4">
            <div class="rounded-medium border border-line p-12">
              <p class="text-22 font-semibold">{counts.live}</p>
              <p class="text-13 text-muted">Live fake sites, new</p>
            </div>
            <div class="rounded-medium border border-line p-12">
              <p class="text-22 font-semibold">{counts.watching}</p>
              <p class="text-13 text-muted">Watching</p>
            </div>
            <div class="rounded-medium border border-line p-12">
              <p class="text-22 font-semibold">{counts.offline}</p>
              <p class="text-13 text-muted">Taken offline</p>
            </div>
            <div class="rounded-medium border border-line p-12">
              <p class="text-22 font-semibold">{counts.dismissed}</p>
              <p class="text-13 text-muted">Dismissed, with your reason</p>
            </div>
          </div>
          {findings.length > 0 &&
            (() => {
              const selected =
                findings.find((f) => f.host === props.selected) ??
                findings.find((f) => f.status === "new") ??
                findings[0];
              if (!selected) return null;
              return (
                <section class="mt-24 rounded-medium border border-line p-16" aria-label="Finding detail">
                  <Pill variant={STATUS[selected.status].pill}>{STATUS[selected.status].label}</Pill>
                  <h2 class="mt-8 text-20 font-semibold">{selected.host}</h2>
                  <p class="text-14 text-muted">
                    {outcomeWords(selected.outcome)} · first seen {sastDay(selected.first_seen)}
                  </p>
                  {props.shots?.[selected.host] ? (
                    <img
                      class="mt-12 w-full rounded-small border border-line"
                      src={`/monitor/shot/${encodeURIComponent(selected.host)}`}
                      alt={`Screenshot of ${selected.host} from the settled capture`}
                    />
                  ) : (
                    <p class="mt-12 text-14 text-muted">
                      The settled screenshot could not be read back. The evidence below still stands, and the takedown
                      pack says the same.
                    </p>
                  )}
                  {(props.evidence?.[selected.host]?.length ?? 0) > 0 && (
                    <ul class="mt-12 list-disc pl-16 text-14">
                      {(props.evidence?.[selected.host] ?? []).map((line) => (
                        <li>{line}</li>
                      ))}
                    </ul>
                  )}
                </section>
              );
            })()}
          {findings.length === 0 ? (
            <div class="mt-24">
              <EmptyState
                layout="filtered"
                title="No findings yet"
                sentence="The daily monitor watches for lookalikes of your business. Anything it confirms appears here with its evidence and a takedown pack."
              />
            </div>
          ) : (
            <table class="mt-24 w-full text-left text-14">
              <thead>
                <tr class="border-b border-line text-13 text-muted">
                  <th class="py-8 pr-12">Domain</th>
                  <th class="py-8 pr-12">Status</th>
                  <th class="py-8 pr-12">First seen</th>
                  <th class="py-8">Actions</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr id={finding.host} class="border-b border-line align-top">
                    <td class="py-12 pr-12">
                      <span class="font-medium">{finding.host}</span>
                      <a class="block text-13 underline" href={`/monitor?finding=${encodeURIComponent(finding.host)}`}>
                        Details
                      </a>
                      <span class="block text-13 text-muted">{outcomeWords(finding.outcome)}</span>
                      {finding.case_id && (
                        <a class="text-13 underline" href={`/cases/${finding.case_id}`}>
                          See the evidence
                        </a>
                      )}
                      {(props.evidence?.[finding.host]?.length ?? 0) > 0 && (
                        <details class="mt-4">
                          <summary class="cursor-pointer text-13">Evidence for this finding</summary>
                          <ul class="mt-4 list-disc pl-16 text-13">
                            {(props.evidence?.[finding.host] ?? []).map((line) => (
                              <li>{line}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      {finding.alert_state === "failed" && (
                        <span class="block text-13 text-alert">
                          The alert mail could not be sent. It will be tried again on the next run.
                        </span>
                      )}
                      {finding.alert_state === "uncertain" && (
                        <span class="block text-13 text-alert">The alert mail may not have been sent.</span>
                      )}
                      {finding.alert_state === "refused" && (
                        <span class="block text-13 text-alert">The alert mail was refused and will not be resent.</span>
                      )}
                    </td>
                    <td class="py-12 pr-12">
                      <Pill variant={STATUS[finding.status].pill}>{STATUS[finding.status].label}</Pill>
                    </td>
                    <td class="py-12 pr-12">{sastDay(finding.first_seen)}</td>
                    <td class="py-12">
                      <div class="flex flex-wrap gap-8">
                        <a
                          class="underline"
                          href={`/monitor/pack/${encodeURIComponent(finding.host)}?format=md`}
                          download
                        >
                          Takedown pack (Markdown)
                        </a>
                        <a
                          class="underline"
                          href={`/monitor/pack/${encodeURIComponent(finding.host)}?format=pdf`}
                          download
                        >
                          Takedown pack (PDF)
                        </a>
                      </div>
                      {finding.status !== "dismissed" ? (
                        <details class="mt-8">
                          <summary class="cursor-pointer text-13 underline">Dismiss</summary>
                          <form
                            method="post"
                            action="/monitor/dismiss"
                            data-busy
                            class="mt-8 flex flex-wrap items-end gap-8"
                          >
                            <input type="hidden" name="host" value={finding.host} />
                            <label class="text-13">
                              Reason
                              <input
                                class="ml-8 rounded-small border border-line px-8 py-4"
                                name="reason"
                                required
                                maxlength={500}
                                placeholder="Why is this not a fake?"
                              />
                            </label>
                            <Button type="submit" variant="ghost" size="small" data-busy-label="Dismissing...">
                              Confirm dismiss
                            </Button>
                          </form>
                          <p class="mt-4 text-13 text-muted">Cancel: close this panel with the Dismiss heading.</p>
                        </details>
                      ) : (
                        <form method="post" action="/monitor/restore" class="mt-8">
                          <input type="hidden" name="host" value={finding.host} />
                          <Button type="submit" variant="ghost" size="small">
                            Restore
                          </Button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {props.dismissError && (
            <p class="mt-12 text-14 text-alert" role="alert">
              {props.dismissError}
            </p>
          )}
          <p class="mt-24 text-13 text-muted">
            We never contact a registrar or host for you. Download the takedown pack and send it to the abuse contacts
            it names, with its screenshot attached.
          </p>
        </main>
      </AppShell>
    </Document>
  );
}
