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
    │   ├── reviews.js         # Маленький loader для Tilda
    │   └── reviews.bundle.js  # Собранный код виджета
    ├── package.json           # Зависимости: express, better-sqlite3, cors, node-cron
    └── nginx-mbs-reviews.conf # Nginx location блоки для /reviews, /trainers
```

## Как устроено

```
Tilda (ровно один tilda-embed.html)
    ↓ defer /widgets/reviews.js → async /widgets/reviews.bundle.js
Hosted reviews widget
    ├─ /reviews → nginx → Node.js → SQLite snapshot → YClients API
    └─ /api/trainers.json + /api/advisors.json → актуальные публичные профили
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
- `https://api.barista-school.ru/static/karta-uchenikov/karta-uchenikov.js` — удалён с главной 2026-06-09.

Виджет отзывов переведён на безопасную схему: Tilda грузит маленький loader `/widgets/reviews.js`, а основной код `/widgets/reviews.bundle.js` подключается асинхронно. Отзывы читаются из серверного snapshot-кэша, а не из yClients напрямую из браузера посетителя.

### Правило для будущих Tilda-блоков

Перед публикацией любого кастомного HTML-блока проверить:

- внутри блока нет `<!DOCTYPE>`, `<html>`, `<head>`, `<body>`, `</body>`, `</html>`;
- внешние `<script src="...">` по возможности имеют `defer` или грузятся через маленький async-loader;
- блок не делает массовые запросы к API при каждой загрузке страницы;
- если блок зависит от backend, у него есть timeout, fallback и кэш.

## Мониторинг доступности сайта

### Зачем

Если `baristaschool.ru` или отдельные Tilda-блоки то грузятся, то не грузятся, мониторинг собирает факты из двух источников:

- браузер посетителя: ошибки JS, незагрузившиеся ресурсы, зависшие виджеты, медленные API-запросы;
- сервер: cron-проверки ключевых страниц и ресурсов раз в минуту.

Мониторинг не пишет телефоны, email, содержимое форм и другие персональные данные. URL очищаются до `origin + pathname`, IP хранится только как короткий SHA-256 hash.

### Код для Tilda

Вставить один раз в общий HTML-код сайта Tilda, лучше в `Настройки сайта → Ещё → HTML-код перед закрывающим </body>`:

```html
<script defer src="https://api.barista-school.ru/site-health/monitor.js"></script>
```

Если нужно временно обойти кэш Safari/Tilda:

```html
<script defer src="https://api.barista-school.ru/site-health/monitor.js?v=20260608-1"></script>
```

### Что логируется

| Событие | Когда появляется |
|---|---|
| `page_load` | Страница загрузилась в браузере |
| `slow_page` | Загрузка страницы заняла больше 12 секунд |
| `resource_error` | Не загрузился важный внешний JS/CSS/image |
| `js_error` | Ошибка JavaScript на странице |
| `promise_error` | Необработанная ошибка Promise |
| `fetch_problem` | API-запрос вернул ошибку или шёл дольше 10 секунд |
| `fetch_error` | API-запрос упал по сети/timeout |
| `slow_resource` | Важный внешний ресурс грузился дольше 8 секунд |
| `widget_problem` | Через 15 секунд root-блок виджета пустой, в skeleton или с текстом ошибки |
| `server_check` | Серверная проверка URL раз в минуту |
| `server_check_error` | Серверная проверка URL упала |

### Где смотреть

Лог на сервере:

```text
/root/app/data/site-health.jsonl
```

Защищённый отчёт:

```bash
curl -H "X-Admin-Key: $ADMIN_KEY" \
  "https://api.barista-school.ru/site-health/report?limit=500"
```

Или в браузере:

```text
https://api.barista-school.ru/site-health/report?key=ADMIN_KEY&limit=500
```

`ADMIN_KEY` брать только из серверного `.env`, не вставлять в Tilda и не публиковать.

### Серверные проверки

