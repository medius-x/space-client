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

## Текущее состояние: M7 (RBAC-UI, настройки)

**UI-полиш к oak-парити (раунд 2, весь визуальный слой):** **шрифты/иконки** — Open
Sans TTF + **@mdi/font 7.4.47 (npm devDep)**: `styles/icons.css` + woff2 в
`styles/fonts/` генерятся `scripts/regen-icons.mjs` (`npm run icons` — список
используемых `mdi-*` классов собирается из исходников, кодпоинты парсятся из css
пакета; только woff2 403 КБ — Chromium-only, ttf-fallback не нужен). Полный
современный набор: настоящие mdi-cog/mdi-trash-can/mdi-monitor-share/mdi-shield-
account/mdi-triangle-wave/mdi-headphones-off — алиасов и inline-SVG (MdiSvg.tsx
удалён) больше нет. **ГРАБЛЯ: в MDI 7.x НЕТ `mdi-settings`** (легаси-дублёр cog
из 1.7.22 выпилен) — использовать `mdi-cog`. Новая иконка в коде → перегенерить
`npm run icons`, иначе глиф пустой. Эмодзи-глифы заменены на MDI
по всему UI: каналы (#/🔊/🔒), композер «+», рейл (home/plus), user-bar (⚙/👤),
voice/call тумблеры — 30×30 иконочные (mic/-off, headphones-off, video/-off,
cast-connected, phone-hangup), марки мьюта (11px, self-жёлтый/mod-красный),
share-пикер, friends. **Каркас** — ростер ПЕРЕЕХАЛ из сайдбара в ОТДЕЛЬНУЮ
правую колонку `MembersPane` 190px #2b2d31 (oak members-pane; скрыт в dmMode и
под звонком), сайдбар 220px #2b2d31, рейл #1e1f22 с белой ПИЛЮЛЕЙ 4×24 у
активного сервера + squircle-морф hover, аватар 36 + presence-точка ПОВЕРХ
аватара (10px, бордер #2b2d31), фолбэк-аватар — цвет детерминированной палитры
(`logic/user-palette.ts`, djb2 % 12, ЕЁ ЖЕ красится ник автора в чате — как oak),
заголовки секций = pane-title (12px bold #b5bac1, НЕ uppercase), voice-строки
участников с аватарами 20. **Чат** — шапка с divider #4e5058, hover строки
#35373c, время «Today at HH:mm/Yesterday/MMM d» (`formatHeaderStamp`),
(edited) #949ba4 11px, NEW-divider ЖЁЛТЫЙ, реакции без бордеров (mine
rgba(88,101,242,.30)), цитаты radius 4 0 0 4 + blurple-полоса, композер =
КАРТОЧКА #383a40 radius 8 c «+» (файл-пикер!) и прозрачной textarea 13px до 10
строк, без Send. **Тосты** — 280px #1e1f22, mention 2px blurple-рамка, body в
1 строку, новые СВЕРХУ + плашка «Hide all». **Прочее** — кнопки primary hover
#4752c4, модалы radius 10 + рамка #383a40, контекст-меню radius 8 строки 12px
#dbdee1 hover #35373c, overlay-скроллбары (12px, rgba(255,255,255,.08)→.18 по
hover), плитки голоса/звонка — ПОСТОЯННАЯ рамка 2px #4e5058 (speaking только
красит), user-bar карточка #383a40 44px. Нативная ОС-рамка окна ОСТАВЛЕНА
сознательно (oak'овый borderless-хром = потеря Aero Snap; вопрос открыт).
**РЕСТРУКТУРИЗАЦИЯ ЛЭАУТА под oak-модель (после юзер-ревью, главный раунд):**
каркас = `.left-section` [рейл 72 + каналы 220] + `.left-overlay` — НИЖНЯЯ
КАРТОЧКА-ОВЕРЛЕЙ ПОВЕРХ ОБОИХ колонок (absolute, отступы 8): [voiceBar
`#313338` radius 8 8 0 0, только при живом голосе] над [userBar `#383a40`
(0 0 8 8 / 8 без голоса)] — в voiceBar СТАТУС-строка (клик = toggleRoomView:
room view = СВАП чат-зоны на плитки, `roomViewOpen` в appStore, гасится на
канал/DM/settings/teardown голоса) + кнопки 30×30: mute/deafen/**NS
(TriangleWaveIcon = APM-тумблер)**/camera/share/leave; userBar = аватар+ник+
**цветной статус STOMP** (Connected/Reconnecting/Lost/Offline)+⚙ ЕДИНСТВЕННАЯ
кнопка (аватар-редактор ПЕРЕЕХАЛ в Settings → General = AvatarEditor, бывший
ProfileModal; 👤 из user-bar УДАЛЁН). VoiceRoom.tsx РАЗДЕЛЁН: VoiceMarks +
VoiceBar (левая карточка) + RoomView (чат-зона: шапка «← имя канала · N in
room · M screens» + плитки + share-panel; тон-кнопки L/R УДАЛЕНЫ из UI —
теперь ТОЛЬКО в Diagnostics). Ростер MembersPane 190px СПРАВА от чата
(content = row; скрыт в dmMode/звонке/room view — починено «внизу под
чатом»: раньше .content был column и ростер падал вниз). MainScreen владеет
всем лэйаутом (ServerRail перенесён из App). Tone L/R и getDisplayMedia-тест
— в скрытой diag-панели (Ctrl+Shift+D). Гейт 191/191.

M6 закрыт и закоммичен (`088df95`). M7 (код готов, ждёт смоука; electron-builder —
после смоука): **ServerSettings** (ПКМ по серверу в рейле, гейт canManageAnySettings
= MANAGE_ROLES||MANAGE_MEMBERS||KICK||BAN||MANAGE_CHANNELS; in-app экран поверх
контента, ESC/✕ закрывает): **Overview** — rename `PATCH /api/server {name}`
(wire разведан по oak-клиенту — ПРОВЕРИТЬ НА СМОУКЕ ответ); **Roles** — список
custom по position (@everyone внизу редактируем только по правам, OWNER скрыт),
«+» создаёт «New role N» сразу POST (дефолт: без цвета/прав, oak-паттерн),
↑/↓-кнопки reorder (drag не делали — осознанное отступление) → `PUT /roles/order`,
trash+confirm; редактор: Appearance (имя, палитра+HEX+Default, mentionable/hoist,
Save Changes — **color на PATCH безусловен: null=сброс, отправляем выбранный
color всегда**), Permissions (каталог `GET /api/permissions`, группы
General/Text/Voice, описания всегда видны, пометка «(not implemented yet)»,
VIEW_CHANNEL без чекбокса), Members-в-роль (полный набор PUT
`/api/members/{id}/roles` + пикер кандидатов без роли); **Members** — активные +
GET /bans НЕ нужен (аудит-4: список ОДИН из /api/members — banned-флаг в каждой
строке, бейдж BANNED + Unban вместо Kick/Ban; отдельный фетч давал дубль и живые
Kick/Ban по забаненному), Kick/Ban через confirm-модали (owner — disabled),
роли read-only (+ явная строка «Owner»); **Channels** —
текст+голос, trash-удаление канала прямо в строке, таб Permissions = tri-state
ЧЕКБОКС-ЦИКЛЕР как oak (Inherit→Allow blurple✓→Deny красный✗, один клик — один
шаг; `PUT /overrides/{roleId}
{allow[],deny[]}` — ПОЛНАЯ замена, neutral = имя вне обоих множеств, DELETE =
сброс к базе роли; показываем только Text/Voice+MANAGE_CHANNELS, VIEW скрыт) и
таб Access = Public/Locked/Hidden (НЕ поле сервера — ИНФЕРЕНС из @everyone-deny:
hidden=deny VIEW, locked=deny READ/SEND/ADD_REACTIONS (text) или CONNECT/SPEAK
(voice); чекбоксы ролей/участников с доступом → Save прогоняет ЧИСТУЮ
`buildAccessWrites` (managed-набор {VIEW,READ,SEND,ADD_REACTIONS,CONNECT,SPEAK}:
@everyone deny=(old−managed)∪modeSet; грантам allow∪=modeSet; снятым −managed;
опустевшие строки DELETE; unmanaged биты переживают) — вся математика в
`logic/channel-access.ts` с тестами). **Live-трекинг**: `/topic/roles|members` →
memberRefresh теперь ДОТЯГИВАЕТ refreshPermissions (гейты второго клиента
флипаются; оверрайды сами пингуют `/topic/channels.changed` → refetch+гейтинг,
а сервер дополнительно кикает из голоса потерявших CONNECT через
VoiceAccessEnforcer). **UserSettings (аудит-раунд 5 = oak-парити SettingsWindow):**
7 секций General/Account/Audio/Video/Appearance/Notifications/Connections; Audio/
Video/Appearance/Notifications — oak STAGED-модель (контролы пишут черновик
`useStagedSettings` в UserSettingsModal, Apply коммитит через `settingsStore.apply`
+ живые эффекты — спикер setSinkId / кеш-бюджет; уход из секции или закрытие без
Apply = СБРОС черновика; General/Account/Connections — immediate): **General** =
идиома Server Settings → Overview (заголовок overview-heading + имя в
role-editor-name без карандаша + AvatarEditor stacked); **Account** — пароль с
oak-лестницей валидации (длина→совпадение→отличие от текущего), ротация пары БЕЗ
рестарта WS; username: гейт CHANGE_NICKNAME, ошибки 409/403 → человекотекстовые
(«Username already taken.»/«no permission») через `ApiError.status`, rename НЕ
закрывает окно — teardownSession не гасит userSettingsOpen, App держит оверлей
на прошлой сессии через мигание sessionBinding при тихом рестарте (поле/статус
живут, baseline едет на новое имя; expiry/kicked закрывают явно); **Audio** —
устройства mic/speaker, Chromium-синтетика «Default -/Communications -»
(deviceId `default`/`communications`) СКРЫТА как дубль System default (аналог
oak-маппера «Первичный звуковой драйвер»); **Video** — дефолтная камера; both
предупреждают amber-строкой только при несохранённых изменениях; **Appearance** —
ctrlEnter, relativeDates, кеш Off/64 MB..4 GB с GB-метками (`logic/settings-format.ts`
+ тесты); **Notifications** — мастера+toast TTL/cap+ring timeout+per-server
mode/suppress, всё staged (пишется в `notifPrefs` записи на том же Apply);
**Connections** — read-only: advertised-адрес `connectionHost:connectionPort` из
GET /api/server («not set by the server» при отсутствии), список «имя сервера —
hostUrl», oak-хинт про future set-up flow. Бейджи (Sidebar/DmSidebar/Home-рейл)
и штампы дат (MessageRow/ForwardCard) теперь ПОДПИСКи на badgeEnabled/
relativeDates — до раунда 5 настройки вообще не перекрашивали их до следующего
сообщения. **Полиш**: @автодополнение в композере (попап по `@префиксу` — ростер, ≤10,
↑/↓/Enter/Tab/Esc; Enter при открытом попапе = выбор, не отправка). Гейт
225/225.

**Аудит-раунд 6 (друзья/DM, 2026-09-13) — oak-парити + кросс-инстанс
агрегация (phase 1):** FriendsPane/DmSidebar перестроены на объединённые
списки по ВСЕМ инстансам (`domain/logic/social-aggregation.ts` — mergeFriendRows
глобальная сорт-по-имени без дедупа «одно имя на двух серверах = два человека»,
mergeDmRows глобальная сорт-по-свежести nulls-last, чистые + тесты).
**Агрегация phase 1** = REST-снапшоты неактивных рекордов (`renderer/social-aggregate.ts`:
relationships+dms+presence+read-states+GET /api/server на запись через
RecordTokenStorage-каспередачу; СТОР `socialDirectory` — снапшот-массив
КЕШИРУЕТСЯ в поле, пересборка только в apply/drop — свежий массив из
getSnapshot() рвёт useSyncExternalStore в бесконечный ре-рендер, ГРАБЛЯ M6
повторена вживую); освежение при входе в DM-вид/свитче/старте; сбой записи
держит предыдущий снапшот. Чужие строки: InstanceTag (14px диск — иконка
сервера из профиля, фолбэк инициалы) + «Open <server>» (френды) / клик =
`openDmOnInstance` (DM-строки: pendingOpenDm в appStore, потребляется в
openSession ПОСЛЕ start вместо restoreLastChannel, переживает логин-модал по
пути); контекст-меню DM только на активных строках. Аватары чужих строк:
`Avatar` принимает `session: null` → `useUncachedImage` (presigned fetch →
blob, без кеша). **Бейджи-раунд:** Home = DM-unread активного + фоновые
dmCounts + ВХОДЯЩИЕ pending-запросы (юзер-решение), прячется в открытом
DM-виде (oak); СЕРВЕРНЫЕ иконки рейла получили бейджи (дыра против oak):
серый = plain unread, красный = mention, число = unread 99+; активный сервер
— живой readStateStore МИНУС DM-каналы (badge-сепарация), неактивные —
serverCounts снапшота; бейдж — СИБЛИНГ `.rail-icon` внутри `.rail-wrap`
(внутри иконки его `clip-path: squircle` ОБРЕЗАЕТ бейдж — грабля).
**oak-фиксы раунда:** автодополнение username в Add Friend (попап ПОД полем,
↑/↓/Enter/Esc); DM-меню: «Add member…» owner-only + разделитель перед Leave;
«+» кликабельна всегда → при <2 друзей модал; аватары DM 36px c ДВУМЯ
инициалами (группа — круг), френда 40px; табы Friends подчёркнутые
(.settings-tab идиома), Add Friend справа без зелёного; Rename-хинт;
confirm-модали на Remove friend/Block (space-добавка, oak бьёт сразу).
**Фиксы уведомлений:** OS-баннер Windows теперь ТОЛЬКО на эффективные
mentions (@/DM) — раньше летел на каждый нефокусный тост и читался как
mention-ping (живой репорт); inOpenChannel серверных каналов учитывает dmMode
(сидя в Home, mention-тост в «активном» канале больше не глотается — oak
нулит selectedChannelId в enterDmMode); СВОЁ сообщение не бампит unread/тост
(STOMP-эхо гонит REST-эхо при !isLoaded — вставлялось как «новое», звенело
отправителю в DM); NEW-divider рендерится над первым ЧУЖИМ непрочитанным
(own-сообщение не бывает NEW — указатель lastRead регулярно стоит под своим
же сообщением после ack-на-отправке). Гейт 231/231.

## M6 (закрыт, 088df95): социальный слой

M5 закрыт и закоммичен (`b14b2a6`). M6: **друзья** —
`GET /api/users/me/relationships` (типы `FRIEND|BLOCKED|PENDING_INCOMING|
PENDING_OUTGOING` — сервер сам сворачивает направление в caller-view); запрос
`POST /friends {username}` (взаимный pending авто-акцептится в FRIEND), accept =
`PUT /friends/{id}`, cancel/decline/unfriend — ОДИН идемпотентный `DELETE
/friends/{id}`; блок `POST/DELETE /blocks`. Пуш `/user/queue/relationships`
(5 типов) — oak-паттерн: ЛЮБОЕ событие = refetch (без ветвления по типам);
актор своих мутаций в пуше не получает → каждая мутация сама зовёт refresh.
**Коалесирование** (`lib/refresher.ts` CoalescingRefresher): событие в полёте
снапшота не параллелит fetch, а переигрывается после — иначе медленный снапшот
прилетает ПОСЛЕ свежего refetch и воскрешает старые строки (класс presence-гонки,
применённый к спискам). Снапшоты соцслоя берутся ПОСЛЕ подписок (та же
антигонка, что presence). **DM**: `GET /api/channels/dm` (в `/api/channels` DM
НЕ входят!); 1:1 = `POST /api/channels/dm {recipientId}` (get-or-create, всегда
200, дублей нет); группа = `POST /api/channels/group-dm` (итог 3–10 участников,
создатель = owner); rename группы = **голый `PATCH /api/channels/{id}`** (серверные
каналы — PATCH `/{id}/name`!); add/remove участника = `POST/DELETE /{id}/participants
[/{userId}]` (remove self = leave; **ушедшему событие НЕ приходит** → локальный
forget); close = `DELETE /api/channels/dm/{id}` (1:1 — любой, группа — owner;
удаляет канал и сообщения ДЛЯ ВСЕХ). Пуш `/user/queue/dm.channels` (CREATED/
PARTICIPANT_ADDED/PARTICIPANT_REMOVED/RENAMED/CLOSED) — тоже refetch; CLOSED
дополнительно локально забывается сразу. Сообщения/read-states DM — те же общие
`/api/channels/{id}/...` + `/topic/channel.{id}` (интерсептор гейтит по участию).
**DM-unread = mention-эквивалент** (`bumpLive(..., forceMention)`, oak-правило):
каждое DM-сообщение красит бейдж красным и звенит колокольчиком; тост кликабелен
в открытый DM; Home-бейдж = сумма DM-unread (красный). **UI**: Home-кнопка ⌂ в
рейле (dmMode; активный серверный канал ПЕРЕЖИВАЕТ заход в Home — activeDmId
отдельно от activeChannelId); сайдбар в dmMode = Friends-строка + DM-лист
(`lastMessageAt desc`, live-флот через `updateDmLastMessage` — правка старого
сообщения строку НЕ поднимает, guard `shouldRefreshPreview`); FriendsPane: табы
All/Online/Pending(in/out секции)/Blocked + Add Friend; ChatPane канало-агностичен
через Channel-shaped адаптер DM (`dmViewChannel`), композер в DM всегда открыт
(гейтов прав нет), заголовок `@peer`. **Ростер**: `GET /api/members` (roleIds +
owner) + `GET /api/roles` (color = ARGB int nullable — **отрицательные значения
норма**, decode `argbIntToCss`; position, hoist) — эффективный цвет/hoist клиент
считает сам (`logic/roster-grouping.ts`, чистая): hoist-бакеты по ВЫСШЕЙ
hoist-роли (kind OWNER не hoistит, owner-юзель всегда в общем Online), группы по
position desc, потом Online, потом Offline (hoist на офлайне НЕ действует);
внутри self-first + алфавит; цвет ника = высшая роль С цветом. `/topic/members` +
`/topic/roles` = contentless ping → коалесированный refetch обоих. 👑 owner-бейдж
в ростере — парити-плюс (у oak его не было; бан-бейджи — M7 Server Settings).
**Модерация**: ПКМ ростера Kick/Ban (гейты KICK/BAN_MEMBERS + клиентский
canActOn-хинт: owner иммунен, иначе strict >, unknown → allow; сервер
перепроверяет) + confirm-модалы; жертве `/user/queue/member.kick {by, banned}`
→ teardown сессии + логин-скрин с причиной (токены при kick живы — реклик
сервера работает). **Блокировка**: клиент НИЧЕГО не скрывает (сервер
enforcement'ит: blockedEitherDirection гейтит friend и DM) — только вкладка
Blocked + Block/Unblock. Аватары друзей/DM-участников — через `override`-проп
Avatar (они могут не быть в ростере сервера).

**Смоук-фиксы M6 (2 живых бага):** (1) **«Нет ни бейджа, ни тоста на DM-сообщение,
пока сам не откроешь DM»** — ДВА корня. Первый: `MessageStore.applyLive` дропает
live-строки каналов с НЕзагруженной историей, а топик-подписка звала
`onLiveMessage` ТОЛЬКО при успешной вставке → неоткрытый DM вообще не порождал
ни бейджа, ни тоста, ни флоат-превью (это и давнишний скрытый недочёт M1 для
НИКОГДА не открывавшихся серверных каналов). Теперь: `onLiveMessage` вызывается
и для «дроп-потому-что-не-загружен» (`inserted || !isLoaded`); молчит только
«дроп-при-загруженном» = собственное echo отправителя. Второй: `bumpLive`
no-op'ил при отсутствии seeded-записи read-state — а у DM, созданного ПОСЛЕ
стартового снимка read-states, записи нет → сид из нуля при первом сообщении.
(2) **«Close DM → Message → сообщение не доходит»** — гонка подписки: close
снимает DM-подписку получателя, повторное создание шлёт CREATED → но подписка
ставилась только по завершении асинхронного refetch, а первое сообщение летит
быстрее и терялось. Теперь CREATED мержится из САМОГО пуша (payload несёт все
поля) + немедленная syncDmSubscriptions; refetch остаётся для свежести.
Дополнительно: onLiveMessage игнорит кадры каналов, которых уже нет локально
(закрытый DM — кадр в полёте после отписки). (3) **«Клик на сервер не выводит
из Home»** — клик по иконке АКТИВНОГО сервера упирался в same-record guard и
ничего не делал; теперь это явный «назад на сервер» (exitHomeMode).

## M5 (закрыт, b14b2a6): P2P-звонки

M4 закрыт и закоммичен (`eb59ddc`). M5: **сигналинг** —
`/app/call.signal` → сервер релеит адресно в `/user/queue/call.signal`, штампует
`from`; `CallSignal{type, to, sdp?, candidate?}`, типы RING/ACCEPT/REJECT/HANGUP/
OFFER/ANSWER/ICE (+UI-статусы CAM/MIC/SCREEN_ON|OFF — сервер релеит как есть);
`IceCandidate{sdp, sdpMid, sdpMLineIndex}` (sdp = candidate-строка); ICE/TURN из
`GET /api/call/config` (имена полей RTCIceServer-совместимы, кладутся в
RTCPeerConnection напрямую). **Ядро `core/peer-call.ts`** — m-line КОНТРАКТ в
initial offer, ренего НЕ существует: [0] голос (мик сразу), [1] видео (камера ИЛИ
экран), [2] шар-аудио; камера/шар/стоп = replaceTrack на пред-согласованных
слотах (видео-слот один — камера и шара взаимно исключаются); stereo=1 мунжится
в ПОСЛЕДНЮЮ m=audio оффера (`mungeStereoIntoOffer(sdp, "")` — fallback как раз
наша раскладка), replaceTrack SDP не трогает — стерео живёт весь звонок;
maxBitrate 256k на шар-сендере; trickle ICE с БУФЕРОМ кандидатов до
setRemoteDescription (ANSWER может опоздать); маршрутизация входящих треков ПО
СЛОТУ m-line (indexOf transceiver). **ICE-restart только caller** (роль фиксирует
RING/ACCEPT-рукопожатие, glare невозможен): failed → лестница 1/2/4/8/16 с без
лимита (`logic/ice-restart.ts`, planIceRestart — транзиентный disconnected
игнорируется); callee «answering in place» — тот же OFFER-путь. **runtime**:
машина состояний idle/ringing-out/ringing-in/connecting/in-call; busy =
авто-REJECT; ring-timeout 60 с (No answer/missed); gap-timeout 30 с (accept→media,
если пир исчез после ACCEPT); сигналы, обогнавшие сессию (OFFER пока микрофон
callee поднимается) буферизуются и дренятся; **эксклюзивы комната↔звонок** —
модал в ОБЕ стороны (start/accept при комнате → «отключит от комнаты», клик по
каналу при звонке → «завершит звонок»); RoomAudio-цепи по фидам -1/-2 (голос/шар
пира) — громкости шэрятся с записью подключения (persistedGain); call-деafen =
локальный roomAudio.setDeafened (серверного voice-control в P2P нет). **Звуки**:
ringback у звонящего (440+480 Гц, 1.8 с бёрст + 1.2 с пауза, луп, тихо);
chime у принимающего (ОДНОКРАТНЫЙ, три парциали C6, экспо-декей 2.6 с) —
`logic/call-sounds.ts`. **UI**: ПКМ по участнику ростера → Call (online, не self);
`CallOverlayCard` (fixed, ringing — чат остаётся доступен); `CallPane`
(connecting/in-call занимает контент-область): 2 тайла (self первый), марки
мьюта своего/пира, слайдеры voice/share пира, Mute/Deafen/Camera/Share/Hangup,
таймер MM:SS (пауза при reconnecting); diag-строка `call`. Грабля (предотвращена):
трек видео пира может прийти ДО монтирования <video> — трек держится в runtime
(getCallPeerVideoTrack), CallPane ре-биндит на флипе peerTileMedia.

**Смоук-фиксы M5 (3 живых бага):** (1) **Чёрный экран видео у получателя** —
`replaceTrack` на слоте, согласованном БЕЗ трека (нет msid в SDP), НЕ анонсирует
источник удалённой стороне: ontrack у получателя не стреляет НИКОГДА. Лекарь —
ПАССИВНЫЙ БИНД `receiver.track` пустых слотов (видео/шар-аудио) после КАЖДОГО
setRemoteDescription (дедуп по треку): трек там существует с момента согласования
m-line (muted), Chromium оживит его с первым RTP — ренего и glare не нужны
(`bindPassiveReceiverSlots`; ontrack остался авторитетом ТОЛЬКО для voice-слота).
Локальное превью при шаре — тот же класс: эффект слушал только callCameraOn,
теперь [callCameraOn, callSharing] + getCallLocalVideoTrack (камера-или-экран).
(2) **Deafen** делал только локальную тишину — теперь глушит и мик (implied mute,
MIC_OFF уезжает пиру → 🔇), undeafen возвращает прежнее состояние мьюка, новый
UI-сигнал DEAFEN_ON/OFF даёт пиру марку 🎧 (серверного voice-control в P2P нет).
(3) **Рингбэк при быстром ответе доигрывал бёрст** — stopRingback убирал только
интервал; теперь мастер-гейн текущего бёрста режется 30-мс рампой
(cancelScheduledValues + linearRampToValueAtTime). (4) **Видео у получателя —
второй раунд (первый пассивный бинд не долечил)**: в логах обеих сторон «remote
track on unexpected m-line slot 3/4» — при SRD Chromium НЕ сматчил наши заранее
созданные ПУСТЫЕ видео/шар-транссиверы с m-line оффера и создал свои: наших 3 +
его новые = 6, индексный слот-контракт сломан, а конструкторские sender'ы callee
шли по мёртвым m-line (RTP в никуда). Лекарь — **адресация по a=mid из
согласованного SDP, не по индексу массива** (`sdp.sectionMids`; slotMids
принимаются из local offer / входящего offer / answer): senderForSlot /
bindPassiveReceiverSlots / роутинг ontrack резолвят транссиверы по mid —
устойчиво к любому матчингу Chromium; телеметрия «mids from …: transceivers: …»
в лог. (5) **«У одного клиент
собеседник офлайн»** — ГОНКА СНАПШОТА И ПОДПИСКИ: presence-снимок брался ДО
stomp.connect/SUBSCRIBE — ONLINE-дельта пира, подключившегося в этом окне,
уходила в топик без подписчика → офлайн навсегда (асимметрично: у второго всё
норм). Лекарь (калька oak pendingDeltas): presence и voice-members снимаются
СТРОГО ПОСЛЕ subscribeGlobalTopics; дельты на время полёта снимка буферизуются в
RosterStore (Map username→статус, последняя побеждает) и накатываются ПОВЕРХ
снимка; проваленный снимок закрывает буфер через abortPresenceSnapshot (накат на
текущее состояние). Остальные срезы (channels/messages/read-states) гонки не
имеют: у них либо рефетч-пинги, либо ack на открытии.

## M4 (закрыт, eb59ddc): голос-парити

M3 закрыт и закоммичен (`7321b95`). M4 (код готов, ждёт смоука): **self mute/deafen +
модерация** — `/app/voice.mute|deafen|kick` с `VoiceControlCommand{channelId,
targetUsername, muted?, deafened?}`; self-ветка (target == сам) права не требует,
сервер держит 4 множества-origin (selfMuted/modMuted/selfDeafened/modDeafened) и
шлёт `/topic/voice.state` с 8 полями (muted/deafened = UNION — комплаенс; origin
флаги ЯВНО — union∖self неоднозначен при обоих true). Клиент: `VoiceControlStore`
(per-connection, origin-флаги verbatim), комплаенс в runtime: `voiceCompliance`
(ЖИВЁТ ВНЕ SfuSession — переживает rejoin, пере-мьютит свежие треки): мик по union,
share-аудио ТОЛЬКО по modMuted (self-mute музыку не глушит — Discord), deafen =
`RoomAudio.setDeafened` (цепи хранят целевую громкость, element.volume 0↔target).
Тумблеры читают ТОЛЬКО self-флаги (свой анмьют не снимает модераторский). KICKED =
`/user/queue/voice.control` → leaveVoice + тост. Модерация: ПКМ «⋯» на тайле
(Server mute/deafen/kick, гейты MUTE_MEMBERS/DEAFEN_MEMBERS/MOVE_MEMBERS,
иерархию проверяет сервер — клиентский гейт только hint). Марки 🔇/🎧 жёлтый
self / красный mod (mod побеждает) в тайлах и сайдбаре; очистка на LEFT (mod-метки
переживают ревход сервером и репаблишатся пушем). **Камера**: `SfuSession.
startCamera/stopCamera` (второй video m-line, взаимное исключение с шаром — один
исходящий видео-слот, oak-модель; у зрителей камера = видео-фид с Watch-семантикой,
селективная подписка), своё превью `<video muted>` в тайле. **Пикер шара**
`SharePickerModal`: вкладки Screens/Windows (IPC `space-capture:sources` —
desktopCapturer с превью 320×180) / Camera (enumerateDevices, без превью v1);
выбор экрана → IPC `space-capture:select(id, withAudio)` → ГРАНТ через
`setDisplayMediaRequestHandler` с pendingGrant (renderer-Constraints
chromeMediaSourceId ненадёжны при живом хендлере — хендлер остаётся единственной
точкой гранта, pending потребляется одним грантом); loopback-аудио ТОЛЬКО у целых
экранов (окна/камера — video-only). **Pop-out просмотрщик шара**: IPC
`space-window:popout` — второй BrowserWindow (#popout в hash), MediaStream не
переходит между контекстами рендерера → главное окно качает JPEG-кадры
(canvas ≤1280, q0.75, ~12 fps, IPC `popout:frame`), закрытие → `popout:closed`.
**Rejoin-лестница** (runtime): onSessionLost/live-426 → teardown + попытки
1/2/4/8/8 с (`logic/rejoin-ladder.ts`), кап 5 → полный выход + voice.leave + тост
+ leave-стук; join-time 426 = ОДИН ретрай через свежий /room; отмена на всех
осознанных выходах; комплаенс пере-применяется после reconnect. **Звуки входа/выхода**
WebAudio-стук «тук … тук» 150→210 Hz (join) / 210→150 (leave), нота 35 мс, пауза
80 мс, атака 3 мс, τ=20 мс (`logic/knock-sound.ts` + `notifications.playKnock`),
join — только после успешного sfu.start, leave/giveUp — уходившему. Списки
голосовых в сайдбаре уже жили с M1 (voiceMembers) — теперь с марками.

**Смоук-фикс M4 (тишина при подключении, лечилась переподключением):** у
subscriber-PC НЕ отслеживался connectionState — ICE-failure входящего тракта
умирал МОЛЧА (все строки лога здоровы: цепь attached, подписки есть). Теперь
`onconnectionstatechange` на subscriber: 'failed' → `SubscriberTransportError` →
runtime пускает REJOIN-ЛЕСТНИЦУ (ровно то, что юзер делал руками); 'connected'
трассируется в лог; состояние видно в diag-строке `sub conn`. Транзиентный
'disconnected' сознательно игнорируется (oak-урок: краткие моргания лечит сам
libwebrtc). Дроп-гипотеза (ontrack раньше attached-события) НЕ подтвердилась
логами — «track on unknown slot mid» не встретился ни разу.

## M3 (закрыт, 7321b95): вложения и медиа

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
none при open+focused); **VirtualList** (M7-миграция на **@tanstack/react-virtual
3.14** после серии джанк-регрессий самодельной математики; публичный API прежний:
estimate→measure высоты через `measureElement`, prepend-якорь по старому первому
ключу с пере-утверждением 3 layout-проходов, jump с бэкфиллом кап 1000 и
re-assert 4×30мс; строки `pointer-events: none` на время активного скролла —
пролёт под курсором больше не ховерится; `domain/logic/virtual-window.ts` УДАЛЁН
вместе с его тестами); пагинация скроллом вверх (HISTORY_PAGE=50, конец по СЫРОЙ
странице); мультиселект (Select → клики тогглят, групповой Forward/Delete);
perf-гейт: кнопка «seed 10k» в diag + jank-трассировщик в space.log
(`[perf] <событие> <мс>`, >100мс события / >50мс longtask — renderer/main.tsx).

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

- **Библиотека после двух осечек (юзер-правило, 2026-09-11):** если проблема не
  закрылась за ~2 попытки ручных фиксов одного корня — третий шаг не новый фикс,
  а поиск общепринятой библиотеки/штатного механизма платформы (пример-прецедент:
  серия скролл-джанков закрылась миграцией на @tanstack/react-virtual + нативные
  механизмы, а не пятой итерацией самодельного кода). Порог именно две осечки —
  зависимости не тащатся с первого чиха.
- **Осознанные отступления от oak (юзер-решения, не «чинить» при сверках):**
  room view без части «· N screens» при нулевом числе шаров (oak печатает «0 screens»);
  speaking-рамка с CSS-fade (oak свапает цвет мгновенно); forward-карточка с ЖЁЛТОЙ
  полосой (oak красит blurple как у reply — различимость признана лучше); динамический
  плейсхолдер композера с именем канала (oak: статичное «Message...»); цвет ника автора
  в чате = цвет высшей роли (oak: детерминированная палитра по нику); порядок каналов
  в сайдбаре = порядок сервера БЕЗ алфавитной сортировки внутри типа (аудит-раунд 3,
  oak: case-insensitive алфавит); «(you)» в голос-строках сайдбара (oak помечает self
  только в ростере и тайлах); ростер СКРЫТ в dmMode (oak-недоделка — там ростер
  инстанса остаётся видимым, открытый пункт их чек-листа; тащить не стали); аватары
  в списке Server Settings → Members (oak: только имя + бейджи). «Reset to inherit»
  в канальном редакторе оверрайдов УДАЛЕНА юзером (2026-09-11: лишняя — сброс =
  выставить всё в Inherit и Save). Аудит-раунд 5 (User Settings, 2026-09-12):
  кнопка Apply ПРИЖАТА к контенту по левому краю (oak: правый-нижний угол окна на
  двухтоновом футере); APM-тоггл УДАЛЁН из Audio (в oak — тестовый люк legacy-
  конвейера; флагом управляет только NS-кнопка голосовой панели/звонка); General-
  аватар = Overview-идиома (без oak-колонки Profile/имя/hint, без dnd и без гейта
  Re-crop по наличию аватара); mode-комбо Notifications с человеческими подписями
  «All messages/Mentions only/Nothing» (oak: сырые имена enum). Аудит-раунд 6
  (2026-09-13): Home-бейдж считает входящие pending-запросы друзей вместе с
  DM-unread (oak: только DM); OS-оповещения Windows только на эффективные
  mentions (oak: OS-нотификаций нет вовсе); confirm-модали на Remove
  friend/Block (oak бьёт из меню сразу).

**Фоновые STOMP-сессии (задача #473, oak phase 2, 2026-09-13):** каждая
записанная учётка держит ЖИВУЮ `ConnectionSession` (runtime `sessionMap` +
промоут/демоут): свитч сервера ПРОМОУТИТ фоновую сессию на место активной
БЕЗ teardown/рукопожатия (статус сразу Connected, каналы из живых сторов),
преждняя активная уходит в фон. Hooks — фабрика `makeSessionHooks(recordId)` с
гейтом `isActive()`: глобальный UI (stomp-статус, voice, звонки, роутинг
каналов) ведёт ТОЛЬКО активная; фоновые бампят свои счётчики, всплывают свои
DM-строки, тостят с prefs своей записи (клик = openDmOnInstance), истечение/
кик на фоновом = тихий dispose + REST-фолбэк + тост. Агрегат: контроллер в
social-aggregate подписан на сторы фоновых сессий → троттлинг 1 c («от первой
отметки», потоп не морит) → те же снапшот-записи в socialDirectory; REST-загрузчик
только для записей без сессии (мёртвая семья токенов, упавший старт). Фоновая
лестница реконнектов после исчерпания тихо перезапускается (пауза 30 с между
циклами) — упавший сервер возвращается сам. Гейт 231/231.
- **Бэклог: рабочий Rename участника** (Server Settings → Members; задача #472): сейчас
  кнопка — oak-заглушка (no-op). Реализация требует серверного эндпоинта под
  MANAGE_NICKNAMES + иерархией (парный деплой); модель — displayName-поле, НЕ
  переименование username (username = JWT-subject: self-rename уже ротирует токены
  и рвёт STOMP principal — чужой rename устроил бы жертве то же). Клиент: форма у
  кнопки, рендер displayName с фолбэком на username, live-пуш.
- Гейт после каждой фазы: `npm test` + `npm run typecheck` зелёные.
- Новые файлы сразу `git add`. Коммиты только по явной команде; subject на английском.
- Никаких single-letter имён (кроме i/j цикла и T/E/K/V генериков); комментарии в коде
  на английском; тесты — на поведение, а не на реализацию.
- Логика, которую можно вынести в чистые функции, живет в чистых функциях с тестами;
  DOM/WebAudio-обвязка вокруг них тонкая.

## Грабли, уже пойманные здесь

- **updateRole шлёт `name` ТОЛЬКО при реальном изменении** (иначе `null` = не
  трогать, partial-PATCH). Сервер валидирует имя роли `[\p{L}\p{N}_-]{1,32}` —
  буквы ЛЮБОГО алфавита (юзер-решение 2026-09-11: запрет кириллицы снят; раньше
  было `[A-Za-z0-9_-]`), цифры, `_`, `-`; пробел/пунктуация — 400. Tradeoff:
  @-упоминания (`@token` ASCII-grammar) нечатаемую роль не матчат — остаётся
  текстом. 400 от `ResponseStatusException` В ЛОГ СЕРВЕРА НЕ ПИШЕТСЯ — «лог
  чистый» ≠ «запрос не дошёл». Дефолт новых ролей — «New-role» (юзер-решение).
- **Инлайновый `<svg>` в корне App сдвигает весь layout вниз**: даже `width=0
  height=0` инлайновый svg открывает строку-бокс (~20px) ПЕРЕД `#app` — низ
  окна (композер/user-bar) уезжал за обрез. SVG-defs в App обязан нести
  `position: absolute` (вне потока). Живой баг полиш-раунда M7.
- **Живой краш M6 «UI crashed: Maximum update depth exceeded»**: getSnapshot,
  собирающий литеральный объект на каждый вызов (или селектор с filter/map),
  РВАНУЛ useSyncExternalStore в бесконечный ре-рендер — контракт: селектор
  возвращает ТОЖДЕСТВЕННУЮ ссылку, пока стор не мутировал. Сеттеры всех сторов
  пересоздают снапшот-объект; производные массивы (filter/sort) — ТОЛЬКО в
  useMemo компонента, никогда в селекторе.

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
