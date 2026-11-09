# space-client

> Project-level context file. Прочитать перед началом любой работы в `space-client`.
> Детали вынесены в `docs/claude/` — заходить по необходимости:
> [working-rules.md](docs/claude/working-rules.md) (правила работы, механики, осознанные отступления от oak),
> [pitfalls.md](docs/claude/pitfalls.md) (грабли, уже пойманные здесь — ОБЯЗАТЕЛЬНО к сведению),
> [feature-log-recent.md](docs/claude/feature-log-recent.md) (свежие фичи: решения и контракты),
> [expressions-invites.md](docs/claude/expressions-invites.md) (эмодзи, стикеры, реакции, паки, инвайты),
> [launch-rounds.md](docs/claude/launch-rounds.md) (пинг, TLS/TOFU, SSH-провижининг),
> [release-ci.md](docs/claude/release-ci.md) (light/full-дистрибутивы, CI/релизы, автообновление, лицензии),
> [milestones-m7.md](docs/claude/milestones-m7.md) (спайк-вердикт, веха M7: настройки/RBAC-UI/аудио),
> [milestones-m1-m6.md](docs/claude/milestones-m1-m6.md) (вехи M1–M6 + wire-контракты чата — ground truth),
> [research-backlog.md](docs/claude/research-backlog.md) (проработки нереализованного).

## Что это

`space-client` — desktop-клиент самохостящегося клона Discord (проект **OAK**):
**Electron + TypeScript + React**, ноль runtime-зависимостей — весь протокол
(REST/STOMP/Janus) написан руками в `src/core/`. Пара к серверу **`oak-server`**
(`../oak-server`; историческое имя клиента — `oak-client`, JavaFX-прототип).

Архитектурное правило: `src/domain/` — React-FREE логика (архитектурный тест запрещает
react вне renderer); `src/renderer/` — только UI.

## Как запускать

```bash
cd C:\Users\Home\IdeaProjects\space-client
npm install        # один раз (и после смены package.json)
npm start          # собрать и запустить окно (инстанс A)
npm run start2     # ВТОРОЙ клиент для смоука (инстанс B: свой userData+localStorage)
npm test           # юнит-тесты vitest (гейт)
npm run typecheck  # строгий TS (tsc --noEmit)
npm run build      # три бандла в dist/ (main/preload/renderer)
```

Два клиента на одной машине: `npm start` + `npm run start2` в разных терминалах;
инстанс B получает `--space-instance=b` → свой кэш и localStorage (логинься другим
юзером). Single-instance lock packaged-сборки есть, но мультиинстанс для смоуков
намеренно оставлен в dev-режиме.

Сервер для смоуков (отдельно): `cd oak-server/env && docker compose up -d` +
`mvn spring-boot:run` в oak-server.

## Структура

- `electron/` — main-процесс (окно, display-media handler, KV-хранилище, security) и preload.
- `src/core/` — протокольные модули, framework-agnostic: `rest.ts` (Bearer +
  single-flight refresh), `stomp.ts` (STOMP 1.2 поверх raw WS), `janus.ts` (REST
  long-poll), `janus-events.ts`, `sdp.ts` (стерео-мунж), `classifier.ts`, `sfu.ts`
  (publisher+subscriber), `audio-math.ts`, `auth.ts` (TokenStorage).
- `src/domain/` — React-FREE логика: `lib/store.ts` (Emitter),
  `persistence/kv-client.ts`, `session/connection-record.ts` (директория подключений +
  RecordTokenStorage с CAS-ротацией), `session/connection-session.ts` (стек на
  подключение: rest+stomp+сторы+топики), `stores/` (Channel/Message/RosterStore),
  `logic/message-grouping.ts`.
- `src/media/RoomAudio.ts` — WebAudio-граф: `<audio>`-плейаут per-feed + анализ,
  per-user GainNode (голос/шар раздельно), speaking, стерео-оракул, тест-тон.
- `src/renderer/` — React: `runtime.ts` (синглтон вне React-дерева), компоненты
  (ServerRail/Sidebar/ChatPane/VoiceRoom/Diagnostics/ContextMenu/Modal/LoginScreen/
  MainScreen), `styles/global.css`.
- `test/` — vitest (node-env): core + domain; импурные модули принимают fake-и
  (`test/mocks/`).

## Мапа для Java-разработчика (maven → npm)

`pom.xml` → `package.json`; `.m2` → `node_modules/` (в проекте); `mvn install` →
`npm install`; `mvn test` → `npm test`; `mvn javafx:run` → `npm start`; проверка типов →
`npm run typecheck`. Node.js v24 LTS; если терминал не видит `node`/`npm` — перезапустить
терминал (PATH). DevTools всегда открыты снизу в окне приложения.

## Wire-контракт (ground truth, не отклоняться)

Задокументирован в [milestones-m1-m6.md](docs/claude/milestones-m1-m6.md) (контракты чата) и
зеркалит record'ы oak-server. Ключевые жёсткие факты: Janus — REST long-poll (WS сломан),
токен — top-level поле `"token"` в теле POST (query на POST = 403), no-trickle (vanilla
ICE), onnegotiationneeded на publisher PC — no-op, subscriber join отложен до непустого
streams (иначе 429 травит handle), классификация share-аудио по mindex, два пространства
мидов (slot ≠ feed_mid), `stereo=1` мунж в fmtp share-audio m-line.

**Wire-совместимость:** новые поля зеркалок — только в конец и синхронно с сервером;
замены — только при парном dev-деплое. Клиентские фичи, зависящие от новых серверных
эндпоинтов/полей, гейтятся capability-флагами (`hasServerCapability()`,
`ServerCapabilities.FEATURES` на сервере) — никогда не рендерить UI, который 404-нет.

## Правила работы (кратко; полностью — working-rules.md)

- **Объём этого файла — не более 28 КБ** (юзер-правило): детали живут в
  `docs/claude/*.md` (каждый тоже ≤28 КБ). При разрастании — выносить в сателлит
  и оставлять ссылку; журнальный стиль записей (даты, статусы смоуков, счётчики
  тестов, имена тестировщиков) не накапливать — сразу решения без шума.
- **Библиотека после двух осечек (юзер-правило):** если проблема не закрылась за ~2
  попытки ручных фиксов одного корня — третий шаг не новый фикс, а поиск
  общепринятой библиотеки/штатного механизма платформы. Порог именно две осечки —
  зависимости не тащатся с первого чиха.
- **Осознанные отступления от oak — юзер-решения, НЕ «чинить» при сверках** (полный
  список — working-rules.md): жёлтая полоса forward-карточки, динамический плейсхолдер
  композера, цвет ника по высшей роли, порядок каналов без алфавитной сортировки,
  ростер скрыт в dmMode, always-on-top окно тостов вместо OS-нотификаций, дефолт
  per-server уведомлений — Mentions only, и др.
- Тесты + typecheck — гейт после каждой фазы; парный релиз с oak-server одной версии
  (установщик клиента встраивает серверный jar той же версии).

## Bootstrap-мапа окружения

Node.js v24 LTS установлен (`C:\Program Files\nodejs`). IntelliJ Ultimate понимает TS
из коробки. DevTools в окне приложения — живой инспектор.