По умолчанию раз в минуту проверяются core/API URL:

- `https://baristaschool.ru/`;
- `https://baristaschool.ru/coffee_club`;
- `https://baristaschool.ru/excu`;
- `https://baristaschool.ru/latte_art_battle`;
- `https://api.barista-school.ru/health`;
- `https://api.barista-school.ru/widgets/reviews.js`.

По умолчанию раз в 15 минут проверяются service URL:

- `/barista_courses`;
- `/probarista`;
- `/latte-art`;
- `/expert`;
- `/alternative`;
- `/sence`;
- `/group`;
- `/master_open`;
- `/business-intensive`;
- `/open_coffeeshop`;
- `/bar_engineering`;
- `/regions`;
- `/sca_menu`;
- `/unique_menu`;
- `/summer_drinks`;
- `/home_barista_online`;
- `/home_barista`;
- `/barista_3`;
- `/coffie_team`;
- `/coffee_club`;
- `/capping`;
- `/tea_capping`;
- `/master_doma`;
- `/casino`;
- `/excu`;
- `/latte_art_battle`;
- `/mbs_mixology_cup`.

Список core URL можно переопределить через env `SITE_HEALTH_CHECK_URLS`, интервал cron — через `SITE_HEALTH_CHECK_INTERVAL`.
Список service URL можно переопределить через env `SITE_HEALTH_SERVICE_CHECK_URLS`, интервал cron — через `SITE_HEALTH_SERVICE_CHECK_INTERVAL`.
Timeout — через `SITE_HEALTH_CHECK_TIMEOUT_MS`.
Для сетевых timeout/abort монитор делает одну повторную попытку через `SITE_HEALTH_RETRY_DELAY_MS` мс, по умолчанию 750. Если повторная попытка успешна, событие пишется как `server_check` с `attempts: 2` и `detail: retry_ok`.
Проверки core и service защищены от наложения: если предыдущий обход ещё идёт, следующий запуск этой группы пропускается.

События серверных проверок получают поле `group`: `core`, `api` или `service`.
Лог `site-health.jsonl` ротируется при 20 МБ в `site-health.jsonl.1`; старый `.1` заменяется новым, поэтому лог не растёт бесконечно.

### Ключевые эндпоинты сервера

| URL | Описание |
|-----|----------|
| `GET /widgets/reviews.js` | Серверный JS-виджет для Tilda |
| `GET /site-health/monitor.js` | Лёгкий браузерный мониторинг для Tilda |
| `POST /site-health/event` | Приём событий доступности сайта |
| `GET /site-health/report` | Защищённый отчёт по последним событиям |
| `GET /trainers?include_zero=1` | Список тренеров из STAFF_MAP + KV |
| `GET /reviews?count=N&page=N&staff_id=ID` | Первая страница отзывов из snapshot-кэша; `page>1` ограничен без `full=1` |
| `GET /reviews-bundle` | Все отзывы из snapshot одним запросом |
| `GET /health` | Проверка статуса |

### Аутентификация

- Публичные snapshot-endpoints `/reviews`, `/reviews-bundle` и `/trainers` доступны только при разрешённом `Origin` или `Referer`.
- Приватные raw endpoints `/events` и `/event/:id` требуют `ADMIN_KEY`.
- `Origin` или `Referer` должен начинаться с одного из `ALLOWED_ORIGINS`
- Без заголовка `Origin` — **403 forbidden**

### Кэш отзывов

- Отзывы собираются сервером в SQLite snapshot и по умолчанию считаются свежими 60 минут (`REVIEWS_SNAPSHOT_TTL_MINUTES`).
- Плановое принудительное обновление: каждые 30 минут на 5-й и 35-й минуте (`REVIEWS_SNAPSHOT_CRON`, cron-формат). Это изменение введено после агрегированной проверки 28.07.2026: webhook отзывов не сохранил подходящих событий, а текущий снимок состоял из 795 отзывов на 9 API-страницах.
- При рестарте PM2 snapshot прогревается автоматически, если отсутствует, устарел или имеет старую схему.
- Обычный публичный `/reviews` не отдаёт `page>1`, чтобы старый Tilda-код не создавал лавину запросов. Для технической полной выдачи использовать `/reviews-bundle` или `/reviews?...&full=1`.
- В публичный ответ не попадают `user_email`, `user_phone`, `record_id` и другие внутренние поля yClients.

