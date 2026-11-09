# Проработки и бэклог — незакрытое

Порядок фич был A→B→C→D; закрыты C и D, остаются A и B. Приоритет бэклога: войс-морфер (клиент-only) → game activity (wire).

- РЕАЛИЗОВАНО — см. docs/claude/feature-log-recent.md: локализация RU/EN (D); бэкап + restore + Migrate (C); миграция server-to-server; пинг-индикатор соединения.

## Форматирование сообщений (клиент-only, M)

- Маркеры на проводе: `**bold** *italic* __underline__ ~~strike~~ ||spoiler|| \`code\``; рендер клиентский; content остаётся plain string @Size(4000) — сервер/wire/миграции не трогаются, гейт не нужен.
- Набор: 4 базовых + спойлер + инлайн-код; КОД-БЛОКИ отложены (ломают estimateRowHeight).
- Композер: тоггл «обычный/отформатированный» у кнопки эмодзи — preview тем же рендерером (НЕ WYSIWYG); правка только в обычном режиме.
- Пасс форматирования в mention-segmenter.ts по text-сегментам (рекурсивно, вложенность ок); рендер в JSX — ноль HTML/sanitizer, XSS невозможен; marked/markdown-it ОТКЛОНЕНЫ.
- Форматируются MessageRow + QuoteCard; прочие превью и старые клиенты видят плоский текст с маркерами; ILIKE-поиск и mention-офсеты не ломаются.
- Ссылки `[x](url)` не вводим (http(s)-детектор); заголовки/списки — нет. Хоткеи Ctrl+B/I/U, Ctrl+Shift+X — обернуть/снять (applyEditorText-идиома); спойлер — клик.

## Бамп мажорных версий GitHub Actions (оба репо)

- GitHub форсит экшены Node 20 → Node 24; старые мажоры теряют поддержку (прецедент 16→20) — риск упасть посреди релиза.
- Актуальные мажоры в ci.yml + release.yml обоих репо; версии сверять в Marketplace. Делать ПОСЛЕ раунда light/full + миграций.

## Session-end сигналы (shutdown при окне в трее)

- Close-to-tray-гвард не отличает shutdown Windows от X: OS жёстко терминирует процесс → teardown голоса нет, фантом-тайлы у пиров до таймаута Janus (~1 мин).
- Ловить session-end (`app.on("session-end")` / WM_QUERYENDSESSION; проверить доставку в 44.x) → initiateGracefulQuit или fire-and-forget janus destroy; оценить logoff vs shutdown.

## Войс-морфер: пара пресетов (клиент-only)

- Топология = нойзодав (media/noise-suppression.ts): mic → эффекты → processed-трек; оба пути (SFU + 1:1) его умеют — морфер сиблинг NS-движка, сервер/Janus/wire не трогаются; ВЫКЛ = шунт (родной трек).
- Radio = BiquadFilter bandpass 300–3400 Гц + WaveShaper + DynamicsCompressor; Robot = ring modulation; Pitch = `@soundtouchjs/audio-worklet` (AudioWorklet вне main-нити) — ресинтез руками НЕ писать.
- Дроп-ин войсчейнджера под WebRTC-микрофон в JS нет; Tone.js и GStreamer отвергнуты.
- Серверный мьют (Janus moderate) не задет — режет m-line, не сигнал; смена эффекта вживую = replaceTrack; кривые — на слух.
- UI: селектор off/radio/robot/pitch (voice-панель + Settings → Audio), настройка локальная.

## Активность «Играет в …» (клиентская половина)

- Регистрация: exe через файловый пикер, имя = базовое имя файла (редактируемое); список в ClientSettings.
- Детект: main листит процессы каждые ~15–30 с (npm ps-list), матч по базовому имени exe; ручной тоггл — override.
- Отображение: себе над userBar, другим — вторая строка в MembersPane. Wire: UserSummary += nullable activity (ПАРНЫЙ деплой; /topic/users уже перекрашивает ростер).
- v1 текст-ONLY без лого (внешние каталоги = API-ключи, против self-hosted); список процессов не покидает машину. Серверная половина + git-хостинг — oak-server/CLAUDE.md.

