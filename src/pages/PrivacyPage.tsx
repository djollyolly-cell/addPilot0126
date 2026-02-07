import { Link } from 'react-router-dom';
import { ArrowLeft, Zap } from 'lucide-react';

export function PrivacyPage() {
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
        <h1 className="text-3xl font-bold text-slate-900 mb-8">Политика конфиденциальности</h1>
        <p className="text-sm text-slate-500 mb-8">Последнее обновление: 1 февраля 2026 г.</p>

        <div className="prose prose-slate max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">1. Общие положения</h2>
            <p className="text-slate-600 leading-relaxed">
              Настоящая Политика конфиденциальности определяет порядок обработки и защиты персональных данных
              пользователей сервиса AdPilot (далее — Сервис), доступного по адресу aipilot.by.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">2. Какие данные мы собираем</h2>
            <ul className="list-disc pl-6 text-slate-600 space-y-2">
              <li>Данные аккаунта VK (имя, email) — при авторизации через VK OAuth</li>
              <li>Email-адрес — при авторизации по email</li>
              <li>Данные рекламных кабинетов VK Ads — для выполнения функций мониторинга</li>
              <li>Telegram ID — при подключении уведомлений</li>
              <li>Технические данные (IP-адрес, тип браузера) — автоматически при использовании Сервиса</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">3. Цели обработки данных</h2>
            <ul className="list-disc pl-6 text-slate-600 space-y-2">
              <li>Предоставление доступа к функциям Сервиса</li>
              <li>Мониторинг рекламных кампаний и автоматизация правил</li>
              <li>Отправка уведомлений и отчётов</li>
              <li>Обработка платежей</li>
              <li>Улучшение качества Сервиса</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">4. Защита данных</h2>
            <p className="text-slate-600 leading-relaxed">
              Мы используем официальное API VK Ads с OAuth-авторизацией. Мы не храним пароли пользователей.
              Данные карт обрабатываются платёжной системой bePaid и не хранятся на наших серверах.
              Доступ к рекламному кабинету можно отозвать в любой момент через настройки VK.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">5. Передача данных третьим лицам</h2>
            <p className="text-slate-600 leading-relaxed">
              Мы не продаём и не передаём персональные данные третьим лицам, за исключением случаев,
              предусмотренных законодательством, а также при взаимодействии с платёжными провайдерами
              для обработки оплаты.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">6. Права пользователя</h2>
            <p className="text-slate-600 leading-relaxed">
              Вы имеете право запросить удаление своих данных, отозвать согласие на обработку,
              а также получить информацию о хранящихся данных. Для этого свяжитесь с нами
              через Telegram: <a href="https://t.me/adpilot_support" className="text-blue-600 hover:underline">@adpilot_support</a>.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-slate-900 mb-3">7. Контакты</h2>
            <p className="text-slate-600 leading-relaxed">
              По вопросам, связанным с обработкой персональных данных, обращайтесь: <br />
              Telegram: <a href="https://t.me/adpilot_support" className="text-blue-600 hover:underline">@adpilot_support</a>
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