### Приватный feed для Telegram-отзывов

Если задан `INTERNAL_REVIEWS_FEED_PATH`, каждое успешное обновление snapshot
атомарно публикует санированный JSON в `/opt/shared/yclients-reviews-feed.json`.
Это не HTTP-endpoint и не часть публичного nginx-контура. В нём только
стабильный ID, дата, nullable-оценка, первое имя клиента, nullable-имя тренера,
текст отзыва и, для новых отзывов, необязательный контекст визита:
`last_visit.date` и `last_visit.service_title`. Контекст берётся только из
существующего непубличного `/opt/shared/yclients-records-snapshot.json`: это
последний состоявшийся визит до полного времени отзыва, а не утверждение о
том, за какой курс оставлен отзыв.

Сначала связь выполняется по явному клиентскому ID из ответа отзывов yClients.
`user_id` комментария не считается таким ID: это отдельное пространство
идентификаторов, которое может не совпадать с `client.id` записей.
Если он отсутствует либо не даёт визита, допускается только строгий внутренний
fallback по нормализированному российскому номеру: номер должен вести ровно к
одному `client.id` в snapshot. При двух и более клиентах с одинаковым номером,
пустом или невалидном номере связь не строится. Подбора по имени или e-mail
нет. `client_id` и номер используются лишь в памяти при построении feed, а
KV-кэш привязан к ID отзыва и хранит только дату и название визита. История не
обогащается: при первом запуске функции виджет
один раз сохраняет границу в KV и берёт только последующие отзывы. Файл
создаётся временно в той же директории, синхронизируется и заменяется через
rename; права `0640`. Секреты yClients, телефоны, e-mail, полное имя, client ID
и сырой webhook в feed не попадают.

`bitrix-tools` читает этот файл как источник Telegram-digest и хранит у себя
только доставленные ID и даты. До включения consumer создаёт baseline, поэтому
история отзывов не отправляется.

### Production-статус на 29.07.2026

`INTERNAL_REVIEWS_FEED_PATH` настроен на
`/opt/shared/yclients-reviews-feed.json`. Consumer `feedback_review_digest` в
`bitrix-tools` подключён к этому файлу и отправляет только новые отзывы в
тренерский Telegram-чат через Пиберри. Перед включением 897 уже существующих
отзывов были сохранены consumer-ом как baseline без публикации истории.

Feed не читать через nginx и не использовать как публичный API. При изменении
его схемы или способа записи сначала обновить контракт в
`bitrix-tools/docs/feedback-review-digest-runbook.md` и проверить, что
невалидный либо устаревший snapshot не двигает журнал доставленных ID.

## Сервер: root@5.35.93.225

- Путь: `/root/app/`
- PM2: `pm2 show barista-reviews`
- Логи: `/root/app/logs/out.log`, `/root/app/logs/error.log`
- База данных: `/root/app/data/kv.db` (SQLite)
- Переменные окружения: `/root/app/.env`

> **Важно:** в Tilda не вставляют полный `reviews-widget.html`. Допустим ровно
> один короткий фрагмент из `tilda-embed.html`; `reviews.js` загружает
> `reviews.bundle.js` асинхронно.

### Структура директорий на сервере