## Light/full установщик — РЕАЛИЗОВАНО

Реализовано раундом light/full-bundled + миграций (финальные каналы `latest.yml` /
`full-bundled.yml`, лестница докачки, `downloadOnServer`, kit-маркеры, релизный
CI-гейт) — актуальные решения в [release-ci.md](release-ci.md).

## Автономный агент — НЕ выбран, задел

- Self-contained shell-скрипт лестницы провижининга в tmux/nohup — миграция без клиента (статус-файл, cancel флагом); отложено: резюм/ghost/stall-логика в shell вне тестов — брать только при реальной нужде.

## A. Очистка диска аттачментами, не снос сообщений (M, 3 фазы)

- StorageGcService.runOnce = sweepOrphans → (used% > high) → purgeBelowLowWatermark (старейшие сообщения; пины/min-keep иммунны) → VACUUM FULL; аттач-сущности в БД нет (JSON messages.attachments), объекты в MinIO; форварды шарят ключи (attachmentExists в purgeBatch защищает).
- Шаг detachAttachments МЕЖДУ orphan-свипом и purge: помечать аттачи старейших сообщений `purgedAt` (AttachmentRef += append-only, без миграций БД), объекты — через посмертную проверку; до low watermark; иммунные исчерпаны → прежний purge сообщений.
- Иммунитет: count (аттачи последних N сообщений) | age (всё свежее X часов); «последние N аттачментов» = N последних сообщений с аттачами по id desc (механика minKeepMessages).
- Политика: колонки ServerProfile у watermark'ов + расширение PUT /api/server/storage + строка в Server Settings → Server; StorageGcReport += detachedAttachments/detachedBytes.
- Клиент обязателен (иначе «вечный loading»): AttachmentRef += purgedAt + tombstone-рендер (прецедент `.message-sticker-dead`) — плейт «removed by storage cleanup», estimateRowHeight не растёт; помечать, НЕ удалять реф (attachmentExists перестаёт матчить).
- Грабли: sweep-grace-days (mtime-орфаны) ≠ age-иммунитет — не смешивать; usage() меряет overlay /app — MinIO-volume на том же диске; GC не листит custom-emojis/stickers/avatars.

## B. Bot API (M, 4–5 фаз)

- Фундамент oak-server совместим: POST /api/channels/{id}/messages под Bearer; STOMP /ws (Authorization в CONNECT); idempotencyKey; CORS не мешает.
- Дыры: bot-флага на User; долгоживущих непользовательских токенов (refresh одноразовый + family-reuse-detection); админ-создания аккаунтов (invite-only); per-bot rate limit; доки; UI.
- Миграция `users += bot boolean` + `bot_owner_id`; таблица bot_tokens (SHA-256, калька RefreshToken); токен показывается ОДИН раз, без expiry, ревок админом; тот же Bearer — фильтр после провалки JWT ищет хеш (in-memory кэш).
- `POST /api/bots {username, nickname}` (гейт MANAGE_MEMBERS или только OWNER — развилка) → 201 {user, token}; `DELETE /api/bots/{id}`; перевыпуск отдельным PUT. Права ШТАТНЫМИ ролями (assignRoles есть).
- Rate limit пер-бот на POST messages (LoginRateLimiter-калька, ~30/10 мин) → 429; события — STOMP as-is, бот подписывается per-channel, реконнект его забота.
- Клиент: UserSummary += bot (append-only, ПАРНЫЙ деплой) + бейдж BOT; UI создания потом (MVP = curl). Дока: oak-server docs/BOT-API.md + echo-бот на node + ссылка из README.
- Грабли: banned/removed гейты на CONNECT уже работают; бот-токен не JWT — переименование бота его не гасит; идемпотентность-кеш пер-юзер — ботам слать с ключом.

## Отклонено: D&D Beyond-профиль

- Публичного API нет и не предвидится; только ToS-серые скрейперы с cookie-сессией юзера — не закладывать. Альтернатива: своя карточка персонажа или JSON-импорт через сторонние экспортёры.
