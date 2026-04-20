import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";

export function useOrganization() {
  const { user } = useAuth();
  const org = useQuery(
    api.organizations.getCurrent,
    user?.userId ? { userId: user.userId as Id<"users"> } : "skip"
  );
  return org;
}
