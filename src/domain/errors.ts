/**
 * Stops the whole run before or between file operations. `userMessage` is shown as-is in a
 * notice, so it must never contain secrets.
 */
export class SyncAbortError extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "SyncAbortError";
  }
}

export class MissingCredentialsError extends SyncAbortError {
  constructor() {
    super("Add your client ID, client secret and refresh token in settings.");
    this.name = "MissingCredentialsError";
  }
}

export class AuthError extends SyncAbortError {
  constructor(
    userMessage = "Refresh token is invalid or revoked. Create a new one and update settings.",
  ) {
    super(userMessage);
    this.name = "AuthError";
  }
}
