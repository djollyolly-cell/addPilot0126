import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NICHE_COEFS } from "./NicheSelector";

interface Props {
  totalCabinets: number;
  selectedNiches: string[];
  onDistributionChange: (dist: Record<string, number>) => void;
  onUnitsChange: (units: number) => void;
}

const computeUnits = (dist: Record<string, number>) =>
  Object.entries(dist).reduce((sum, [k, v]) => sum + v * (NICHE_COEFS[k] ?? 0), 0);

export function LoadCalculator({ totalCabinets, selectedNiches, onDistributionChange, onUnitsChange }: Props) {
  const [distribution, setDistribution] = useState<Record<string, number>>({});

  useEffect(() => {
    if (selectedNiches.length === 0) {
      setDistribution({});
      onDistributionChange({});
      onUnitsChange(0);
      return;
    }
    const equal = Math.floor(totalCabinets / selectedNiches.length);
    const dist: Record<string, number> = {};
    selectedNiches.forEach((n, i) => {
      dist[n] = i === selectedNiches.length - 1
        ? totalCabinets - equal * (selectedNiches.length - 1)
        : equal;
    });
    setDistribution(dist);
    onDistributionChange(dist);
    onUnitsChange(computeUnits(dist));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCabinets, selectedNiches.join(",")]);

  const updateNiche = (code: string, value: number) => {
    if (selectedNiches.length === 0) return;
    const lastNiche = selectedNiches[selectedNiches.length - 1];
    if (code === lastNiche) return;

    const newDist = { ...distribution, [code]: value };
    const sumExceptLast = selectedNiches
      .filter((n) => n !== lastNiche)
      .reduce((s, n) => s + (newDist[n] ?? 0), 0);
    const remainder = totalCabinets - sumExceptLast;
    if (remainder < 0) return;
    newDist[lastNiche] = remainder;
    setDistribution(newDist);
    onDistributionChange(newDist);
    onUnitsChange(computeUnits(newDist));
  };

  if (selectedNiches.length === 0) {
    return <p className="text-muted-foreground">Выберите ниши для расчёта.</p>;
  }

  const lastNiche = selectedNiches[selectedNiches.length - 1];
  const totalUnits = computeUnits(distribution);

  return (
    <div className="space-y-3" data-testid="load-calculator">
      {selectedNiches.map((n) => {
        const isLast = n === lastNiche;
        const count = distribution[n] ?? 0;
        const units = count * (NICHE_COEFS[n] ?? 0);
        return (
          <div key={n} className="grid grid-cols-3 gap-3 items-center">
            <Label>{n} &times;{NICHE_COEFS[n]}</Label>
            <Input
              type="number"
              min={0}
              max={totalCabinets}
              value={count}
              disabled={isLast}
              onChange={(e) => updateNiche(n, parseInt(e.target.value) || 0)}
            />
            <span className="text-sm text-muted-foreground">{units} ед.</span>
          </div>
        );
      })}
      <div className="border-t pt-3 flex justify-between font-semibold">
        <span>Итого:</span>
        <span>{totalUnits} единиц нагрузки</span>
      </div>
    </div>
  );
}