```
/root/app/
├── server.js
├── kv-store.js
├── package.json
├── ecosystem.config.js
├── public/
│   └── widgets/
│       ├── reviews.js         # loader для Tilda
│       └── reviews.bundle.js  # собранный виджет
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

### Обновить hosted-виджет

1. Измените исходник `reviews-widget.html`. Если нужен новый cache-buster,
   согласованно обновите версию в `scripts/build-hosted-widget.js` и
   `tilda-embed.html`.
2. Соберите два артефакта: `node scripts/build-hosted-widget.js`.
3. Проверьте синтаксис loader и bundle, сохраните резервные копии обоих
   production-файлов и сначала загрузите `reviews.bundle.js`, затем
   `reviews.js`.
4. Для изменения только hosted-файлов перезапуск PM2 не требуется. Он нужен
   только вместе с изменениями backend.
5. В Tilda замените блок целиком на актуальное содержимое
   `tilda-embed.html`, убедитесь, что такой блок один, и опубликуйте страницу.
6. Сверьте публичные loader и bundle с собранными файлами, затем проверьте
   на главной странице ленту, селект и открытие профиля на desktop и mobile.

### Изменить private feed для Telegram

Контракт private feed состоит из трёх связанных файлов:
`server/server.js`, `server/review-feed.js` и
`server/review-visit-enrichment.js`. При изменении логики или схемы feed
выкладывать все изменившиеся файлы из этого набора, а не только `server.js`.
Перед заменой сохранять резервную копию production-файла, затем проверять
загрузку Node.js, перезапускать только `barista-reviews` и подтверждать, что
в `/opt/shared/yclients-reviews-feed.json` появился ожидаемый санированный
контекст визита. Не выводить и не публиковать client ID, телефон, e-mail или
полный ответ API.

Для изменения сериализации `last_visit` обязателен `server/review-feed.js`:
если его не выложить вместе с новой логикой обогащения, визит может быть
найден в кэше, но не попасть в Telegram-карточку.

### Код для Tilda

Вставить один раз в HTML-блок Tilda:

```html
<div id="mbs-reviews-widget" data-mbs-reviews-widget></div>
<script defer src="https://api.barista-school.ru/widgets/reviews.js?v=20260907-1"></script>
```

Это текущая версия фрагмента; при следующем cache-buster копируйте код только
из `tilda-embed.html`, а не редактируйте версию вручную в Tilda.

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
const STAGE_ONE_COUNT = 20;        // Первая быстрая порция отзывов
const FULL_LOAD_PAGE_SIZE = 50;    // legacy, используется только если включить AUTO_FULL_LOAD
const AUTO_FULL_LOAD = false;      // не включать на сайте без отдельной причины
const FETCH_TIMEOUT_MS = 15000;    // Таймаут fetch (мс)
const REVIEWS_CACHE_TTL = 30 * 60 * 1000; // localStorage кэш: 30 минут
const TRAINERS_API_URL = 'https://api.barista-school.ru/api/trainers.json';
const ADVISORS_API_URL = 'https://api.barista-school.ru/api/advisors.json';
```

### Профили и видимость специалистов

Виджет строит селект и ленту только по двум актуальным публичным каталогам:

- `trainers.json` — тренеры;
- `advisors.json` — наставники, включая Анастасию Кадушкину.

Отзыв без соответствующей карточки не выводится — так в публичный блок не попадают бывшие сотрудники. Имя специалиста отображается кнопкой и открывает общий профиль из `trainer-profile-widget.js`; Tilda-якоря для персональных поп-апов больше не используются.

Если один из каталогов кратковременно недоступен, виджет использует второй. Если недоступны оба, отзывы не показываются: это безопаснее, чем вернуть в ленту устаревшие профили.

`STAFF_MAP` backend не определяет публичный состав специалистов: для ленты и
селектора источником истины остаётся объединение двух публичных каталогов.

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
| 2026-06-19 | Новые отзывы не появлялись до суточного cron, а `ещё есть` не запускало догрузку напрямую | Snapshot принудительно обновлён через admin endpoint; подготовлен hourly snapshot cron, `ещё есть` стало кнопкой, правая стрелка догружает заранее, hosted widget обновлён до `20260619-1` |
