// Who brought a case in, one answer for the Cases list and the report header (D07 T03 §42, the rules of D07 T04 §7): a
// current member of the case's organisation, named (an upload's by email when the name is blank); an upload whose
// uploader is no current member, a former member; else nothing recorded. Its own module, free of the Worker's types,
// so the report header (rendered in Node tests too) can name it without importing the database code.
export type Checker = { kind: "member"; name: string } | { kind: "former" } | null;
