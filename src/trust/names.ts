// How a business name is compared (D05 T01): Unicode NFKC, case folded, punctuation removed, white space collapsed, so
// "Hadeda Couriers (Pty) Ltd" and "hadeda  couriers pty ltd" are one name. Free of Worker bindings, so the console's
// view can use it where the identity store cannot be loaded.
export const normaliseName = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
