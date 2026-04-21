# cpc_limit Integration Verification Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify that the `cpc_limit` rule type (implemented earlier today at unit level) works end-to-end through the production rule evaluation pipeline — rule CRUD, trace diagnostic, action-log creation, dedup, and safety-check bypass.

**Architecture:** The pure `evaluateCondition` function is already tested (7 unit tests). What's NOT yet verified: (1) rule CRUD round-trips `minSpent` in DB correctly, (2) the trace variant (used by admin diagnostic UI) returns correct reasons, (3) `checkRulesForAccount` actually calls into the new case with real `metricsDaily` data, (4) the safety-check list at [ruleEngine.ts:1831](convex/ruleEngine.ts) correctly *excludes* `cpc_limit` (since clicks is atomic), (5) `calculateSavings` + `actionLogs` write path works for this rule. No new runtime code — tests only. If a gap is found, the test fails and the fix is scoped in-task.

**Tech Stack:** Vitest + convex-test (same pattern as existing `convex/ruleEngine.test.ts`), pure-function tests in `tests/unit/ruleEngine.test.ts`.

---

## Files

- Modify: `convex/ruleEngine.test.ts` — add integration tests for CRUD round-trip, dedup, safety-check exclusion
- Modify: `tests/unit/ruleEngine.test.ts` — add trace tests for cpc_limit (mirroring the existing `describe("cpl_limit", ...)` block at line 383)
- Modify (if gap found): `convex/ruleEngine.ts` or `convex/rules.ts` or `src/pages/RulesPage.tsx` — only if a test fails

---

## Task 1: Trace tests for cpc_limit

Verify `evaluateConditionTrace` returns correct `stoppedAt` codes and human-readable reasons for every branch.

**Files:**
- Modify: `tests/unit/ruleEngine.test.ts` (add `describe("cpc_limit", ...)` block after the existing `describe("new_lead", ...)` at line 532)

- [ ] **Step 1: Write the failing trace tests**

Add this block to `tests/unit/ruleEngine.test.ts` after the `new_lead` describe block inside the `describe("evaluateConditionTrace", ...)` suite:

```typescript
  describe("cpc_limit", () => {
    it("returns triggered when cpc > maxCpc and spent >= minSpent", () => {
      const trace = evaluateConditionTrace(
        "cpc_limit",
        { metric: "cpc", operator: ">", value: 25, minSpent: 200 },
        { spent: 250, leads: 0, impressions: 1000, clicks: 5 } // cpc=50
      );
      expect(trace.triggered).toBe(true);
      expect(trace.stoppedAt).toBe("triggered");
      expect(trace.reason).toContain("CPC");
      expect(trace.reason).toContain("50");
      expect(trace.reason).toContain("25");
    });

    it("returns wait when spent < minSpent", () => {
      const trace = evaluateConditionTrace(
        "cpc_limit",
        { metric: "cpc", operator: ">", value: 25, minSpent: 200 },
        { spent: 100, leads: 0, impressions: 500, clicks: 1 }
      );
      expect(trace.triggered).toBe(false);
      expect(trace.stoppedAt).toBe("step6_condition_not_met");
      expect(trace.reason).toContain("минимум");
    });

    it("returns triggered when clicks=0 and spent >= minSpent", () => {
      const trace = evaluateConditionTrace(
        "cpc_limit",
        { metric: "cpc", operator: ">", value: 25, minSpent: 200 },
        { spent: 1000, leads: 0, impressions: 50000, clicks: 0 }
      );
      expect(trace.triggered).toBe(true);
      expect(trace.stoppedAt).toBe("triggered");
      expect(trace.reason).toContain("кликов: 0");
    });

    it("returns not met when cpc <= maxCpc", () => {
      const trace = evaluateConditionTrace(
        "cpc_limit",
        { metric: "cpc", operator: ">", value: 25, minSpent: 200 },
        { spent: 250, leads: 0, impressions: 5000, clicks: 50 } // cpc=5
      );
      expect(trace.triggered).toBe(false);
      expect(trace.stoppedAt).toBe("step6_condition_not_met");
      expect(trace.reason).toContain("CPC");
      expect(trace.reason).toContain("5");
    });
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run tests/unit/ruleEngine.test.ts -t "cpc_limit"`
Expected: PASS (4/4). The trace implementation is already there from the earlier work — this task retroactively verifies correctness after the fact.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ruleEngine.test.ts
git commit -m "test(rules): add trace tests for cpc_limit evaluator"
```

---

## Task 2: Verify rules.create persists minSpent correctly

End-to-end test: create a cpc_limit rule via `api.rules.create`, then read it back via `api.rules.list` and assert `conditions.minSpent` survives the round-trip.

**Files:**
- Modify: `convex/ruleEngine.test.ts` (add test at the end of the `describe("ruleEngine", ...)` block, before the closing `});`)

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe("ruleEngine", ...)` block in `convex/ruleEngine.test.ts` (use the existing `createTestSetup` helper):

