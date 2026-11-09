# Свежие фичи — решения

## Версия сервера после adopt-провижна (КЛИЕНТ-ONLY)
Профиль применялся только при handshake и `/topic/server`-пушами — рестарт сервера не пушет. Фикс: `ConnectionSession.applyServerProfile` — единая точка применения (`/topic/server`-хендлер на ней); `refreshServerProfile()` — REST-перечитывание (гварды disposed); runtime `refreshServerProfilesForHost(hostUrl)` — по всем живым сессиям хоста; вызов из ProvisioningPanel в succeeded-ветке до автологина (идемпотентен).

## Релеевая докачка jar (КЛИЕНТ-ONLY, релиз 0.5.1)
`net.fetch` (Chromium-стек main) при обрыве redirect-цепочки (GitHub 302→CDN) давал голый `null` в UI. Фикс: `fetchToFileOnce` на Node `https.request` с ручными редиректами (бюджет 5); `downloadToFile` = 3 попытки, бэкофф 2с/5с (GET идемпотентен; отмена юзера не ретраится); `messageOf` — ничего не рендерится как null.

## Single-instance lock + boot-argv/ppid (КЛИЕНТ-ONLY)
Доп-окна с двоящимся голосом = вторые экземпляры exe (делят userData → делят токены). Лок только packaged: `app.isPackaged && !instanceName` → `requestSingleInstanceLock`; победитель в `second-instance` логирует cmdline двойника + cwd и фокусит окно. Dev без лока by design (смоуки; лок ключуется по userData). Boot-строка лога += `ppid` + `argv`.

## DFN3: слайдер потолка подавления + самотест (КЛИЕНТ-ONLY)
Единственная ручка vendored wasm — `df_set_atten_lim` (потолок дБ на кадр; 0 = лимитер выкл = сильнейшее); старый слайдер 0..100 — весь диапазон вне слышимости. Решение: `domain/logic/ns-settings.ts` — 6..40 дБ, дефолт 15; санация legacy: 0→40, 1..5→6, 50→40, мусор→15. Самотест runNoiseEngineSelfTest: onset duck/recovery/steady + AGGRESSIVE; steady верифицирует потолок; замер от сэмпла 1 (сэмпл 0 = латентность движка). Замер: потолок 15 → recovery ~125мс, steady −14.9 дБ — работает; «секундные» просадки были безлимитом; RNNoise без потолка → onset неизмеримы.

## Жёлтый AFK-статус в ростере (ДЕПЛОЙ ПАРНЫЙ — сервер первым)
Зелёный→жёлтый по серверному AFK-таймауту; работает и без AFK-комнаты. Сервер: `/topic/voice.afk` — только переходы; `GET /api/voice/afk` — снимок, VIEW-фильтрован. Клиент: RosterStore `afk`-множество с snapshot/delta-дисциплиной presence (beginAfkSnapshot/setVoiceAfk/abortAfkSnapshot + буфер гонок; offline-дельта гасит жёлтый); подписка и снимки гейтятся **capability `afk-roster`** (без флага ноль запросов — профиль присваивается до подписок); `rest.getVoiceAfk` 404-толерантен; Avatar `away` → `.avatar-presence.online.away` (--sp-yellow).

## Два UX-фикса (КЛИЕНТ-ONLY)
Подменю ПКМ гасли (диагональный путь пересекает соседние строки): юзер выбрал задержку — `SUBMENU_CLOSE_GRACE_MS=350` с отменой при re-enter; вертикальная навигация закрывает мгновенно, dx>1px вправо = «полёт к подменю» (pointerXRef + `closeSubmenuUnlessFlyingRight`). `formatTimeOfDay` всегда 24ч HH:MM (был locale AM/PM); lang удалён (ChatPane-гуттер, checkedAt, backup.latest).

