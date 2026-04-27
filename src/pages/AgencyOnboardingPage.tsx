import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { Loader2, Building2, CheckCircle } from "lucide-react";

const TIER_THRESHOLDS = [
  { code: "agency_s", maxUnits: 30, name: "Agency S", price: 14900 },
  { code: "agency_m", maxUnits: 60, name: "Agency M", price: 24900 },
  { code: "agency_l", maxUnits: 120, name: "Agency L", price: 39900 },
];

export default function AgencyOnboardingPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const createCheckout = useAction(api.billing.createBepaidCheckout);
  const submitXLRequest = useAction(api.organizations.submitAgencyXLRequest);

  const isXL = searchParams.get("tier") === "agency_xl";

  const [totalCabinets, setTotalCabinets] = useState(isXL ? 50 : 10);
  const [niches, setNiches] = useState<string[]>(["beauty"]);
  const [distribution, setDistribution] = useState<Record<string, number>>({});
  const [units, setUnits] = useState(0);
  const [orgName, setOrgName] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [xlSubmitted, setXlSubmitted] = useState(false);

  const recommendedTier = TIER_THRESHOLDS.find((t) => units <= t.maxUnits) ?? null;

  // For non-XL: if units exceed all thresholds, suggest XL
  const isOverL = !isXL && !recommendedTier;

  const handleProceedToPayment = async () => {
    if (!user) { navigate("/login"); return; }
    if (!orgName.trim()) { setError("Введите название организации"); return; }
    if (niches.length === 0) { setError("Выберите хотя бы одну нишу"); return; }
    if (!recommendedTier) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await createCheckout({
        userId: user.userId as Id<"users">,
        tier: recommendedTier.code as "agency_s" | "agency_m" | "agency_l",
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

  const handleSubmitXLRequest = async () => {
    if (!contactName.trim()) { setError("Введите имя"); return; }
    if (!contactPhone.trim()) { setError("Введите телефон"); return; }
    if (!orgName.trim()) { setError("Введите название организации"); return; }
    if (niches.length === 0) { setError("Выберите хотя бы одну нишу"); return; }

    setSubmitting(true);
    setError(null);
    try {
      await submitXLRequest({
        userId: user?.userId ? user.userId as Id<"users"> : undefined,
        contactName: contactName.trim(),
        contactPhone: contactPhone.trim(),
        contactEmail: contactEmail.trim() || undefined,
        orgName: orgName.trim(),
        totalCabinets,
        nichesConfig: Object.entries(distribution).map(([niche, cabinetsCount]) => ({
          niche, cabinetsCount,
        })),
        estimatedLoadUnits: units,
      });
      setXlSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ошибка отправки заявки");
    } finally {
      setSubmitting(false);
    }
  };

  if (xlSubmitted) {
    return (
      <div className="max-w-lg mx-auto p-4 md:p-8 text-center space-y-6" data-testid="xl-request-sent">
        <CheckCircle className="h-16 w-16 text-green-500 mx-auto" />
        <h1 className="text-2xl font-bold">Заявка отправлена</h1>
        <p className="text-muted-foreground">
          Свяжемся с вами в Telegram в течение 2-3 часов для обсуждения индивидуальных условий.
        </p>
        <Button variant="outline" onClick={() => navigate("/pricing")}>
          Вернуться к тарифам
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8 space-y-6" data-testid="agency-onboarding">
      <h1 className="text-2xl font-bold flex items-center gap-2">
        <Building2 className="h-6 w-6 text-primary" />
        {isXL ? "Заявка на Agency XL" : "Подключение Agency-тарифа"}
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
              <div className="text-sm text-muted-foreground">
                {isXL || isOverL ? "Расчётная нагрузка:" : "Рекомендуемый пакет:"}
              </div>
              {isXL || isOverL ? (
                <>
                  <div className="text-xl font-bold">{units} ед. нагрузки</div>
                  <div className="text-sm text-muted-foreground">Agency XL — индивидуальная цена</div>
                </>
              ) : (
                <>
                  <div className="text-xl font-bold">{recommendedTier!.name}</div>
                  <div className="text-2xl text-primary">{recommendedTier!.price.toLocaleString("ru-RU")} &#8381;/мес</div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. {isXL || isOverL ? "Контактные данные" : "Название организации"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {(isXL || isOverL) && (
            <>
              <div>
                <Label>Имя</Label>
                <Input
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Иван Петров"
                  data-testid="contact-name"
                />
              </div>
              <div>
                <Label>Телефон / Telegram</Label>
                <Input
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  placeholder="+7 900 123-45-67 или @username"
                  data-testid="contact-phone"
                />
              </div>
              <div>
                <Label>Email <span className="text-muted-foreground text-xs">(необязательно)</span></Label>
                <Input
                  type="email"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  placeholder="ivan@agency.ru"
                  data-testid="contact-email"
                />
              </div>
            </>
          )}
          <div>
            <Label>Название организации</Label>
            <Input
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              placeholder="ООО Цифровое агентство"
              data-testid="org-name"
            />
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
      )}

      {isXL || isOverL ? (
        <Button onClick={handleSubmitXLRequest} disabled={submitting} className="w-full" size="lg" data-testid="submit-xl-request">
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Отправить заявку
        </Button>
      ) : (
        <Button onClick={handleProceedToPayment} disabled={submitting || !recommendedTier} className="w-full" size="lg" data-testid="proceed-payment">
          {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Перейти к оплате — {recommendedTier?.price.toLocaleString("ru-RU")} &#8381;/мес
        </Button>
      )}
    </div>
  );
}
