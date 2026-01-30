import { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useAuth } from "../lib/useAuth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import {
  MessageCircle,
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  Copy,
  Link2,
  Moon,
  Clock,
} from "lucide-react";
import { Id } from "../../convex/_generated/dataModel";

const BOT_USERNAME = import.meta.env.VITE_TELEGRAM_BOT_USERNAME || "Addpilot_bot";

export function TelegramSettingsPage() {
  const { user } = useAuth();
  const userId = user?.userId as Id<"users"> | undefined;

  const connectionStatus = useQuery(
    api.telegram.getConnectionStatus,
    userId ? { userId } : "skip"
  );
  const existingToken = useQuery(
    api.telegram.getLinkToken,
    userId ? { userId } : "skip"
  );
  const generateToken = useMutation(api.telegram.generateLinkToken);

  const userSettings = useQuery(
    api.userSettings.get,
    userId ? { userId } : "skip"
  );
  const setQuietHours = useMutation(api.userSettings.setQuietHours);
  const setDigestEnabled = useMutation(api.userSettings.setDigestEnabled);

  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [quietEnabled, setQuietEnabled] = useState(false);
  const [quietStart, setQuietStart] = useState("23:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const [digestOn, setDigestOn] = useState(true);

  useEffect(() => {
    if (existingToken) {
      setLinkToken(existingToken);
    }
  }, [existingToken]);

  useEffect(() => {
    if (userSettings) {
      setQuietEnabled(userSettings.quietHoursEnabled);
      setQuietStart(userSettings.quietHoursStart ?? "23:00");
      setQuietEnd(userSettings.quietHoursEnd ?? "07:00");
      setDigestOn(userSettings.digestEnabled);
    }
  }, [userSettings]);

  const handleGenerateToken = async () => {
    if (!userId) return;
    const token = await generateToken({ userId });
    setLinkToken(token);
    setCopied(false);
  };

  const botLink = linkToken
    ? `https://t.me/${BOT_USERNAME}?start=${linkToken}`
    : null;

  const qrCodeUrl = botLink
    ? `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(botLink)}&size=200x200&format=svg`
    : null;

  const handleCopyLink = () => {
    if (botLink) {
      navigator.clipboard.writeText(botLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6" data-testid="telegram-settings">
      <div>
        <h1 className="text-3xl font-bold">Telegram</h1>
        <p className="text-muted-foreground">
          Подключите бота для получения уведомлений
        </p>
      </div>

      {/* Connection Status */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">Статус подключения</CardTitle>
              <CardDescription>Telegram-бот AddPilot</CardDescription>
            </div>
            {connectionStatus?.connected ? (
              <Badge variant="success" className="gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Подключен
              </Badge>
            ) : (
              <Badge variant="secondary">Не подключен</Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {connectionStatus?.connected ? (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-success/10">
              <MessageCircle className="h-6 w-6 text-success" />
              <div className="flex-1">
                <p className="font-medium">Бот подключен</p>
                <p className="text-sm text-muted-foreground">
                  Уведомления отправляются в Telegram
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 rounded-lg bg-muted">
              <MessageCircle className="h-6 w-6 text-muted-foreground" />
              <div className="flex-1">
                <p className="font-medium">Бот не подключен</p>
                <p className="text-sm text-muted-foreground">
                  Следуйте инструкции ниже для подключения
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Quiet Hours */}
      {connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Moon className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Тихие часы</CardTitle>
                <CardDescription>
                  Не отправлять уведомления в указанное время
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={quietEnabled}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setQuietEnabled(enabled);
                  if (userId) {
                    await setQuietHours({
                      userId,
                      enabled,
                      start: quietStart,
                      end: quietEnd,
                    });
                  }
                }}
                className="h-4 w-4 rounded border-gray-300"
                data-testid="quiet-hours-toggle"
              />
              <span className="text-sm font-medium">Включить тихие часы</span>
            </label>

            {quietEnabled && (
              <div className="flex items-center gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">С</label>
                  <input
                    type="time"
                    value={quietStart}
                    onChange={async (e) => {
                      const val = e.target.value;
                      setQuietStart(val);
                      if (userId) {
                        await setQuietHours({
                          userId,
                          enabled: true,
                          start: val,
                          end: quietEnd,
                        });
                      }
                    }}
                    className="block w-28 px-2 py-1 border rounded text-sm"
                    data-testid="quiet-hours-start"
                  />
                </div>
                <span className="text-muted-foreground mt-5">—</span>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">До</label>
                  <input
                    type="time"
                    value={quietEnd}
                    onChange={async (e) => {
                      const val = e.target.value;
                      setQuietEnd(val);
                      if (userId) {
                        await setQuietHours({
                          userId,
                          enabled: true,
                          start: quietStart,
                          end: val,
                        });
                      }
                    }}
                    className="block w-28 px-2 py-1 border rounded text-sm"
                    data-testid="quiet-hours-end"
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Daily Digest */}
      {connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              <div>
                <CardTitle className="text-lg">Дайджест</CardTitle>
                <CardDescription>
                  Ежедневная сводка за предыдущий день
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={digestOn}
                onChange={async (e) => {
                  const enabled = e.target.checked;
                  setDigestOn(enabled);
                  if (userId) {
                    await setDigestEnabled({ userId, enabled });
                  }
                }}
                className="h-4 w-4 rounded border-gray-300"
                data-testid="digest-toggle"
              />
              <span className="text-sm font-medium">
                Отправлять дайджест в 09:00 (МСК)
              </span>
            </label>
          </CardContent>
        </Card>
      )}

      {/* Connection Flow */}
      {!connectionStatus?.connected && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Подключение бота</CardTitle>
            <CardDescription>
              Отсканируйте QR-код или перейдите по ссылке
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Step 1: Generate link */}
            {!linkToken ? (
              <div className="text-center space-y-4">
                <p className="text-sm text-muted-foreground">
                  Нажмите кнопку, чтобы получить ссылку для подключения
                </p>
                <Button onClick={handleGenerateToken} className="gap-2">
                  <Link2 className="h-4 w-4" />
                  Получить ссылку
                </Button>
              </div>
            ) : (
              <>
                {/* QR Code */}
                <div className="flex flex-col items-center gap-4">
                  <div
                    className="p-4 bg-white rounded-xl shadow-sm border"
                    data-testid="telegram-qr"
                  >
                    {qrCodeUrl && (
                      <img
                        src={qrCodeUrl}
                        alt="QR-код для Telegram бота"
                        width={200}
                        height={200}
                        className="block"
                        data-testid="telegram-qr-image"
                      />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground text-center">
                    Отсканируйте камерой телефона
                  </p>
                </div>

                {/* Direct link */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">Или перейдите по ссылке:</p>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm font-mono truncate">
                      {botLink}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyLink}
                      className="gap-1 shrink-0"
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? "Скопировано" : "Копировать"}
                    </Button>
                  </div>
                  <a
                    href={botLink || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Открыть в Telegram
                  </a>
                </div>

                {/* Instructions */}
                <div className="space-y-2 pt-4 border-t">
                  <p className="text-sm font-medium">Инструкция:</p>
                  <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                    <li>Откройте ссылку или отсканируйте QR-код</li>
                    <li>
                      Нажмите <strong>Start</strong> в Telegram
                    </li>
                    <li>Бот подтвердит подключение</li>
                    <li>Эта страница обновится автоматически</li>
                  </ol>
                </div>

                {/* Regenerate */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleGenerateToken}
                  className="gap-1"
                >
                  <RefreshCw className="h-3 w-3" />
                  Сгенерировать новую ссылку
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
