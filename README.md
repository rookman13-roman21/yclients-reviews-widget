# YClients Reviews Widget — МШБ

Виджет отзывов с YClients для сайта baristaschool.ru (Tilda).

## Структура проекта

```
yclients-reviews-widget/
├── reviews-widget.html        # Исходник виджета (HTML/CSS/JS)
├── tilda-embed.html           # Короткий код для Tilda: вставить один раз
├── scripts/
│   └── build-hosted-widget.js # Сборка server/public/widgets/reviews.js
└── server/
    ├── server.js              # Node.js прокси-сервер (PM2: barista-reviews)
    ├── kv-store.js            # SQLite KV-хранилище (события webhook)
    ├── public/widgets/
    │   └── reviews.js         # Серверная версия виджета для Tilda
    ├── package.json           # Зависимости: express, better-sqlite3, cors, node-cron
    └── nginx-mbs-reviews.conf # Nginx location блоки для /reviews, /trainers
```

## Как устроено

```
Tilda (tilda-embed.html)
    ↓ loads /widgets/reviews.js
Hosted widget JS
    ↓ fetch /trainers, /reviews
nginx (api.barista-school.ru)
    ↓ proxy_pass port 3000
Node.js server.js (PM2: barista-reviews)
    ↓ SQLite snapshot, обновление по cron 1 раз в сутки
YClients API (company 453962)
```

## Инцидент 2026-06-08: сайт Tilda не догружал блоки

### Что произошло

На `baristaschool.ru` часть страниц открывалась только до середины: отзывы, карта проектов, фотогалереи и расписания могли оставаться в skeleton/loading-состоянии или вообще не появляться. На главной странице проблема стабильно уходила после отключения блока квиза.

### Подтверждённая причина

В Tilda HTML-блок был вставлен не фрагмент, а полноценный HTML-документ:

```html
<!DOCTYPE html>
<html>
<head>...</head>
<body>...</body>
</html>
```

Для Tilda так делать нельзя. В T123/HTML-блоках допустим только фрагмент: `<style>`, нужная разметка и `<script>`, без `<!DOCTYPE>`, `<html>`, `<head>`, `<body>`, `</body>`, `</html>`. Вложенный документ преждевременно закрывал DOM и ломал все блоки ниже себя.

### Что было найдено дополнительно

На главной странице внешние синхронные скрипты без `async/defer` могут блокировать разбор HTML, если их CDN или API подвисает:

- `https://forma.tinkoff.ru/static/onlineScript.js` в `<head>`;
- `https://api.barista-school.ru/widgets/reviews.js`;
- `https://api.barista-school.ru/static/karta-uchenikov/karta-uchenikov.js`.

Виджет отзывов переведён на безопасную схему: Tilda грузит маленький loader `/widgets/reviews.js`, а основной код `/widgets/reviews.bundle.js` подключается асинхронно. Отзывы читаются из серверного snapshot-кэша, а не из yClients напрямую из браузера посетителя.

### Правило для будущих Tilda-блоков

Перед публикацией любого кастомного HTML-блока проверить:

- внутри блока нет `<!DOCTYPE>`, `<html>`, `<head>`, `<body>`, `</body>`, `</html>`;
- внешние `<script src="...">` по возможности имеют `defer` или грузятся через маленький async-loader;
- блок не делает массовые запросы к API при каждой загрузке страницы;
- если блок зависит от backend, у него есть timeout, fallback и кэш.

### Ключевые эндпоинты сервера

| URL | Описание |
|-----|----------|
| `GET /widgets/reviews.js` | Серверный JS-виджет для Tilda |
| `GET /trainers?include_zero=1` | Список тренеров из STAFF_MAP + KV |
| `GET /reviews?count=N&page=N&staff_id=ID` | Первая страница отзывов из snapshot-кэша; `page>1` ограничен без `full=1` |
| `GET /reviews-bundle` | Все отзывы из snapshot одним запросом |
| `GET /health` | Проверка статуса |

### Аутентификация

- `X-API-Key: <YCLIENTS_READ_KEY>` — для чтения (если задан в .env)
- `Origin` или `Referer` — должен начинаться с одного из `ALLOWED_ORIGINS`
- Без заголовка `Origin` — **403 forbidden**

