import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../convex/_generated/api';
import { useAuth } from '@/lib/useAuth';
import { Id } from '../../convex/_generated/dataModel';
import { useNavigate, Link } from 'react-router-dom';
import {
  Wand2,
  ArrowLeft,
  Loader2,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Image,
  Rocket,
  Building2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { RegionSelect } from '@/components/RegionSelect';

const objectives = [
  { value: 'traffic', label: 'Трафик на сайт', desc: 'Клики на ваш сайт' },
  { value: 'social', label: 'Вступления в сообщество', desc: 'Подписки ВК' },
  { value: 'messages', label: 'Сообщения сообщества', desc: 'Лиды через ЛС' },
  { value: 'video_views', label: 'Продвижение видео', desc: 'Просмотры видео' },
  { value: 'engagement', label: 'Продвижение поста', desc: 'Промо публикации' },
];

interface BannerVariant {
  title: string;
  text: string;
  imageStorageId?: string;
  isSelected: boolean;
  generatingImage: boolean;
}

export default function AICabinetNewPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Active account
  const settings = useQuery(
    api.userSettings.get,
    user?.userId ? { userId: user.userId as Id<"users"> } : 'skip'
  );
  const accountId = settings?.activeAccountId;

  // Saved business directions
  const savedDirections = useQuery(
    api.businessDirections.list,
    accountId ? { accountId: accountId as Id<"adAccounts"> } : 'skip'
  );

  // Step state
  const [activeStep, setActiveStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — Business info
  const [businessDirection, setBusinessDirection] = useState('');
  const [targetUrl, setTargetUrl] = useState('');

  // Step 2 — Campaign settings
  const [objective, setObjective] = useState('traffic');
  const [selectedRegions, setSelectedRegions] = useState<number[]>([1]); // Moscow by default
  const [ageFrom, setAgeFrom] = useState(22);
  const [ageTo, setAgeTo] = useState(55);
  const [sex, setSex] = useState('MF');
  const [dailyBudget, setDailyBudget] = useState(500);

  // Step 3 — Banners
  const [banners, setBanners] = useState<BannerVariant[]>([]);
  const [generatingTexts, setGeneratingTexts] = useState(false);

  // Step 4 — Launch
  const [launching, setLaunching] = useState(false);

  // Mutations & actions
  const createCampaign = useMutation(api.aiCabinet.createCampaign);
  const createBanner = useMutation(api.aiCabinet.createBanner);
  const generateTexts = useAction(api.aiGenerate.generateBannerTexts);
  const generateImage = useAction(api.aiGenerate.generateBannerImage);
  const improveField = useAction(api.aiGenerate.improveTextField);
  const launchCampaign = useAction(api.aiCabinet.launchCampaign);
  const [improvingField, setImprovingField] = useState<string | null>(null); // "title-0", "text-1", etc.

  const handleStep1Next = () => {
    if (!businessDirection.trim()) { setError('Введите направление бизнеса'); return; }
    if (!targetUrl.trim()) { setError('Введите ссылку'); return; }
    setError(null);
    setActiveStep(2);
    setMaxStepReached((prev) => Math.max(prev, 2));
  };

  const handleStep2Next = () => {
    if (selectedRegions.length === 0) { setError('Выберите хотя бы один регион'); return; }
    if (dailyBudget < 100) { setError('Минимальный бюджет: 100₽'); return; }
    setError(null);
    setActiveStep(3);
    setMaxStepReached((prev) => Math.max(prev, 3));
    // Auto-generate banners
    if (banners.length === 0) {
      handleGenerateTexts();
    }
  };

  const handleGenerateTexts = async () => {
    if (!user?.userId) return;
    setGeneratingTexts(true);
    setError(null);
    try {
      const results = await generateTexts({
        userId: user.userId as Id<"users">,
        businessDirection,
        objective,
        targetUrl,
      });
      setBanners(results.map((r: { title: string; text: string }) => ({
        title: r.title,
        text: r.text,
        isSelected: true,
        generatingImage: false,
      })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации');
    } finally {
      setGeneratingTexts(false);
    }
  };

  const handleGenerateImage = async (index: number) => {
    if (!user?.userId) return;
    const banner = banners[index];
    setBanners(prev => prev.map((b, i) => i === index ? { ...b, generatingImage: true } : b));
    try {
      const result = await generateImage({
        userId: user.userId as Id<"users">,
        businessDirection,
        title: banner.title,
        text: banner.text,
      });
      setBanners(prev => prev.map((b, i) =>
        i === index ? { ...b, imageStorageId: result.storageId, generatingImage: false } : b
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка генерации изображения');
      setBanners(prev => prev.map((b, i) => i === index ? { ...b, generatingImage: false } : b));
    }
  };

  const handleImproveField = async (index: number, field: 'title' | 'text') => {
    if (!user?.userId) return;
    const key = `${field}-${index}`;
    setImprovingField(key);
    try {
      const improved = await improveField({
        userId: user.userId as Id<"users">,
        businessDirection,
        objective,
        field,
        currentValue: banners[index][field],
      });
      setBanners(prev => prev.map((b, i) =>
        i === index ? { ...b, [field]: improved } : b
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка улучшения');
    } finally {
      setImprovingField(null);
    }
  };

  const handleLaunch = async () => {
    if (!user?.userId || !accountId) return;
    const selected = banners.filter(b => b.isSelected);
    if (selected.length === 0) { setError('Выберите хотя бы один баннер'); return; }

    setLaunching(true);
    setError(null);
    try {
      // 1. Create campaign in DB
      const campaignId = await createCampaign({
        userId: user.userId as Id<"users">,
        accountId: accountId as Id<"adAccounts">,
        businessDirection,
        objective,
        targetUrl,
        regions: selectedRegions,
        ageFrom,
        ageTo,
        sex,
        dailyBudget,
      });

      // 2. Create banners in DB
      for (const banner of banners) {
        await createBanner({
          campaignId: campaignId as Id<"aiCampaigns">,
          title: banner.title,
          text: banner.text,
          imageStorageId: banner.imageStorageId as Id<"_storage"> | undefined,
          isSelected: banner.isSelected,
        });
      }

      // 3. Launch to myTarget (token resolved server-side)
      await launchCampaign({
        campaignId: campaignId as Id<"aiCampaigns">,
      });

      navigate(`/ai-cabinet/${campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запуска');
    } finally {
      setLaunching(false);
    }
  };

  const handleSaveDraft = async () => {
    if (!user?.userId || !accountId) return;
    if (!businessDirection.trim()) { setError('Введите направление бизнеса'); return; }

    setError(null);
    try {
      const campaignId = await createCampaign({
        userId: user.userId as Id<"users">,
        accountId: accountId as Id<"adAccounts">,
        businessDirection,
        objective,
        targetUrl,
        regions: selectedRegions,
        ageFrom,
        ageTo,
        sex,
        dailyBudget,
      });

      // Save banners if any
      for (const banner of banners) {
        await createBanner({
          campaignId: campaignId as Id<"aiCampaigns">,
          title: banner.title,
          text: banner.text,
          imageStorageId: banner.imageStorageId as Id<"_storage"> | undefined,
          isSelected: banner.isSelected,
        });
      }

      navigate(`/ai-cabinet/${campaignId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    }
  };

  const stepCompleted = (step: number) => {
    if (step === 1) return businessDirection.trim() !== '' && targetUrl.trim() !== '';
    if (step === 2) return maxStepReached > 2 && selectedRegions.length > 0 && dailyBudget >= 100;
    if (step === 3) return maxStepReached > 3 && banners.some(b => b.isSelected);
    return false;
  };

  const canOpenStep = (step: number) => step <= maxStepReached;

  return (
    <div className="space-y-6 max-w-3xl mx-auto" data-testid="ai-cabinet-new-page">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/ai-cabinet">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Wand2 className="h-6 w-6 text-primary" />
          Новая AI-кампания
        </h1>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto text-xs underline">Закрыть</button>
        </div>
      )}

      {/* No account */}
      {!accountId && (
        <div className="text-center py-12">
          <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium mb-2">Выберите аккаунт</h3>
          <p className="text-muted-foreground mb-4">Подключите рекламный аккаунт для создания кампании</p>
          <Link to="/accounts"><Button variant="outline">Перейти к кабинетам</Button></Link>
        </div>
      )}

      {accountId && (
        <>
          {/* Step 1 — Business info */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => setActiveStep(1)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    stepCompleted(1) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {stepCompleted(1) ? <CheckCircle className="h-4 w-4" /> : '1'}
                  </div>
                  <CardTitle className="text-base">О бизнесе</CardTitle>
                </div>
                {activeStep === 1 ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </CardHeader>
            {activeStep === 1 && (
              <CardContent className="space-y-4">
                <div>
                  <Label htmlFor="business">Направление бизнеса</Label>
                  <Input
                    id="business"
                    placeholder="Стоматология, Фитнес, Доставка еды..."
                    value={businessDirection}
                    onChange={(e) => setBusinessDirection(e.target.value)}
                  />
                  {savedDirections && savedDirections.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <span className="text-xs text-muted-foreground">Сохранённые:</span>
                      {savedDirections.filter(d => d.isActive).map((d) => (
                        <button
                          key={d._id}
                          type="button"
                          onClick={() => setBusinessDirection(d.name)}
                          className={`px-2 py-0.5 rounded-full text-xs transition-colors ${
                            businessDirection === d.name
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground hover:bg-muted/80'
                          }`}
                        >
                          {d.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <Label htmlFor="url">Ссылка</Label>
                  <Input
                    id="url"
                    type="url"
                    placeholder="https://example.com или https://vk.com/group"
                    value={targetUrl}
                    onChange={(e) => setTargetUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Сайт, сообщество ВК или лид-форма
                  </p>
                </div>
                <Button onClick={handleStep1Next} className="w-full">
                  Далее
                </Button>
              </CardContent>
            )}
          </Card>

          {/* Step 2 — Campaign settings */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => canOpenStep(2) && setActiveStep(activeStep === 2 ? 1 : 2)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    stepCompleted(2) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {stepCompleted(2) ? <CheckCircle className="h-4 w-4" /> : '2'}
                  </div>
                  <CardTitle className="text-base">Настройки кампании</CardTitle>
                </div>
                {activeStep === 2 ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </CardHeader>
            {activeStep === 2 && (
              <CardContent className="space-y-4">
                {/* Objective */}
                <div>
                  <Label>Цель рекламы</Label>
                  <div className="grid grid-cols-1 gap-2 mt-2">
                    {objectives.map((obj) => (
                      <button
                        key={obj.value}
                        onClick={() => setObjective(obj.value)}
                        className={`text-left p-3 rounded-lg border transition-colors ${
                          objective === obj.value
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <p className="font-medium text-sm">{obj.label}</p>
                        <p className="text-xs text-muted-foreground">{obj.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Regions */}
                <div>
                  <Label>География</Label>
                  <div className="mt-2">
                    <RegionSelect
                      accountId={accountId!}
                      value={selectedRegions}
                      onChange={setSelectedRegions}
                    />
                  </div>
                </div>

                {/* Age */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="ageFrom">Возраст от</Label>
                    <Input
                      id="ageFrom"
                      type="number"
                      min={12}
                      max={75}
                      value={ageFrom}
                      onChange={(e) => setAgeFrom(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <Label htmlFor="ageTo">Возраст до</Label>
                    <Input
                      id="ageTo"
                      type="number"
                      min={12}
                      max={75}
                      value={ageTo}
                      onChange={(e) => setAgeTo(Number(e.target.value))}
                    />
                  </div>
                </div>

                {/* Sex */}
                <div>
                  <Label>Пол</Label>
                  <div className="flex gap-2 mt-2">
                    {[
                      { value: 'MF', label: 'Все' },
                      { value: 'M', label: 'Мужчины' },
                      { value: 'F', label: 'Женщины' },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => setSex(opt.value)}
                        className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${
                          sex === opt.value
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Daily budget */}
                <div>
                  <Label htmlFor="budget">Дневной бюджет (₽)</Label>
                  <Input
                    id="budget"
                    type="number"
                    min={100}
                    step={100}
                    value={dailyBudget}
                    onChange={(e) => setDailyBudget(Number(e.target.value))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">Минимум: 100₽</p>
                </div>

                <Button onClick={handleStep2Next} className="w-full">
                  Далее — AI сгенерирует объявления
                </Button>
              </CardContent>
            )}
          </Card>

          {/* Step 3 — AI Banners */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => canOpenStep(3) && setActiveStep(activeStep === 3 ? 2 : 3)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    stepCompleted(3) ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {stepCompleted(3) ? <CheckCircle className="h-4 w-4" /> : '3'}
                  </div>
                  <CardTitle className="text-base">Объявления (AI)</CardTitle>
                </div>
                {activeStep === 3 ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </CardHeader>
            {activeStep === 3 && (
              <CardContent className="space-y-4">
                {generatingTexts ? (
                  <div className="flex flex-col items-center py-8 gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">AI генерирует объявления...</p>
                  </div>
                ) : banners.length === 0 ? (
                  <div className="text-center py-8">
                    <Sparkles className="h-8 w-8 text-muted-foreground mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground mb-4">
                      Нажмите для генерации 3 вариантов объявлений
                    </p>
                    <Button onClick={handleGenerateTexts}>
                      <Sparkles className="h-4 w-4 mr-2" />
                      Сгенерировать
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-muted-foreground">
                        Выберите баннеры для запуска (минимум 1)
                      </p>
                      <Button variant="outline" size="sm" onClick={handleGenerateTexts}>
                        <Sparkles className="h-4 w-4 mr-1" />
                        Перегенерировать
                      </Button>
                    </div>

                    {banners.map((banner, index) => (
                      <Card key={index} className={`border-2 transition-colors ${
                        banner.isSelected ? 'border-primary' : 'border-border'
                      }`}>
                        <CardContent className="p-4 space-y-3">
                          <div className="flex items-start justify-between">
                            <Badge variant={banner.isSelected ? 'default' : 'secondary'}>
                              Вариант {index + 1}
                            </Badge>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={banner.isSelected}
                                onChange={() => {
                                  setBanners(prev => prev.map((b, i) =>
                                    i === index ? { ...b, isSelected: !b.isSelected } : b
                                  ));
                                }}
                                className="w-4 h-4 rounded border-border"
                              />
                              <span className="text-sm">Запустить</span>
                            </label>
                          </div>

                          {/* Editable title */}
                          <div>
                            <Label className="text-xs">Заголовок ({banner.title.length}/25)</Label>
                            <div className="flex gap-1">
                              <Input
                                value={banner.title}
                                maxLength={25}
                                onChange={(e) => {
                                  setBanners(prev => prev.map((b, i) =>
                                    i === index ? { ...b, title: e.target.value } : b
                                  ));
                                }}
                                className="flex-1"
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 shrink-0"
                                onClick={() => handleImproveField(index, 'title')}
                                disabled={improvingField === `title-${index}`}
                                title="AI улучшение"
                              >
                                {improvingField === `title-${index}` ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Sparkles className="h-4 w-4 text-primary" />
                                )}
                              </Button>
                            </div>
                          </div>

                          {/* Editable text */}
                          <div>
                            <Label className="text-xs">Текст ({banner.text.length}/90)</Label>
                            <div className="flex gap-1">
                              <textarea
                                value={banner.text}
                                maxLength={90}
                                rows={2}
                                onChange={(e) => {
                                  setBanners(prev => prev.map((b, i) =>
                                    i === index ? { ...b, text: e.target.value } : b
                                  ));
                                }}
                                className="flex-1 px-3 py-2 text-sm border border-border rounded-lg bg-background resize-none"
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 shrink-0 self-start mt-1"
                                onClick={() => handleImproveField(index, 'text')}
                                disabled={improvingField === `text-${index}`}
                                title="AI улучшение"
                              >
                                {improvingField === `text-${index}` ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Sparkles className="h-4 w-4 text-primary" />
                                )}
                              </Button>
                            </div>
                          </div>

                          {/* Image */}
                          <div>
                            {banner.imageStorageId ? (
                              <div className="relative">
                                <img
                                  src={`${import.meta.env.VITE_CONVEX_SITE_URL || ''}/api/storage/${banner.imageStorageId}`}
                                  alt="Баннер"
                                  className="w-full max-w-[200px] rounded-lg border border-border"
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="mt-2"
                                  onClick={() => handleGenerateImage(index)}
                                  disabled={banner.generatingImage}
                                >
                                  {banner.generatingImage ? (
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                  ) : (
                                    <Image className="h-4 w-4 mr-1" />
                                  )}
                                  Новое изображение
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleGenerateImage(index)}
                                disabled={banner.generatingImage}
                              >
                                {banner.generatingImage ? (
                                  <>
                                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                                    Генерация...
                                  </>
                                ) : (
                                  <>
                                    <Image className="h-4 w-4 mr-1" />
                                    Сгенерировать изображение
                                  </>
                                )}
                              </Button>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    ))}

                    <Button onClick={() => { setActiveStep(4); setMaxStepReached((prev) => Math.max(prev, 4)); }} className="w-full">
                      Далее — Превью и запуск
                    </Button>
                  </>
                )}
              </CardContent>
            )}
          </Card>

          {/* Step 4 — Preview & Launch */}
          <Card>
            <CardHeader
              className="cursor-pointer"
              onClick={() => canOpenStep(4) && setActiveStep(activeStep === 4 ? 3 : 4)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                    activeStep === 4 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    4
                  </div>
                  <CardTitle className="text-base">Превью и запуск</CardTitle>
                </div>
                {activeStep === 4 ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </CardHeader>
            {activeStep === 4 && (
              <CardContent className="space-y-4">
                {/* Summary */}
                <div className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Направление</span>
                    <span className="font-medium">{businessDirection}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Цель</span>
                    <span className="font-medium">
                      {objectives.find(o => o.value === objective)?.label}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Ссылка</span>
                    <a href={targetUrl} target="_blank" rel="noreferrer" className="font-medium text-primary truncate max-w-[200px]">
                      {targetUrl}
                    </a>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Регионы</span>
                    <span className="font-medium">{selectedRegions.length} шт.</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Возраст</span>
                    <span className="font-medium">{ageFrom}–{ageTo}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Пол</span>
                    <span className="font-medium">
                      {sex === 'MF' ? 'Все' : sex === 'M' ? 'Мужчины' : 'Женщины'}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Дневной бюджет</span>
                    <span className="font-medium">{formatCurrency(dailyBudget)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Баннеров</span>
                    <span className="font-medium">{banners.filter(b => b.isSelected).length} из {banners.length}</span>
                  </div>
                </div>

                {/* Selected banners preview */}
                {banners.filter(b => b.isSelected).length > 0 && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Выбранные баннеры:</p>
                    {banners.filter(b => b.isSelected).map((banner, idx) => (
                      <div key={idx} className="p-3 rounded-lg border border-border">
                        <div className="flex gap-3">
                          {banner.imageStorageId && (
                            <img
                              src={`${import.meta.env.VITE_CONVEX_SITE_URL || ''}/api/storage/${banner.imageStorageId}`}
                              alt="Баннер"
                              className="w-16 h-16 rounded-lg border border-border object-cover shrink-0"
                            />
                          )}
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{banner.title}</p>
                            <p className="text-xs text-muted-foreground mt-1">{banner.text}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="border-t border-border pt-4 flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={handleSaveDraft}
                    disabled={launching}
                  >
                    Сохранить черновик
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={handleLaunch}
                    disabled={launching}
                  >
                    {launching ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Запуск...
                      </>
                    ) : (
                      <>
                        <Rocket className="h-4 w-4 mr-2" />
                        Запустить кампанию
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
