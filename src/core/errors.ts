/** An expected failure with a message meant for the user (no stack trace). */
export class MirrorError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "MirrorError";
  }
}
