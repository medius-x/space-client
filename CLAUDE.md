# space-client

Electron + TypeScript **спайк-клиент** OAK-сервера. Цель — доказать на живом сервере
две фичи, недоступные Java-клиенту (стерео шар-звука, per-user громкость), системный
звук через `getDisplayMedia` и браузерный APM. После спайка — решение о полной переписи
клиента. Полный план: `C:\Users\Home\.claude\plans\goofy-leaping-sutton.md`.

## ВЕРДИКТ СПАЙКА (2026-09-04): GO — все цели доказаны на живом сервере

1. **Голос через SFU из Electron** — ✓ (двусторонний, после трёх починок диспатча, см. Грабли).
2. **СТЕРЕО шар-звука** — ✓✓✓ последовательный тест Tone L → Tone R у зрителя:
   `PASS (signal LEFT): L=-43.9 R=-100.0 Δ=56.1 dB ch=2` и
   `PASS (signal RIGHT): L=-60.6 R=-32.0 Δ=28.6 dB ch=2` — противоположный канал
   местами на цифровой тишине; обмен каналов исключён. Полная fmtp-цепочка в логе:
   SENT `stereo=1` → Janus answer `stereo=1` → wire `stereo=1` → decode ch=2.
3. **Per-user громкость + отдельная громкость шара** — ✓ (voice/share слайдеры действуют
   независимо; playout через `<audio>`, так что буст ограничен 100%).
4. **Системный звук через getDisplayMedia** — ✓ (`audio:'loopback'`, self-test:
   track channels=2 rate=48000; ноль WASAPI-кода).
5. **Браузерный APM** — ✓ голос чистый; физическая петля (микрофон вплотную к
   динамику) AEC не берёт — ожидаемо, задокументировано.

Смысл вердикта: обе фичи, похороненные в oak-client как NO-GO (headless-ADM webrtc-java),
в Electron/Chromium работают end-to-end против того же сервера без единого изменения
сервера. Решение о полной переписи (оценка 6–10 недель в нашем темпе) — за владельцем.

Физическая грабля смоука: наушники на столе + микрофон гарнитуры вплотную к «уху» =
акустическая петля, моргает MONO (оба канала громкие). Убрать микрофон от динамика.

## Текущее состояние: M3 (вложения и медиа)

M2 закрыт и закоммичен (`893b3f6`). M3 (код готов, ждёт смоука): **аплоад 2-фазный**
(`POST /api/attachments {fileName}` → `{key, uploadUrl}` → голый PUT в MinIO с
Content-Type, БЕЗ авторизации — подпись в query; видео получают клиентский
JPEG-превью: seek 5% + canvas ≤480 + отдельный слот, провал превью не блокирует
отправку — `media/video-thumbnail.ts`); **композер**: paste (clipboardData.files)
и drag-drop на чат-панель, стейджинг-бокс построчно с «×», кап 10, гейт по
ATTACH_FILES, отправка с пустым текстом при вложениях; **рендер**
(`AttachmentView`): мозаика картинок (1 крупно / 2-3 в ряд / 4+ грид 2 колонки —
`logic/attachment-layout.ts`, чистая + тесты), видео-карточка (превью+play+бейдж
длительности → модал с fresh-link recovery), аудио-карточка + закреплённый
**NowPlayingBar** (один общий трек — `media/playback.ts`: HTMLAudioElement,
resume без переустановки src, fresh-link recovery с позицией смерти, стоп на
смене канала), прочие файлы → чип в системный браузер (`space-shell:openExternal`).
**Кэш картинок** (`media/attachment-cache.ts`): память (objectURL LRU 32) → диск
(IPC `space-cache:put/get/trim`, LRU 256 МБ, ключ = стабильный MinIO key —
presigned переподписывается, HTTP-кэш бесполезен) → сеть; in-flight дедуп;
fresh-link на протухшем URL (403/404→null). **Лайтбокс**: wheel-зум, drag-пан,
dbl-reset, ←/→ внутри сообщения, Save через OS-диалог (`space-file:save`).
**Аватары**: двухфазный аплоад (оригинал ≤2048 + кроп 256 через интерактивный
`AvatarCropDialog` move+corner-resize → confirm), Re-crop из сохранённого
оригинала (`GET /api/users/me/avatar/original`), Remove; live через `/topic/users`
(RosterStore.updateUser); рендер в сообщениях/ростере/user-bar (вход — 👤 внизу
сайдбара → ProfileModal); фолбэк — цветной круг с инициалом. **Кросс-инстанс
форвард аттачей** разблокирован: fresh-link исходника → downloadBytes → слот на
целевом инстансе → uploadBytes (временный RestClient по записи).

