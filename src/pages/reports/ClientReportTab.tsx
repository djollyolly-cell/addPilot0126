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
  const [selectedAccountIds, setSelectedAccountIds] = useState<Id<"adAccounts">[]>([]);
  const [selectedCommunityIds, setSelectedCommunityIds] = useState<number[]>([]);
  const [campaignStatus, setCampaignStatus] = useState("all");
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [fields, setFields] = useState<string[]>(DEFAULT_TEMPLATE_FIELDS);
  const [building, setBuilding] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhones, setShowPhones] = useState(false);

  const buildReport = useAction(api.clientReport.buildReport);

  function handleTemplateLoad(t: Doc<"reportTemplates">) {
    setSelectedAccountIds(t.filters.accountIds);
    setSelectedCommunityIds(t.filters.communityIds ?? []);
    setCampaignStatus(t.filters.campaignStatus ?? "all");
    setGranularity(t.granularity);
    setFields(t.fields);
  }

  async function handleApply() {
    if (!userId) return;
    if (selectedAccountIds.length === 0) {
      setError("Выберите хотя бы один кабинет");
      return;
    }
    if (dateFrom > dateTo) {
      setError("Дата начала не может быть позже даты окончания");
      return;
    }
    setError(null);
    setBuilding(true);
    try {
      const result = await buildReport({
        userId,
        accountIds: selectedAccountIds,
        communityIds: selectedCommunityIds.length ? selectedCommunityIds : undefined,
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
  }

  function handleExport() {
    if (!report) return;
    const accountNames = (accounts ?? [])
      .filter((a) => selectedAccountIds.includes(a._id))
      .map((a) => a.name);
    exportReportToExcel({
      dateFrom, dateTo, accountNames, granularity,
      userEmail: user?.email ?? "",
      fields, rows: report.rows, totals: report.totals,
      phonesDetail: fields.includes("phones_detail") ? report.phonesDetail : undefined,
    });
  }

  const currentFilters = {
    accountIds: selectedAccountIds,
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
            <label className="text-sm font-medium">Кабинеты</label>
            <div className="mt-1 space-y-1 max-h-40 overflow-y-auto border border-border rounded-md p-2">
              {accounts?.map((a) => (
                <label key={a._id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox"
                    checked={selectedAccountIds.includes(a._id)}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedAccountIds([...selectedAccountIds, a._id]);
                      else setSelectedAccountIds(selectedAccountIds.filter((x) => x !== a._id));
                    }} />
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