### Кэш отзывов

- Отзывы собираются сервером в SQLite snapshot и обновляются не чаще 1 раза в сутки.
- Плановое принудительное обновление: каждый день в `04:20` МСК.
- При рестарте PM2 snapshot прогревается автоматически, если отсутствует, устарел или имеет старую схему.
- Обычный публичный `/reviews` не отдаёт `page>1`, чтобы старый Tilda-код не создавал лавину запросов. Для технической полной выдачи использовать `/reviews-bundle` или `/reviews?...&full=1`.
- В публичный ответ не попадают `user_email`, `user_phone`, `record_id` и другие внутренние поля yClients.

## Сервер: root@5.35.93.225

- Путь: `/root/app/`
- PM2: `pm2 show barista-reviews`
- Логи: `/root/app/logs/out.log`, `/root/app/logs/error.log`
- База данных: `/root/app/data/kv.db` (SQLite)
- Переменные окружения: `/root/app/.env`

> **Важно:** в Tilda больше не нужно вставлять полный `reviews-widget.html`. В Tilda вставляется короткий код из `tilda-embed.html`, а основной код виджета хранится и обновляется на сервере как `/widgets/reviews.js`.

### Структура директорий на сервере

```
/root/app/
├── server.js
├── kv-store.js
├── package.json
├── ecosystem.config.js
├── public/
│   └── widgets/
│       └── reviews.js  # JS-виджет для Tilda
├── data/
│   └── kv.db          # SQLite (webhook-события)
├── logs/
│   ├── out.log
│   └── error.log
└── node_modules/
```

### Ключевые env-переменные

```env
YCLIENTS_PARTNER_TOKEN=...   # Партнёрский токен YClients
YCLIENTS_USER_TOKEN=...      # Пользовательский токен YClients
YCLIENTS_COMPANY_ID=453962   # ID компании МШБ
YCLIENTS_READ_KEY=           # Пустой = не требует X-API-Key
ADMIN_KEY=...                # Для /admin/* эндпоинтов
ALLOWED_ORIGINS=https://baristaschool.ru,...
PORT=3000
```

### STAFF_MAP (хардкод на сервере, server.js)

```js
const STAFF_MAP = {
  3269178: 'Роман Лунгу',
  2748512: 'Денис Храмов'  // отображается как 'Денис Ефремов' через NAME_OVERRIDES
};
```

## Деплой

### Обновить сервер и hosted-виджет

```bash
node scripts/build-hosted-widget.js
scp -i ~/.ssh/id_ed25519 server/server.js root@5.35.93.225:/root/app/server.js
scp -i ~/.ssh/id_ed25519 server/public/widgets/reviews.js root@5.35.93.225:/root/app/public/widgets/reviews.js
ssh -i ~/.ssh/id_ed25519 root@5.35.93.225 'pm2 restart barista-reviews'
```

### Код для Tilda

Вставить один раз в HTML-блок Tilda:

```html
<div id="mbs-reviews-widget" data-mbs-reviews-widget></div>
<script defer src="https://api.barista-school.ru/widgets/reviews.js"></script>
```

После этого обычные изменения виджета делаются через `reviews-widget.html` → `node scripts/build-hosted-widget.js` → деплой файлов из `server/public/widgets/` на сервер. Tilda-код менять не нужно.

`/widgets/reviews.js` — маленький неблокирующий loader для Tilda. Основной код виджета лежит в `/widgets/reviews.bundle.js` и грузится асинхронно, чтобы не останавливать загрузку остальных блоков страницы.

### Обновить nginx (если менялся mbs-reviews.conf)

```bash
scp -i ~/.ssh/id_ed25519 server/nginx-mbs-reviews.conf root@5.35.93.225:/etc/nginx/snippets/mbs-reviews.conf
ssh -i ~/.ssh/id_ed25519 root@5.35.93.225 'nginx -t && systemctl reload nginx'
```

## Виджет (reviews-widget.html)

Вставляется в Tilda как HTML-блок. Двухэтапная загрузка:
- **Этап 1** — первые `STAGE_ONE_COUNT` отзывов из серверного snapshot-кэша (быстро)
- **Этап 2** — отключён по умолчанию: браузер посетителя не догружает все страницы отзывов и не обращается к yClients напрямую

