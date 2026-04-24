import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

interface PhoneEntry {
  date: string;
  leftAt: number;
  phone: string;
  firstName: string;
  lastName: string;
  dialogUrl?: string;
  source: "vk_dialog" | "lead_ad";
}

export function PhonesDrawer({
  phones,
  onClose,
}: {
  phones: PhoneEntry[];
  onClose: () => void;
}) {
  return (
    <div
      className="fixed right-0 top-0 h-full w-full max-w-md bg-background border-l border-border shadow-xl z-40 flex flex-col"
      data-testid="phones-drawer"
    >
      <div className="flex items-center justify-between p-4 border-b border-border">
        <h3 className="font-bold">Номера ({phones.length})</h3>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {phones.length === 0 && (
          <div className="text-sm text-muted-foreground">Номеров нет.</div>
        )}
        {phones.map((p, i) => (
          <div
            key={i}
            className="p-3 border border-border rounded-md text-sm space-y-1"
          >
            <div className="font-mono">{p.phone}</div>
            <div className="text-muted-foreground">
              {p.firstName} {p.lastName}
            </div>
            <div className="text-xs text-muted-foreground flex gap-2">
              <span>{new Date(p.leftAt).toLocaleString("ru-RU")}</span>
              <span>·</span>
              <span>{p.source === "vk_dialog" ? "VK сообщения" : "Lead Ads"}</span>
              {p.dialogUrl && (
                <>
                  <span>·</span>
                  <a
                    href={p.dialogUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary hover:underline"
                  >
                    диалог
                  </a>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
