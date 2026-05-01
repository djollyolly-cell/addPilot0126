import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural regression guard for the recursion-fix design (2026-05-01).
 *
 * Contract: in `getValidTokenForAccount`, `tokenExpiresAt === 0` is the
 * "invalidated by TOKEN_EXPIRED" marker set by `handleTokenExpired`.
 * It MUST NOT take the liveness/permanent branch — it MUST fall through
 * to the refresh / provider cascade (agency_client_credentials, GetUNIQ,
 * Click.ru, ZaleyCash, Vitamin).
 *
 * If a future contributor reintroduces `=== 0` into the
 * `undefined || null` predicate, this test fires.
 *
 * See: docs/superpowers/specs/2026-05-01-token-recovery-recursion-fix-design.md
 */

const AUTH_PATH = resolve(__dirname, "../../convex/auth.ts");

function getValidTokenForAccountBody(): string {
  const src = readFileSync(AUTH_PATH, "utf8");
  const startMarker = "export const getValidTokenForAccount = internalAction";
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("getValidTokenForAccount not found");
  // Find next top-level export const at column 0 after the start
  const after = src.slice(start + startMarker.length);
  const nextMatch = after.match(/\nexport const [A-Za-z]/);
  const end = nextMatch ? start + startMarker.length + (nextMatch.index ?? after.length) : src.length;
  return src.slice(start, end);
}

describe("getValidTokenForAccount: tokenExpiresAt=0 fall-through guard", () => {
  const body = getValidTokenForAccountBody();

  it("contains a liveness predicate that excludes tokenExpiresAt === 0", () => {
    // Find every `if (account.tokenExpiresAt === ...)` predicate and ensure
    // none of them combine `=== 0` with the undefined/null check (that would
    // re-route the invalidated marker into liveness instead of the cascade).
    const livenessPredicateRe =
      /if\s*\(\s*account\.tokenExpiresAt\s*===\s*undefined[^)]*\)/g;
    const matches = body.match(livenessPredicateRe);
    expect(matches, "expected at least one liveness predicate").toBeTruthy();
    for (const m of matches!) {
      expect(
        m,
        `liveness predicate must NOT include "=== 0" (would route invalidated marker into liveness branch): ${m}`
      ).not.toMatch(/===\s*0/);
    }
  });

  it("documents tokenExpiresAt=0 as the invalidated marker that falls through", () => {
    // The fall-through is enforced by the predicate above; this is a docstring
    // contract so future readers understand WHY `=== 0` is intentionally absent.
    const hasMarkerComment =
      /tokenExpiresAt\s*=\s*0[^]*invalidat|invalidat[^]*tokenExpiresAt\s*=\s*0/i.test(
        body
      ) ||
      /tokenExpiresAt=0[^]*invalidat|invalidat[^]*tokenExpiresAt=0/i.test(body);
    expect(
      hasMarkerComment,
      "expected a comment explaining tokenExpiresAt=0 is the invalidated marker"
    ).toBe(true);

    const hasFallThroughComment =
      /falls?\s+through|fall-?through/i.test(body);
    expect(
      hasFallThroughComment,
      "expected a comment indicating fall-through to refresh/provider cascade"
    ).toBe(true);
  });

  it("contains no recursive recovery calls (tryRecoverToken / handleTokenExpired)", () => {
    // The MUST NOT rule from the spec: getValidTokenForAccount must not
    // call back into tokenRecovery.tryRecoverToken or .handleTokenExpired,
    // because that creates the recursive backedge.
    // We strip line and block comments before checking, so doc references
    // to those names do not produce false positives.
    const codeOnly = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(codeOnly).not.toMatch(/tokenRecovery\.tryRecoverToken/);
    expect(codeOnly).not.toMatch(/tokenRecovery\.handleTokenExpired/);
  });
});
