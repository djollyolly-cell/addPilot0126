import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check } from "lucide-react";

interface Props {
  name: string;
  price?: number;
  includedLoadUnits: number;
  overagePerUnit?: number;
  features: string[];
  recommended?: boolean;
  onSelect: () => void;
}

export function AgencyTierCard({ name, price, includedLoadUnits, overagePerUnit, features, recommended, onSelect }: Props) {
  return (
    <Card
      className={`relative flex flex-col ${recommended ? "border-primary shadow-lg" : ""}`}
      data-testid={`agency-tier-${name.toLowerCase().replace(/\s/g, "-")}`}
    >
      {recommended && (
        <Badge className="absolute -top-3 left-1/2 -translate-x-1/2 px-3">
          Рекомендуем
        </Badge>
      )}
      <CardHeader className="text-center pb-2">
        <CardTitle className="text-xl">{name}</CardTitle>
        {price != null ? (
          <div className="text-3xl font-bold text-foreground">
            {price.toLocaleString("ru-RU")} <span className="text-base font-normal text-muted-foreground">&#8381;/мес</span>
          </div>
        ) : (
          <div className="text-2xl font-bold text-foreground">Индивидуально</div>
        )}
        <p className="text-sm text-muted-foreground">{includedLoadUnits}+ ед. нагрузки</p>
        {overagePerUnit && (
          <p className="text-xs text-muted-foreground">Доп. единица: {overagePerUnit} ₽</p>
        )}
      </CardHeader>
      <CardContent className="flex-1">
        <ul className="space-y-2">
          {features.map((f, i) => (
            <li key={i} className="flex items-start gap-2">
              <Check className="h-4 w-4 text-green-500 shrink-0 mt-0.5" />
              <span className="text-sm">{f}</span>
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter>
        <Button
          className="w-full"
          variant={recommended ? "default" : "outline"}
          onClick={onSelect}
        >
          {price != null ? "Рассчитать" : "Связаться"}
        </Button>
      </CardFooter>
    </Card>
  );
}
