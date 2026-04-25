import * as XLSX from "xlsx";
import { FIELD_CATALOG } from "./reportFieldCatalog";

interface ReportRow {
  date: string;
  [key: string]: unknown;
}

interface ExportParams {
  dateFrom: string;
  dateTo: string;
  accountNames: string[];
  granularity: string;
  userEmail: string;
  fields: string[];
  rows: ReportRow[];
  totals: Record<string, unknown>;
  totalsByType?: Record<string, Record<string, unknown>>;
  typeLabels?: Record<string, string>;
  phonesDetail?: Array<{
    date: string; leftAt: number; phone: string;
    firstName: string; lastName: string;
    dialogUrl?: string; source: string;
  }>;
}

export function exportReportToExcel(p: ExportParams): void {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const metaData = [
    ["Отчёт клиенту"],
    ["Период", `${p.dateFrom} — ${p.dateTo}`],
    ["Кабинеты", p.accountNames.join(", ")],
    ["Гранулярность", p.granularity],
    ["Построен", new Date().toLocaleString("ru-RU")],
    ["Пользователь", p.userEmail],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(metaData), "Сводка");

  // Sheet 2: Report data
  const visibleFields = p.fields.filter((f) => f !== "phones_detail");
  const fieldDefs = visibleFields.map((f) => FIELD_CATALOG.find((c) => c.id === f)).filter(Boolean);
  const headers = fieldDefs.map((f) => f!.label);
  const dataRows = p.rows.map((r) => visibleFields.map((f) => r[f] ?? ""));

  // Per-type subtotal rows (before grand total)
  const typeRows: unknown[][] = [];
  if (p.totalsByType && Object.keys(p.totalsByType).length > 1) {
    for (const [typeKey, typeRow] of Object.entries(p.totalsByType)) {
      const label = p.typeLabels?.[typeKey] ?? typeKey;
      typeRows.push([label, ...visibleFields.slice(1).map((f) => typeRow[f] ?? "")]);
    }
  }

  const totalsRow = ["Итого", ...visibleFields.slice(1).map((f) => p.totals[f] ?? "")];
  const reportSheet = XLSX.utils.aoa_to_sheet([headers, ...dataRows, ...typeRows, totalsRow]);
  XLSX.utils.book_append_sheet(wb, reportSheet, "Отчёт");

  // Sheet 3: Phones (if any)
  if (p.phonesDetail && p.phonesDetail.length > 0) {
    const phoneHeaders = ["Дата", "Время", "Номер", "Имя", "Фамилия", "Источник", "Ссылка на диалог"];
    const phoneRows = p.phonesDetail.map((ph) => [
      ph.date,
      new Date(ph.leftAt).toLocaleTimeString("ru-RU"),
      ph.phone,
      ph.firstName,
      ph.lastName,
      ph.source === "vk_dialog" ? "VK сообщения" : "Lead Ads",
      ph.dialogUrl ?? "",
    ]);
    const phoneSheet = XLSX.utils.aoa_to_sheet([phoneHeaders, ...phoneRows]);

    // Make dialog URLs clickable hyperlinks in Excel (column G, index 6)
    for (let row = 0; row < p.phonesDetail.length; row++) {
      const url = p.phonesDetail[row].dialogUrl;
      if (!url) continue;
      const cellRef = XLSX.utils.encode_cell({ r: row + 1, c: 6 });
      const cell = phoneSheet[cellRef];
      if (cell) {
        cell.l = { Target: url, Tooltip: "Открыть диалог" };
      }
    }

    XLSX.utils.book_append_sheet(wb, phoneSheet, "Номера");
  }

  const fn = `report_${p.dateFrom}_${p.dateTo}_${p.accountNames[0] || "report"}.xlsx`;
  XLSX.writeFile(wb, fn);
}
