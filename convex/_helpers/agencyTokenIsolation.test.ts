import { describe, expect, it } from "vitest";
import {
  isOwnOAuthBroadcastAccount,
  resolveTokenIsolationStrategy,
  shouldAutofillUserCredentials,
} from "./agencyTokenIsolation";

describe("shouldAutofillUserCredentials", () => {
  it("allows user credential autofill by default", () => {
    expect(shouldAutofillUserCredentials()).toBe(true);
    expect(shouldAutofillUserCredentials(false)).toBe(true);
  });

  it("blocks user credential autofill when agency flow opts out", () => {
    expect(shouldAutofillUserCredentials(true)).toBe(false);
  });
});

describe("isOwnOAuthBroadcastAccount", () => {
  it("allows ordinary own VK Ads accounts", () => {
    expect(isOwnOAuthBroadcastAccount({ vkAccountId: "mt_2719151" })).toBe(true);
  });

  it("blocks agency client OAuth accounts", () => {
    expect(isOwnOAuthBroadcastAccount({ vkAccountId: "mt_client_2719151" })).toBe(false);
  });

  it("blocks provider-linked accounts even when vkAccountId looks like own OAuth", () => {
    expect(
      isOwnOAuthBroadcastAccount({
        vkAccountId: "mt_2719151",
        agencyProviderId: "provider",
      })
    ).toBe(false);
  });

  it("blocks Vitamin accounts even when vkAccountId looks like own OAuth", () => {
    expect(
      isOwnOAuthBroadcastAccount({
        vkAccountId: "mt_2719151",
        vitaminCabinetId: "154223",
      })
    ).toBe(false);
  });

  it("blocks agency cabinet accounts even when vkAccountId looks like own OAuth", () => {
    expect(
      isOwnOAuthBroadcastAccount({
        vkAccountId: "mt_2719151",
        agencyCabinetId: "agency-cabinet",
      })
    ).toBe(false);
  });

  it("blocks manual/provider slug accounts", () => {
    expect(isOwnOAuthBroadcastAccount({ vkAccountId: "agency_liyJv7bUgVbGKezW" })).toBe(false);
  });

  it("blocks accounts without a VK Ads account id", () => {
    expect(isOwnOAuthBroadcastAccount({})).toBe(false);
  });
});

describe("resolveTokenIsolationStrategy", () => {
  it("classifies ordinary own OAuth accounts", () => {
    expect(resolveTokenIsolationStrategy({ vkAccountId: "mt_2719151" })).toBe("own_oauth");
  });

  it("classifies agency client OAuth accounts", () => {
    expect(resolveTokenIsolationStrategy({ vkAccountId: "mt_client_2719151" })).toBe(
      "agency_client_oauth"
    );
  });

  it("classifies API-backed provider accounts", () => {
    expect(
      resolveTokenIsolationStrategy({
        vkAccountId: "agency_vitamin",
        agencyProviderId: "provider",
        agencyCabinetId: "154223",
        providerHasApi: true,
      })
    ).toBe("provider_api");
  });

  it("classifies Vitamin accounts as API-backed even when provider metadata is missing", () => {
    expect(
      resolveTokenIsolationStrategy({
        vkAccountId: "agency_vitamin",
        vitaminCabinetId: "154223",
      })
    ).toBe("provider_api");
  });

  it("classifies non-API provider accounts as static provider tokens", () => {
    expect(
      resolveTokenIsolationStrategy({
        vkAccountId: "agency_targethunter",
        agencyProviderId: "provider",
        agencyCabinetId: "cabinet",
        providerHasApi: false,
      })
    ).toBe("provider_static");
  });

  it("classifies agency slug accounts without provider linkage as manual API keys", () => {
    expect(resolveTokenIsolationStrategy({ vkAccountId: "agency_manual" })).toBe("manual_api_key");
  });

  it("keeps provider linkage higher priority than vkAccountId shape", () => {
    expect(
      resolveTokenIsolationStrategy({
        vkAccountId: "mt_2719151",
        agencyProviderId: "provider",
        providerHasApi: false,
      })
    ).toBe("provider_static");
  });

  it("classifies unknown shapes as unknown", () => {
    expect(resolveTokenIsolationStrategy({ vkAccountId: "vkads_2719151" })).toBe("unknown");
  });
});
