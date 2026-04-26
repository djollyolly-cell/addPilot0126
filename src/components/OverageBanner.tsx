import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAuth } from "@/lib/useAuth";
import { Id } from "../../convex/_generated/dataModel";
import { AlertTriangle, Snowflake, Lock } from "lucide-react";
import { Link } from "react-router-dom";

export function OverageBanner() {
  const { user } = useAuth();
  const status = useQuery(
    api.loadUnits.getCurrentLoadStatus,
    user?.userId ? { userId: user.userId as Id<"users"> } : "skip"
  );

  if (!status) return null;

  if (status.expiredGracePhase === "frozen") {
    return (
      <div className="bg-destructive/10 border-b border-destructive/30 p-3 flex items-center gap-2 text-sm" data-testid="overage-banner-frozen">
        <Snowflake className="h-4 w-4 text-destructive shrink-0" />
        <span>Кабинеты заморожены — подписка истекла. <Link to="/pricing" className="underline font-medium">Восстановить</Link></span>
      </div>
    );
  }

  if (status.expiredGracePhase === "read_only" || status.expiredGracePhase === "deep_read_only") {
    return (
      <div className="bg-warning/10 border-b border-warning/30 p-3 flex items-center gap-2 text-sm" data-testid="overage-banner-readonly">
        <Lock className="h-4 w-4 text-warning shrink-0" />
        <span>Подписка истекла. Только просмотр. <Link to="/pricing" className="underline font-medium">Продлить</Link></span>
      </div>
    );
  }

  if (status.featuresDisabledAt) {
    return (
      <div className="bg-warning/10 border-b border-warning/30 p-3 flex items-center gap-2 text-sm" data-testid="overage-banner-features-off">
        <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
        <span>
          Превышен лимит пакета ({status.currentLoadUnits} / {status.maxLoadUnits} ед.).
          Конструктор и добавление кабинетов отключены.
          {" "}<Link to="/pricing" className="underline font-medium">Обновить тариф</Link>
        </span>
      </div>
    );
  }

  if (status.isOverLimit) {
    return (
      <div className="bg-primary/10 border-b border-primary/30 p-3 flex items-center gap-2 text-sm" data-testid="overage-banner-warning">
        <AlertTriangle className="h-4 w-4 text-primary shrink-0" />
        <span>
          Нагрузка {status.currentLoadUnits} / {status.maxLoadUnits} ед.
          Перейдите на пакет выше для бесперебойной работы.
        </span>
      </div>
    );
  }

  return null;
}
