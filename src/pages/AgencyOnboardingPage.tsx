import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Id } from "../../convex/_generated/dataModel";
import { useAuth } from "@/lib/useAuth";
import { NicheSelector } from "@/components/NicheSelector";
import { LoadCalculator } from "@/components/LoadCalculator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Building2 } from "lucide-react";

const TIER_THRESHOLDS = [
  { code: "agency_s", maxUnits: 30, name: "Agency S", price: 14900 },
  { code: "agency_m", maxUnits: 60, name: "Agency M", price: 24900 },
  { code: "agency_l", maxUnits: 120, name: "Agency L", price: 39900 },
  { code: "agency_xl", maxUnits: 200, name: "Agency XL", price: 59900 },
];

export default function AgencyOnboardingPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const createCheckout = useAction(api.billing.createBepaidCheckout);

  const [totalCabinets, setTotalCabinets] = useState(20);
  const [niches, setNiches] = useState<string[]>(["beauty"]);
  const [distribution, setDistribution] = useState<Record<string, number>>({});
  const [units, setUnits] = useState(0);
  const [orgName, setOrgName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recommendedTier = TIER_THRESHOLDS.find((t) => units <= t.maxUnits) ?? TIER_THRESHOLDS[3];

  const handleProceedToPayment = async () => {
    if (!user) { navigate("/login"); return; }
    if (!orgName.trim()) { setError("Введите название организации"); return; }
    if (niches.length === 0) { setError("Выберите хотя бы одну нишу"); return; }

    setSubmitting(true);
    setError(null);
    try {
      const result = await createCheckout({
        userId: user.userId as Id<"users">,
        tier: recommendedTier.code as "agency_s" | "agency_m" | "agency_l" | "agency_xl",
        amountBYN: Math.round(recommendedTier.price * 0.027 * 100) / 100,
        returnUrl: `${window.location.origin}/pricing?status=success&tier=${recommendedTier.code}`,
        pendingOrgName: orgName.trim(),
        pendingOrgNiches: Object.entries(distribution).map(([niche, cabinetsCount]) => ({
          niche, cabinetsCount,
        })),
      });
      if (result.success && result.redirectUrl) {
        window.location.href = result.redirectUrl;
      } else {
        setError(result.error ?? "Ошибка создания платежа");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6" data-testid="agency-onboarding">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Building2 className="h-6 w-6 text-primary" />
        Подключение Agency-тарифа
      </h1>

      <Card>
        <CardHeader>
          <CardTitle>1. Параметры</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>Количество рекламных кабинетов</Label>
            <Input
              type="number"
              min={1}
              max={500}
              value={totalCabinets}
              onChange={(e) => setTotalCabinets(Math.max(1, parseInt(e.target.value) || 1))}
              data-testid="cabinets-count"
            />
          </div>
          <div>
            <Label>Ниши (можно несколько)</Label>
            <NicheSelector selected={niches} onChange={setNiches} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Распределение и расчёт</CardTitle>
        </CardHeader>
        <CardContent>
          <LoadCalculator
            totalCabinets={totalCabinets}
            selectedNiches={niches}
            onDistributionChange={setDistribution}
            onUnitsChange={setUnits}
          />
          {units > 0 && (
            <div className="mt-6 p-4 bg-muted rounded-lg">
              <div className="text-sm text-muted-foreground">Рекомендуемый пакет:</div>
              <div className="text-xl font-bold">{recommendedTier.name}</div>
              <div className="text-2xl text-primary">{recommendedTier.price.toLocaleString("ru-RU")} ₽/мес</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Название организации</CardTitle>
        </CardHeader>
        <CardContent>
          <Input
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="ООО Цифровое агентство"
            data-testid="org-name"
          />
        </CardContent>
      </Card>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      <Button onClick={handleProceedToPayment} disabled={submitting} className="w-full" size="lg" data-testid="proceed-payment">
        {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
        Перейти к оплате — {recommendedTier.price.toLocaleString("ru-RU")} ₽/мес
      </Button>
    </div>
  );
}
