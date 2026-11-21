import { describe, expect, it } from "vitest";
import { DriveHttpError, classifyDriveError } from "../../src/adapters/google/drive-errors";
import { quote } from "../../src/adapters/google/drive-query";
import { NetworkError } from "../../src/ports/http-transport";

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: new TextEncoder().encode(JSON.stringify(body)).buffer,
});

describe("classifyDriveError (DESIGN §6.4)", () => {
  it.each([
    [new NetworkError(), true],
    [new DriveHttpError(429, ""), true],
    [new DriveHttpError(500, "backendError"), true],
    [new DriveHttpError(503, ""), true],
    [new DriveHttpError(403, "rateLimitExceeded"), true],
    [new DriveHttpError(403, "userRateLimitExceeded"), true],
    [new DriveHttpError(403, "insufficientPermissions"), false],
    [new DriveHttpError(400, "badRequest"), false],
    [new DriveHttpError(404, "notFound"), false],
    [new Error("other"), false],
  ])("%s → retry %s", (error, retry) => {
    expect(classifyDriveError(error).retry).toBe(retry);
  });

  it("parses Drive and OAuth error bodies and Retry-After", () => {
    const drive = DriveHttpError.fromResponse(
      response(
        403,
        { error: { errors: [{ reason: "rateLimitExceeded" }] } },
        { "retry-after": "2" },
      ),
    );
    expect(drive.reason).toBe("rateLimitExceeded");
    expect(drive.retryAfterMs).toBe(2000);
    expect(DriveHttpError.fromResponse(response(400, { error: "invalid_grant" })).reason).toBe(
      "invalid_grant",
    );
  });

  it("keeps messages free of response bodies", () => {
    const error = DriveHttpError.fromResponse(response(500, { secret: "do-not-log" }));
    expect(error.message).toBe("HTTP 500");
  });
});

describe("quote", () => {
  it("escapes backslashes and single quotes", () => {
    expect(quote("it's a\\b")).toBe("'it\\'s a\\\\b'");
  });
});