## «4 звёздочки» при стыке bold и bold+strike (КЛИЕНТ-ONLY)
MARKER_ORDER фиксирован: стык закрывающего маркера рана N с открывающим N+1 тем же символом (`**`+`**~~`→`****`) ломает findClosingMarker. Фикс: `serializeComposerRoot` ведёт `boundaryChar`; `markerOrderAvoidingBoundary` ведёт маркер, не делящий граничный символ; канонический порядок, если ведущий безопасен или все маркеры делят символ. Вложенность уплощается при загрузке (appendSegments flatten) → round-trip без потерь; runParts не тронут.

## Встроенная проверка орфографии en+ru (КЛИЕНТ-ONLY)
Подчёркивания + ПКМ «Орфография ›» + тумблер General; en-US + ru фиксированы. Платфакты (зонд scripts/spellcheck-probe.cjs в репо): у Chromium НЕТ `ru-RU` — языки НИКОГДА не фильтровать по availableSpellCheckerLanguages; на Win Windows Spellcheck API даёт подчёркивания, но context-menu params ВСЕГДА пусты (electron#38876) — встроенное меню мёртво; `setSpellCheckerLanguages([])` НЕ выкл — только `setSpellCheckerEnabled(false)`; webFrame-провайдер перехватывает проверку в обход session-флага — тумблер гасит ОБА слоя; caretRangeFromPoint в textarea сломан — слово под ПКМ по КАРЕТКЕ. Решение (юзер): вшитые словари — nspell в MAIN + Hunspell en_US и ru_RU (Лопатин, wooorm/dictionaries) в `src/renderer/public/spell/` (AGPL-совместимо; STATIC_ASSETS_ROOT, asar-aware); `electron/spell.ts`: провал = тихая деградация; слово верно, если знает хоть один словарь; IPC `checkWords` (кап 256×200) и `menuData(word)`. REP-таблица (28 фонетических пар) дописывается к ru-aff при загрузке (файл нетронут — лицензионно чисто; без REP верный вариант тонет в ngram-шуме). hunspell-asm ОТКЛОНЁН бенчмарком (ранжирование хуже nspell): «полный алгоритм = лучше» проверять ДО миграции. Словарь юзера: KV `spellCheckWords` (кап 1000) → nspell.add; пункт гейтится spellCheckEnabled. Грабля: подчёркивания и пункт меню независимы — двойной гейт.

## Детектор мёртвого микрофона (КЛИЕНТ-ONLY)
Тихая смерть USB-донгла: захват открыт, публиковалась идеальная цифровая тишина. `domain/logic/mic-silence.ts`: MicSilenceTracker — стрик RMS ≤ 1e-6, вердикт после 90с нуля; живой кадр сбрасывает. RoomAudio: второй analyser на ДО-шумодавном raw (RNNoise выдаёт точные нули → processed не годится; engine off → raw===published); гейт publishedTrack.enabled (осознанный мьют тоже ноль). SfuSession.rawMicTrack — до micEnhancer; replaceMicTrack не трогает; обе точки attach (голос + звонок) — смена движка перевязывает анализ. UI (юзер: ТОЛЬКО статус-строка): янтарная `.voice-bar-status.mic-silent` (не красный — медиа-путь здоров). Граница: «check headset» покрывает и аппаратный мьют; автоперезаход не делаем. Security: новых IPC/REST нет; rawTrack не покидает процесс.

## Гонка токенов при автологине (КЛИЕНТ-ONLY)
Сервер переустановлен на том же IP: автологин по re-login-ветке (rotate), а фоновая сессия записи со старой парой → silent-refresh 401 → `tokenStorage.clear()` стёр новую пару. Фикс: `RestClient.doRefresh` — при 401, если в хранилище другой refresh (семья заменена), не чистить/не expired — retry перечитает storage; `startSession` existing-ветка гасит живую сессию записи ДО applyTokens. Цена: in-memory чаты записи умирают (было и так).

## Миграция server-to-server (ДЕПЛОЙ ПАРНЫЙ — сервер первым)
Вариант B: новый сервер сам тянет бэкап со старого (curl + одноразовый токен), компьютер = control plane; fallback «через компьютер» навсегда (легаси/за NAT/провал пробы). Решения: TTL токена 2 часа (30 минут истекали бы посреди restore); PEM серта захватывает клиент одноразовым `session.setCertificateVerifyProc` (сервер Caddy-серт не читает; сверка с TOFU-пином записи); Range/206 на /file обязателен (иначе `curl -C -` = ошибка 33). Сервер: POST/DELETE `/api/server/backup/migration-transfer` (Bearer, requireAdministrator, 409 без архива; ответ {token, expiresAt, archiveSha256, archiveBytes}); GET `/api/server/backup/transfer/{status,file}` — permitAll, весь гейт в заголовке `X-Space-Migration-Token`; токен single-slot, многоразовый до ревока («одноразовость» = deliver-and-delete архива). **ServerCapabilities.FEATURES += `server-migration`**. Клиент: `migrationTransfer` (params.ts: sourceUrl https-only, token base64url, sha hex-64, certificatePem; взаимоисключение с backupArchivePath); restore: `.migration-auth` 0600 (Ssh2Transport.writeFile += mode) + old-ca.pem → downloadOnServer → `sha256sum -c` → scrub; backup-schedule.ts: suppress расписания старого сервера на окно миграции (подменит single-slot архив), отпуск в succeeded/failed/cancel; флоу: съёмка → (capability) issue → probe → direct / fallback download + hashFile; finally: ревок (только fallback). IPC `provisioning:probe-migration` (main резолвит persistedPinForHostname) и `provisioning:hash-file` (гейт temp/downloads); cancelProvisioningRun: сперва `pkill -f space-provisioning-download` (закачки отвязаны от SSH; UA-маркер в argv). Security: 404 на пустой слот неотличим от «нет токена»; токен в 0600-файле, не в cmdline.

## (продолжение)


## Бэкап сервера + restore при провижининге + Migrate

Деплой парный: сервер первым, клиент следом. Блок клиента гейтится capability `"backups"` (ServerProfile.capabilities; первое использование `hasServerCapability()`): профиль присваивается в start() до permissions-снапшота; поздние /topic/server-пуши его не меняют; старый сервер → блок скрыт целиком, вкл. Migrate.

Серверная половина (детали — oak-server/CLAUDE.md): REST `/api/server/backup` run (202, claim синхронно — всегда running=true) / status / estimate / file (стрим); гейт всех — `requireAdministrator` (MANAGE_SERVER НЕ проходит — юзер); дамп TRUNCATE'ит всё КРОМЕ flyway_schema_history и refresh_tokens — миграция = честный ре-логин (.env убивает JWT); RestoreRunner: env `oak.restore.file`+public-*; manifest-гейт Flyway; маркеры `RESTORE COMPLETED`/`FAILED` грепает провижининг.

Клиент: Server Settings → Backups (гейт owner||ADMIN-бит). «Download latest» рендерится только при `status.fileAvailable===true` (нет у старого сервера → не гасится): перекачать неотданный буфер; после полной доставки сервер копию УДАЛЯЕТ; «Delete archive» → REST `discardBackupArchive()` (DELETE /file, 204). SPACE-гейт: estimate += `availableBytes` (-1 = нечитаемо); нехватка → подтверждение DISABLED (ENOSPC); -1 → без блокировки.

Расписание КЛИЕНТСКОЕ (`renderer/backup-schedule.ts`): per-record `ClientSettings.backupSchedules {enabled, minuteOfDay}`; срабатывает только при живом клиенте, догона НЕТ (юзер); папка/retention глобальные — `backupFolder`/`backupKeepCount`. RETENTION ТОЛЬКО автоматический (юзер): prune только после планового скачивания; ручные кнопки не удаляют.

Мост `spaceBackup` (electron/backups.ts): MAIN стримит URL в файл (не ArrayBuffer в рендерере); имена basename; папка из KV main, не из запроса; target "temp" — one-shot в tmp/space-migrate. prune: префикс `server-backup-<host>-` под `^[\w.-]+$`.

Провижининг-restore: `ProvisioningParams += backupArchivePath` (main проверяет существование до прогона). Restore-режим: env += `OAK_RESTORE_FILE=/restore/backup.zip` + `OAK_RESTORE_PUBLIC_HOST/PORT/SCHEME`; START_ORDER БЕЗ oak; полл docker-логов на маркеры (провал = ProvisioningFailure с причиной); needsLoginRestored: register НЕ выполняется (вход паролем исходного владельца). Restore на ADOPT (живой compose) = отказ. Compose-шаблоны в env/ и electron/provisioning/files/ — синхронно.

Migrate: съёмка бэкапа = ПЕРВЫЙ шаг прогона (юзер: скачивание после старта миграции; при ошибке/отмене архив удаляется). `ProvisioningPanel mode="migrate"`: стадия "backup" первой в STAGE_ORDER (синтезируется локально) → `takeMigrationBackup(session, shouldAbort)` → `provisioning.start(backupArchivePath + migrationArchive:true)`. temp чистит IPC `space-backup:deleteTemp`; FINALLY прогона удаляет архив (гейт path.relative). Архив строго one-shot.

Принятые границы: restore-архив = доверенный ввод уровня jar-override (подмена = произвольный SQL на новой машине); backupArchivePath — тот же renderer→main file-read класс, что jarPath/sshKeyPath.

## Смена сервера из голосовой

Юзер: выбрасывание из голоса при свитче — НОРМА (голос живёт только на активной сессии), но с confirm-диалогом. Корень: свитч звал `teardownVoice()` без `voice.leave` — сервер держал membership вечно. Фикс: полный `leaveVoice()` ДО смены activeSession. `requestServerSwitch(recordId, continuation?)` + `SwitchConfirmModal`: при живом голосе и таргете ≠ активной записи ставит диалог, иначе сразу; continuation — после свитча. АВТО-пути (тосты, звонок, tlsRetry) — прямым switchConnection: интенция уже выражена. Звонок 1-на-1 рвётся так же, но диалогом не покрыт (юзер просил комнаты).

## Локализация RU/EN + выбор языка

Свой i18n-слой без зависимостей, словари TS-константами (`src/domain/i18n/`): `en.ts` (EN as const — источник union MessageKey), `ru.ts` (`RU: Dict` — compile-time паритет ключей), `i18n.ts` (чистая `tf(lang,key,params)`; плюрализация Intl.PluralRules, лестница forms[category] ?? other), `permissions.ts` (бит → ключ, фолбэк на сырое имя — wire-множество открытое).

Язык — ПЕР-ПРОЦЕССНЫЙ module-state (окно/тост/попап/main свой): main — KV-сеяние + IPC-синк; аукс-окна — `spaceI18n.get()` + onLanguage-пуш. `ClientSettings.language: "en"|"ru"|"system"`; селектор General, endonym'ами, immediate. Даты следуют ЯЗЫКУ. IPC `space-i18n`: sync (union-валидация) / get / onLanguage. Провижининг: t-инъекция; язык можно менять среди прогона.

НЕ переводится (осознанно): бренд SPACE; имена движков; имена серверов/каналов/ников; Diagnostics.tsx (Ctrl+Shift+F12, EN); wire-дискриминаторы bridges.ts; токен `from:`; СЕРВЕРНЫЕ тексты ошибок — EN (один сервер на всех).

Юзер-термины RU: «Ре-логин»; «Выкл/Вкл микрофон», «Выкл/Вкл наушники» (title = действие по клику); VolumeRow `kind:"voice"|"share"` → muteVoice/unmuteVoice / muteShareAudio/unmuteShareAudio; мод-меню — voice.serverUnmute «Снять мьют» / serverUndeafen «Снять глушение». Плейсхолдер композера обрезается по ширине поля с «…»: `truncateTextToWidth` (glyph-metrics.ts); Composer мерит ширину ResizeObserver'ом.

3-й язык: словарь полный by Dict-тип; проводка в 6 точках (UiLang, DICTS, resolveUiLanguage, санация SettingsStore, селектор General, electron/main.ts); забытая точка = ошибка компиляции, не молчаливый EN.

## Раунд 8 доработок

- Обсуждения: ПОЛНЫЙ MessageRow-корень ПОД плиткой (юзер-репорт: сниппет не влезал). originMessage — SUBSCRIBED-поиск (`useStore(listFor(parentChannelId))`, module-EMPTY — M6-контракт); права/реакции origin — в РОДИТЕЛЕ, не в discussion-адаптере; при живом ряде плитка несёт ТОЛЬКО кнопки, снапшот — fallback «origin вне окна».
- Подключённая голосовая НЕ выделена как активный чат (Discord-поведение): убран .voice-channel.active; зелёное имя/glyph осталось.
- Окно: KV `window-bounds`; валидация при чтении (мин 300×200, workArea живого дисплея); persist = getNormalBounds() (RESTORE-размер в maximized).
- Версии: IPC `space-updates:version`; «Client version» в Diagnostics; серверная — в логе при СМЕНЕ.
- Громкость пира до 300%: `PEER_VOLUME_MAX=3` + `RoomAudio.MAX_PLAYOUT_GAIN=3` + IPC-кламп popoutVolume.
- Композер: своё ПКМ-меню (нативного в textarea нет): Undo/Redo (execCommand), Cut/Copy/Paste (clipboard; Paste через async-пробу), Delete/SelectAll; правки через `applyEditorText` (setText + rAF-рефокус).
- NS-движки: `NS_ENGINE_DESCRIPTIONS` (VoiceRoom.tsx) — классификация юзера + вердикт качества.

## Раунд 7 багов эксплуатации

- Щелчки шар-звука: путь данных шёл ЧЕРЕЗ RENDERER MAIN THREAD; фоновое окно троттлится → underrun'ы кольца = клики. Финальный фикс: буфер инжектора 1→4 с. Утечки захвата: `space-sysaudio:start` возвращает ПОЛНЫЙ объект (не bool); releaseNativeShareAudio — БЕЗУСЛОВНЫЙ stop.
- ГРАБЛЯ-ПРАВИЛО SAB (не повторять): SAB в рендерере недоступен БЕЗ cross-origin isolation; COI/COEP мульти-серверному клиенту НЕВОЗМОЖНЫ (заблокируют presigned-медиа пользовательских серверов); Electron не сериализует SAB в invoke-ответе. SAB-механика ВЫРЕЗАНА.
- Шар SILENT: watchdog контекста инжектора (not-running → WARN + resume(); suspended = тишина без ошибок — главный кандидат); честный NO SIGNAL (статс-окон не было ≠ тишина); WARN на ended display-видео на обоих швах.
- Клик по тосту не навигировал: window.focus() не поднимает свёрнутое/трей-окно → IPC `space-window:raise` (sender-based: restore+show+focus) перед focus().
- Around-скролл: aroundActive-эффект СИММЕТРИЧЕН (флаг стора вооружает belowEndRef+jumpToPresent); snap OFF при belowEnd — история растёт ПОД читателем; цепочка страниц — от завершения loadNewer (≥50 && near-bottom), afterId из СТОРА. Пилюля «Jump To Present» УДАЛЕНА (юзер-итерации) → постоянная кнопка `.chat-scroll-down` (вне 80px-зоны низа ИЛИ around-дыра; клик: дыра → reloadTail, иначе scrollToBottom; гашение только при !belowEnd). NEW-бейдж при замыкании around-хвоста подавлен one-shot `tailLandingSuppressRef`.
- AFK выкидывал активных: смотрящий свой шар (или с камерой) не трогает мышь → idle → sweep. `isAfkActive(idle, speaking, streaming)`: живой исходящий шар/камера = активность. Корень-кандидат: 30-с интервал рендерера умирает на свёрнутом окне. ТАЙМЕР В MAIN: IPC `space-afk:arm`/`space-afk:tick`; рендерер на тик шлёт /app/voice.activity. Сервер: sweep-лог с причиной и last active.
