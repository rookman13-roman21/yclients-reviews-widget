# YClients Reviews Widget — МШБ

Виджет отзывов с YClients для сайта baristaschool.ru (Tilda).

## Структура проекта

```
yclients-reviews-widget/
├── reviews-widget.html        # Код виджета для вставки в Tilda
└── server/
    ├── server.js              # Node.js прокси-сервер (barista-reviews)
    ├── kv-store.js            # SQLite KV-хранилище (события webhook)
    ├── package.json           # Зависимости: express, better-sqlite3, cors, node-cron
    └── nginx-mbs-reviews.conf # Nginx location блоки для /reviews, /trainers
```

## Как устроено

```
Tilda (reviews-widget.html)
    ↓ fetch /trainers, /reviews, /reviews-bundle
nginx (api.barista-school.ru)
    ↓ proxy_pass port 3000
Node.js server.js (PM2: barista-reviews)
    ↓ API
YClients API (company 453962)
```

### Ключевые эндпоинты сервера

| URL | Описание |
|-----|----------|
| `GET /trainers?include_zero=1` | Список тренеров из STAFF_MAP + KV |
| `GET /reviews?count=N&page=N&staff_id=ID` | Постраничные отзывы из YClients |
| `GET /reviews-bundle` | Все отзывы одним запросом (кэш 6ч) |
| `GET /health` | Проверка статуса |

### Аутентификация

- `X-API-Key: <YCLIENTS_READ_KEY>` — для чтения (если задан в .env)
- `Origin` или `Referer` — должен начинаться с одного из `ALLOWED_ORIGINS`
- Без заголовка `Origin` — **403 forbidden**

## Сервер: root@5.35.93.225

- Путь: `/root/app/`
- PM2: `pm2 show barista-reviews`
- Логи: `/root/app/logs/out.log`, `/root/app/logs/error.log`
- База данных: `/root/app/data/kv.db` (SQLite)
- Переменные окружения: `/root/app/.env`

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

## Деплой

```bash
# Обновить server.js
scp -i ~/.ssh/id_ed25519 server/server.js root@5.35.93.225:/root/app/server.js
ssh -i ~/.ssh/id_ed25519 root@5.35.93.225 'pm2 restart barista-reviews'

# Обновить nginx (если менялся mbs-reviews.conf)
scp -i ~/.ssh/id_ed25519 server/nginx-mbs-reviews.conf root@5.35.93.225:/etc/nginx/snippets/mbs-reviews.conf
ssh -i ~/.ssh/id_ed25519 root@5.35.93.225 'nginx -t && systemctl reload nginx'
```

## Виджет (reviews-widget.html)

Вставляется в Tilda как HTML-блок.

### Настройки (верх скрипта)

```js
const WORKER_URL = 'https://api.barista-school.ru'; // URL прокси-сервера
const API_KEY = '...';        // X-API-Key (если задан в .env YCLIENTS_READ_KEY)
const STAGE_ONE_COUNT = 20;   // Первая быстрая порция отзывов
const FULL_LOAD_PAGE_SIZE = 50; // Размер страницы при полной загрузке
```

### Видимость тренеров (TRAINER_VISIBILITY)

```js
const TRAINER_VISIBILITY = {
  '1322544': 1,  // Роман Суслин — показывать
  '2748512': 1,  // Денис Храмов — показывать
  '3866140': 1,  // Никита — показывать
  ...
  '2730371': 0,  // Александра — скрыть
};
```

### Ссылки на попапы тренеров

```js
const TRAINER_POPUPS = {
  '2748512': '#denefrem',
  '1322544': '#roman',
  ...
};
```

## Зависимости сервера

| Пакет | Версия | Назначение |
|-------|--------|-----------|
| `express` | latest | HTTP-сервер |
| `better-sqlite3` | latest | SQLite KV-хранилище |
| `cors` | latest | CORS-заголовки |
| `node-cron` | **v4** | Периодические задачи (кэш, очистка) |

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
