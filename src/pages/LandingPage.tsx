import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import {
  Wallet,
  Shield,
  Bell,
  BarChart3,
  Zap,
  TrendingDown,
  CheckCircle2,
  ChevronDown,
  ArrowRight,
  MessageCircle,
} from 'lucide-react';
import { useState } from 'react';
import { cn } from '../lib/utils';

// ═══════════════════════════════════════════════════════════
// Landing Page Components
// ═══════════════════════════════════════════════════════════

function LandingHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 bg-primary rounded-lg flex items-center justify-center">
              <Wallet className="w-5 h-5 text-primary-foreground" />
            </div>
            <span className="text-xl font-bold text-foreground">AddPilot</span>
          </div>

          {/* Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Возможности
            </a>
            <a href="#how-it-works" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Как работает
            </a>
            <a href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Тарифы
            </a>
            <a href="#faq" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              FAQ
            </a>
          </nav>

          {/* Auth buttons */}
          <div className="flex items-center gap-3">
            <Link to="/login">
              <Button variant="ghost" size="sm">
                Войти
              </Button>
            </Link>
            <Link to="/login">
              <Button size="sm">
                Регистрация
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

function HeroSection() {
  return (
    <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8 bg-gradient-to-br from-blue-50 via-white to-indigo-50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center max-w-4xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6">
            <Zap className="w-4 h-4" />
            Автоматизация VK Ads
          </div>

          {/* Headline */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold text-foreground tracking-tight mb-6">
            AI-ассистент для{' '}
            <span className="text-primary">таргетологов</span>
          </h1>

          {/* Subheadline */}
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            AddPilot автоматически останавливает неэффективную рекламу,
            экономит бюджет и уведомляет вас в Telegram — пока вы спите
          </p>

          {/* CTA buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-12">
            <Link to="/login">
              <Button size="lg" className="text-base px-8 py-6">
                Попробовать бесплатно
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
            </Link>
            <a href="#how-it-works">
              <Button variant="outline" size="lg" className="text-base px-8 py-6">
                Как это работает
              </Button>
            </a>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-8 max-w-lg mx-auto">
            <div>
              <div className="text-3xl font-bold text-foreground">500+</div>
              <div className="text-sm text-muted-foreground">Пользователей</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-foreground">2M₽</div>
              <div className="text-sm text-muted-foreground">Сэкономлено</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-foreground">24/7</div>
              <div className="text-sm text-muted-foreground">Мониторинг</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features = [
    {
      icon: Shield,
      title: 'Автоматические правила',
      description: 'Настройте условия остановки рекламы по CPL, CTR, расходам. Бот сам остановит неэффективные объявления.',
    },
    {
      icon: Bell,
      title: 'Telegram уведомления',
      description: 'Мгновенные алерты о сработавших правилах. Отмените действие одной кнопкой прямо в чате.',
    },
    {
      icon: BarChart3,
      title: 'Аналитика в реальном времени',
      description: 'Отслеживайте CPL, CTR, конверсии и расходы. Графики и отчёты по каждому кабинету.',
    },
    {
      icon: TrendingDown,
      title: 'Экономия бюджета',
      description: 'В среднем пользователи экономят 15-30% рекламного бюджета благодаря автоматической оптимизации.',
    },
  ];

  return (
    <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Возможности AddPilot
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Всё что нужно для автоматизации и оптимизации вашей рекламы в VK Ads
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => (
            <Card key={index} className="border-0 shadow-lg hover:shadow-xl transition-shadow">
              <CardHeader>
                <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center mb-4">
                  <feature.icon className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-lg">{feature.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <CardDescription className="text-base">
                  {feature.description}
                </CardDescription>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const steps = [
    {
      number: '01',
      title: 'Подключите VK Ads',
      description: 'Авторизуйтесь через VK и дайте доступ к рекламным кабинетам',
    },
    {
      number: '02',
      title: 'Настройте правила',
      description: 'Создайте условия автоматической остановки: CPL > X, CTR < Y, расход > Z',
    },
    {
      number: '03',
      title: 'Подключите Telegram',
      description: 'Получайте мгновенные уведомления о действиях бота в мессенджере',
    },
    {
      number: '04',
      title: 'Экономьте бюджет',
      description: 'AddPilot работает 24/7, останавливая неэффективную рекламу автоматически',
    },
  ];

  return (
    <section id="how-it-works" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Как это работает
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Настройка занимает 5 минут. Дальше AddPilot работает автоматически.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-8">
          {steps.map((step, index) => (
            <div key={index} className="relative">
              {/* Connector line */}
              {index < steps.length - 1 && (
                <div className="hidden lg:block absolute top-8 left-[60%] w-full h-0.5 bg-primary/20" />
              )}

              <div className="text-center">
                <div className="w-16 h-16 bg-primary text-primary-foreground rounded-full flex items-center justify-center text-xl font-bold mx-auto mb-4">
                  {step.number}
                </div>
                <h3 className="text-lg font-semibold text-foreground mb-2">
                  {step.title}
                </h3>
                <p className="text-muted-foreground">
                  {step.description}
                </p>
              </div>
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
      name: 'Freemium',
      price: '0',
      period: 'навсегда',
      description: 'Для старта и тестирования',
      features: [
        '1 рекламный кабинет',
        '3 правила автоматизации',
        'Telegram-уведомления',
        'Базовая аналитика',
      ],
      cta: 'Начать бесплатно',
      popular: false,
    },
    {
      name: 'Start',
      price: '990',
      period: 'в месяц',
      description: 'Для фрилансеров и небольших проектов',
      features: [
        '3 рекламных кабинета',
        '10 правил автоматизации',
        'Telegram-уведомления',
        'Расширенная аналитика',
        'Приоритетная поддержка',
      ],
      cta: 'Выбрать Start',
      popular: true,
    },
    {
      name: 'Pro',
      price: '2 490',
      period: 'в месяц',
      description: 'Для агентств и команд',
      features: [
        '10 рекламных кабинетов',
        'Безлимитные правила',
        'Telegram-уведомления',
        'Полная аналитика',
        'Приоритетная поддержка',
        'API доступ',
      ],
      cta: 'Выбрать Pro',
      popular: false,
    },
  ];

  return (
    <section id="pricing" className="py-20 px-4 sm:px-6 lg:px-8 bg-white">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Простые и понятные тарифы
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Начните бесплатно. Перейдите на платный тариф когда будете готовы.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {plans.map((plan, index) => (
            <Card
              key={index}
              className={cn(
                'relative',
                plan.popular && 'border-primary shadow-xl scale-105'
              )}
            >
              {plan.popular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 px-4 py-1 bg-primary text-primary-foreground text-sm font-medium rounded-full">
                  Популярный
                </div>
              )}
              <CardHeader className="text-center pb-2">
                <CardTitle className="text-xl">{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-center">
                <div className="mb-6">
                  <span className="text-4xl font-bold text-foreground">{plan.price}₽</span>
                  <span className="text-muted-foreground">/{plan.period}</span>
                </div>

                <ul className="space-y-3 mb-8 text-left">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Link to="/login">
                  <Button
                    className="w-full"
                    variant={plan.popular ? 'default' : 'outline'}
                  >
                    {plan.cta}
                  </Button>
                </Link>
              </CardContent>
            </Card>
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
      question: 'Как подключить VK Ads кабинет?',
      answer: 'После регистрации нажмите "Подключить кабинет" и авторизуйтесь через VK. AddPilot получит доступ только к рекламным данным — мы не видим ваши личные сообщения или друзей.',
    },
    {
      question: 'Безопасно ли давать доступ к кабинету?',
      answer: 'Да. Мы используем официальный VK OAuth 2.0 с PKCE. Токены хранятся в зашифрованном виде. Вы можете отозвать доступ в любой момент в настройках VK.',
    },
    {
      question: 'Можно ли отменить действие бота?',
      answer: 'Да! При каждом срабатывании правила вы получаете уведомление в Telegram с кнопкой "Отменить". Нажмите её в течение 5 минут, и объявление будет запущено снова.',
    },
    {
      question: 'Что если бот ошибётся?',
      answer: 'Бот действует строго по вашим правилам. Если CPL превысил лимит — объявление остановится. Вы всегда можете отменить действие или изменить правила.',
    },
    {
      question: 'Как работает Freemium?',
      answer: 'Freemium бесплатен навсегда. Вы получаете 1 кабинет и 3 правила — этого достаточно для старта. Перейдите на платный тариф когда понадобится больше.',
    },
  ];

  return (
    <section id="faq" className="py-20 px-4 sm:px-6 lg:px-8 bg-gray-50">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Частые вопросы
          </h2>
          <p className="text-lg text-muted-foreground">
            Не нашли ответ? Напишите нам в Telegram.
          </p>
        </div>

        <div className="space-y-4">
          {faqs.map((faq, index) => (
            <div
              key={index}
              className="bg-white rounded-lg border shadow-sm overflow-hidden"
            >
              <button
                onClick={() => setOpenIndex(openIndex === index ? null : index)}
                className="w-full px-6 py-4 text-left flex items-center justify-between hover:bg-gray-50 transition-colors"
              >
                <span className="font-medium text-foreground">{faq.question}</span>
                <ChevronDown
                  className={cn(
                    'w-5 h-5 text-muted-foreground transition-transform',
                    openIndex === index && 'rotate-180'
                  )}
                />
              </button>
              {openIndex === index && (
                <div className="px-6 pb-4 text-muted-foreground">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="py-12 px-4 sm:px-6 lg:px-8 bg-foreground text-background">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-4 gap-8 mb-8">
          {/* Logo & description */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-9 h-9 bg-background rounded-lg flex items-center justify-center">
                <Wallet className="w-5 h-5 text-foreground" />
              </div>
              <span className="text-xl font-bold">AddPilot</span>
            </div>
            <p className="text-background/70 max-w-md">
              AI-ассистент для таргетологов VK Ads. Автоматизация, аналитика и экономия бюджета.
            </p>
          </div>

          {/* Links */}
          <div>
            <h4 className="font-semibold mb-4">Продукт</h4>
            <ul className="space-y-2 text-background/70">
              <li><a href="#features" className="hover:text-background transition-colors">Возможности</a></li>
              <li><a href="#pricing" className="hover:text-background transition-colors">Тарифы</a></li>
              <li><a href="#faq" className="hover:text-background transition-colors">FAQ</a></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="font-semibold mb-4">Контакты</h4>
            <ul className="space-y-2 text-background/70">
              <li className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4" />
                <a href="https://t.me/addpilot_support" className="hover:text-background transition-colors">
                  Telegram
                </a>
              </li>
              <li>support@addpilot.ru</li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-background/20 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-background/50 text-sm">
            © {new Date().getFullYear()} AddPilot. Все права защищены.
          </p>
          <div className="flex gap-6 text-sm text-background/50">
            <a href="/privacy" className="hover:text-background transition-colors">
              Политика конфиденциальности
            </a>
            <a href="/terms" className="hover:text-background transition-colors">
              Оферта
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

// ═══════════════════════════════════════════════════════════
// Main Landing Page
// ═══════════════════════════════════════════════════════════

export function LandingPage() {
  return (
    <div className="min-h-screen">
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
