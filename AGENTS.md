# yclients-reviews-widget — карточка проекта

> Статус: active
> Обновлено: 2026-07-23
> ⚠️ Репозиторий ПУБЛИЧНЫЙ — не коммитить секреты и токены YClients.

- **Что это:** виджет отзывов с YClients для baristaschool.ru (Tilda).
- **Production:** hosted-фрагмент `server/public/widgets/reviews.js`; в Tilda вставлен `tilda-embed.html` (один раз).
- **Где править:** исходник `reviews-widget.html`; после правок пересобрать `scripts/build-hosted-widget.js`.
- **Как проверить:** блок отзывов на сайте.
- **Как деплоится:** сборка → hosted-файл на сервере (см. README).
- **Контур выпуска:** `reviews-widget.html` собирается в hosted loader и bundle на сервере; Tilda один раз подключает loader через `tilda-embed.html`.
- **Доказательство версии в production:** release marker, server hash и commit SHA не фиксируются; проверка — публичный hosted URL и блок отзывов на сайте.
- **Откат:** автоматического отката нет; вручную поставить предыдущие проверенные loader/bundle и при необходимости вернуть cache-buster Tilda.
- **Соседние системы:** YClients API, Tilda.
- **Главная дока:** `README.md`.