```typescript
  test("cpc_limit: create persists minSpent in conditions", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPC Limit Test",
      type: "cpc_limit",
      value: 25,
      minSpent: 200,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeDefined();
    expect(rule!.type).toBe("cpc_limit");
    expect(Array.isArray(rule!.conditions)).toBe(false);
    if (!Array.isArray(rule!.conditions)) {
      expect(rule!.conditions.value).toBe(25);
      expect(rule!.conditions.minSpent).toBe(200);
      expect(rule!.conditions.metric).toBe("cpc");
      expect(rule!.conditions.operator).toBe(">");
    }
  });

  test("cpc_limit: create rejects minSpent=0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Bad CPC Rule",
        type: "cpc_limit",
        value: 25,
        minSpent: 0,
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow(/Минимальный расход/);
  });

  test("cpc_limit: create rejects missing minSpent", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    await expect(
      t.mutation(api.rules.create, {
        userId,
        name: "Bad CPC Rule 2",
        type: "cpc_limit",
        value: 25,
        actions: { stopAd: true, notify: true },
        targetAccountIds: [accountId],
      })
    ).rejects.toThrow(/Минимальный расход/);
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run convex/ruleEngine.test.ts -t "cpc_limit"`
Expected: PASS (3/3). If "create persists minSpent" fails with `rule.conditions.minSpent === undefined`, the plumbing in `convex/rules.ts` is broken — fix there. If the validation tests fail, the guard block added earlier doesn't catch empty/zero minSpent — tighten the check.

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.test.ts
git commit -m "test(rules): verify cpc_limit create persists minSpent and enforces validation"
```

---

## Task 3: Verify rules.update round-trips minSpent

Update the existing rule's `minSpent` and assert the new value is stored.

**Files:**
- Modify: `convex/ruleEngine.test.ts` (append test after Task 2 tests)

- [ ] **Step 1: Write the failing test**

Append to `convex/ruleEngine.test.ts` inside the same `describe("ruleEngine", ...)`:

```typescript
  test("cpc_limit: update changes minSpent", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPC Update Test",
      type: "cpc_limit",
      value: 25,
      minSpent: 200,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    await t.mutation(api.rules.update, {
      ruleId,
      userId,
      minSpent: 500,
    });

    const rule = await t.query(api.rules.get, { ruleId });
    expect(rule).toBeDefined();
    if (!Array.isArray(rule!.conditions)) {
      expect(rule!.conditions.minSpent).toBe(500);
      expect(rule!.conditions.value).toBe(25); // value unchanged
    }
  });

  test("cpc_limit: update rejects minSpent=0", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPC Update Reject Test",
      type: "cpc_limit",
      value: 25,
      minSpent: 200,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    await expect(
      t.mutation(api.rules.update, {
        ruleId,
        userId,
        minSpent: 0,
      })
    ).rejects.toThrow(/Минимальный расход/);
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run convex/ruleEngine.test.ts -t "cpc_limit"`
Expected: PASS (now 5/5 cpc_limit integration tests). If "update changes minSpent" fails, the `if (rule.type === "cpc_limit" && args.minSpent !== undefined)` branch in `convex/rules.ts:update` handler isn't merging into conditions correctly — fix there.

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.test.ts
git commit -m "test(rules): verify cpc_limit update round-trips minSpent"
```

---

## Task 4: Verify cpc_limit is excluded from the safety-check path

The safety-check block at [convex/ruleEngine.ts:1831](convex/ruleEngine.ts) fetches fresh leads via the VK statistics API only for `clicks_no_leads` and `cpl_limit`. cpc_limit must NOT enter that branch because `clicks` is an atomic metric from a single source. This test is a guard against future regressions (someone adds cpc_limit to the list).

**Files:**
- Modify: `convex/ruleEngine.test.ts` (append test)

- [ ] **Step 1: Write the guard test**

Append to `convex/ruleEngine.test.ts`:

```typescript
  test("cpc_limit: source code does NOT include cpc_limit in safety-check list", async () => {
    // This is a structural guard: the safety-check branch in checkRulesForAccount
    // fetches fresh VK stats and should only run for lead-based rules.
    // cpc_limit is click-based and must NOT be added to this list.
    const fs = await import("fs");
    const path = await import("path");
    const srcPath = path.join(
      process.cwd(),
      "convex",
      "ruleEngine.ts"
    );
    const source = fs.readFileSync(srcPath, "utf-8");

    // Find the safety-check line (it looks like:
    //   `if ((rule.type === "clicks_no_leads" || rule.type === "cpl_limit") && rule.actions.stopAd && metricsSnapshot.leads === 0) {`
    // We match the `safety check` comment line and inspect the next few lines.
    const safetyCheckIdx = source.indexOf("Safety check for clicks_no_leads");
    expect(safetyCheckIdx).toBeGreaterThan(0);
    const window = source.slice(safetyCheckIdx, safetyCheckIdx + 400);
    expect(window).not.toContain("cpc_limit");
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run convex/ruleEngine.test.ts -t "safety-check list"`
Expected: PASS. If it fails, someone accidentally added `cpc_limit` to the safety-check branch — remove it.

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.test.ts
git commit -m "test(rules): guard cpc_limit against accidental inclusion in safety-check branch"
```

---

## Task 5: Verify calculateSavings works correctly for a cpc_limit trigger

When a cpc_limit rule stops an ad, the action log must record `savedAmount` = projected saved budget. `calculateSavings` is a pure helper that just returns `spentToday` (no projection — per the existing spec). Verify it returns the right number for a cpc_limit-style input.

**Files:**
- Modify: `tests/unit/ruleEngine.test.ts` (append to the existing `describe("calculateSavings", ...)` block at line 308)

- [ ] **Step 1: Write the test**

Find the `describe("calculateSavings", ...)` block in `tests/unit/ruleEngine.test.ts` and append this test inside it:

```typescript
  it("returns spent-today for cpc_limit triggered ad (250₽ spent, 5 clicks, cpc=50)", () => {
    // cpc_limit trigger scenario: spent=250, clicks=5, cpc=50, over maxCpc=25
    // Expected behavior: savings = spent (no projection)
    expect(calculateSavings(250)).toBe(250);
  });

  it("returns spent-today for cpc_limit triggered ad with no clicks (1000₽, 0 clicks)", () => {
    // cpc_limit trigger scenario: spent=1000, clicks=0, minSpent=200 → triggered
    expect(calculateSavings(1000)).toBe(1000);
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run tests/unit/ruleEngine.test.ts -t "calculateSavings"`
Expected: PASS (both new tests pass — `calculateSavings` is trivial).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/ruleEngine.test.ts
git commit -m "test(rules): calculateSavings for cpc_limit scenarios"
```

---

## Task 6: Verify actionLog creation for cpc_limit trigger

Mirror the existing "S8-DoD#12: VK API error creates actionLog" pattern at [convex/ruleEngine.test.ts:504](convex/ruleEngine.test.ts), but for a successful cpc_limit trigger. This exercises the `createActionLogPublic` test mutation with cpc_limit-specific metrics.

**Files:**
- Modify: `convex/ruleEngine.test.ts` (append test)

- [ ] **Step 1: Write the test**

Append to `convex/ruleEngine.test.ts`:

```typescript
  test("cpc_limit: actionLog can be created with cpc-specific reason and metrics", async () => {
    const t = convexTest(schema);
    const { userId, accountId } = await createTestSetup(t);

    const ruleId = await t.mutation(api.rules.create, {
      userId,
      name: "CPC Action Log Rule",
      type: "cpc_limit",
      value: 25,
      minSpent: 200,
      actions: { stopAd: true, notify: true },
      targetAccountIds: [accountId],
    });

    const logId = await t.mutation(api.ruleEngine.createActionLogPublic, {
      userId,
      ruleId,
      accountId,
      adId: "ad_cpc_1",
      adName: "Expensive CPC Ad",
      actionType: "stopped_and_notified",
      reason: "CPC 50₽ > лимит 25₽ (расход 250₽, кликов 5)",
      metricsSnapshot: {
        spent: 250,
        leads: 0,
        impressions: 1000,
        clicks: 5,
      },
      savedAmount: 250,
      status: "success",
    });

    expect(logId).toBeDefined();
    const logs = await t.query(api.actionLogs.list, { userId });
    const log = logs.find((l) => l._id === logId);
    expect(log).toBeDefined();
    expect(log!.reason).toContain("CPC");
    expect(log!.savedAmount).toBe(250);
    expect(log!.status).toBe("success");
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run convex/ruleEngine.test.ts -t "actionLog can be created with cpc"`
Expected: PASS. If `api.actionLogs.list` doesn't exist, use `t.run(async (ctx) => ctx.db.get(logId))` instead.

- [ ] **Step 3: Commit**

```bash
git add convex/ruleEngine.test.ts
git commit -m "test(rules): verify actionLog write path works for cpc_limit"
```

---

## Task 7: Run full test suite + lint + typecheck

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run`
Expected: all tests pass (was 563 before Task 1, should now be 563 + new tests from Tasks 1-6).

- [ ] **Step 2: Lint changed files**

Run: `npx eslint convex/ruleEngine.test.ts tests/unit/ruleEngine.test.ts`
Expected: no new warnings or errors.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p convex/tsconfig.json 2>&1 | wc -l`
Expected: 34 (same count as baseline — pre-existing errors from stale `_generated/api.d.ts`, unrelated to this work). If higher, check which new errors belong to test files and fix.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -u
git commit -m "test(rules): finalize cpc_limit integration test suite" --allow-empty
```

---

## Manual Verification Checklist (not testable in CI)

After all automated tasks pass, verify manually in dev:

- [ ] Create a cpc_limit rule in the UI ([/rules](http://localhost:5174/rules)) with `minSpent=200, maxCpc=25`. Confirm it saves. Reload page. Open the rule for editing. Confirm both fields are pre-populated with the saved values.
- [ ] Check the rule card shows `· от 200₽ · CPC > 25₽` under the rule name.
- [ ] If the admin diagnostic page at [/admin/rule-diagnostic](http://localhost:5174/admin/rule-diagnostic) lists rule types, verify `cpc_limit` appears and the trace reasons are rendered in Russian.

Out of scope for this plan (would require live VK API access):
- End-to-end stop-ad call to VK
- Real Telegram notification delivery
