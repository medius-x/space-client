# Пинг, TLS и провижининг — решения (launch-раунды)


## Пинг-индикатор соединения

Деплой парный «сервер → клиент» (сервер — oak-server PingHandler), старую пару не ломает.

- `src/domain/logic/connection-quality.ts`: EWMA (α=0.3) среднего + джиттера; good (avg≤150 && jitter≤60 мс) / weak (≤400/≤150) / bad. Джиттер — отклонения только ≤150 мс (стоп рендерера двигает среднее, не джиттер); первое эхо вердикт не сеет (seed = min двух). Ни одного эха → unsupported после 2 miss-ов (старый сервер дропает SEND молча); иначе 1 miss = weak, 2 подряд = bad. REST — только ms-число в unsupported (хук `onRequestLatency`, любой HTTP-ответ).
- Цикл `ConnectionSession`: SEND `/app/ping` каждые 10 с (было 25, юзер-запрос), эхо-таймаут 10 с; эхо парится по значению таймстампа (=== in-flight); подписка `/user/queue/ping` ДО первого SEND (гонка первого коннекта); onLost → stop без miss. `onConnectionQuality` патчит `AppState.connectionQuality` только активной сессии.

## Раунд A: лого, close-to-tray, пинг-шум (клиент-only; сервер — 2 строки yml)

