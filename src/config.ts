// A setting the Worker needs is missing or unusable (a secret absent or too short). Thrown at the point of use and never
// turned into a user-facing refusal: it is the operator's to fix (docs/operations.md), not the caller's.
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
