import { v } from "convex/values";
import { query } from "./_generated/server";

const ADMIN_EMAILS = ["13632013@vk.com", "786709647@vk.com"];

async function assertAdmin(ctx: any, sessionToken: string) {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_token", (q: any) => q.eq("token", sessionToken))
    .first();
  if (!session || session.expiresAt < Date.now()) {
    throw new Error("Unauthorized: invalid session");
  }
  const user = await ctx.db.get(session.userId);
  if (!user) throw new Error("Forbidden: admin access required");
  if (user.isAdmin !== true && !ADMIN_EMAILS.includes(user.email)) {
    throw new Error("Forbidden: admin access required");
  }
  return user;
}

export const getMetrics = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await assertAdmin(ctx, args.sessionToken);

    const users = await ctx.db.query("users").collect();
    const payments = await ctx.db.query("payments").collect();
    const completedPayments = payments.filter((p) => p.status === "completed");

    const now = Date.now();
    // Start of today in UTC+3 (Minsk/Moscow)
    const nowDate = new Date(now);
    const utc3Now = new Date(nowDate.getTime() + 3 * 60 * 60 * 1000);
    const startOfTodayUTC3 = new Date(
      Date.UTC(utc3Now.getUTCFullYear(), utc3Now.getUTCMonth(), utc3Now.getUTCDate())
    );
    const todayStart = startOfTodayUTC3.getTime() - 3 * 60 * 60 * 1000; // back to UTC
    const sevenDaysAgo = todayStart - 6 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = todayStart - 29 * 24 * 60 * 60 * 1000;

    // --- Registrations ---
    const registrationsToday = users.filter((u) => u.createdAt >= todayStart).length;
    // 7d/30d include today
    const registrations7d = users.filter((u) => u.createdAt >= sevenDaysAgo).length;
    const registrations30d = users.filter((u) => u.createdAt >= thirtyDaysAgo).length;

    // --- Payments today ---
    const paymentsToday = completedPayments.filter(
      (p) => (p.completedAt || p.createdAt) >= todayStart
    );
    const paymentsTodayCount = paymentsToday.length;
    const paymentsTodaySum = paymentsToday.reduce((s, p) => s + p.amount, 0);

    // --- Active paid users ---
    const activePaid = users.filter(
      (u) =>
        u.subscriptionTier &&
        u.subscriptionTier !== "freemium" &&
        u.subscriptionExpiresAt &&
        u.subscriptionExpiresAt > now
    );
    const activeStart = activePaid.filter((u) => u.subscriptionTier === "start").length;
    const activePro = activePaid.filter((u) => u.subscriptionTier === "pro").length;

    // --- MRR = sum of completed payments in last 30 days (actual revenue) ---
    const payments30d = completedPayments.filter(
      (p) => (p.completedAt || p.createdAt) >= thirtyDaysAgo
    );
    const mrr = payments30d.reduce((s, p) => s + p.amount, 0);

    // --- Churn (last 30 days: expired and not renewed) ---
    const expiredRecently = users.filter(
      (u) =>
        u.subscriptionExpiresAt &&
        u.subscriptionExpiresAt < now &&
        u.subscriptionExpiresAt >= thirtyDaysAgo &&
        u.subscriptionTier !== "freemium"
    );
    // Check if any of them renewed (has a payment after expiry)
    const churnedUsers = expiredRecently.filter((u) => {
      const renewalPayment = completedPayments.find(
        (p) =>
          p.userId === u._id &&
          (p.completedAt || p.createdAt) > (u.subscriptionExpiresAt || 0)
      );
      return !renewalPayment;
    });
    const totalPaidLastMonth = users.filter(
      (u) =>
        u.subscriptionTier &&
        u.subscriptionTier !== "freemium" &&
        u.subscriptionExpiresAt &&
        u.subscriptionExpiresAt >= thirtyDaysAgo
    ).length;
    const churnRate = totalPaidLastMonth > 0
      ? Math.round((churnedUsers.length / totalPaidLastMonth) * 100)
      : 0;

    // --- Conversion: Free → Paid ---
    const totalWithPayment = new Set(completedPayments.map((p) => p.userId as string)).size;
    const conversionRate = users.length > 0
      ? Math.round((totalWithPayment / users.length) * 100)
      : 0;

    // --- Time to Convert (median days from registration to first payment) ---
    const userFirstPayment = new Map<string, number>();
    for (const p of completedPayments) {
      const uid = p.userId as string;
      const pTime = p.completedAt || p.createdAt;
      const existing = userFirstPayment.get(uid);
      if (!existing || pTime < existing) {
        userFirstPayment.set(uid, pTime);
      }
    }
    const conversionDays: number[] = [];
    for (const [uid, firstPaymentAt] of userFirstPayment) {
      const user = users.find((u) => (u._id as string) === uid);
      if (user) {
        const days = Math.round((firstPaymentAt - user.createdAt) / (24 * 60 * 60 * 1000));
        if (days >= 0) conversionDays.push(days);
      }
    }
    conversionDays.sort((a, b) => a - b);
    const medianConversionDays = conversionDays.length > 0
      ? conversionDays[Math.floor(conversionDays.length / 2)]
      : null;

    // --- LTV (average total paid per paying user, no subscription gaps) ---
    const payingUsers = [...userFirstPayment.keys()];
    const ltvValues: number[] = [];
    for (const uid of payingUsers) {
      const userPayments = completedPayments
        .filter((p) => (p.userId as string) === uid)
        .sort((a, b) => (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt));
      const total = userPayments.reduce((s, p) => s + p.amount, 0);
      ltvValues.push(total);
    }
    const avgLtv = ltvValues.length > 0
      ? Math.round((ltvValues.reduce((s, v) => s + v, 0) / ltvValues.length) * 100) / 100
      : 0;

    // --- ARPU ---
    const arpu = activePaid.length > 0 ? Math.round(mrr / activePaid.length * 100) / 100 : 0;

    // --- Recent registrations list (last 7 days) for table ---
    const recentUsers = users
      .filter((u) => u.createdAt >= sevenDaysAgo)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((u) => ({
        name: u.name || u.email,
        tier: u.subscriptionTier || "freemium",
        createdAt: u.createdAt,
      }));

    // --- Recent payments list (last 7 days) ---
    const recentPayments = completedPayments
      .filter((p) => (p.completedAt || p.createdAt) >= sevenDaysAgo)
      .sort((a, b) => (b.completedAt || b.createdAt) - (a.completedAt || a.createdAt))
      .slice(0, 20)
      .map((p) => {
        const user = users.find((u) => u._id === p.userId);
        return {
          userName: user?.name || user?.email || "—",
          tier: p.tier,
          amount: p.amount,
          currency: p.currency,
          completedAt: p.completedAt || p.createdAt,
        };
      });

    // --- Funnel: first payment tier distribution ---
    // For each paying user, find what tier their FIRST payment was
    const userFirstPaymentTier = new Map<string, string>();
    for (const p of completedPayments.sort((a, b) => (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt))) {
      const uid = p.userId as string;
      if (!userFirstPaymentTier.has(uid)) {
        userFirstPaymentTier.set(uid, p.tier);
      }
    }
    const firstPaymentStart = [...userFirstPaymentTier.values()].filter((t) => t === "start").length;
    const firstPaymentPro = [...userFirstPaymentTier.values()].filter((t) => t === "pro").length;
    const totalFirstPayments = userFirstPaymentTier.size;

    // --- Funnel: Start → Pro upgrades ---
    // Users who had a "start" payment and later a "pro" payment
    const usersWithStart = new Set<string>();
    const usersUpgradedToPro: { userId: string; startDate: number; proDate: number }[] = [];

    const sortedPayments = completedPayments.sort(
      (a, b) => (a.completedAt || a.createdAt) - (b.completedAt || b.createdAt)
    );

    for (const p of sortedPayments) {
      const uid = p.userId as string;
      if (p.tier === "start") {
        usersWithStart.add(uid);
      } else if (p.tier === "pro" && usersWithStart.has(uid)) {
        // Check if not already counted
        if (!usersUpgradedToPro.find((u) => u.userId === uid)) {
          // Find their first start payment date
          const firstStart = sortedPayments.find(
            (sp) => (sp.userId as string) === uid && sp.tier === "start"
          );
          if (firstStart) {
            usersUpgradedToPro.push({
              userId: uid,
              startDate: firstStart.completedAt || firstStart.createdAt,
              proDate: p.completedAt || p.createdAt,
            });
          }
        }
      }
    }

    const upgradeCount = usersUpgradedToPro.length;
    const upgradeDays = usersUpgradedToPro
      .map((u) => Math.round((u.proDate - u.startDate) / (24 * 60 * 60 * 1000)))
      .sort((a, b) => a - b);
    const medianUpgradeDays = upgradeDays.length > 0
      ? upgradeDays[Math.floor(upgradeDays.length / 2)]
      : null;

    // Percentage of Start users who upgraded to Pro
    const totalEverStart = usersWithStart.size;
    const upgradeRate = totalEverStart > 0
      ? Math.round((upgradeCount / totalEverStart) * 100)
      : 0;

    return {
      registrationsToday,
      registrations7d,
      registrations30d,
      paymentsTodayCount,
      paymentsTodaySum,
      mrr: Math.round(mrr * 100) / 100,
      activeStart,
      activePro,
      churnRate,
      churnedCount: churnedUsers.length,
      conversionRate,
      medianConversionDays,
      avgLtv,
      arpu,
      recentUsers,
      recentPayments,
      // Funnel metrics
      firstPaymentStart,
      firstPaymentPro,
      totalFirstPayments,
      upgradeCount,
      upgradeRate,
      medianUpgradeDays,
      totalEverStart,
    };
  },
});
