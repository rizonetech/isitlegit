// The URL an evidence card links a file by (D07 T03 §3): `/a/<caseId>/<key>`, the key one percent-encoded segment, with
// a link holder's report-link signature parameters carried as they were given (the artefact route, src/web/pages/
// artefacts.tsx, verifies them). Kept apart from the route so the report view can be drawn without storage.
export function artefactUrl(caseId: string, key: string, link?: string): string {
  return `/a/${caseId}/${encodeURIComponent(key)}${link ?? ""}`;
}
