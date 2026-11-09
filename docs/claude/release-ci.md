# Установщик, CI/релизы и автообновление — решения


## Хвосты раундов до Launch D

Оптимистик текста (юзер-решение: без pending-индикатора, текст-only): temp с ОТРИЦАТЕЛЬНЫМ id; СТОМП-эхо опережает 201 → поглощение FIFO по (authorId, content); `lastServerMessageId` — единственный законный «последний id»; Retry — тот же idempotencyKey. Capability-флаги (юзер-решение): только фичи ПОСЛЕ 0.1.0, всё до — безусловная база. Свитч: fresh-путь openSession демоутит живую сессию вместо teardown — возврат мгновенный промоут; дискового кеша истории нет осознанно (сервер удаляет сообщения).

## Launch D: установщик + CI/релизы

electron-builder.yml: win nsis oneClick per-user (без UAC), `npmRebuild: false` (koffi — N-API prebuilt), `asarUnpack: koffi/**`, extraResources: provisioning/files (вшитый jar + 6 docker-архивов ~610 МБ — юзер-решение: полный офлайн-комплект). Пути: `app.isPackaged → process.resourcesPath`. userData общий у prod и dev — не запускать вдвоём (GPU-cache lock).

ci.yml: node 24 → npm ci → typecheck → test → build. release.yml (тег v*): гейт version == тег → скачать серверный набор ТОЙ ЖЕ версии из релиза oak-server (asset-имена из manifest.json) → npm run dist → exe в GitHub Release. Образы несёт релиз сервера: `npm run images:publish -- v*` (gh CLI) — git чист.

Парность: package.json == pom.xml. Релизный порядок: bump ОБОИХ версий → тег сервера (CI: jar) → images:publish на dev-машине → тег клиента (CI: установщик). Границы: подписи кода нет (SmartScreen); KV userData переживает перезапись.

## Лицензии: атрибуция образов + AGPL

