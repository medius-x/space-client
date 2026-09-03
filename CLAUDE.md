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

## Текущее состояние: M0 (React-шелл поверх ядра спайка)

Полная перепись oak-клиента (план: goofy-leaping-sutton.md). M0 готов: electron-vite +
React 19, стор-паттерн Emitter+useSyncExternalStore, runtime-синглтон вне React-дерева
(HMR не роняет голос), голоc/шар/оракул перенесены без потерь, старый vanilla-UI удалён.
Вехи M1–M7 в трекере задач. React запрещён вне src/renderer (test/architecture.test.ts).

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

- `electron/` — main-процесс (окно, display-media handler, security) и preload.
- `static/` — index.html + styles.css (палитра перенесена из oak-client, `--sp-*`).
- `src/core/` — протокольные модули, framework-agnostic, переживают полную перепись:
  `rest.ts` (Bearer + single-flight refresh), `stomp.ts` (STOMP 1.2 поверх raw WS),
  `janus.ts` (REST long-poll), `janus-events.ts` (типизированные события videoroom),
  `sdp.ts` (стерео-мунж), `classifier.ts` (mindex-классификация, slot↔stream mid),
  `sfu.ts` (publisher+subscriber), `audio-math.ts` (чистая математика).
- `src/audio.ts` — WebAudio-граф: per-user GainNode (голос/шар раздельно), speaking,
  стерео-оракул (ChannelSplitter → AnalyserL/R ДО гейна), тест-тон 440L/660R.
- `src/ui/` — vanilla DOM; `src/main.ts` — композиционный корень.
- `test/` — vitest; все импурные модули принимают fake-и (`test/mocks/`).

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