Решения: TLS в ОБОИХ режимах (домен → Let's Encrypt, bare-IP → self-signed + пин); оба репо на GitHub ПУБЛИЧНО; лого позже → заглушка; схлопывание миграций V3–V5 отменено (wontfix).

- Пинг-шум (`application-dev.yml`): DEBUG spring websocket/simp → INFO.
- Лого: `electron/build/icon.png` (окно; ico — builder), `icon-48.png` (трей), `src/renderer/public/logo.png` (монохром; rail — `<img class="rail-logo">`). Плитка = цвет рейла #1e1f22; глиф по перцентилям; кроп полей, форма сохранена (юзер). Заглушечный генератор `npm run logo` УДАЛЁН; даунскейл лестницей ×2 (bicubic = муар).
- Close-to-tray (`electron/main.ts`): X прячет окно (голос/тосты живут), выход — Quit из трея; трей на процесс (`--space-instance=b`). Graceful-путь X — `initiateGracefulQuit()` на флаге `gracefulQuitStarted` (before-quit ставит тот же). `setAppUserModelId("oak.space")`. Граница: OS-shutdown со скрытым окном = жёсткий kill (фантом-тайлы голоса ~минута).

## Раунд B: TLS — TOFU-пин + https-адреса (ПАРНЫЙ, сервер первым: V17 + connectionScheme)

Self-signed (bare-IP за Caddy): TOFU-подтверждение отпечатка, пин в записи; CA-signed проходит сам.

- `domain/logic/cert-pin.ts`: normalize (SHA-256 hex uppercase), match, hostnameFromUrl; пин по HOSTNAME, не origin — один серт Caddy = oak:443 + MinIO:9443 + /janus.
- `certificate-error` (main.ts) — вердиктор ВСЕХ https/wss. Порядок: session-allowance ПЕРВЫМ (иначе Connect на изменённый серт = deadlock со старым пином) → пин совпал → allow → не совпал → блок + лог CHANGED + диалог (MITM?; переустановка = перетраст) → пина нет → TOFU-диалог. Грабля Electron 44.x: в typings только SHA-1 fingerprint — SHA-256 сами (sha256 DER), как `openssl x509 -fingerprint -sha256` (== gen-self-signed.sh). IPC `space-tls:decide` {hostname, fingerprint, accept}: accept → sessionAcceptedCertificates + немедленный персист по всем записям hostname (`persistAcceptedPin`); `withSessionCertificatePin` в kvMutate дописывает пин в connection:*.
- `TlsTrustModal.tsx` на уровне App (ошибка фоновой сессии); мягкие тексты (fingerprint, Cancel/Connect). `tlsRetry`: отвергнутая сертом попытка умерла до сервера — Trust перезапускает.
- `normalizeHostUrl`: голый host — localhost/127.0.0.1/[::1] → http, прочее → https; не-http(s) схема → ошибка. Wire: `ServerProfile += connectionScheme?` (append-only), `ConnectionRecord += certFingerprint?` (пишет main). CSP: + `https:`/`wss:` — клиент ходит на любые добавленные адреса. Граница: первый TOFU-контакт уязвим без side-channel; LE — пина нет никогда.
- Reachability (юзер: рейл кликабелен ВСЕГДА, мёртвый сервер = «Offline» в user panel, свитч НЕ блокировать; точки откачены). `probeServerReachable`: fetch /api/server + таймаут — любой HTTP = жив, reject = сеть. switchConnection: проба до openSession; фейл → сессия цела + тост; ApiError → re-login; полу-мёртвая фон-сессия → reconnectNow. Boot после N неудач — честный offline; фоновые сессии гейтятся пробой 2.5 с (висячие fetch забивают пул). Офлайн-вид: фейл openSession оставляет полусессию без стомпа (stompState "off" → «Offline»); `armOfflineWatch` — проба/10 с → openSession.

## Раунд C: client provisioning — SSH-деплой из вкладки Create (КЛИЕНТ-ONLY)

IP + SSH-креды → клиент ставит на свежую Ubuntu весь стек OAK (Docker → /opt/oak compose → секреты → серт → файрволл → OWNER) и автологинится; ssh2 — external dep.

- Ядро `src/domain/provisioning/` — пайплайн от ШВОВ (транспорт exec/writeFile/readFile, шаблоны, randomHex); `electron/provisioning.ts` — Ssh2Transport (exec + onOutputLine, SFTP + onProgress). IPC `provisioning:start/cancel` + `provisioning:event` (step | succeeded | failed; progress?); SSH-креды только в scope прогона.
- Шаблоны `electron/provisioning/files/` (CRLF→LF — janus libconfig не прощает): janus/* и Dockerfile.server — ДОСЛОВНЫЕ копии oak-server/env; compose и Caddyfile — производные (наружу 443/9443 + coturn + RTP 2000-2300/udp; dockerd = iptables-правило на порт, урезано с 2000-4000). janus.jcfg `rtp_port_range` РАСКОММЕНТИРОВАН (иначе эфемерные порты вне маппинга); диапазон в ТРЁХ местах СИНХРОННО: compose + jcfg + ufw. Caddyfile: маркер `# provisioning:tls-file` (tls-строки режутся для домена — ACME) + `default_sni {$OAK_PUBLIC_HOST}` (нет SNI на bare-IP); env доходит в контейнер ТОЛЬКО через compose environment (без проброса — рестарт-цикл). ЗЕРКАЛО: правки oak-server/env/* дублируются в files/**.
- Шаги: probe (не-Linux — отказ; pre-flight: диск ≥5 ГБ, RAM ≥1.2 ГБ, cgroup; parseInt, не Number) → docker (нет → get.docker.com) → layout (живой compose → ADOPT: шаблоны обновляются, .env и серт НЕ трогаются — пины клиентов живут; НИКОГДА down -v) → env (randomBytes: 16 Б пароли, 32 Б секреты; TURN_EXTERNAL_IP = сырой IP) → certificate (домен → ACME; IP → self-signed; adopt читает существующий) → firewall (SSH-порт ИЗ ФОРМЫ, не 22; 443/9443/5349/34780 tcp + 34780/udp + 2000:2300 и 55000:55050 udp; идемпотентен) → compose (up -d --build) → wait (curl -k https://localhost/api/server с Host публичного адреса — ОБЯЗАТЕЛЕН; готовность = код приложения, НЕ 502/503/504) → register.
- Register: тела register/login ФАЙЛАМИ по SFTP (пароль не в командной строке); register возвращает юзера БЕЗ токена → после 201 И 409 логин тем же паролем (401 на 409 → ownerReady=false). Токен → PATCH /api/server/connection: wire = {connectionHost, connectionPort: 443, connectionScheme}, НЕ host/scheme (чужие поля Jackson игнорирует → null = no-op; порт обязателен — иначе invite host:8080 под https).
- TOFU-пин без диалога: отпечаток по ДОВЕРЕННОМУ SSH-каналу — main сам ставит sessionAcceptedCertificates + persistAcceptedPin (side-channel-сверка из TLS-диалога).
- UI: пустой аккаунт → дефолты admin/admin/password; Advanced: SSH порт/ключ/домен/firewall/jar-override; Modal.locked на прогон (повтор — already in progress).
- Jar-лестница (юзер: клиент НЕСЁТ сервер — парность by construction): override → bundled files/oak-server.jar (~79 МБ; dev `npm run jar:sync`; пак — extraResources) → GitHub latest (PROVISIONING_JAR_URL); +79 МБ — принятая цена.
- Образы: `npm run images:sync` пинует все по digest'ам dev-версий (дифф пинов = обновление; manifest.json в git). Пулл: каждый образ ОТДЕЛЬНО (compose pull абортится на первом неудачном) → DNS-fix → зеркала (gcr первым; отказ зеркала авторитетен) → докачка из вшитого набора (SFTP + `gunzip | docker load`) → fail «neither pullable nor bundled».
- Security: host/domain — единственные юзер-строки в shell/.env, charset `[A-Za-z0-9.:-]`, двойная валидация; пароль только в SFTP-файлах; PATCH — токен + гейт MANAGE_SERVER; `.provision-*.json` скраб в catch.

## Начало раунда D: packaged-смоук и смежные фиксы

- Janus NAT: без nat_1_1_mapping janus анонсировал контейнерный IP в ICE; комнатный RTCPeerConnection без iceServers → глухие (на dev прощалось). Фикс (ОБА репо): janus.jcfg += `nat_1_1_mapping = "@NAT_1_1_IP@"` (пустой env → удаляется), compose janus.environment += `NAT_1_1_IP: ${TURN_EXTERNAL_IP}`; dev — `docker compose build janus`.
- «Voice connected» + глиф: «On a call» рядом со STOMP-«Connected» маскировал мёртвый медиа-путь; медиа-RTT (`voice-rtt.ts`, nominated pair; `SfuSession.getVoiceRttMillis()`) в статусе — глиф-волны (3/2 дуги по <120/<250 мс), число в tooltip.
- NS в звонках: wrapCallMic ДО создания PeerCallSession → guard убивал движок на старте каждого 1-на-1 (комната не задета). Фикс: `noisePipelineStillWanted` + `callMicBootInFlight`.
- Обрывы SSH: обрыв считался ФАТАЛЬНЫМ, а команда на сервере живёт (OOM опровергнут — умер sshd-монитор). Фиксы: ExecOutcome += signal; `describeExecFailure` (SIGKILL → OOM-подсказка; канал без статуса); `ConnectionLostError` при close(null). Далее (юзер «Делай»): реконнект + идемпотентный перезапуск шага + терпеливее keepalive.
- Debian-смоук C (ПАРНЫЙ: ростер-каналы x2, health = container:null): `container` → `| null`; `MemberEvent.type += "joined"` → /topic/members.