THIRD-PARTY-NOTICES.md в обоих репо (образ, digest, лицензия, upstream, исходники) + licenses/*.txt — в установщик через extraResources. Верифицировано: janus GPL-3.0-only, coturn BSD-3-Clause, temurin GPLv2+Classpath-Exception (текст исключения обязателен — НЕ EPL); OS-слои — лицензии дистрибутивов. Оба репо AGPL-3.0-only: копилефт от закрытых форков (прецедент Revolt); GPL-образы — агрегация отдельных программ; разжать уже выпущенное AGPL нельзя (принято).

## README, скриншоты, демо-стенд

E2E честно: звонки 1-на-1 — P2P WebRTC; голосовые комнаты — SFU, E2E не заявляется. Демо-стенд demo-data.mjs — только на диске, untracked навсегда; скриншотный инстанц `--space-instance=c`. Редакция IP — только WinRT-OCR + повторный OCR; vision-координатам не доверять.

## Раунд фиксов первого живого теста (клиент-only)

Around-окно: applyLive молча дропал live с id > хвоста окна — теперь aroundDropCount кормит пилюлю «Jump To Present · N new» + автодогрузка (кап 6 страниц) + heal в openDm; StompClient изолирует бросающий хендлер (try/catch на кадры). Шумодав: очередь rebuild'ов + поколенческий discard; сторож аплинка UplinkStallDetector (два нулевых прироста bytesSent): 1-й stall — rebuild, 2-й — handleVoiceSessionLost, кап 2 автореджойна. installFileDropGuard закрыл и дыру file://-навигации. Роли: membership — стейджинг с undo и единой Save (юзер-спека); пересев draft только при !dirty.

## UI-раунд: рендер-путь и фикс прокрутки

Каденс (юзер-правило): фаза → гейты → СМОК юзера → ЯВНОЕ разрешение → коммит. Принцип «ОЦЕНКА == ПЕРВЫЙ КАДР»: чистый message-row-height.ts ЗЕРКАЛИТ рендер-математику (мозаики/видео/стеки цитат за уровень); живая ширина кешится module-level; MessageRow-memo требует стабильных actions (useMemo). ГРАБЛИ: useMemo после раннего return = краш «Rendered more hooks» (хуки только до ветвлений); перед правками гасить dev-инстанс юзера. K2: scroll-gating — пейсинг 250 мс, bottomProximity = переход ЛИБО re-assert (чистый edge ломал around-цепочку), onScroll — один rAF-батч. K6: громкости СОБЕСНИКА voice/share независимы (IPC kind voice|share, кламп 0..2).

## Рейл серверов: порядок + drag-and-drop

Корень тасования — lastUsedAt (бампится каждым стартом сессии); юзер выбрал полный Discord-вариант: порядок только ручной. Порядок — НЕ-записной KV-ключ `connection-order` (plaintext-массив record-id; НЕ `connection:*` — шифрование не нужно: внутри только uuid; дефис ≠ подчёркивание — префикс-скан не подберёт). Чистый rail-drag.ts: applyRailDrop (no-op возвращает тот же объект), sortRecordsForRail (дубль → первое вхождение, мёртвые id игнорятся; невошедшие в хвост по createdAt asc + тай id), sanitizeRailOrder. reorder() валидирует «ровно все записи по одному разу» до мутации; mostRecentlyUsed() — единственный потребитель lastUsedAt (авторезюм, survivor, boot-надпись); touch() порядок не двигает. Drag: порог 4px; click после драга глотается.

## Кеш высот: коллизия id двух серверов

Virtualizer кеширует высоты по ключу строки, кеш ПОБЕЖДАЕТ оценку; голый `String(message.id)` коллидировал между пер-БД последовательностями (id с единицы в каждой базе); ChatPane без key не перемонтируется при промоуте фоновой сессии → строки нового сервера ложатся по протухшим высотам старого; кеш не протухает по времени. Фикс: `rowKeyOf = \`${recordId}:${messageId}\`` — переведены ВСЕ 4 потребителя ключа (itemKey, settling-jump, центрирование unread, прыжок по цитате); pendingJumpRef сбрасывается при смене канала/сессии. Регресс: быстрый путь jumpTo слал голый String(id).

## Раунд 12 фиксов

ГЛАВНАЯ ГРАБЛЯ: тост-окно с setIgnoreMouseEvents(true,{forward:true}) при опустевшем стеке делало только hide() — мышиный хук оставался на СКРЫТОМ окне и навсегда убивал DnD всего клиента. Фикс: empty-стек снимает хук полностью, show перевзводит. Громкость 0–200%: element.volume капается платформой на 1.0 — RoomAudio на per-chain playoutGain 0..2 (setSinkId), провал графа = fallback на элемент-путь. Прочее: stopWatchingShare() первой строкой teardownVoice + IPC closePopout (попап шара переживал кик); ghostGuard: серверный voiceMembers — авторитет; RoleEditor key={selected.id}; кап картинок 320px; video: nodownload + своя Download-кнопка; папка загрузок — все сохранения без диалога в <Downloads>/SPACE (basename в main), вкладка General первой (один ключ «general», разный контекст client/account); инвайт копируется сразу, плашка НЕ тост.

## Автообновление клиента

electron-updater против GitHub Releases; `autoDownload=false` — ни одного тихого байта, закачка только по кнопке; скачалось → graceful teardown голоса → quitAndInstall — тихий NSIS + автоперезапуск. Фид: publish-блок electron-builder.yml; app-update.yml читается ИЗ ПАКА — `--dir` НЕ генерит (верификация только полным dist). ГРАБЛЯ ИМЁН: latest.yml ссылается на ДЕФИСНОЕ SPACE-Setup-<v>.exe, билдер кладёт с ПРОБЕЛАМИ — CI зеркалит exe+blockmap до upload (иначе 404); сборка `--publish never`, публикация gh-шагом. Проверки: старт через 15 с, суточная только при idle ≥15 мин; тумблера НЕТ (юзер-правка: оба чекбокса off = механизм выключен). update-policy: Skip = точная строка версии; isNewerVersion только числовые a.b.c. dev: app.isPackaged-гейт в main. IPC download/install БЕЗ аргументов, sha512 проверяет апдейтер. Security: компрометация GitHub-аккаунта = злой апдейт всем (без подписи кода, принято); репо обязано быть публичным (приватный = 404 анонимному апдейтеру).

## Раунд D1: GitHub + релиз 0.2.0

Грабли: 404 анонимного GitHub API ≠ «репо нет» (приватные маскируются) — проверять только авторизованным `gh api`. gh вне PATH (C:\Users\Home\tools\gh\bin); после переименования аккаунта токен протух — logout+login. Push по HTTPS: `gh auth setup-git` + remote set-url — ssh-agent не нужен. Открытие: `gh api -X PATCH visibility=public` (анонимный апдейтер). Branch protection: main (клиент)/master (сервер), force-push и удаление запрещены, linear history, enforce_admins false (solo). ГЛАВНАЯ ГРАБЛЯ РЕЛИЗА: release.yml качал `images/postgres.tar.gz`, images:publish заливает ПЛОСКИЕ имена из manifest.json → 404. ПРАВИЛО КОНТРАКТА: имена ассетов релиза сервера определяет СКРИПТ ЗАЛИВКИ (manifest.json), workflow подстраивается (jar → files/, архивы → files/images/). images:publish НЕ ходит в GHCR — архивы аттачатся ассетами релиза, write:packages/docker login не нужны. Перетег (`git tag -f && git push -f`) — рабочий путь ДО создания релиза. Релиз 0.2.0 — первый публичный (semver 0.2.0 vs 1.0.0 — юзер-решение): сервер jar + 6 образов, клиент exe + latest.yml + blockmap; url фида обязан совпадать с ассетами бит-в-бит (curl). Порядок подтверждён end-to-end; images:publish требует gh в PATH команды. Social preview — только руками.


## (дистрибутивы)


## Каналы обновления

- **Light — ОСНОВНОЙ дистрибутив** под текущим именем (`SPACE-Setup-<v>.exe`, фид
  `latest.yml`); полный — **full-bundled** (`SPACE-Full-Bundle-Setup-<v>.exe`,
  `publish.channel: full-bundled` → фид `full-bundled.yml` — каноническое
  `<channel>.yml` electron-updater'а, НЕ `latest-full-bundled.yml`).
- Рантайм-ветвления канала в коде НЕТ — channel зашит в `app-update.yml` артефакта,
  `updates.ts` не тронут. Существующие full-установки при обновлении получают
  light-комплект (NSIS сносит каталог, −590 МБ) — осознанно.
- Легаси/дев-машина с kit=full без tar.gz ведёт себя как light, НЕ падает.

## Единая лестница большого контента (jar и образы, симметрично)

(1) сервер сам качает с GitHub; (2) фолбэк через клиента — full-bundled заливает
ВШИТОЕ, light качает с GitHub на диск и заливает. Jar: Advanced-override всегда
побеждает. Образы: missing-check → `docker pull` (digest) → DNS-fix → зеркала
gcr/daocloud → снятие зеркал → СЕРВЕР-GitHub → терминальный этап (ветвление по
`files.images !== null`). MISSING-хвост везде: каждый этап работает только с
недостающим (встали пять образов — с GitHub едет один minio).

## downloadOnServer (pipeline.ts)

Фоновая закачка НА сервере: `setsid sh -c 'exec curl -fsS -C - …' </dev/null
>/dev/null 2>/tmp/log & echo $! > pidfile` — stdio отвязан от SSH-канала (иначе
exec виснет на незакрытых FDs, обрыв канала SIGPIPE'ит закачку). Поллинг
`stat -c %s` + `kill -0` по pid-файлу со стейт-машиной: размер==expected → done
ДО перезапусков; умер недокачанным → 2 ручных рестарта `curl -C -`; не растёт
≥300 с при живом → `kill -- -pgid` ПОСЛЕ сверки `/proc/<pid>/cmdline` на dest
(PID re-use). Идемпотентен под resumeOnDrop: re-entry находит живой трансфер по
pid+cmdline и продолжает поллить. Проба достижимости `curl -fsSIL` (302 GitHub =
успех): reachable ТОЛЬКО при спарсенном Content-Length — без expected-размера нет
honest done-условия. wget НЕ используется: probe-этап гарантирует curl.

## Контракты

- `ProvisioningFiles` = {jarOverridePath, jarBundledPath, kitVersion, kit,
  imageManifest, images} (устаревшие jarLocalPath/PROVISIONING_JAR_URL удалены).
- 8-й параметр пайплайна `clientFileDownloader?` — инъекция `downloadToFile` из
  electron-слоя (прецедент: crypto.randomBytes).
- `serverJarUrl`/`serverKitAssetUrl` (artifacts.ts) — URL по ТЕГУ версии клиента,
  НЕ latest (парность важнее availability).
- readTemplates: kit.json (нет файла → "full"); манифест пинов ОТДЕЛЬНО от
  локальных архивов (light дропнул бы весь манифест, а он нужен пуллам и URL).
- `electron/provisioning.ts downloadToFile`: стрим getReader→createWriteStream
  (НЕ arrayBuffer), stall-watchdog 300 с, троттл прогресса 250 мс, отмена, unlink
  недописанного; клиентские докачки чистятся в finally прогона.

## Сборка и релизы

- electron-builder.yml = light (extraResources-фильтр `!**/*.tar.gz`,
  `!oak-server.jar` + kit-light.json → provisioning/files/kit.json);
  electron-builder-full-bundled.yml — полный дубль (channel full-bundled,
  artifactName «SPACE Full Bundled Setup», kit-full.json); скрипт `dist:full`.
- release.yml: fetch kit → full-билд → вынос артефактов в release-full/ (+снос
  release/) → чистка jar/tar.gz (manifest.json ОСТАЁТСЯ) → light-билд →
  зеркалирование пробел→дефис ×2 → upload 2 exe + 2 blockmap + latest.yml +
  full-bundled.yml + проверка, что оба фида ссылаются на дефисные имена.
- **CI-гейт эквивалентности критичных строк двух конфигов** — дрейф = один из
  каналов молча умирает.
- Маркеры: electron/provisioning/kit-light.json / kit-full.json (в git); в files/
  их НЕТ — dev-режим без маркера = "full" (архивы на диске).
- **Ручной чейнджлог релизов**: `release-notes/v<версия>.md` в репо = тело
  GitHub-релиза (release.yml `--notes-file`; нет файла → прежние авто-ноты).
  Конвенция — в release-notes/README.md.
- Факты размеров (лечат заниженные оценки): light = 134 МБ честный низ (база
  electron ~427 MiB unpacked + app.asar 57 МБ + словари/шрифты/ns-модули; nsis
  жмёт ~3.2×), full-bundled = 737 МБ, выигрыш 5.2×. README — честные цифры.
- ГРАБЛЯ релизного порядка: тег клиента, уехавший в репо раньше серверных
  ассетов (гонка cwd в цепочке push), — прогон отменён, тег снят, повтор в
  правильном порядке. Серверные ассеты — строго раньше клиентского тега.