Грабли: `Uint8Array<ArrayBufferLike>` ≠ BlobPart в строгом TS — cast `as BlobPart`;
кэш-IPC гоняет Uint8Array structured-clone'ом. Гейт 114/114.

## M2 (закрыт, 893b3f6): глубина чата + VirtualList

M1 закрыт и закоммичен (`M1: connections, channels and chat core`). M2 (код готов,
ждёт смоука): мутации сообщений edit (PATCH {content}, инлайн-редактор с oak-клавишами)
/ delete (свой или MANAGE_MESSAGES, confirm-модал); replies (replyToId, рекурсивные
цитаты depth-5 с live-патчингом `logic/reply-tree.ts` — удаление/правка оригинала
патчит цитаты локально, сервер ничего не пушит); forwards (модал с выбором
сервер+канал; same-instance — сервер копирует сам; cross-instance — снапшот-режим
через временный RestClient по записи, текст-only — АТТАЧИ до M3); reactions (10
слагов-каталог в types.ts: hundred…cross, НИКАКИХ point; чипы с toggle-mine по
selfUserId, попап-пикер из контекст-меню); mentions-рендер (сегментация по
server-офсетам); unread/read-states (сеяние из GET /api/read-states, локальные
bump'ы, ack на open/focus, бейджи в сайдбаре серый/красный, divider NEW с
auto-dismiss); уведомления (in-app тосты стек ≤3, OS Notification из renderer —
без IPC, WebAudio-колокольчик E6+квинта только на mention; декайдер:
none при open+focused); **свой VirtualList** (`domain/logic/virtual-window.ts`
чистая математика + компонент: estimate→measure высоты, prepend-анкор по старому
первому ключу с пере-утверждением 3 layout-прохода, jump с бэкфиллом кап 1000 и
re-assert 4×30мс); пагинация скроллом вверх (HISTORY_PAGE=50, конец по СЫРОЙ
странице); мультиселект (Select → клики тогглят, групповой Forward/Delete);
perf-гейт: кнопка «seed 10k» в diag. Гейт 104/104.

Отложено (осознанно): контекст-меню «Copy text» есть, markdown-lite нет (oak
backlog), day-dividers нет, автодополнение @упоминаний нет (M7-полиш), live-трекинг
ролей для гейтов — M7, кросс-инстанс форвард аттачей — M3 (нужен presigned-аплоад).

## M1 (закрыт): ConnectionSession + каналы + чат-ядро

Полная перепись oak-клиента (план: goofy-leaping-sutton.md). M0 готов: electron-vite +
React 19, стор-паттерн Emitter+useSyncExternalStore, runtime-синглтон вне React-дерева
(HMR не роняет голос), голоc/шар/оракул перенесены без потерь, старый vanilla-UI удалён.
React запрещён вне src/renderer (test/architecture.test.ts).

M1 (код готов, смоук пройден, ждёт коммита): KV-хранилище (JSON-файлы в userData,
per-key лок в main, операции get/set/merge/rotate-tokens/delete/keys); записи
подключений `connection:{uuid}` — порт ServerConnection (токены/lastChannelId/
громкости/cachedServerName); `ConnectionSession` — rest+stomp+сторы на подключение
(Channel/Message/Roster/Permission) + роутинг STOMP-топиков; ServerRail
(переключение/забыть сервер, авто-resume последнего при старте); чат:
история+группировка+композер (**Enter=send, Ctrl+Enter ИЛИ Shift+Enter=newline** —
контракт oak; swap-настройка «Ctrl+Enter sends» — M7); create/rename/delete каналов
live; клиентский гейтинг прав как в oak: композер скрыт без SEND_MESSAGES канала
(`GET /api/channels/{id}/permissions/me`), «+» и ПКМ-меню каналов — только с
MANAGE_CHANNELS (`GET /api/users/me/permissions`); громкости переехали из
localStorage в запись (коалесированный флэш 800 мс). Голос не тронут.

