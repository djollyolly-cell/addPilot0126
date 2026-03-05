import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import {
  Zap,
  Menu,
  X,
  Shield,
  Bell,
  BarChart3,
  CheckCircle2,
  Clock,
  ChevronDown,
  Settings,
  Send,
  LineChart,
  UserPlus
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';

// ═══════════════════════════════════════════════════════════
// AdPilot Landing Page
// ═══════════════════════════════════════════════════════════

function LandingHeader() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-transparent transition-all duration-300">
      <div className="max-w-[1400px] mx-auto px-6">
        <div className="flex items-center justify-between h-20">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Zap className="w-6 h-6 text-white fill-white" />
            </div>
            <span className="text-xl font-bold text-slate-900 tracking-tight">AdPilot</span>
          </div>

          {/* Navigation */}
          <nav className="hidden md:flex items-center gap-10">
            <a href="#features" className="text-sm font-medium text-slate-600 hover:text-blue-600 transition-colors">
              Возможности
            </a>
            <a href="#how-it-works" className="text-sm font-medium text-slate-600 hover:text-blue-600 transition-colors">
              Как это работает
            </a>
            <a href="#pricing" className="text-sm font-medium text-slate-600 hover:text-blue-600 transition-colors">
              Тарифы
            </a>
          </nav>

          {/* Auth buttons */}
          <div className="hidden md:flex items-center gap-4">
            <Link to="/login" className="text-sm font-medium text-slate-600 hover:text-slate-900">
              Войти
            </Link>
            <Link to="/login">
              <Button variant="outline" className="rounded-full border-slate-200 hover:border-blue-200 hover:bg-blue-50 text-slate-900 font-semibold px-6">
                Начать бесплатно
              </Button>
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden p-2 text-slate-600"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="md:hidden bg-white border-b border-slate-100 px-6 py-4 space-y-4 shadow-xl">
          <a href="#features" onClick={() => setMobileMenuOpen(false)} className="block text-slate-600 font-medium">Возможности</a>
          <a href="#how-it-works" onClick={() => setMobileMenuOpen(false)} className="block text-slate-600 font-medium">Как это работает</a>
          <a href="#pricing" onClick={() => setMobileMenuOpen(false)} className="block text-slate-600 font-medium">Тарифы</a>
          <Link to="/login" className="block pt-2">
            <Button className="w-full bg-blue-600 hover:bg-blue-700 text-white rounded-full">
              Начать бесплатно
            </Button>
          </Link>
        </div>
      )}
    </header>
  );
}

