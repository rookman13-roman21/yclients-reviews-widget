# yclients-reviews-widget — карточка проекта

> Статус: active
> Обновлено: 2026-09-07
> ⚠️ Репозиторий ПУБЛИЧНЫЙ — не коммитить секреты и токены YClients.

- **Что это:** виджет отзывов с YClients для baristaschool.ru (Tilda).
- **Production:** hosted-фрагмент `server/public/widgets/reviews.js`; в Tilda вставлен `tilda-embed.html` (один раз).
- **Где править:** исходник `reviews-widget.html`; после правок пересобрать `scripts/build-hosted-widget.js`.
- **Как проверить:** блок отзывов на сайте.
- **Профили специалистов:** лента и селект сверяются с `https://api.barista-school.ru/api/trainers.json` и `https://api.barista-school.ru/api/advisors.json`. Имя открывает общий `trainer-profile-widget.js`; отзыв без актуальной карточки не отображается.
- **Как деплоится:** сайт-виджет собирается в hosted-файл; изменения private feed выкладываются отдельным bundle из `server/server.js`, `server/review-feed.js` и `server/review-visit-enrichment.js` с перезапуском PM2 `barista-reviews` (см. README). Связь визита сначала идёт по ID; fallback по номеру допустим только для одного точного `client.id` и остаётся внутри процесса.
- **Контур выпуска:** `reviews-widget.html` собирается в hosted loader и bundle на сервере; Tilda один раз подключает loader через `tilda-embed.html`.
- **Доказательство версии в production:** release marker, server hash и commit SHA не фиксируются; проверка — публичный hosted URL и блок отзывов на сайте.
- **Откат:** автоматического отката нет; вручную поставить предыдущие проверенные loader/bundle и при необходимости вернуть cache-buster Tilda.
- **Соседние системы:** YClients API, Tilda.
- **Главная дока:** `README.md`.

## API-cutover yClients .ru — пакет 4042 (19.09.2026)

API-константа переводится на api.yclients.ru. Выпуск server/server.js в /root/app/server.js после backup и restart PM2 barista-reviews. Private feed и SQLite сохраняются. Проверка: comments GET, публичный snapshot и штатный cron, агрегаты TLS/429. Откат предыдущего server.js и restart того же PM2. Russian Trusted Root CA — отдельный этап; этот пакет не меняет trust. Фактический статус выкладки фиксируется в задаче 4042 и workspace release manifest.