### Wire-контракты чата (ground truth, выжато из oak-server)

- `GET /api/channels/{id}/messages?limit=&beforeId=` — старые первыми; limit дефолт 50,
  кап 200. MessageResponse: автор ПЛОСКИЙ (authorId/authorUsername), attachments/
  mentions/reactions НИКОГДА null (пустые массивы), createdAt — ISO-строка.
  **`content` у attachment-only сообщений = null, НЕ ""** (живой краш M2-смоука:
  пустой экран при скролле вверх, segmentMessageContent упал на .length null) —
  тип Message.content честно `string | null`, все рендеры коалесят `?? ""`.
- `POST /api/channels/{id}/messages` → 201 + созданное сообщение; STOMP-echo того же id
  приходит ВСЕМ, включая отправителя → дедуп по id (MessageStore.applyLive).
- Каналы: `POST /api/channels {name, type|null→TEXT}`; rename = **PATCH
  `/api/channels/{id}/name` {name}** (голый PATCH /{id} — маршрут group-DM!);
  `DELETE /api/channels/{id}` → 204.
- Топики: `/topic/channels` (ChannelResponse, создание) · `/topic/channels.deleted`
  (bare Long) · `/topic/channels.changed` (bare Long — ПИНГ без данных после КАЖДОЙ
  мутации оверрайдов и rename → единственно правильная реакция — diff-refetch) ·
  `/topic/server` (ServerProfileResponse) · сообщения канала: **`/topic/channel.{id}`**
  (ТОЧКА-разделитель; .edited/.deleted/.reactions — суффиксы для M2). Подписка на ВСЕ
  текст-каналы сразу, не только активный.
- `GET /api/server` → {id, name, avatarKey, avatarUrl, connectionHost, connectionPort}.
- Presigned-URL аттачей переподписуются на каждый fetch — identity только по `key`
  (для M3; в DTO поле thumbnailUrl с обычной орфографией — проверить на M3).

## Bootstrap для Java-разработчика (мапа maven → npm)

| Ты знаешь | Здесь | Комментарий |
|---|---|---|
| `pom.xml` | `package.json` | зависимости + скрипты |
| `.m2` (центральный кэш) | `node_modules/` (в проекте) | удалил папку → `npm install` пересоздал |
| `mvn install` | `npm install` | ставит зависимости из package.json |
| `mvn test` | `npm test` | vitest, гейт после каждой фазы |
| `mvn javafx:run` | `npm start` | сборка (esbuild) + запуск Electron |
| `mvn compile`-проверка типов | `npm run typecheck` | tsc --noEmit |
| — | `npm run build` | три бандла в `dist/` (main/preload/renderer) |
| IDEA Maven-панель | `npm run <script>` из терминала | npm-скрипты = maven-гоалы |

- Node.js уже установлен (v24 LTS, `C:\Program Files\nodejs`). Если терминал не видит
  `node`/`npm` — перезапусти терминал (PATH).
- IDE: IntelliJ Ultimate понимает TS из коробки; иначе VS Code (10 минут).
- DevTools: в окне приложения всегда открыты снизу — живой инспектор, консоль, network.
- **Ноль runtime-зависимостей**: весь протокол (REST/STOMP/Janus) написан руками в
  `src/core/` — как StompClient/JanusClient в oak-client, только на TS.

## Как запускать

```bash
cd C:\Users\Home\IdeaProjects\space-client
npm install        # один раз (и после смены package.json)
npm start          # собрать и запустить окно (инстанс A)
npm run start2     # ВТОРОЙ клиент для смоука (инстанс B: свой userData+localStorage)
npm test           # юнит-тесты (гейт)
npm run typecheck  # строгий TS
```

Два клиента на одной машине: `npm start` в одном терминале + `npm run start2` в другом.
Инстанс B получает отдельный `--space-instance=b` → свой кэш и свой localStorage
(логинься другим юзером). Single-instance lock'а нет НАМЕРЕННО — мультиинстанс
нужен для смоуков; ошибки `Unable to move the cache (0x5)` были симптомом драки
двух процессов за один userData.

Сервер для смоуков (запускается отдельно, как обычно):
`cd oak-server/env && docker compose up -d` + `mvn spring-boot:run` в oak-server.

## Структура

