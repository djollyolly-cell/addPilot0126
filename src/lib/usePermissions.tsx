import { useAuth } from "./useAuth";

export function usePermissions() {
  const { user } = useAuth();

  const hasPermission = (perm: string): boolean => {
    if (!user) return false;
    if (!user.organizationId) return true; // individual fallback
    if (user.organizationRole === "owner") return true;
    return (user.permissions ?? []).includes(perm);
  };

  const isOwner = (): boolean => user?.organizationRole === "owner";
  const isManager = (): boolean => user?.organizationRole === "manager";
  const isInOrganization = (): boolean => !!user?.organizationId;

  const canAddAccount = (): boolean => hasPermission("add_accounts");
  const canInviteMembers = (): boolean => hasPermission("invite_members");
  const canManageRules = (): boolean => hasPermission("rules");
  const canControlAds = (): boolean => hasPermission("ads_control");
  const canViewReports = (): boolean => hasPermission("reports");
  const canManageBudgets = (): boolean => hasPermission("budgets");

  return {
    hasPermission, isOwner, isManager, isInOrganization,
    canAddAccount, canInviteMembers, canManageRules,
    canControlAds, canViewReports, canManageBudgets,
  };
}