function HeroSection() {
  return (
    <section className="relative pt-32 pb-40 px-6 overflow-hidden">
      <div className="max-w-[1400px] mx-auto relative z-10">
        
        {/* Floating Elements - Hidden on mobile, visible on lg */}
        <div className="hidden lg:block absolute inset-0 pointer-events-none">
          
          {/* Top Left: Yellow Note */}
          <div className="absolute top-10 left-4 xl:left-10 w-48 bg-[#fef08a] rounded-sm shadow-xl -rotate-6 p-6 flex flex-col justify-between transform transition-transform hover:-rotate-3 duration-300 pointer-events-auto">
            <div className="w-3 h-3 rounded-full bg-red-400 mx-auto -mt-2 mb-4 opacity-50 shadow-sm"></div>
            <p className="font-medium text-slate-700 text-lg leading-tight mb-8">
              Не забудь проверить лимиты CPL!
            </p>
            <div className="absolute -bottom-6 -right-6 w-12 h-12 bg-white rounded-xl shadow-lg flex items-center justify-center rotate-6">
              <CheckCircle2 className="w-6 h-6 text-blue-600" />
            </div>
          </div>

          {/* Top Right: Time/Alert Card */}
          <div className="absolute top-20 right-4 xl:right-10 w-64 bg-white rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] p-5 rotate-3 transform transition-transform hover:rotate-0 duration-300 pointer-events-auto">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-slate-50 rounded-full flex items-center justify-center border border-slate-100">
                <Clock className="w-5 h-5 text-slate-500" />
              </div>
              <div>
                <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">Мониторинг</div>
                <div className="text-sm font-bold text-slate-900">Активен 24/7</div>
              </div>
            </div>
            <div className="bg-blue-50 rounded-2xl p-3 flex items-center gap-3 border border-blue-100">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></div>
              <span className="text-xs font-bold text-blue-700">Сканирование...</span>
              <span className="ml-auto text-xs text-blue-400">5м</span>
            </div>
          </div>

          {/* Bottom Left: Campaign Stats */}
          <div className="absolute bottom-0 left-4 xl:left-10 w-72 bg-white rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] p-6 -rotate-2 transform transition-transform hover:rotate-0 duration-300 pointer-events-auto border border-slate-50">
             <div className="flex justify-between items-center mb-6">
                <div className="text-sm font-bold text-slate-900">Задачи на сегодня</div>
                <div className="w-2 h-2 rounded-full bg-green-500"></div>
             </div>
             <div className="space-y-4">
               <div className="group p-3 rounded-2xl bg-slate-50 hover:bg-blue-50 transition-colors cursor-pointer">
                 <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs font-medium text-slate-500 group-hover:text-blue-600">Кампания #123</span>
                    <span className="ml-auto text-xs font-bold text-red-500">CPL +40%</span>
                 </div>
                 <div className="h-1.5 bg-slate-200 rounded-full w-full overflow-hidden">
                    <div className="h-full bg-red-500 w-[85%] rounded-full"></div>
                 </div>
               </div>
               
               <div className="group p-3 rounded-2xl bg-slate-50 hover:bg-blue-50 transition-colors cursor-pointer">
                 <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs font-medium text-slate-500 group-hover:text-blue-600">Кампания #456</span>
                    <span className="ml-auto text-xs font-bold text-green-500">OK</span>
                 </div>
                 <div className="h-1.5 bg-slate-200 rounded-full w-full overflow-hidden">
                    <div className="h-full bg-blue-500 w-[45%] rounded-full"></div>
                 </div>
               </div>
             </div>
          </div>

          {/* Bottom Right: Integrations */}
          <div className="absolute bottom-10 right-4 xl:right-10 w-auto bg-white rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] p-6 rotate-6 transform transition-transform hover:rotate-3 duration-300 pointer-events-auto border border-slate-50">
            <div className="text-sm font-bold text-slate-900 mb-4 text-center">Интеграции</div>
            <div className="flex items-center gap-4">
              <div className="w-14 h-14 bg-white border-2 border-slate-100 rounded-2xl flex items-center justify-center hover:border-blue-200 hover:-translate-y-1 transition-all">
                 <svg viewBox="0 0 24 24" className="w-7 h-7 text-[#0077FF] fill-current"><path d="M15.07 2H8.93C3.33 2 2 3.33 2 8.93v6.14C2 20.67 3.33 22 8.93 22h6.14c5.6 0 6.93-1.33 6.93-6.93V8.93C22 3.33 20.67 2 15.07 2zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4z"/></svg>
              </div>
              <div className="w-14 h-14 bg-white border-2 border-slate-100 rounded-2xl flex items-center justify-center hover:border-blue-200 hover:-translate-y-1 transition-all">
                 <Send className="w-7 h-7 text-[#24A1DE]" />
              </div>
            </div>
          </div>

        </div>

        {/* Main Content */}
        <div className="relative z-20 max-w-4xl mx-auto text-center pt-20">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-700 rounded-full text-sm font-semibold mb-10 hover:bg-blue-100 transition-colors cursor-default border border-blue-100">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            Сервис авто-правил для VK Ads
          </div>

          <h1 className="text-5xl sm:text-7xl font-bold text-slate-900 tracking-tight leading-[1.1] mb-10">
            Защитите бюджет <br/>
            от слива <span className="text-blue-600">на автопилоте</span>
          </h1>
          
          <p className="text-xl sm:text-2xl text-slate-500 mb-14 max-w-2xl mx-auto leading-relaxed font-light">
            AdPilot круглосуточно следит за ставками, CPL и CTR. 
            Останавливает неэффективные объявления и присылает отчеты в Telegram.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
             <Link to="/login">
              <Button size="lg" className="h-16 px-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full text-lg font-bold shadow-xl shadow-blue-600/30 transition-all hover:scale-105 hover:shadow-2xl">
                Подключить кабинет бесплатно
              </Button>
            </Link>
            <div className="flex items-center gap-2 text-slate-500 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span>Без привязки карты</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const benefits = [
    {
      icon: Shield,
      title: 'Щит от слива бюджета',
      description: 'Больше никаких сюрпризов утром. Если CPL превысит норму или CTR упадет ниже плинтуса — мы моментально остановим объявление.',
    },
    {
      icon: Clock,
      title: 'Реакция быстрее человека',
      description: 'Робот проверяет кампании каждые 5 минут. Человек физически не может так часто обновлять статистику. Мы реагируем за 60 секунд.',
    },
    {
      icon: Bell,
      title: 'Полный контроль в Telegram',
      description: 'Вам не нужно сидеть в кабинете. Получайте отчеты и критические уведомления прямо в мессенджер, где бы вы ни находились.',
    },
    {
      icon: BarChart3,
      title: 'Визуализация экономии',
      description: 'Наглядный график покажет, сколько денег мы сберегли вам сегодня. Легко обосновать стоимость сервиса перед клиентом.',
    },
  ];

  return (
    <>
      {/* Pain Points Section - Why do you need this? */}
      <section className="py-16 px-6 relative z-10 bg-slate-50/50">
        <div className="max-w-[1200px] mx-auto">
           <div className="text-center mb-12">
            <h2 className="text-2xl sm:text-3xl font-bold text-slate-900 mb-4">
              Почему таргетологи теряют деньги?
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-6">
            <div className="bg-white p-6 rounded-2xl border border-red-100 shadow-sm">
               <div className="text-4xl mb-4">😫</div>
               <h3 className="font-bold text-lg mb-2">Слив бюджета ночью</h3>
               <p className="text-slate-600 text-sm">Пока вы спите, алгоритм VK может открутить 5000₽ на нерабочую связку. Утром будет больно.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-orange-100 shadow-sm">
               <div className="text-4xl mb-4">😵‍💫</div>
               <h3 className="font-bold text-lg mb-2">Рутина и выгорание</h3>
               <p className="text-slate-600 text-sm">Постоянно обновлять кабинет и проверять ставки — это путь к неврозу, а не к масштабированию.</p>
            </div>
            <div className="bg-white p-6 rounded-2xl border border-yellow-100 shadow-sm">
               <div className="text-4xl mb-4">📉</div>
               <h3 className="font-bold text-lg mb-2">Человеческий фактор</h3>
               <p className="text-slate-600 text-sm">Забыли выключить тест? Не заметили падение CTR? Ошибки стоят денег. Робот не ошибается.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits Section */}
      <section id="features" className="py-24 px-6 relative z-10">
        <div className="max-w-[1200px] mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
              Ваш личный ассистент
            </h2>
            <p className="text-lg text-slate-600 max-w-2xl mx-auto">
              Забирает рутину, оставляет стратегию
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-8">
            {benefits.map((f, i) => (
              <div key={i} className="group p-8 rounded-3xl bg-white border border-slate-200 hover:border-blue-200 hover:shadow-xl hover:shadow-blue-900/5 transition-all duration-300">
                <div className="w-14 h-14 bg-blue-50 rounded-2xl flex items-center justify-center mb-6 group-hover:bg-blue-600 transition-colors duration-300">
                  <f.icon className="w-7 h-7 text-blue-600 group-hover:text-white transition-colors duration-300" />
                </div>
                <h3 className="text-xl font-bold text-slate-900 mb-3">{f.title}</h3>
                <p className="text-slate-600 leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function HowItWorksSection() {
  const steps = [
    {
      icon: UserPlus,
      step: '1',
      title: 'Авторизация через VK',
      description: 'Войдите через VK OAuth и подключите свой рекламный кабинет VK Ads.',
    },
    {
      icon: Settings,
      step: '2',
      title: 'Настройка правил',
      description: 'Выберите готовый пресет или создайте свои правила: лимит CPL, мин. CTR, быстрый скрут.',
    },
    {
      icon: Send,
      step: '3',
      title: 'Подключение Telegram',
      description: 'Привяжите Telegram для получения мгновенных уведомлений о срабатывании правил.',
    },
    {
      icon: LineChart,
      step: '4',
      title: 'Отслеживание экономии',
      description: 'Смотрите сколько денег сэкономлено на дашборде. Показывайте отчёты клиентам.',
    },
  ];

  return (
    <section id="how-it-works" className="py-24 px-6 bg-slate-50/80 backdrop-blur-sm border-y border-slate-200">
      <div className="max-w-[1200px] mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
            Как это работает
          </h2>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            4 простых шага для защиты вашего бюджета
          </p>
        </div>

        <div className="grid md:grid-cols-4 gap-8 relative">
          {/* Connector Line (Desktop) */}
          <div className="hidden md:block absolute top-8 left-[10%] right-[10%] h-0.5 bg-gradient-to-r from-slate-200 via-blue-200 to-slate-200" />
          
          {steps.map((s, i) => (
            <div key={i} className="text-center relative z-10 group">
              <div className="w-16 h-16 bg-white border-4 border-slate-50 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-sm group-hover:border-blue-100 group-hover:shadow-md transition-all duration-300">
                <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center text-white text-lg font-bold">
                  {s.step}
                </div>
              </div>
              <h3 className="text-lg font-bold text-slate-900 mb-3">{s.title}</h3>
              <p className="text-slate-600 text-sm leading-relaxed">{s.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  const plans = [
    {
      id: 'freemium',
      name: 'Freemium',
      price: '0',
      description: 'Для знакомства с сервисом',
      features: [
        '1 рекламный кабинет',
        '2 правила',
        'Уведомления в Telegram',
        'Без автоостановки',
      ],
      cta: 'Начать бесплатно',
      highlighted: false,
    },
    {
      id: 'start',
      name: 'Start',
      price: '990',
      description: 'Для фрилансеров',
      features: [
        '3 рекламных кабинета',
        '10 правил',
        'Уведомления в Telegram',
        'Автоостановка объявлений',
        'Дашборд экономии',
      ],
      cta: 'Выбрать Start',
      highlighted: true,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '2 490',
      description: 'Для агентств',
      features: [
        'Безлимит кабинетов',
        'Безлимит правил',
        'Уведомления в Telegram',
        'Автоостановка объявлений',
        'Дашборд экономии',
        'Приоритетная поддержка',
      ],
      cta: 'Выбрать Pro',
      highlighted: false,
    },
  ];

  return (
    <section id="pricing" className="py-24 px-6 relative z-10">
      <div className="max-w-[1200px] mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
            Тарифы
          </h2>
          <p className="text-lg text-slate-600 max-w-2xl mx-auto">
            Выберите план, который подходит вашим задачам
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto items-center">
          {plans.map((plan, i) => (
            <div
              key={i}
              className={cn(
                "rounded-3xl p-8 border transition-all duration-300 relative",
                plan.highlighted
                  ? "border-blue-200 bg-white shadow-2xl shadow-blue-900/10 scale-110 z-10"
                  : "border-slate-200 bg-white hover:border-blue-100 hover:shadow-lg z-0"
              )}
            >
              {plan.highlighted && (
                <div className="absolute -top-4 left-0 right-0 text-center">
                  <span className="px-4 py-1.5 bg-blue-600 text-white text-xs font-bold uppercase tracking-wider rounded-full shadow-lg shadow-blue-600/30">
                    Популярный
                  </span>
                </div>
              )}
              <div className="text-center mb-8">
                <h3 className="text-xl font-bold text-slate-900 mb-2">{plan.name}</h3>
                <p className="text-sm text-slate-500 mb-6">{plan.description}</p>
                <div className="flex items-baseline justify-center gap-1">
                  <span className="text-5xl font-bold text-slate-900 tracking-tight">{plan.price}</span>
                  <span className="text-slate-500 font-medium">₽/мес</span>
                </div>
              </div>
              <ul className="space-y-4 mb-8">
                {plan.features.map((feature, j) => (
                  <li key={j} className="flex items-center gap-3 text-sm text-slate-700">
                    <div className={cn(
                      "w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0",
                      plan.highlighted ? "bg-blue-100" : "bg-slate-100"
                    )}>
                      <CheckCircle2 className={cn(
                        "w-3.5 h-3.5",
                        plan.highlighted ? "text-blue-600" : "text-slate-500"
                      )} />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>
              <Link to={`/pricing?plan=${plan.id}`} className="block">
                <Button
                  className={cn(
                    "w-full h-12 rounded-xl font-bold transition-all",
                    plan.highlighted
                      ? "bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-600/20 hover:shadow-xl hover:shadow-blue-600/30"
                      : "bg-slate-50 hover:bg-slate-100 text-slate-900"
                  )}
                >
                  {plan.cta}
                </Button>
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const faqs = [
    {
      question: 'Как AdPilot подключается к VK Ads?',
      answer: 'Через официальный VK OAuth. Вы авторизуетесь через свой аккаунт ВКонтакте, и система получает доступ к вашим рекламным кабинетам через официальное API.',
    },
    {
      question: 'Безопасно ли давать доступ к рекламному кабинету?',
      answer: 'Да. AdPilot использует официальное VK Ads API с OAuth авторизацией. Мы не храним ваши пароли. Вы можете отозвать доступ в любой момент в настройках VK.',
    },
    {
      question: 'Как быстро срабатывают правила?',
      answer: 'Система проверяет кампании каждые 5 минут. При обнаружении нарушения правила реакция происходит менее чем за 60 секунд — остановка объявления и уведомление в Telegram.',
    },
    {
      question: 'Можно ли отменить автоматическую остановку?',
      answer: 'Да. В уведомлении Telegram есть кнопка «Отменить остановку». Также в течение 5 минут после срабатывания можно отменить действие через веб-интерфейс.',
    },
    {
      question: 'Как рассчитывается экономия?',
      answer: 'Потенциальная экономия = средний расход в минуту за последний час × оставшееся время до конца дня. Это показывает, сколько денег было бы потрачено, если бы объявление не остановили.',
    },
  ];

  return (
    <section id="faq" className="py-24 px-6 bg-slate-50/50 border-t border-slate-200">
      <div className="max-w-[800px] mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-slate-900 mb-4 tracking-tight">
            Частые вопросы
          </h2>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, i) => (
            <div
              key={i}
              className="bg-white rounded-2xl border border-slate-200 overflow-hidden transition-all hover:border-blue-200"
            >
              <button
                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                className="w-full px-8 py-6 flex items-center justify-between text-left"
              >
                <span className="font-bold text-slate-900 text-lg">{faq.question}</span>
                <ChevronDown
                  className={cn(
                    "w-5 h-5 text-slate-400 transition-transform duration-300",
                    openIndex === i && "rotate-180 text-blue-600"
                  )}
                />
              </button>
              <div
                className={cn(
                  "px-8 text-slate-600 overflow-hidden transition-all duration-300",
                  openIndex === i ? "max-h-48 pb-6 opacity-100" : "max-h-0 opacity-0"
                )}
              >
                {faq.answer}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="py-12 px-6 bg-slate-900 text-white relative z-10">
      <div className="max-w-[1200px] mx-auto">
        <div className="flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20">
              <Zap className="w-5 h-5 text-white fill-white" />
            </div>
            <span className="text-xl font-bold tracking-tight">AdPilot</span>
          </div>
          <div className="flex gap-8 text-slate-400 text-sm font-medium">
            <Link to="/privacy" className="hover:text-blue-400 transition-colors">Политика конфиденциальности</Link>
            <Link to="/terms" className="hover:text-blue-400 transition-colors">Условия использования</Link>
            <a href="https://t.me/adpilot_support" target="_blank" rel="noopener noreferrer" className="hover:text-blue-400 transition-colors">Поддержка</a>
          </div>
          <div className="text-slate-500 text-sm font-medium text-center md:text-right">
            <p>© {new Date().getFullYear()} AdPilot</p>
            <p className="text-slate-600 text-xs mt-1">ИП Медведева Анжелика Александровна УНП 491464862 Жлобинским районным исполнительным комитетом 09 марта 2022 года. Почтовый адрес: РБ, Гомельская обл., г.Жлобин мк3, д43</p>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-dot-pattern">
      <LandingHeader />
      <main>
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <PricingSection />
        <FAQSection />
      </main>
      <LandingFooter />
    </div>
  );
}