- `electron/` — main-процесс (окно, display-media handler, KV-хранилище, security) и preload.
- `src/core/` — протокольные модули, framework-agnostic: `rest.ts` (Bearer +
  single-flight refresh + чат/каналы/профиль), `stomp.ts` (STOMP 1.2 поверх raw WS),
  `janus.ts` (REST long-poll), `janus-events.ts`, `sdp.ts` (стерео-мунж),
  `classifier.ts`, `sfu.ts` (publisher+subscriber), `audio-math.ts`, `auth.ts`
  (TokenStorage: local / memory / record-backed).
- `src/domain/` — React-FREE логика (архитектурный тест запрещает react вне renderer):
  `lib/store.ts` (Emitter), `persistence/kv-client.ts` (renderer-обёртка KV с
  memory-fallback), `session/connection-record.ts` (запись подключения + директория +
  RecordTokenStorage с CAS-ротацией), `session/connection-session.ts` (стек на
  подключение: rest+stomp+сторы+топики), `stores/` (ChannelStore/MessageStore/
  RosterStore), `logic/message-grouping.ts` (чистая группировка).
- `src/media/RoomAudio.ts` — WebAudio-граф: `<audio>`-плейаут per-feed + параллельный
  анализ, per-user GainNode (голос/шар раздельно), speaking, стерео-оракул, тест-тон.
- `src/renderer/` — React: `runtime.ts` (синглтон вне React-дерева: appStore,
  connectionDirectory, sessionBinding, голос), компоненты (ServerRail/Sidebar/ChatPane/
  VoiceRoom/Diagnostics/ContextMenu/Modal/LoginScreen/MainScreen), `styles/global.css`.
- `test/` — vitest (node-env): core + domain; все импурные модули принимают fake-и
  (`test/mocks/`).

## Wire-контракт (ground truth, не отклоняться)

Задокументирован в плане (файл выше) и выжат из oak-client тремя разведагентами.
Ключевые жёсткие факты: Janus — REST long-poll (WS сломан), токен — top-level поле
`"token"` в теле POST (query на POST = 403), no-trickle (vanilla ICE), onnegotiationneeded
на publisher PC — no-op, subscriber join отложен до непустого streams (иначе 429 травит
handle), классификация share-аудио по mindex, два пространства мидов (slot ≠ feed_mid),
`stereo=1` мунж в fmtp share-audio m-line — Janus его эхает.

## Правила работы (как в oak-client)

- Гейт после каждой фазы: `npm test` + `npm run typecheck` зелёные.
- Новые файлы сразу `git add`. Коммиты только по явной команде; subject на английском.
- Никаких single-letter имён (кроме i/j цикла и T/E/K/V генериков); комментарии в коде
  на английском; тесты — на поведение, а не на реализацию.
- Логика, которую можно вынести в чистые функции, живет в чистых функциях с тестами;
  DOM/WebAudio-обвязка вокруг них тонкая.

## Грабли, уже пойманные здесь

- **NUL-литералы в исходниках**: не писать `"\u0000"` в JS/TS-строках (коллапсируется
  в реальный байт, grep считает файл бинарным) — использовать `String.fromCharCode(0)`.
- Строгий TS 5.9: типизированные массивы дженеричны над буфером —
  `Float32Array<ArrayBuffer>` для `getFloatTimeDomainData`.
- STOMP: heartbeat-EOL может приклеиться к началу кадра в одном WS-сообщении — парсер
  стриппает ведущие пустые строки.
- **Удалённые WebRTC-треки молчат через `createMediaStreamSource`** (живой смоук
  2026-09-03: цепи строились, треки live, тишина; локальные треки при этом работают).
  Рабочий путь: скрытый `<audio srcObject=…>` + `createMediaElementSource` — граф
  (гейны, метры, стерео-сплиттер) питается от него. Локальный мик — по-прежнему
  `createMediaStreamSource` (анализ без плейаута).
- **`splitter.connect(gain)` несёт только ЛЕВЫЙ канал** — стерео-микс в гейн надо
  пускать напрямую `source.connect(gain)`, сплиттер оставлять параллельным тапом.
- **Отрывать DOM-глобали от ресивера нельзя**: `globalThis.fetch` без `.bind(globalThis)`
  в Chromium кидает `Illegal invocation` (node-fetch — нет, поэтому фейки в тестах этого
  не видят). То же потенциально касается других window-методов.