### Ключевые настройки (верх скрипта)

```js
const WORKER_URL = 'https://api.barista-school.ru'; // URL прокси-сервера
const API_KEY = 'T2t7a5whm5...';  // X-API-Key (соответствует YCLIENTS_READ_KEY в .env)
const STAGE_ONE_COUNT = 20;        // Первая быстрая порция отзывов
const FULL_LOAD_PAGE_SIZE = 50;    // legacy, используется только если включить AUTO_FULL_LOAD
const AUTO_FULL_LOAD = false;      // не включать на сайте без отдельной причины
const FETCH_TIMEOUT_MS = 15000;    // Таймаут fetch (мс)
const REVIEWS_CACHE_TTL = 30 * 60 * 1000; // localStorage кэш: 30 минут
```

### Видимость тренеров (TRAINER_VISIBILITY)

`1` = показывать в фильтре и карточках, `0` = скрыть. Отсутствующий ID показывается по умолчанию.

```js
const TRAINER_VISIBILITY = {
  '2730371': 0, // Александра
  '3781544': 0, // Алина
  '1322836': 1, // Анастасия Кадушкина
  '2586628': 0, // Валерия
  '2748512': 1, // Денис Храмов (отображается как Денис Ефремов)
  '3257457': 0, // Ева Гуцу
  '2350188': 0, // Иван Колпаков
  '2164697': 0, // Максим Литвинов
  '2151123': 0, // Марина Никифорова
  '2694420': 0, // Милица Дементьева
  '3866140': 1, // Никита Баховский
  '3323198': 0, // Никита Бобачев
  '3269178': 1, // Роман Лунгу
  '3915755': 1, // Сабрина Темурова
  '1322544': 0, // Суслин Роман
  '4103142': 0, // (имя неизвестно)
  '4837950': 0, // Аркадий Скалин
};
```

### Fallback-имена (STAFF_FALLBACK)

Используются если `/trainers` недоступен — полностью зеркалирует `TRAINER_VISIBILITY` по составу ID.

### Ссылки на попапы тренеров (TRAINER_POPUPS)

```js
const TRAINER_POPUPS = {
  '2748512': '#denefrem',  // Денис Ефремов
  '3269178': '#romba',     // Роман Лунгу
  '3866140': '#nikita',    // Никита Баховский
  '3915755': '#sabrina',   // Сабрина Темурова
  '1322544': '#roman',     // Суслин Роман
  '1322836': '#nastiya',   // Анастасия Кадушкина
  '4837950': '#skalin',    // Аркадий Скалин
};
```

## Зависимости сервера

| Пакет | Версия | Назначение |
|-------|--------|-----------|
| `express` | latest | HTTP-сервер |
| `better-sqlite3` | latest | SQLite KV-хранилище |
| `cors` | latest | CORS-заголовки |
| `node-cron` | **v4** | Периодические задачи (кэш, очистка) |
| `dotenv` | latest | Загрузка .env |

> **node-cron обновлён до v4** — исправлена уязвимость в транзитивной зависимости `uuid` (GHSA-uuidv4).  
> Проверка: `npm audit` → 0 уязвимостей.

### Обновление зависимостей на сервере

```bash
ssh -i ~/.ssh/id_ed25519 root@5.35.93.225
cd /root/app
npm install
pm2 restart barista-reviews
```

---

## История исправлений

| Дата | Проблема | Решение |
|------|----------|---------|
| 2025-06-XX | `node-cron` → уязвимость uuid | Обновлён до v4, 0 уязвимостей |
| 2026-04-30 | `/trainers` и `/reviews` → 404 | Добавлен `nginx-mbs-reviews.conf` с location блоками, подключён через `include` в `sites-enabled/barista-api` |
| 2026-04-30 | `/trainers` возвращал пустой список | Добавлен параметр `?include_zero=1` в виджете (KV-база пустая, счётчики = 0, фильтр обрезал всех тренеров) |
| 2026-05-16 | XSS в `renderItem()` | `authorHtml` обёрнут в `escapeHtml()` (было: `author ? author : ''`) |
| 2026-05-16 | `console.log` спам на каждый рендер карточки | Удалён отладочный `console.log('Rendering item:', ...)` из `renderItem()` |
