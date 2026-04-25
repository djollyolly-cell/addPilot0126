import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id, Doc } from "../../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, AlertCircle, Download } from "lucide-react";
import { FieldPicker } from "./components/FieldPicker";
import { TemplateSelector } from "./components/TemplateSelector";
import { PhonesDrawer } from "./components/PhonesDrawer";
import { FIELD_CATALOG, DEFAULT_TEMPLATE_FIELDS } from "./lib/reportFieldCatalog";
import { exportReportToExcel } from "./lib/exportToExcel";

type Granularity = "day" | "day_campaign" | "day_group" | "day_banner";

function todayStr(): string { return new Date().toISOString().slice(0, 10); }
function weekAgoStr(): string {
  const d = new Date(); d.setDate(d.getDate() - 6);
  return d.toISOString().slice(0, 10);
}

export function ClientReportTab() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;

  const accounts = useQuery(api.adAccounts.list, userId ? { userId } : "skip");
  const communities = useQuery(
    api.communityProfiles.list,
    userId ? { userId } : "skip"
  );

  const [dateFrom, setDateFrom] = useState(weekAgoStr());
  const [dateTo, setDateTo] = useState(todayStr());
  const [selectedAccountId, setSelectedAccountId] = useState<Id<"adAccounts"> | null>(null);
  const [selectedCommunityIds, setSelectedCommunityIds] = useState<number[]>([]);
  const [campaignStatus, setCampaignStatus] = useState("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [fields, setFields] = useState<string[]>(DEFAULT_TEMPLATE_FIELDS);
  const [building, setBuilding] = useState(false);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhones, setShowPhones] = useState(false);

  const buildReportAction = useAction(api.clientReport.buildReport);
  const buildCommunityReportAction = useAction(api.clientReport.buildCommunityReport);

  function handleTemplateLoad(t: Doc<"reportTemplates">) {
    if (t.filters.accountIds.length > 1) {
      console.warn(`Template "${t.name}" has ${t.filters.accountIds.length} accounts — using first one`);
    }
    setSelectedAccountId(t.filters.accountIds[0] ?? null);
    setSelectedCommunityIds(t.filters.communityIds ?? []);
    setCampaignStatus(t.filters.campaignStatus ?? "all");
    setGranularity(t.granularity);
    setFields(t.fields);
  }

  async function loadCommunityData(accountId: Id<"adAccounts">) {
    const needsCommunity = fields.some((f) =>
      ["message_starts", "phones_count", "phones_detail", "senler_subs"].includes(f)
    );
    if (!needsCommunity || selectedCommunityIds.length === 0) return;

    setCommunityLoading(true);
    setCommunityError(null);
    try {
      const communityResult = await buildCommunityReportAction({
        userId: userId!,
        accountId,
        communityIds: selectedCommunityIds,
        fields,
        dateFrom,
        dateTo,
      });
      // Merge community data into report
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setReport((prev: any) => {
        if (!prev) return prev;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const updated = { ...prev, rows: prev.rows.map((r: any) => ({ ...r })) };

        // Community data merges into first row with matching date
        for (const [date, count] of Object.entries(communityResult.messageStartsByDate)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = updated.rows.find((r: any) => r.date === date);
          if (row) row.message_starts = (row.message_starts ?? 0) + (count as number);
        }
        for (const [date, count] of Object.entries(communityResult.senlerSubsByDate)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = updated.rows.find((r: any) => r.date === date);
          if (row) row.senler_subs = (row.senler_subs ?? 0) + (count as number);
        }
        // Merge phones
        updated.phonesDetail = [
          ...(updated.phonesDetail ?? []),
          ...communityResult.phonesDetail,
        ];
        // Update phones_count per date
        const phonesCountByDate = new Map<string, number>();
        for (const p of communityResult.phonesDetail) {
          phonesCountByDate.set(p.date, (phonesCountByDate.get(p.date) ?? 0) + 1);
        }
        for (const [date, count] of phonesCountByDate) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const row = updated.rows.find((r: any) => r.date === date);
          if (row) row.phones_count = (row.phones_count ?? 0) + count;
        }
        // Merge partial errors
        if (communityResult.partialErrors.length > 0) {
          updated.partialErrors = [...updated.partialErrors, ...communityResult.partialErrors];
        }
        return updated;
      });
    } catch (err) {
      setCommunityError(err instanceof Error ? err.message : "Ошибка сообщества");
    } finally {
      setCommunityLoading(false);
    }
  }

  async function handleApply() {
    if (!userId) return;
    if (!selectedAccountId) {
      setError("Выберите кабинет");
      return;
    }
    if (dateFrom > dateTo) {
      setError("Дата начала не может быть позже даты окончания");
      return;
    }
    setError(null);
    setCommunityError(null);
    setBuilding(true);

    try {
      const result = await buildReportAction({
        userId,
        accountId: selectedAccountId,
        campaignStatus: campaignStatus !== "all" ? campaignStatus : undefined,
        granularity,
        fields,
        dateFrom,
        dateTo,
      });
      setReport(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка построения");
    } finally {
      setBuilding(false);
    }

    // Call 2: community data (async, non-blocking)
    await loadCommunityData(selectedAccountId);
  }

  function handleExport() {
    if (!report) return;
    const accountName = accounts?.find((a) => a._id === selectedAccountId)?.name ?? "";
    exportReportToExcel({
      dateFrom, dateTo, accountNames: [accountName], granularity,
      userEmail: user?.email ?? "",
      fields, rows: report.rows, totals: report.totals,
      phonesDetail: fields.includes("phones_detail") ? report.phonesDetail : undefined,
    });
  }

  const currentFilters = {
    accountIds: selectedAccountId ? [selectedAccountId] : [],
    communityIds: selectedCommunityIds.length ? selectedCommunityIds : undefined,
    campaignStatus: campaignStatus !== "all" ? campaignStatus : undefined,
  };

  return (
    <div className="space-y-4" data-testid="client-report-tab">
      {/* Template + error banner */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">Шаблон:</span>
        {userId && (
          <TemplateSelector
            userId={userId}
            currentFilters={currentFilters}
            currentGranularity={granularity}
            currentFields={fields}
            onTemplateLoad={handleTemplateLoad}
          />
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">Период с</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-border rounded-md bg-background text-sm" />
            </div>
            <div>
              <label className="text-sm font-medium">по</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="w-full mt-1 px-3 py-2 border border-border rounded-md bg-background text-sm" />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Кабинет</label>
            <div className="mt-1 space-y-1 max-h-40 overflow-y-auto border border-border rounded-md p-2">
              {accounts?.map((a) => (
                <label key={a._id} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="account"
                    checked={selectedAccountId === a._id}
                    onChange={() => setSelectedAccountId(a._id)} />
                  {a.name}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Сообщества</label>
            <div className="mt-1 space-y-1 max-h-32 overflow-y-auto border border-border rounded-md p-2">
              {communities?.length === 0 && (
                <span className="text-sm text-muted-foreground">
                  Нет подключённых. Добавьте в Настройках.
                </span>
              )}
              {communities?.map((c) => (
                <label key={c._id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox"
                    checked={selectedCommunityIds.includes(c.vkGroupId)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedCommunityIds([...selectedCommunityIds, c.vkGroupId]);
                      else setSelectedCommunityIds(selectedCommunityIds.filter((x) => x !== c.vkGroupId));
                    }} />
                  {c.vkGroupName}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium">Гранулярность</label>
            <div className="mt-1 space-y-1">
              {[
                { v: "day", l: "По дням" },
                { v: "day_campaign", l: "По дням × кампании" },
                { v: "day_group", l: "По дням × группы" },
                { v: "day_banner", l: "По дням × баннеры" },
              ].map((opt) => (
                <label key={opt.v} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="gran" value={opt.v}
                    checked={granularity === opt.v}
                    onChange={() => setGranularity(opt.v as Granularity)} />
                  {opt.l}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Field picker */}
      <Card>
        <CardContent className="pt-6">
          <FieldPicker selected={fields} onChange={setFields} />
        </CardContent>
      </Card>

      {/* Apply */}
      <Button onClick={handleApply} disabled={building} data-testid="apply-btn">
        {building && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        Применить
      </Button>

      {/* Report */}
      {report && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <div className="font-bold">Отчёт</div>
                <div className="text-sm text-muted-foreground">
                  {report.dateFrom} — {report.dateTo}
                </div>
              </div>
              <div className="flex gap-2">
                {fields.includes("phones_detail") && (
                  <Button variant="outline" onClick={() => setShowPhones(true)}>
                    Номера ({report.phonesDetail?.length ?? 0})
                  </Button>
                )}
                <Button onClick={handleExport}>
                  <Download className="h-4 w-4 mr-1" /> Скачать Excel
                </Button>
              </div>
            </div>

            {report.partialErrors.length > 0 && (
              <div className="mb-4 p-3 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 text-sm">
                Частичные ошибки:
                <ul className="list-disc ml-5 mt-1">
                  {report.partialErrors.map((e: string, i: number) =>
                    <li key={i}>{e}</li>
                  )}
                </ul>
              </div>
            )}

            {communityLoading && (
              <div className="mb-4 p-3 rounded-lg bg-primary/10 text-primary text-sm flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                Загрузка данных сообщества...
              </div>
            )}

            {communityError && (
              <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm flex items-center gap-2">
                <AlertCircle className="h-4 w-4" />
                <span>{communityError}</span>
                <Button variant="ghost" size="sm" onClick={() => {
                  if (selectedAccountId) loadCommunityData(selectedAccountId);
                }}>
                  Повторить
                </Button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {fields.filter((f) => f !== "phones_detail").map((f) => (
                      <th key={f} className="text-left py-2 px-3">
                        {FIELD_CATALOG.find((c) => c.id === f)?.label ?? f}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.slice(0, 500).map((r: Record<string, unknown>, i: number) => (
                    <tr key={i} className="border-b border-border">
                      {fields.filter((f) => f !== "phones_detail").map((f) => (
                        <td key={f} className="py-2 px-3">{String(r[f] ?? "—")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  {report.totalsByType && Object.keys(report.totalsByType).length > 1 && (
                    Object.entries(report.totalsByType).map(([typeName, typeRow]: [string, Record<string, unknown>]) => (
                      <tr key={typeName} className="text-sm text-muted-foreground border-t border-border">
                        {fields.filter((f) => f !== "phones_detail").map((f, i) => (
                          <td key={f} className="py-1 px-3">
                            {i === 0 ? typeName : String(typeRow[f] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                  <tr className="font-bold border-t-2 border-border">
                    {fields.filter((f) => f !== "phones_detail").map((f, i) => (
                      <td key={f} className="py-2 px-3">
                        {i === 0 ? "Итого" : String(report.totals[f] ?? "")}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {showPhones && report && (
        <PhonesDrawer phones={report.phonesDetail ?? []} onClose={() => setShowPhones(false)} />
      )}
    </div>
  );
}
