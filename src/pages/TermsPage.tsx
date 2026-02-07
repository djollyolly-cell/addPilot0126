import { Link } from 'react-router-dom';
import { ArrowLeft, Zap } from 'lucide-react';

export function TermsPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="border-b sticky top-0 bg-white/80 backdrop-blur-sm z-10">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 text-slate-600 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white fill-white" />
            </div>
            <span className="font-bold">AdPilot</span>
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-12">
        <h1 className="text-3xl font-bold text-slate-900 mb-8">Условия использования</h1>
        <p className="text-sm text-slate-500 mb-8">Последнее обновление: 1 февраля 2026 г.</p>

        <div className="prose prose-slate max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">1. Общие положения</h2>
            <p className="text-slate-600 leading-relaxed">
              Настоящие Условия использования регулируют доступ и использование сервиса AdPilot (далее — Сервис),
              предоставляемого по адресу aipilot.by. Используя Сервис, вы соглашаетесь с данными условиями.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">2. Описание Сервиса</h2>
            <p className="text-slate-600 leading-relaxed">
              AdPilot — это сервис автоматизации мониторинга рекламных кампаний VK Ads. Сервис отслеживает
              показатели рекламных кампаний (CPL, CTR, скрут бюджета), автоматически останавливает неэффективные
              объявления и отправляет уведомления в Telegram.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">3. Регистрация и доступ</h2>
            <ul className="list-disc pl-6 text-slate-600 space-y-2">
              <li>Для использования Сервиса необходима авторизация через VK OAuth или email</li>
              <li>Вы несёте ответственность за безопасность своего аккаунта</li>
              <li>Сервис доступен лицам, достигшим 18 лет</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">4. Тарифы и оплата</h2>
            <ul className="list-disc pl-6 text-slate-600 space-y-2">
              <li>Сервис предоставляет бесплатный тариф (Freemium) и платные тарифы (Start, Pro)</li>
              <li>Оплата производится ежемесячно через платёжную систему bePaid</li>
              <li>Подписка продлевается автоматически, если не отменена до окончания периода</li>
              <li>Возврат средств осуществляется в течение 14 дней с момента оплаты при обращении в поддержку</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">5. Ограничения ответственности</h2>
            <p className="text-slate-600 leading-relaxed">
              Сервис предоставляется «как есть». Мы не гарантируем бесперебойную работу и не несём
              ответственности за убытки, связанные с автоматической остановкой или неостановкой рекламных
              объявлений. Решения по управлению рекламными кампаниями принимаются на основе заданных
              пользователем правил.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">6. Доступ к рекламным кабинетам</h2>
            <p className="text-slate-600 leading-relaxed">
              Подключая рекламный кабинет, вы предоставляете Сервису доступ через официальное API VK Ads.
              Вы можете отозвать доступ в любой момент через настройки VK ID. При отзыве доступа
              мониторинг и автоматические правила перестанут работать.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">7. Прекращение использования</h2>
            <p className="text-slate-600 leading-relaxed">
              Вы можете прекратить использование Сервиса в любой момент. Мы оставляем за собой право
              заблокировать доступ при нарушении данных условий.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">8. Контакты</h2>
            <p className="text-slate-600 leading-relaxed">
              По любым вопросам обращайтесь: <br />
              Telegram: <a href="https://t.me/adpilot_support" className="text-blue-600 hover:underline">@adpilot_support</a>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
