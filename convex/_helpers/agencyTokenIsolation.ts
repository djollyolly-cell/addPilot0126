type AccountForBroadcast = {
  vkAccountId?: string;
  agencyProviderId?: unknown;
  vitaminCabinetId?: unknown;
  agencyCabinetId?: unknown;
  providerHasApi?: boolean;
};

// Local incident guard for token isolation. The agency integration prep branch
// has a broader tokenStrategy helper; reconcile these before merging that track.
export type TokenIsolationStrategy =
  | "own_oauth"
  | "agency_client_oauth"
  | "provider_api"
  | "provider_static"
  | "manual_api_key"
  | "unknown";

export function shouldAutofillUserCredentials(skipUserCredentialAutofill?: boolean) {
  return skipUserCredentialAutofill !== true;
}

export function isOwnOAuthBroadcastAccount(account: AccountForBroadcast) {
  const vkAccountId = account.vkAccountId ?? "";
  return (
    vkAccountId.startsWith("mt_") &&
    !vkAccountId.startsWith("mt_client_") &&
    !account.agencyProviderId &&
    !account.vitaminCabinetId &&
    !account.agencyCabinetId
  );
}

export function resolveTokenIsolationStrategy(account: AccountForBroadcast): TokenIsolationStrategy {
  const vkAccountId = account.vkAccountId ?? "";
  const hasProviderLink = Boolean(
    account.agencyProviderId || account.vitaminCabinetId || account.agencyCabinetId
  );

  if (hasProviderLink) {
    return account.providerHasApi || account.vitaminCabinetId ? "provider_api" : "provider_static";
  }

  if (vkAccountId.startsWith("mt_client_")) {
    return "agency_client_oauth";
  }

  if (vkAccountId.startsWith("agency_")) {
    return "manual_api_key";
  }

  if (isOwnOAuthBroadcastAccount(account)) {
    return "own_oauth";
  }

  return "unknown";
}
