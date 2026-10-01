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

**Аудит-раунд 7 (уведомления, 2026-09-13) — oak-парити:** **ROLE-упоминания** —
полные mention'ы (@роль, которую держишь = красный бейдж + дзинь + blurple,
oak mentionsMe); матч по ID: `MentionIdentity {userId, roleIds}` собирается из
member-ростра СВОЕЙ сессии (`selfIdentityFor`, фон тоже), USER тоже по id
(rename не ломает), до загрузки ростера ничего не матчится (oak «safe before
the roster»); сигнатуры `ReadStateStore.bumpLive`/`NotificationHub.
handleMessage` принимают identity вместо username-строки. **Тосты:**
mention-рамка следует за MENTION, а не за решением звука (mention при
выключенном звуке — blurple, oak передаёт флаг отдельно); заголовки oak-формата
(`toastServerHeader`/`dmToastHeader` в `logic/toast-preview.ts`): серверный
«Server  #channel» (два пробела), DM-группа — имя, 1:1 — БЕЗ заголовка (автор
и есть пир; раньше был дубль), чужой инстанс тегается именем сервера, пустой
header не рендерится; превью = `toastPreview` (strip @токенов, схлопывание
пробелов, 80 символов + «…» — oak previewText; пустой → «(attachment)», наше);
**TTL карточки пазится ховером** с дозапуском на ОСТАТОК (oak timer.pause;
курсор ушёл из окна целиком — resume всех пауз, mouseleave через пустоту не
стреляет); jump за кап 1000 → тост «Message is too far back to jump to» (oak).
**Фон:** дефолт per-server режима = MENTIONS (юзер-решение, oak: ALL — спам
фоновых серверных тостов; единая `DEFAULT_NOTIFICATION_PREFS` в
connection-record, модалка читает её); клик фонового СЕРВЕРНОГО тоста работает:
`pendingOpenChannel` (симметрично pendingOpenDm: свитч+открытие после старта,
переживает teardown/логин-модал, удалённый канал → фолбэк restoreLastChannel;
`openChannelOnInstance`; оба pendings потребляет общий `consumePendingOpen`).
**Звук:** стук входа/выхода под гейтом soundEnabled (oak гейтит каждый); весь
UI-звук (динь/стук/рингбек/чайм) следует ВЫБРАННОМУ СПИКЕРУ —
`NotificationHub.setOutputDevice` → AudioContext.setSinkId (feature-detect
через структурный тип — в TS-lib метода нет; вызовы: Settings→Audio Apply +
openSession, рядом с roomAudio.setOutputDevice); дзинь перетембрен под oak
`buildMessagePcm`: парциали 1046.5+1570.9 Гц (C6+квинта), амплитуды 0.32/0.14,
атака 4 мс, общий экспо-декей τ=0.10 с (setTargetAtTime — точная кривая), 0.35
с. **Read-state:** badgeEnabled больше НЕ глушит счётчики (bumpLive ходит
всегда; рендер-гейт и так во всех бейджах — повторное включение сразу
показывает накопленное, oak гейтит только отрисовку); ack при СМЕНЕ открытого
чата — `ackActiveChannel()` ДО patch в setActiveChannel/openDm (страховка от
бампа в полёте, oak switch-away). Гейт 237/237.

**Смоук-фиксы раунда 7 (живой смоук юзера, 2026-09-15):** (1) тост-окно стало
ЧЁРНЫМ непрозрачным прямоугольником — при чистовой перезаписи ToastStackScreen
потерялся ЭФФЕКТ ПРОЗРАЧНОСТИ (documentElement/body → transparent; global.css
красит body в --sp-darkest ТОЛЬКО для главного окна); восстановлен + CSS-страховка
`body:has(.toast-stack) { background: transparent }`; в тост-окно добавлена
диагностика `[toast] show/card N clicked/hide-all clicked` в space.log. (2)
@everyone/@here: звук был, blurple-рамки нет — локальный effectiveMention в
handleMessage не включал everyone-ветку (её досчитывал только декайдер); теперь
ОДНА формула (user/role/DM/unsuppressed-everyone) кормит и решение, и рамку.
(3) клик по СЕРВЕРНОМУ тосту активного инстанса не открывал канал (onClick
undefined): теперь `setActiveChannel(message.channelId)` (гасит dmMode из Home).
(4) превью тостов больше НЕ срезает @ники (юзер-решение: видеть, КОГО пинговали;
отступление от oak previewText) — только схлопывание пробелов + 80 символов.
(5) СТУК входа/выхода голосовых комнат переехал под ОТДЕЛЬНЫЙ тоггл
`voiceSoundsEnabled` (дефолт true) в Settings → Audio → Sounds (юзер-решение:
связка с «Play mention sound» в Notifications непрозрачна; oak гейтит одним
soundEnabled). (6) @автодополнение композера расширено до oak-набора:
@everyone/@here + MENTIONABLE-роли (memberStore.roles, kind CUSTOM) + юзеры,
одним плоским списком (broad → role → user, кап 10; роли/пинги — глиф
mdi-account-multiple в слоте аватара). Гейт 236/237.

**Смоук-фиксы раунда 7, итерация 2 (2026-09-15):** (1) мышиный выбор в @-попапе
ВОЗВРАЩАЕТ ФОКУС композеру с кареткой ПОСЛЕ вставки (`composerInputRef` +
requestAnimationFrame — рендер должен лечь раньше setSelectionRange; live
report: после клика по варианту приходилось тыкать в поле). (2) Превью тоста
СЕГМЕНТИРОВАНО по mention-офсетам (`toastPreviewSegments` в
logic/toast-preview.ts): ВАЛИДНЫЕ пинги рендерятся `.toast-mention`
(soft-blurple + лёгкий фон, как в чате), прочие @-слова — обычным текстом;
бюджет 80 общий, «…» — отдельный plain-сегмент; сегменты едут в payload
необязательным полем (системные тосты — без), ToastStackScreen рендерит
сегментами при наличии. (3) Откат отдельного voiceSoundsEnabled-тоггла
(юзер-решение): стук снова под ЕДИНЫМ звуковым выключателем, подпись сделана
явной — «Play application sounds» + hint «динь упоминаний И стуки входа/выхода
голосовой комнаты; тосты остаются». Гейт 240/240.

**Итерация 3 (2026-09-15, live-репорты):** (а) segments не доезжали до
тост-окна — showToast строит ДРУГОЙ объект для IPC и поле не пробрасывалось
(все спаны серые); (б) подсветка сужена до ПИНГОВ ПОЛУЧАТЕЛЯ (юзер-решение:
светится только МОЙ ник): `toastPreviewSegments(content, mentions, self)` —
флаг спана = USER-by-id / ROLE-held / unsuppressed @everyone-@here; без
identity (ростер не загружен) не светится ничего; ГРАБЛЯ IPC: каждое новое
поле payload обязано пробрасываться в ручном объекте `toastBridge.show({...})`
в showToast — типизация ToastCardPayload не ловит пропуск. Гейт 242/242.

**Аудит-раунд 8 (аттачи + звонки, 2026-09-15) — oak-парити + юзер-требования:**
**ЗВОНКИ — главное открытие аудита: в oak звонок НЕ занимает чат-область**
(MainController: «A 1-on-1 call does NOT take the pane»); его поверхности =
sticky-карточка CallOverlay в углу ЭКРАНА (ringing) + ТА ЖЕ voiceBar + тот же
room view с 2 плитками (accepted). Перестроено так же: **CallPane.tsx УДАЛЁН**
(жил в контент-области со своим тулбаром); звонок рендерится ЧЕРЕЗ RoomView
(call-режим: плитки self-первым + peer, те же .tile/планки «Your camera/Your
screen»/«Sharing screen…», speaking-рамки через roomAudio.speakingSnapshot —
звонковые фиды именованы пиром, свой мик теперь attachOwnMic'ом в roomAudio;
шапка = ник пира + «2 in room · N screens»; ПКМ по плитке пира = VoiceMemberCard
ТОЛЬКО громкости, проп moderation); **VoiceBar получил call-режим**: у caller
на ringing-out — жёлтый «Calling…» + ТОЛЬКО красная трубка (юзер-решение:
исходящей стороне НИКАКОЙ экранной карточки — отступление от oak, где у caller
тоже карточка «Ringing…»+Cancel); connecting → «Connecting…» (честная фаза
accept→negotiated — у oak её нет, IN_CALL сразу); in-call → зелёный «On a
call» → «On a call — MM:SS» (тик 1 с, пауза при reconnecting, жёлтый
«Reconnecting…»); детали «peer/server»; КНОПКА Camera УДАЛЕНА (oak: камера —
источник внутри шар-пикера); клик по статус-строке = toggle room view,
авто-открытие на accept (roomViewOpen:true), гасится на teardownCall.
**ЗВОНОЧНАЯ КАРТОЧКА в тост-окне** (oak CallOverlay = отдельный always-on-top
Stage в углу экрана — у нас ТО ЖЕ тост-окно): расширенный payload-union
`ToastShowPayload` ({kind: message|call|call-status|call-end}); карточка =
аватар 48 (presigned URL из ростера — авторизации не нужно; фолбэк =
палитра-инициал), статус «Incoming call» → ник → сервер dim, кнопки Accept
зелёная/Decline красная (mdi-phone/phone-hangup), БЕЗ TTL — живёт до
accept/reject/timeout/HANGUP; после Accept НЕ исчезает — статус «Connecting…»
до OFFER (кнопки скрыты; oak оставляет мёртвые кнопки — мы прячем). Кнопки
маршрутизируются IPC `toast:callAction` → notifications.setCallActionHandler →
runtime accept/reject. **ПРИОРИТЕТ НАД ТОСТАМИ** (юзер-решение): пока call-card
жива, ToastStackScreen дропает стек message-карточек и гасит новые (лог
«suppressed»), чип Hide all скрыт. **Механика:** дубль-RING от того же пира в
ringing-in ИГНОРИРУЕТСЯ (раньше слал авто-REJECT и убивал звонок — oak
swallow); ring-timeout дефолт 120 c (oak; было 60) и ПЕРЕАРМИРУЕТСЯ на callee
после Accept (баундит accept→OFFER; отдельного 30-с gap-timeout больше нет);
playback.stop() на старте in-call («one audible stream»); chime перетембрен
дословно: 1046.5/1570.9/2616.3 Гц, амплитуды 0.25/0.12/0.06, общий
setTargetAtTime τ=0.55 c. Статусные тосты звонка («Declined your call.»/«The
call ended.»/«No answer.»/«Could not connect.») — НАШИ добавки, oak молчит
(юзер-решение оставить). **АТТАЧИ:** мозаика = ПОРТ AttachmentLayout.java
(квадраты: 1 = сторона min(usable, min(natW,natH)) c no-upscale и contain
внутри квадрата — 64×64 остаётся 64×64; 2–3 = ряд квадратных кроп-тайлов;
4–10 = грид 2 колонки; GAP 4, было 8; до декода плейсхолдер на весь usable);
**лайтбокс** — математика зума/пана вынесена в чистый `logic/
image-viewer-transform.ts` (порт 1:1 + тесты): зум К КУРСОРУ, пан С КЛАМПОМ
(влезающая ось пиннится центром), scale 1..10 (было 8), dbl-reset; тулбар =
Download/Forward/Open in browser/Copy (canvas→PNG→clipboard)/Details
(Name/Type/Dimensions/Size — размер докачивается по клику, DTO его не несёт);
Forward = форвард ВСЕГО сообщения (oak шлёт subset-одиночный аттач — наше
отступление, без wire-расширения); видео-карточка по пропорциям превью
(max-height 320, ширина auto — портретные не доминируют); файл-чип =
mdi-attachment (последний эмодзи-глиф выпилен); NowPlayingBar: mute-кнопка
0↔lastPositive + «--:--» до известной длительности (seek disabled), то же в
аудио-карточке; **edit-удаление картинок** (oak attachmentRemovalActive): в
редакторе у каждого image-тайла «×» (16×16, тайл гаснет 0.4), хинт-лестница
«enter to save · esc to cancel [+ click × to remove an image | N image(s)
will be removed]»; коммит — PATCH с remaining-ключами (EditMessageRequest.
attachments: отсутствует = не трогать, список = заменить — сервер валидирует
subset); гварды: blank-оголяющий и no-op = тихий cancel. B9 (рестор при
провале + «Uploading…») оказался уже реализован (композер хранит текст,
стейджинг чистится только по успеху). Гейт 252/252.

**Смоук-фиксы раунда 8 (живой смоук, 2026-09-15):** (1) аватар звоночной
карточки показывался БИТЫМ глифом — ростерный presigned avatarUrl мог протухнуть
(снапшот при коннекте, звонок позже), а blob:-objectURL кеша не живёт в чужом
рендер-контексте; теперь карточка красится СРАЗУ палитра-инициалом, затем аватар
докачивается через attachmentCache.loadImage (со fresh-link recovery) и
уезжает в тост-окно как **data: URL** (гвард: обновляем только пока этот ring
жив — поздний декод не воскрешает карточку и не понижает «Connecting…»);
ГРАБЛЯ: аватары живут в rosterStore.users (UserSummary.avatarKey/Url), НЕ в
ServerMember. (2) divider шапки room view/звонка УЕЗЖАЛ ниже divider'а
сайдбара: кнопка «назад» 30×30 раздувала min-height:37 шапку до 46px —
.room-view-header переведён на ФИКС height:37px + box-sizing:border-box (кнопка
центрируется и чуть вылезает за слот, не задевая divider; шапка остаётся
«близнецом» sidebar-server-header/chat-header). Гейт 252/252. Итерация 2:
аватар так и не доезжал — лог показал `avatar cache: hit` → `Failed to fetch`:
**ГРАБЛЯ CSP: index.html дев-CSP не содержал `blob:` в connect-src** (аттачи
везло — MinIO на localhost:* подпадал под http-правило; <img> с blob:/data:
шёл через img-src и потому работал) — fetch(objectURL) из кеша блокировался
браузером с голым «Failed to fetch»; фикс = `connect-src 'self' blob: …`;
фолбэк-инициалы переведены на oak-две-буквы; цепочка загрузки аватара
остаётся залогирована ([call] incoming-card avatar cache/dataUrl/failed).
Итерация 3 (юзер-запрос): у caller'а на ringing-out voiceBar теперь показывает
mute/deafen/NS (раньше только трубку) — микрофон УЖЕ захвачен при наборе,
поэтому `toggleCallMic` без сессии гейтит ТРЕК напрямую; PeerCallSession
наследует гейт (конструктор читает track.enabled — не предполагает true) и
ПЕРЕАНОНСИРУЕТ пред-accept-состояние пиру при создании (MIC_OFF/DEAFEN_ON
летят до OFFER, буферизуются у callee pendingCallSignals); кнопка share
появляется только с connecting — видео-слот договаривается в offer, до accept
шарить не с кем. Итерация 4 (юзер-решения): (а) share-кнопка на ringing-out
ВИДНА но disabled (title «Available once the call connects»); (б) accept НЕ
открывает call view — чат остаётся как при join комнаты, room view только по
явному клику на статус-строку voiceBar (убрано roomViewOpen:true из обоих
establish-путей); (в) ГРАБЛЯ FIXED-В-TRANSFORM: лайтбокс и видео-модал рендерятся
внутри строк VirtualList (tanstack virtual трансформит строки) — `position:
fixed` КЛИПАЕТСЯ к трансформ-предку, модал прилипал к строке чата вместо окна;
фикс = createPortal(…, document.body) для обоих. Известное ограничение (oak
парити): звонок 1-на-1 с НЕфокусного сервера НЕ дойдёт — фоновые сессии
глотают call.signal (подписка ведёт только активная). Итерация 5 (live-репорты):
(а) ОДИНОЧНАЯ картинка больше НЕ сидит в квадратном боксе с чёрным
letterbox'ом (oak держит квадратный bounding — поля читались как сломанный
рендер): бокс = вписанная в oak-квадрат картинка С ОБРЕЗАННЫМИ поляМИ
(`singleTileBox` = side/max(natW,natH), side прежний min(usable, min-сторона);
вертикальная 400×900 → 178×400; тесты). (б) видео-карточка: убран
min-width:200 у .video-thumb (у узких вертикальных превью справа оставалась
чёрная ПОЛОСА — картинка 180 в контейнере 200); бокс = ровно кадр превью,
фолбэк без превью — отдельный фикс-плейт 320×180. Итерация 6: тулбар лайтбокса
— каждый контрол на полупрозрачно-СЕРОЙ пилюле rgba(128,128,128,.45) (+ счётчик
тем же стилем): голая белая иконка исчезала на светлой картинке (live).
Итерация 7: (а) Details-карточка лайтбокса — ТОГЛ (повторный клик закрывает) и
якорится К КНОПКЕ (inline left/bottom над тулбаром), а не в углу вьюера;
(б) «×» удаления картинки в редакторе — onMouseDown preventDefault: редактор
коммитится по blur, а blur стреляет ДО click — редактор закрывался, пометка
не успевала ставиться (классическая фокус-грабля кликабельных детей
blur-коммитящих полей). Итерация 8 (scroll-jank): медиа-aware ОЦЕНКА высоты
строки — аттачи раньше оценивались плоско +22px, а реальная мозаика 200-500px:
входящая в окно строка с картинкой сменяла оценку фактом и сдвигала контент
под собой (оставшийся «прыжок при прокрутке»). Теперь: картинка-одна ~300,
2-3 ~210, 4+ ceil(n/2)*220, видео 340, аудио 56, чип 40 (порядок величины, не
пиксель — натуральный размер до декода неизвестен). ПРЕДЗАГРУЗКА: старт 100
(oak INITIAL_HISTORY_LIMIT), страницы вверх по 50 (HISTORY_PAGE) + до 3
alignment-страниц (граница не режет группу), jump-бэкфилл кап 1000.

**Задача #475/#472 (2026-09-15): rail-попап + RENAME-МОДЕЛЬ (ник everywhere) + фоновые
звонки.** (1) **Rail name bubble** (oak showNameBubble): кастомная пилюля справа от иконки
сервера, вертикально ПО ЦЕНТРУ иконки (не у курсора, не нативный title), #1e1f22/#4e5058
radius 8, 14px, паддинг 6/12; появление через 400 мс ховера, мгновенное исчезновение; только
у серверных иконок (Home/«+» без). (2) **RENAME-МОДЕЛЬ** (сервер см. oak-server/CLAUDE.md,
ДЕПЛОЙ ПАРНЫЙ): username = LOGIN (только Settings→Account «Change login» с пояснением про
principal; нигде больше не рендерится), nickname = НИК (unique в своём множестве,
юникод-без-пробелов) = единственное отображаемое имя И единственный механизм упоминаний.
Клиент: `displayNameOf(users, username)` (logic/display-name.ts) + хук `useDisplayName` —
РЕНДЕР ВСЕГДА ЧЕРЕЗ ЖИВОЙ РОСТЕР (пуш /topic/users несёт UserSummary с displayName →
переименование перекрашивает всё разом): автор в чате, reply-бар, цитаты/форварды (nameOf-
проп в QuoteCard/ForwardCard), ростер MembersPane (member.nickname), voice-строки сайдбара,
тайлы RoomView/звонка + шапка «Call», VoiceBar-детали, VoiceMemberCard, звоночная карточка
(peerName), тосты (handleMessage += authorName-параметр), друзья/DM (Relationship.displayName,
dmDisplayName по никам), UserBar/General. MessageResponse НЕ расширен — username остаётся
ключом. UI: Account → «Change login»; Appearance → «Change nickname» (self-PATCH + «Reset
to login», гейт CHANGE_NICKNAME); Server Settings → Members — рабочая Rename-форма (гейт
MANAGE_NICKNAMES+canActOn, self — CHANGE_NICKNAME; 409 → «Nickname is already taken.»).
@-автодополнение композера и Add Friend — ПО НИКАМ (вставка ника; триггер-regex юникод
`/(?:^|\s)@([\p{L}\p{N}_-]*)$/u`). Кросс-инстанс форвард шлёт originAuthorName = НИК. (3)
**Фоновые звонки**: фоновая STOMP-сессия больше не глотает call.signal — RING с неактивного
инстанса → ТА ЖЕ звоночная карточка в тост-окне с именем ФОНОВОГО сервера + чайм + аватар из
ростера фоновой сессии + локальный ring-таймаут (busy: активный звонок/другая карточка →
авто-REJECT с фоновой — oak); HANGUP/диспоуз фоновой → карточка умирает; **Accept** →
`pendingBackgroundAccept` → switchConnection (промоут живой сессии без teardown) →
`consumePendingOpen` поднимает ringing-in + acceptCallNow; **Decline** → REJECT с фоновой
сессии без переключения. ГРАБЛЯ: hooks-фабрика не имеет session — sendCallSignal фоновой
через `sessionMap.get(recordId)`; аватар-погоня карточки гвардится «живостью ринга»
(активный: ringing-in+peer; фон: backgroundRing-запись), не activeSession-сравнением.
Гейты: сервер 258/258, клиент 256/256 + typecheck + build. **Смоук-фиксы итерации 1 (2026-09-15):** (1)
rail-попап НЕ ПОЯВЛЯЛСЯ — ГРАБЛЯ OVERFLOW-КЛИПА: рейл крутит `overflow-y: auto`, а по CSS-спецификации
явный не-visible по одной оси вычисляет вторую в auto → absolute-пилюля за 72px-краем рейла ОБРЕЗАНА;
фикс = createPortal(document.body) + position:fixed с inline-координатами от rect иконки (снимаются
в момент срабатывания 400-мс таймера). (2) «Ник не изменился в списке друзей в Home» — relationships/DM-
снапшоты обновляются ТОЛЬКО по relationships-событию, которого rename не шлёт: `SocialStore.
applyUserRename(username, displayName)` вызывается из /topic/users-подписки (патчит relationship.
displayName, DM-participants и lastMessageAuthorName по старому имени участника; avatar-only пуш без
изменения имени — no-op без emit); серверный `DmChannelResponse.lastMessageAuthorName` перешёл с
getUsername() на displayName() (превью DM-строки ПАЛИЛО ЛОГИН), live-путь `updateDmLastMessage` получил
authorName-параметр (runtime резолвит через ростер обеих — активной и фоновой — веток). Смоук продолжается.

**Смоук-фиксы итерации 2 (2026-09-16, юзер-решения):** (1) presence-точки ростера — Discord-стиль:
точка у ВСЕХ аватаров (зелёная онлайн / СЕРая оффлайн; отсутствие точки читается как «статус неизвестен»);
первичный баг: fallback-ветка MembersPane (пока memberStore пуст) передавала showPresence БЕЗ online-флага
→ у онлайн рендерилась серая. (2) UserSettings-секции поделены по SCOPE (юзер): General (аватар+НИК —
NicknameForm переехала из Appearance) и Account — SERVER-related: шапка контент-панели дописывает
« — {имя сервера}» к названию раздела (SERVER_SCOPED_SECTIONS); Audio/Video/Appearance/Notifications/
Connections — CLIENT-related, без суффикса. Гейт 256/256.

**Шумодавы RNNoise + DeepFilterNet3 (задача #476, 2026-09-17).** Юзер-решения: движок
`off | rnnoise | deepfilternet3` (ДЕФОЛТ rnnoise, ВКЛЮЧЕН); WebRTC built-in NS ИСКЛЮЧЕН совсем
(асимметрия «только со следующего захода» отвергнута юзером); AEC/AGC ВСЕГДА on без тумблера
(эхо мучает других — как Discord); при живом движке констрейнт noiseSuppression=false (двойной NS
портит речь). Констрейнты захвата: `echoCancellation:true, noiseSuppression:false,
autoGainControl:true, sampleRate:48000` (sfu + captureCallMic). Пайплайн `media/
noise-suppression.ts`: raw → MediaStreamSource → AudioWorklet(движок) → MediaStreamDestination →
processed-трек (отдельный AudioContext 48k interactive; raw-трек остаётся у владельца). RNNoise =
`@jitsi/rnnoise-wasm` SYNC-склейка (wasm base64-инлайн, создана для ворклетов): глюк импортируется
`?raw` ДИНАМИЧЕСКИ (иначе ~1.9 МБ base64 едут в главном бандле — отдельный чанк грузится при старте
движка), склеивается с нашим процессором в Blob → addModule; кадры ровно 480 сэмплов, ×32768 →
`_rnnoise_process_frame` (VAD бесплатно) → ÷32768; bypass через port.postMessage (кадры идут
напрямую). ГРАБЛЯ-ДИЗАЙН (поймана тестом): 480 % 128 = 96 — без ПРАЙМИНГ-кадра тишины выходное
кольцо осушается на 32 сэмпла раз в цикл и вставляет нули В СЕРЕДИНУ потока (лёгкий треск);
прайминг делает задержку константной 480 — семантика в чистом `domain/logic/rnnoise-framing.ts`
(+тесты), ворклет несёт КОПИЮ (keep in sync). DeepFilterNet3 = пакет `deepfilternet3-noise-filter`
(lazy import; его wasm+ONNX-модель по дефолту тянулись с cdn.mezon.ai — НЕСАМОДОСТАТОЧНО для
self-hosted: оба файла СКАЧАНЫ и закоммичены в `src/renderer/public/df3/`, cdnUrl="df3" — локально,
fetch 'self' уже в CSP). Интеграция: `SfuSession.micEnhancer` (хук: start() пропускает трек ДО
addTrack — сырые кадры не утекут) + `wrapCallMic` для звонков (callMicStream RAW для teardown,
callPublishedMic PROCESSED в PeerCallSession/attachOwnMic; pre-accept mute-гейт бьёт по published);
`PeerCallSession.replaceMicTrack` (слот MLINE_VOICE, replaceTrack, мьют-состояние переносится).
На лету (watchNoiseSettings в bootstrap): bypass кнопкой = мгновенно; смена движка = rebuild
пайплайна от сохранённого raw-трека + replaceMicTrack + перепривязка attachOwnMic (БЕЗ перезахвата
и ренего); гварды «raw жив и голос/звонок жив» после async-бута. UI (юзер-решение, oak-семантика):
NS-кнопка голосовой панели/звонка — КЛИК открывает карточку NsEngineMenu (rnnoise/dfn3/off, чек у
активного), зелёная при любом движке, СЕРАЯ в off; bypass-механики НЕТ (юзер отверг «клик = мгновенный
bypass» — вернулись к oak); Settings→Audio — staged-селектор Engine + hint. Миграция настроек:
apmEnabled true→rnnoise / false→off (load()). CSP: script-src/worker-src += blob: (AudioWorklet-модули
из blob-URL — и наш, и DFN3-шные). Диагностика: diag-строка `ns` (engine/live/vad). Лог
`[ns] engine … live/down`. Гейт 260/260 + typecheck + build. **Смоук-фиксы итерации 1 (2026-09-17,
по space.log):** (1) `import(...)` УЖЕ возвращает промис — обёртка «loadGlue is not a function»
убрана, глюк грузится прямым await import; (2) ГРАБЛЯ CSP-WASM: компиляция WebAssembly ВНУТРИ
AudioWorklet-модуля подчинена script-src — CompileError «'unsafe-eval' is not an allowed source»;
фикс = узкий токен `'wasm-unsafe-eval'` (только wasm, не JS-eval; нужен и RNNoise-склейке, и
DFN3-компиляции); (3) ошибки старта звонка (captureCallMic/wrapCallMic) логируются [call] — тост
мимолётный, причина обязана оставаться на диске; (4) диагностика тишины при РЕ-ДЖОЙНЕ ПАРТНЁРА
(входящий тракт, НЕ шумодавы): добавлены логи «subscriber answer sent (N m-lines)» и «remote track
on slot … (muted=…)» — ловушка на следующий прогон. Итерация 2: (5) ГРАБЛЯ ЛОГИКИ: после выбора
off `activeNoisePipeline === null`, и watchNoiseSettings выходил по раннему return НАВСЕГДА (до
перезахода) — «вернул RNNoise, а шум не пропал» (лог: между off и следующим live пусто); фикс =
rebuild на ЛЮБУЮ смену движка пока голос/звонок жив (null-пайплайн не повод молчать). (6) rebuild
получил try/catch вокруг createNoisePipeline: упавший движок = publish RAW (sender никогда не
остаётся с мёртвым треком распущенного пайплайна) + [ns] error-лог. (7) ИЗВЕСТНАЯ ГРАБЛЯ ПАКЕТА
DFN3: его ворклет ГЛОТАЕТ ошибку инициализации (console.error в ворклет-консоль → тихий passthrough,
«live» в логе при нефункционирующем движке) — при разборе смотреть красную строку DevTools
«Failed to initialize DeepFilter in AudioWorklet». Итерация 3 (смоук пройден, 2026-09-17): (8)
ГРАБЛЯ PER-ORIGIN deviceId: Chromium выдаёт media-device id СВОИ для каждого origin — id микрофона,
сохранённый в dev-окне (http://localhost), НЕ СУЩЕСТВУЕТ в прод-окне (file://) → `deviceId:{exact}` →
мгновенный OverconstrainedError С ПУСТЫМ message (DOMException — в логах печатать `name`, message
часто пуст); фикс = fallback на System default при OverconstrainedError в ОБОИХ захватах (sfu +
captureCallMic) с warn-логом «saved microphone unavailable in this window»; заодно УБРАН констрейнт
sampleRate:48000 (нестандартный, риск Overconstrained; AudioContext пайплайна сам ресемплит вход).
(9) joinVoice-catch логирует [voice] room join failed (detail статуса перезаписывается leaving-состоянием).
(10) DevTools: флаг `--space-devtools` в argv + скрипты `start:tools`/`start2:tools` (npm-скрипты не
умеют env портативно на Windows). (11) Варнинг ворклета DFN3 «deprecated parameters for initSync()» —
БЕЗВРЕДЕН (wasm-bindgen стиль вызова), означает УСПЕШНУЮ инициализацию. Смоук-вердикт юзера: оба
движка работают, переключение off↔движки на живом голосе режет/возвращает шум клавиатуры; принципиальной
разницы движков на слух не выявлено — решат реальные шумы.

**DFN3-сага (продолжение #476, 2026-09-17, закрыто живым смоуком).** Пакет `deepfilternet3-noise-filter` оказался
НЕПРИГОДЕН как есть: его AudioWorklet-процессор ГЛОТАЕТ ошибки инициализации (catch → console.error → тихий
passthrough) — при живом «engine live» движок не обрабатывал НИЧЕГО. Заменили их процессор СВОИМ поверх их же
wasm-bindgen-глю: `scripts/extract-df3-glue.mjs` (npm run df3:glue) вырезает из пакета workletCode-литерал
(JSON.parse; маркер `const WorkletMessageTypes`), режет их процессор и кладёт IIFE-ПРЕФИКС глю в
`src/media/df3-glue.ts` СТРОКОЙ (export default JSON.stringify) — НЕ ?raw-файлом: (а) exports-пакета не даёт
глубоких импортов, (б) ГРАБЛЯ VITE-DEV: ?raw-импорт проектного файла ВНЕ renderer-root НЕ переписывается
анализатором — URL падает в SPA-fallback и приходит index.html → битый blob. Наш процессор (`space-dfn3`,
строка DFN3_PROCESSOR_SOURCE в noise-suppression.ts): кадрирование с прайминг-кадром (как RNNoise), ЖЁСТКОЕ
РУКОПОЖАТИЕ — ворклет обязан ответить ready(frame N)/error, ошибка → throw → fallback raw + [ns]-лог; никаких
тихих passthrough. ГРАБЛИ ПО ПУТИ (все живые): (1) ШАБЛОННАЯ СКОБКА: `${DFN3_PROCESSOR_SOURCE})();` — первая
`}` ЗАКРЫВАЕТ ИНТЕРПОЛЯЦИЮ, в модуль уезжает `)();` → «Unexpected token ')'»; правильно ДВОЙНАЯ `}})();`;
(2) **Content-Encoding: gzip на статике .gz** — dev-сервер (и любой gzip-осведомлённый) отдаёт .tar.gz с этим
заголовком → браузерный fetch ПРОЗРАЧНО РАСПАКОВЫВАЕТ → df_create получает сырой tar (8 601 600 вместо
7 983 136 байт) и паникует «unreachable» (wasm-trap Rust); фикс = модель лежит как `DeepFilterNet3_onnx.bin`
(тело то же gzip, df распакует сам); (3) их df_create в Node работал, в ворклете падал — средовой_dump через
лог размеров байтов в main («dfn3 boot assets: wasm=… model=…») вскрыл (2). **NS-самотест** в diag-панели
(`runNoiseEngineSelfTest`): детерминированный белый шум (LCG, ±0.25) → движок → peak-RMS-вердикт
SUPPRESSED/PASSTHROUGH/WEAK в [selftest]-лог — движок тестируется БЕЗ микрофона/комнаты/собеседника.
**Ползунок уровня DFN3** (юзер-решение: шкала движка ограничена 0–100 → слайдер, не число): настройка
`deepFilterSuppressionLevel` (дефолт 50), UI в Settings→Audio только при DFN3 (type=range + значение в
подписи, hint про шкалу: 0 = без предела/сильнейшее), применение НА ЛЕТУ через df_set_atten_lim в живой
ворклет (port-сообщение, appliedDeepFilterLevel против повторов) + уровень при создании пайплайна.
**Ловушка тишины при заходе — РАЗГАДАНА (2026-09-17, вечер).** Повтор с вооружённой диагностикой: трек
приходит muted=true при полностью здоровой подписке (join → answer sent → transport connected), и через 5 с
«STILL muted». Решающий прогон 18:18: ревход НЕ вылечил (STILL снова), а тишина кончилась `→ UNMUTED` на том
же фиде БЕЗ участия заходившего — **пир был замучен по мьюку**: замученный publisher НЕ ШЛЁТ RTP вообще
(track.enabled=false = нет пакетов), трек получателя висит muted. «Лечилось перезаходом» — совпадение с
размутом пира. Сопутствующий баг усиливал загадку: бейдж мьюта пира ПРОПАДАЛ у заходящего (см. ниже).
Правки: (а) sfu-сторожевая строка различает сценарии через колбэк `describeMuteState` (marks из
voiceControlStore): «still muted — expected: self-muted» (INFO) vs «STILL muted with NO mute mark — real
silent join» (WARN); (б) joinVoice чистит ТОЛЬКО свои метки (`clearUser(own)`, было `clearAll()` — чужие
метки валидны и раньше стирались); (в) oak-server: tracker при КАЖДОМ enter ре-паблишит состояния ВСЕХ
меченых участников канала (сеет заходчику, чинит пропустивших пуши; subsumes прежний репаблиш mod-метки
вошедшего). Гейты: сервер 264/264 (+1 тест reseed), клиент 267/267.

**Движки Speex + Gate; протокол space-asset:// (2026-09-17, юзер-смоук пройден).** Каталог движков стал
`off | rnnoise | deepfilternet3 | speex | gate` (NsEngineMenu + Settings→Audio + самотест-кнопки в diag на
КАЖДЫЙ движок; вердикт Gate на белом шуме — WEAK ПО ОПРЕДЕЛЕНИЮ: гейт глушит паузы). Speex = speexdsp
`preprocess` из `@sapphi-red/web-noise-suppressor` (wasm 56КБ, wasm+ворклет vendored в `public/ns/`,
`npm run ns:vendor`); Gate = оттуда же (пороги −45/−60 дБ, hold 250 мс). **Протокол `space-asset://`**
(main.ts): read-only file-хендлер на статику рендерера (dev: src/renderer/public, прод: out/renderer), path-
traversal-гварда; ДВИЖКОВЫЕ АССЕТЫ ГРУЗЯТСЯ ТОЛЬКО ЧЕРЕЗ НЕГО: прод-окно — file://-ДОКУМЕНТ и fetch()
СОБСТВЕННЫХ файлов запрещён CORS'ом (origin null) — относительный fetch работает лишь под vite-dev.
ГРАБЛИ CORS-СХЕМЫ: registerSchemesAsPrivileged БЕЗ corsEnabled + без заголовка ACAO в ответе даёт голое
«Failed to fetch» из file://-страницы (origin null = кросс-схемный запрос); CSP connect-src += space-asset:.
ГРАБЛЯ PER-CONTEXT addModule: список AudioWorklet-модулей у КАЖДОГО AudioContext СВОЙ — регистрация на
одноразовом «контексте-носителе» с кешем на окно оставляла пайплайн-контекст пуст («no valid
AudioWorkletGlobalScope»); addModule зовётся на контексте пайплайна, никаких кешей. **DTLN ОТКАЧЕН (первая попытка)**
(@workadventure/noise-suppression удалён): их ворклет-обёртка жёстко резолвит litert-wasm+tflite по
file://-fetch (в проде мёртв) и НЕ пробрасывает их пути; НИЖНИЙ API пакета (createNoiseSuppressionModule
{liteRtWasmRoot, model1Url, model2Url}) всё позволяет — следующий раунд: своя ворклет-обёртка поверх их
процессора по DFN3-паттерну + vendored litert/модели через space-asset. SettingsStore.load() санирует
устаревший движок из KV. **NS-попап**: карточка открывается ВВЕРХ, нижним краем вплотную
к кнопке (translateY(-100%), без фиксированной высоты — раньше улетала за низ окна), повторный клик по
NS-кнопке ЗАКРЫВАЕТ (toggle). Гейты 260/260.

**DTLN-движок, вторая попытка — получилась (#477, 2026-09-17).** Каталог стал `off | rnnoise |
deepfilternet3 | dtln | speex | gate` (пакет вернулся как devDependency — ИСТОЧНИК для `npm run
ns:vendor`, в рантайме НЕ импортируется). Ключ к успеху: их 5.8-МБ `assets/audio-worklet-processor.js` —
САМОДОСТАТОЧНЫЙ rolldown-IIFE (registerProcessor в хвосте) с ОБОИМИ tflite-моделями инлайном (base64)
и emscripten-фабриками litert в скоупе; честное рукопожатие ready/error по порту (НЕ как DFN3);
единственный внешний ассет — litert-wasm, передаётся ЧЕРЕЗ processorOptions.liteRtWasmBinary
(ArrayBuffer) — обёртку пакета (тот самый file://-резолвер) обходим целиком. Вендорится 2 файла →
`public/ns/dtln/`: процессор (модели внутри) + `litert_wasm_internal.wasm` (8.8 МБ, RELAXED-SIMD
вариант — Chromium в Electron поддерживает relaxed SIMD всегда, compat/jspi/threaded НЕ вендорим;
`processorOptions.liteRtVariant:"relaxed"` выбирает фабрику ModuleFactory$1 = relaxed, маппинг подтверждён
их же browser-runtime-options: compat→litert_wasm_compat, иначе→litert_wasm_internal). Интеграция в
`createDtlnPipeline`: контекст **16 кГц** (натив DTLN — кадры 512@16k=32 мс, ресемплера в их процессоре
НЕТ → Chromium сам ресемплит 48k-мик на MediaStreamSource, опубликованный трек = wideband 16k mono —
intrinsic to DTLN, Opus несёт нормально; 512=4×128 — прайминг НЕ нужен, их ring сам копит кванты и
тишинит стартовые); процессор-текст+wasm (14.6 МБ) КЕШИРУЮТСЯ модульно (переключение движков на живом
голосе не тянет их повторно; байпы только structured-clone, не transfer — кеш жив); blob→addModule на
контексте пайплайна (per-context грабля); рукопожатие ready/error с таймаутом 15 с (компиляция 8.8-МБ
wasm + 2 модели в ворклете); `bypassUntilReady:false` — до ready тишина, но пайплайн не публикуется до
handshake; dispose шлёт их `{type:"dispose"}` (dtln_stop). UI: пункт DTLN в NsEngineMenu (третьим, после
тяжеловесов), опция в Settings→Audio + подсказка «heaviest, wideband 16 kHz», кнопка самотеста в diag.
Гейты 260/260 + typecheck + build (бандл НЕ вырос — пакет не импортируется).

**Аудит-фиксы устойчивости к обрывам сети (#478, 2026-09-17, ДЕПЛОЙ ПАРНЫЙ с oak-server).**
Аудит всего сетевого слоя; итоговые фиксы: (1) **RESYNC ПОСЛЕ STOMP-РЕКОННЕКТА** (главная дыра:
пуши за время WS-дыры пропадали навсегда — сообщения не появлялись до рестарта): StompClient
`onConnected(reconnected)` (флаг `everConnected` — первый коннект НЕ реконнект, start() сам
делает снапшоты) → `ConnectionSession.resyncAfterReconnect()`: presence (с delta-буфером как в
start()) + voiceMembers + socialRefresh + memberRefresh + refetchChannels + read-states, ПОТОМ
хвосты сообщений — для каждого loaded-канала свежая последняя страница (`getMessages(…, 100)`)
вливается через НОВЫЙ `MessageStore.mergeTail` (батч-merge по id, ОДИН emit, возвращает только
НОВЫЕ строки — они проходят через `onLiveMessage` = бейджи/тосты/превью считают их как live);
ПОРЯДОК: read-states СТРАТЬЮТ per-channel состояние (applySnapshot заменяет) — их фетч обязан
закончиться ДО бампов хвостов, иначе сотрёт unread; хвосты ПОСЛЕДОВАТЕЛЬНЫ (не штампом).
Дыра >100 сообщений оставляет дырки в середине — это уже не «морг». (2) **Publisher-PC failed →
rejoin-лестница**: зеркало M4-фикса сабскрайбера — `PublisherTransportError` из sfu → runtime
`handleVoiceSessionLost("outgoing media transport failed")` (раньше только «Connection failed»
в баре навсегда). (3) **REST-устойчивость**: `request()` обёрнут в `fetchWithRetries` — таймаут
20 с (AbortController; НЕ для uploadBytes/downloadBytes — большие тела) + ретраи ТОЛЬКО для
идемпотентных вызовов (GET/PUT/DELETE + POST с `idempotencyKey`), бэкоф `[500, 1500]`
(`retryDelaysMs` инжектится тестами); 5xx НЕ ретраится (сервер сказал — повтор может
пере-триггерить сайд-эффекты); refresh-POST таймаутится, но НИКОГДА не ретраится (refresh-токен
одноразовый — повтор с тем же токеном REVOC'нет семью). (4) **Реанонс звонка** после
WS-реконнекта: `PeerCallSession.reannounceState()` — MIC/DEAFEN/CAM/SCREEN по текущему
состоянию (одношотные сигналы, потерянные за дыру, восстанавливают пиру марки). (5)
**IDEMPOTENCY-KEY сообщений** (антидубль при «запрос дошёл, ответ потерян»):
`ConnectionSession.sendMessage/sendMessageWithFiles` генерят `crypto.randomUUID()` на отправку
→ `CreateMessageRequest.idempotencyKey` (4-е поле) — сервер отдаёт ОРИГИНАЛ по ключу (см.
oak-server/CLAUDE.md); благодаря ключу POST /messages теперь БЕЗОПАСНО ретраится (лестница п.3).
Гейты: клиент 267/267 (+7 тестов: mergeTail-батч, стомп-флаг, ретраи GET/POST±key/5xx), сервер
263/263 (+5: replay-юниты + интеграция). Смоук-сценарий: выключить сеть на ~30 с — WS
переподнимется, пропущенные сообщения появятся, голос перезайдёт комнатой, звонок вернётся по
ICE-restart'у.

**Storage GC: раздел Server в Server Settings (#479, 2026-09-17, ДЕПЛОЙ ПАРНЫЙ с oak-server).**
Чистка хранилища «по нужде», не по возрасту: сервер ночью замеряет диск и при заполнении выше
порога сносит старейшие сообщения/сироты-аттачи до нижнего порога (детали механики —
oak-server/CLAUDE.md, включая событийную очистку аттача в момент смерти последней ссылки).
Клиент: НОВЫЙ раздел **Server** в Server Settings под НОВЫМ пермишшеном MANAGE_STORAGE
(гейт `canManageServerSettings` расширен — держатель только этого права тоже заходит):
бар занятости диска (used/total/%, зелёный → красный над порогом), ползунки порогов
high/low (%), поле времени ночной чистки «HH:mm» (валидация high > low), «Run cleanup now»
(202 + поллинг раз в 1 с пока running), отчёт последнего прогона (trigger/outcome/сметённые
сироты/байты/сообщения/итоговый %). REST: getStorageStatus/updateStorageSettings/
triggerStorageGc; типы StoragePolicy/StorageUsage/StorageGcRun/StorageStatus в types.ts.
Гейты 267/267 + typecheck + build; сервер 272/272. **Итерация 2 (юзер-решения):** «Run cleanup
now» без подзаголовка, кнопкой-соседом Save changes; запуск через confirm-модал («сервер может
подвиснуть на несколько секунд — чат замрёт»); тоггл «Automatic cleanup» (gcEnabled в политике)
— выключен = серверный шедулер не чистит вовсе, поле времени дизейблится (ручной запуск и
событийная очистка не зависят от тоггла). Сервер 273/273.

**Настраиваемые горячие клавиши + глобальный mute без фокуса (#480, 2026-09-18).**
Юзер-решения: каталог Discord-совместимый, скоуп «глобальные + локальные»; фидбек
глобального toggle-mute — ЗВУК-свип (возрастающий = unmute, убывающий = mute, НЕ стук
входа/выхода — должен отличаться), тост не нужен; PTT — бэклог отдельным раундом
(Electron globalShortcut НЕ даёт keyup; нужен нативный хук вроде uiohook-napi — первый
нативный модуль, отдельное решение). **Каталог** (`domain/logic/keybinds.ts`, чистый):
global — Toggle Mute `Ctrl+Shift+M`, Toggle Deafen `Ctrl+Shift+D`, Toggle NS
`Ctrl+Shift+N`; local — Next/Prev Channel `Alt+↓/↑`. Unbound по умолчанию: decline-call
(глобальный Esc украл бы Escape у всей ОС), accept-call (**ОТКАЗ от дискордова Ctrl+Enter:
OS-wide хорд съедает клавишу везде, а Ctrl+Enter — перенос строки композера / send при
ctrlEnterSends — глобальная регистрация сломала бы контракт ввода**), mark-channel-read
(Esc занят модалками). **Механика глобальных:** renderer владеет картой — `installHotkeys()`
(bootstrap, сразу после watchNoiseSettings) пушит полный global-сет invoke
`space-hotkey:sync` → main `globalShortcut.unregisterAll()+register` каждый → статус
per-action `{ok|taken}` (`isRegistered()===false` после register — Windows молча фейлит
при занятом чужим процессом хорде: второй dev-инстанс/чужое приложение → амбер-бейдж
«In use by another application» в UI); пресс = `webContents.send("space-hotkey:press", id)`
ТОЛЬКО в главное окно → `dispatchHotkeyAction` в runtime-синглтоне; `will-quit →
unregisterAll()`. Синк только при ИЗМЕНЕНИИ canonical payload (JSON-сравнение — чужие
apply настроек не перерегистрируют ОС-хорды). **Два пути НИКОГДА не смешиваются:**
глобальный хорд ВСЕГДА приходит через OS-hook (и в фокусе тоже — RegisterHotKey не
пропускает клавишу в приложение), поэтому локальный keydown-матчер матчит только
scope=local (иначе двойной тоггл). **Локальный keydown** (window-листенер в runtime):
skip defaultPrevented/repeat; bare-клавиша в INPUT/TEXTAREA/contenteditable = обычная
печать (Alt+↓/↑ в композере работают); preventDefault только на хордах с модификатором.
**Диспетчер:** `voiceSurfaceFor` (call бьёт room; ringing-in поверх комнаты = room —
мик звонка ещё не захвачен, комнатный жив; none = тишина) → toggleCall*/toggleSelf*;
NS-тоггл = off↔последний движок через `settingsStore.apply` (живой пайплайн перестраивает
watchNoiseSettings); accept/decline-call = `callCardAction` (ВЫРЕЗАНО из замыкания
тост-карточки — кнопки и хоткей делят семантику, включая фоновый ринг с промоутом
инстанса); mark-read = ackActiveChannel; шаг каналов = adjacentChannelId по TEXT-каналам
(no-op в dmMode). **Mute-кью** (`logic/mute-cue.ts` + NotificationHub.playMuteCue): один
осциллятор с portamento 500↔900 Гц / 120 мс (unmute вверх, mute вниз), гейт soundEnabled,
направление = НОВОЕ состояние (room: !selfMuted, call: !callMicOn); кнопочный путь без
звука (в фокусе видно UI). **Акцелератор-алгебра:** канон-формат Electron
(«Control+Shift+M»), `acceleratorFromKeyboardEvent` (event.code→токен: KeyM→M,
ArrowDown→Down, Digit/Numpad, F1-24, пунктуация; немапимые коды = null),
`normalizeAccelerator` (синонимы Ctrl/Cmd/CmdOrCtrl→Control, Esc→Escape, реордер
модификаторов, мусор→null), `resolveKeybinds` (дефолты⊕stored, «»=unbound, unknown id
дроп — forward-compat), конфликт-детект ЛЮБОГО скоупа (local+global дубль = двойной
выстрел). Хранение: `ClientSettings.keybinds` (тот же KV client-settings), секция
**Keybinds** в UserSettingsModal (staged, между Video и Appearance; рекордер: click →
«Press keys…», Escape = отмена записи (capture+stopImmediatePropagation — модал жив),
Backspace = unbind, чистые модификаторы игнор; per-row ⟲ + «Reset all keybinds»;
бейджи конфликт/OS-taken/глобальная-bare-клавиша-ворнинга). **Диагностика переехала
Ctrl+Shift+D → Ctrl+Shift+F12** (дефолт deafen забрал дискордовскую хорду — иначе каждый
focused-пресс глушил И открывал панель). Тесты: keybinds.test.ts (19) + mute-cue.test.ts
(5, инвариант попарного непересечения трёх частотных регистров: стук 150-210 / деafen
280-480 / мут 500-900). Гейт 289/289 + typecheck + build. **Смоук-вердикт: всё работает.**
**Полиш-итерация (юзер-решения по смоуку):** (1) **deafen-кью** — тот же свип регистром
НИЖЕ (`deafenCue`: 280↔480 Гц против мьютовых 500↔900; три звуковых семейства попарно не
пересекаются — тест), `playDeafenCue` рядом с playMuteCue (общий приватный `playSweep`),
диспетчер играет на toggle-deafen с направлением НОВОЕ состояние; (2) секция Keybinds
УШЛА из STAGED (window-level Apply убран) — **per-row подтверждение**: записанный хорд
висит pending в пилюле, ПОВЕРХ её правого края две квадратные кнопки (зелёная mdi-check
= сохранить через `settingsStore.apply` — OS-перерегистрация едет по settings-подписке;
красная mdi-close = откат; pending один на всю секцию, старт другой записи/клик по чужой
пилюле дропает его; Backspace в рекордере стейджит unbind, reset-кнопка тоже через pending);
конфликт-бейдж считается по ПОКАЗАННОМУ значению (pending виден до подтверждения);
(3) reset-кнопка (mdi-refresh) рендерится ВСЕГДА (выравнивание колонок — live-репорт),
disabled на значении-равном-дефолту. Гейт 291/291 + typecheck + build. Смоук pending
(полиш: deafen-звук, ✓/✕-флоу, выравнивание). **Полиш-итерация 2 (live-репорты):**
(а) **рекордер был ГЛУХ к занятым хордам** — зарегистрированный OS-хорд НЕ доходит до
окна вовсе (RegisterHotKey съедает клавишу до keydown), запись конфликтующего хорда
выглядела как «ничего не происходит»; лекарь: на время живой записи
`suspendGlobalHotkeys()` (sync([]) + lastSynced="[]") / по концу записи
`resumeGlobalHotkeys()` (сброс lastSynced + форс-синк — JSON-детектор одинаковый payload
пропустил бы и оставил ОС-хорды мёртвыми); (б) **конфликт-ПОПАП** при записи занятого
хорда (дубль любого скоупа = двойной выстрел): хорд ОТКАЗЫВАЕТСЯ (не pending), над
пилюлей всплывает amber-попап «{хорд} is already bound to {действие}» (до следующего
действия); бейдж «Also used by» остался для pending-состояний через reset; (в) taken-
бейдж («In use by another application») ПЕРЕЕХАЛ из пилюли-обёртки в label-блок; ГРАБЛЯ
ВЫРАВНИВАНИЯ (два захода): фикс-ширина пилюли 170px с ellipsis выровняла только ШИРИНУ,
но не ПОЗИЦИЮ — `justify-content: space-between` при label шириной по контенту оставлял
пилюлю ПЛАВАТЬ в середине строки (длиннее подпись — левее); лекарь = `flex: 1` на
`.keybind-label` — label забирает всё свободное место, пилюля+reset жёстко прибиты
вправо. Гейт 291/291 + typecheck + build. Смоук pending. **Полиш-итерация 3 (юзер-решения):**
(1) sweep-кью ПЕРЕЕХАЛИ в сами toggle-функции (`toggleSelfMute/toggleSelfDeafen/
toggleCallMic/toggleCallDeafen` — включая pre-accept track-ветку звонка) — звук теперь
одинаков у кнопок voice panel И хоткеев (диспетчер звук не дублирует); (2) браузерный
focus-ring у кнопок voice-bar после МЫШИННОГО клика висел и после хоткей-тоггла —
`.voice-toggle:focus:not(:focus-visible) { outline: none }` (клавиатурный фокус ринг
сохраняет); (3) reset-кнопка Keybinds = серая пилюля 26×26 (--sp-control, mdi-refresh;
был голый глиф — читался как надпись), клик открывает CONFIRM-МОДАЛ («Reset the binding
for {label} to {дефолт}?», Cancel/Reset) — сброс не срабатывает сразу. Гейт 291/291 +
typecheck + build. Смоук pending. **Полиш-итерация 4 (юзер-решения):** (1) focus-ring
голосовых кнопок убран БЕЗУСЛОВНО (`.voice-toggle:focus/:focus-visible { outline: none }`,
обе поверхности — voice-bar и room-toolbar; `:not(:focus-visible)` не хватало — эвристика
Chromium помечает фокус «клавиатурным» после недавней печати в чате, и мышиный клик всё
равно рисовал ринг); (2) confirm-модал переехал с ПЕР-РОУ reset (юзер: там уже есть
✓/✕-подтверждение) на «Reset all keybinds» — та стала ВИДИМОЙ серой кнопкой
(.keybind-reset-all, тот же --sp-control), модал «Reset every binding — global and
in-app — back to its default?». Гейт 291/291 + typecheck + build. Смоук pending.
**Полиш-итерация 5 (live-репорт):** (1) «Reset all keybinds» выровнена ВПРАВО (все
reset-контролы секции справа — юзер-решение); (2) БАГ ДВОЙНОЙ ЗАПИСИ: recording-state
жил локально в каждой пилюле — клик по второй НЕ гасил первую, оба capture-keydown-
листенера висели одновременно и первый (ранее зарегистрированный) съедал каждый хорд,
ввод шёл «по очереди в поля»; лекарь = state перенесён в секцию (`recordingId`,
единственный keydown-sink), рекордер стал чисто презентационным; ПЛЮС window-pointerdown
(capture): клик вне `.keybind-recorder` отменяет запись («Press keys…» гаснет); suspend
OS-хордов теперь на всю сессию записи ([recording]-булево — прыжок пилюля→пилюля не
дёргает suspend/resume). Гейт 291/291 + typecheck + build. Смоук pending.

**Поиск по сообщениям + окно ?around= (#481, 2026-09-18, ДЕПЛОЙ ПАРНЫЙ с oak-server).**
Юзер-решения: матчинг ПОДСТРОКОЙ как Discord (ILIKE + pg_trgm-GIN на сервере; tsvector
отвергнут — не ищет подстроки и не живёт в H2-тестах); скоуп = текущий канал + переключатель
«Everywhere» (весь сервер; DM в серверо-широкий НЕ входят, в открытом DM скоуп только этот
DM); фильтры v1 = текст + from:(автор); прыжок к результату = ОКНО ?around= сразу (закрывает
старую роадмап-задачу «прыжок по истории»; бэкфилл-кап 1000 остаётся для цитат). **Сервер**
(детали — oak-server/CLAUDE.md): `GET /api/search/messages?q=&channelId=&author=&beforeId=&limit=`
(`SearchMessagesResponse{total, results}` — total без курсора; newest-first; limit 25/50);
история += параметры `aroundId` (окно limit центр. на сообщении; 404 если чужой/удалённый)
и `afterId` (страница младше ASC); ReadStateService.ack стал МОНОТОННЫМ; индексы pg_trgm —
РУЧНОЙ МИГРАЦИЕЙ (docker exec psql). **Клиент:** REST `getMessages(..., {aroundId?, afterId?})`
+ `searchMessages` (тип SearchMessagesResult в types.ts); **MessageStore around-режим**
(`aroundWithoutTail`-сет): `applySnapshotAround` (ЗАМЕНЯЕТ список канала), `appendPage`
(зеркало prependPage, сорт-склейка), `markTailReached`; ГЕЙТЫ: `applyLive` при around дропает
id>last (дыра между окном и хвостом — вставка соврала бы о смежности; своё отправленное из
окна не появляется, Discord-фейсфул), `mergeTail` → [] (recon-heal не вшивает дыру; счётчики
восстанавливает read-states-снапшот), applySnapshot/dropChannel гасят; «дыра» = forbid не
автодогрузка. Сессия: `loadAround/loadNewer/raw<NEWER_PAGE → markTailReached+ack`/
`reloadTail` («Jump to present»); константы AROUND_LIMIT=NEWER_PAGE=50. **runtime**:
AppState += searchOpen/searchScope/activeAround (сброс в teardown); `toggleSearch`,
`setSearchScope`, `setActiveChannel(channelId, aroundMessageId?)` (around-путь: ОДИН патч с
activeAround, БЕЗ loadHistory+ack — ack середины обнулил бы unread; 404-фолбэк = loadHistory
+ тост «Message not found»; обычный путь при around-канале = reloadTail вместо no-op
loadHistory), `openChannelAtMessage` (канал открыт → re-arm патчем; чужой канал →
setActiveChannel(around); DM → openDm + патч); **ackActiveChannel guard** по
isAroundWithoutTail (локальный ReadStateStore.ack НЕ монотонен — обнулил бы бейдж; закрывает
ВСЕ пути: focus-regain/mark-read/switch-away/after-load). **ChatPane**: кнопка-лупа
mdi-magnify в chat-header справа (margin-left:auto; в dmMode тоже), эффект смены канала
skip'ает loadHistory при activeAround для этого канала; **MessageList**: around-эффект
(потребляет activeAround при прибытии окна: scrollToKey center ×4 + highlight + firstLayout
claimed; без cleanup — consumption-патч перезапустил бы эффект и убил бы флеш), belowEndRef/
loadingNewerRef/jumpToPresent-state; onBottomProximity при belowEnd → loadNewer (цепочка
автозагрузок при pinned); рост-эффект при belowEnd НЕ двигает NEW-divider и НЕ аккает;
«Jump To Present»-пилюля (absolute над композером, blurple) → reloadTail + scrollToBottom.
**SearchPane** (правая колонка 340px, СВАП ростера в MainScreen при searchOpen; скрыта в
Friends/room view): query-инпут (debounce 300мс, минимум 2 символа при только-q; Enter =
немедленно; Escape = закрыть), скоуп-селектор [#/имя | Everywhere] (dmMode → только «This
DM»), from:-инпут с попапом автодополнения ПО НИКАМ (ростер, ↑/↓/Enter/Tab/Esc, на wire
уходит username), «N results»/«No results», группы по дням (Today/Yesterday/Mon d[, yyyy]),
карточки: #канал (только в Everywhere) + аватар + ник из живого ростера + время
formatHeaderStamp + превью flattenForSearch(120) с <mark>-подсветкой highlightSegments
(indexOf-цикл, БЕЗ regex — LIKE-метасимволы бесплатны; кириллица кейс-insensitive) + имена
аттачей; Load more (beforeId = последний id); клик = openChannelAtMessage, панель НЕ
закрывается; seq-guard от stale-ответов. **Хоткей** `toggle-search` (local, дефолт Ctrl+F —
дискордов хорд; модификаторный → preventDefault гасит browser-find, из композера работает).
Чистая логика `domain/logic/search-results.ts` (highlightSegments/flattenForSearch/
groupSearchResultsByDay/formatSearchDayStamp) + тесты; MessageStore around-контракт,
rest-search пути, keybinds-каталог. Гейты: сервер 284/284 (+8), клиент 307/307 + typecheck
+ build (icons.css перегенерен — mdi-magnify). **Смоук pending; ДЕПЛОЙ ПАРНЫЙ: индексы
psql → сервер → клиент.**
**UI-полиш (юзер-решения 2026-09-18, живой смоук поиска пройден):** (1) кнопка-лупа
УДАЛЕНА из chat-header — раздувала min-height:37 шапку до 46px и divider уезжал ниже
сайдбарного (та же room-view-грабля); (2) правая колонка стала ПОСТОЯННЫМ элементом
`RightPane` (в SearchPane.tsx): шапка height:37 + border-bottom (divider ПРОДОЛЖАЕТ линию
шапки чата) с полем поиска + лупой-кнопкой ВНУТРИ поля справа; body свапает ростер ↔
результаты; (3) ростер 190→222px (ширина на обёртке .right-pane; .members-pane потерял
width, стал flex-телом); (4) фильтры панели (скоуп + from:) — СТОЛБИКОМ (колонка узкая);
(5) query живёт в RightPane и ПЕРЕЖИВАЕТ закрытие панели; ввод ≥2 символов сам открывает
панель; лупа = toggle, Escape в поле = закрыть; Ctrl+F фокусирует поле; (6) в dmMode колонка
появляется ТОЛЬКО при открытом поиске (DM-чат сохраняет полную ширину; поиск по DM живёт
через Ctrl+F). Гейт 307/307 + typecheck + build. **Полиш-итерация 2 (юзер-решения):** (1)
from:-поле ВО ВСЮ ШИРИНУ — внешний label убран, подпись стала placeholder'ем «from:»
(попап автодополнения от left:0); (2) стрелка скоуп-селекта — appearance:none + СВОЙ глиф
mdi-chevron-down абсолютом right:7 (нативная стрелка Chromium прижата к краю ЛЮБОЙ
padding-right — не сдвигается; своя встала на вертикаль лупы поиска; icons.css реген,
44 глифа); (3) Escape в поле поиска теперь и ЗАКРЫВАЕТ панель, и ОЧИЩАЕТ строку (раньше
текст переживал закрытие). Гейт 307/307 + typecheck + build. Смоук pending.
**Полиш-итерация 3 (юзер-решения):** (1) ЛУПА больше НЕ закрывает панель (повторный клик
по ней не должен возвращать ростер) — только открывает/ищет; рядом СЛЕВА от лупы, когда
поле НЕПУСТОЕ, появляется кнопка-крестик (mdi-close, .search-clear) = аналог Esc: чистит
поле + возвращает ростер; (2) автокомплит from: показывает ВЕСЬ ростер СРАЗУ ПО ФОКУСУ
мышки (пустой префикс матчит всех — как @-попап композера; кап 10). Гейт 307/307 +
typecheck + build. Смоук pending.

**Push-to-talk — СКИПНУТО (юзер-решение 2026-09-18; контекст на случай возвращения).**
PTT = «удержание = микрофон открыт, отпустил — закрыт» требует ГЛОБАЛЬНЫХ keydown+keyup.
Electron `globalShortcut` даёт ТОЛЬКО нажатие (RegisterHotKey-семантика, события отпускания
нет) → единственный путь — низкоуровневый хук ОС (uiohook-napi / libuiohook;
WH_KEYBOARD_LL на Windows). Решено НЕ делать; соображения, чтобы не переоткрывать вслепую:
(1) **приватность-паттерн** — такой хук технически видит каждый символ в ЛЮБОМ приложении
(вкл. пароли в браузере); наш use-case честный (2 клавиши PTT), но AV-эвристики помечают
это как «потенциальный кейлоггер», а вдумчивый юзер — «клиент читает всю клавиатуру»;
для self-hosted проекта репутационная цена; (2) **стабильность наоборот** — хук зовётся
СИНХРОННО в цепочке ввода ОС: тупящий колбэк (CPU-пик в игре) → Windows после
LowLevelHooksTimeout МОЛЧА отцепляет хук (классика libuiohook: «PTT работал полчаса и
перестал», отладка противная); (3) **эксплуатация** — первый НАТИВНЫЙ модуль в проекте:
ABI Electron, prebuilds, asar-unpack при упаковке, пересборка на каждом мажорном
обновлении Electron (сейчас ноль нативных модулей — npm install и всё работает, это
стоит сохранить). ЧТО РИСКОМ НЕ ЯВЛЯЕТСЯ: юзер-спейс, без драйвера и админ-прав; так
работают Discord/PowerToys/AHK — практика массовая и легальная. ГЛАВНОЕ: кейс «мутиться
в игре» УЖЕ закрыт без хука — globalShortcut это системный сервис (ОС сама сообщает
комбинацию, содержимого не видит, из строя не выбивается), toggle-mute работает; PTT
отличается ТОЛЬКО UX-ом «удержание вместо переключения». Условие возврата: понадобится
именно удержание; при возвращении — библиотека uiohook-napi (общепринятая), учесть
мышиные кнопки (популярный PTT-бинд), интеграцию с self/mod-мьютами (модераторский мьют
PTT переживает) и индикацию «сейчас говоришь».

**Спайк вычитания собственного звука из loopback (#483, 2026-09-18, смоук pending).**
Цель: при шаре экрана зритель слышит десктоп БЕЗ нашего голосового канала (у Discord
такого нет — открытый feature-request). Модель = эхоподавление на ЦИФРОВОМ пути:
loopback[n] ≈ h∗reference[n−D] (D = буферы render→mix→capture, h ≈ громкость) —
булк-дилэй из периодической FFT-кросскорреляции + короткий NLMS-FIR вокруг него,
рекорреляция ~0.5 с за дрейфом. **АрХИТЕКТУРНЫЙ ФАКТ (поправка к ранним прикидкам):
плayout НЕ идёт через WebAudio-граф** — remote-треки играют голыми `<audio>`-элементами
(урок M0), граф только анализ; референс будущей продакшн-ветки = РЕКОНСТРУКЦИЯ с тех же
MediaStreamTrack'ов (createMediaStreamSource работает для анализа) с зеркалированием
element.volume/deafen. Спайк-поверхность: (1) чистый DSP `domain/logic/subtract-dsp.ts`
(fftInPlace/ifftInPlace radix-2, crossCorrelationPeak ±maxLag с нормировкой качества,
ReferenceCanceller — ring+NLMS с гейтом тишины референса; + тесты: FFT=naive DFT,
лаг 700±2/quality>0.9, конвергенция >30 дБ, passthrough при короткой истории);
(2) `media/share-subtraction.ts` — ворклет-строка С РУЧНОЙ СИНХРОНИЗИРОВАННОЙ КОПИЕЙ
DSP (rnnoise-framing-прецедент, keep in sync; БЕЗ `${}` в литерале — грабля DFN3),
процессор: 2 канала SubtractorChannel (TAPS=1024 ≈ ±10.7 мс, MAX_LAG=16000, корреляция
каждые 24000 сэмплов, ре-центровка: |Δ|≤64 — NLMS сам, ≤HALF−128 — сдвиг окна с
сохранением табов, больше — холодный рестарт), readStats-оконная механика по port
(каждое чтение СБРАСЫВАЕТ окно); createShareSubtraction(loopbackTrack, reference: track
| AudioNode, context?) — per-context addModule (грабля #476), sink-track для будущей
публикации; (3) самотест `runShareSubtractionSelfTest` (diag-кнопка «Share-subtract
self-test»): арм grant'а `spaceCapture.select(screen, true)` → getDisplayMedia →
loopback; детерминированный LCG-шум играет через `<audio>`-ЭЛЕМЕНТ (честный путь
плayout'а!) и тем же тапом узла идёт в референс ворклета; фазы L-only / R-only / stereo
(ловят своп каналов), каждая: 1 с конвергенция → сброс окна → 1.2 с измерение → дБ;
вердикт по худшей фазе: ≥20 SUPPRESSED / ≥8 PARTIAL (подозревай ОС-улучшения звука) /
FAILED; логирует delay/quality per channel. Гейты 313/313 + typecheck + build.
Смоук: тишину на десктопе, Ctrl+Shift+F12 → кнопка, смотреть [selftest]-хвост.
**ГРАБЛЯ MessagePort (живая, первый прогон): «stats timeout (worklet silent)» при живом
ворклете — `port.addEventListener("message", …)` НЕ СТАРТУЕТ порт (доставки нет до
`port.start()`); идиома `port.onmessage = …` NS-движков стартует неявно, потому там
работало. Фикс = `node.port.start()` после конструирования AudioWorkletNode.**
**Итерация 2 (живой прогон A/B): корреляция ЗАВЕЛАСЬ (delay стабилен L=R: 10110/10110
при улучшениях и 8766/8770 на «Выкл» — улучшения добавляют тракту ~28 мс!), но NLMS
РАСХОДИЛСЯ (−38.5 дБ, потом NaN). Корень: гейт активности и нормализатор шага делили
лагирующий EMA-энергии — на жёстком онсете (тишина→шум) мгновенная энергия прыгает на
6 порядков, EMA ползёт ~21 мс: гейт уже открыт, знаменатель ещё крошечный → взрыв табов
первые ~мс фазы. Фикс = честный NLMS на ИСТИННОЙ энергии окна табов (Σx² по окну, EMA
осталась только гейтом) в ОБЕИХ копиях (чистая + ворклет); регрессионный тест
«survives a hard onset after silence» ловит ровно это. Побочно: quality 0.10–0.17 —
норма для разведрения тишиной в корреляционном буфере (нормировка по полной энергии
буферов), пиков не ломает. Гейты 314/314 + typecheck + build.**
**Итерация 3 (второй живой прогон A/B): расходимость вылечена (стабильно, без NaN), но
плато ~3 дБ в ОБОИХ режимах улучшений → узкое место НЕ ОС-улучшения, а слабая
корреляция loopback↔reference на фиксированном лаге (quality 0.09–0.17 при полных
буферах) = подозрение на дрейф выравнивания между доменами часов рендер-конtext'а и
доставки loopback-трека (~500–2000 ppm по оценке из quality). Телеметрия: lagHistory
(каждый рекорреляционный замер ~0.5 с, в stats+лог — сканирующий лаг = дрейф,
прыгающий = drop/dup кадров); ignore-band ре-центровки РЕЗАН 64→8 сэмпла (непрерывное
сопровождение — раньше при дрейфе ~24 сэмпла/с коррекция срабатывала раз в ~3 с и
фильтр размазывался); добавлена фаза «tone-440» (дрейф-толерантная проба: тон
коррелирует через дрейф; если тон давится сильно лучше шума — broadband-лимит = дрейф;
в вердикт НЕ входит). Тест ~14 с. Гейты 314/314 + typecheck + build.**
**Итерация 4 (третий живой прогон): ГИПОТЕЗА ДРЕЙФА ОПРОКИНУТА — лаги стоят ровно
(10494×4, 8766×5), выравнивание стабильно; тон-проба ОКАЗАЛАСЬ КРИВОЙ (чистый 440 Гц
периодичен, корреляция имеет пики каждый 109 сэмплов → залипла на лагах 6/50 — нужен
был чирп). Остались: стабильный дилэй + quality ~0.1 + ~3 дБ = почерк ВРЕМЕННÓЙ
спектральной обработки трека. ГЛАВНЫЙ ПОДОЗРЕВАЕМЫЙ: ВСЕ 4 места захвата loopback
(оба самотеста + продакшн-шар комнаты + шар звонка) просили audio:{channelCount}
БЕЗ echoCancellation/noiseSuppression/autoGainControl:false → Chromium может гнать
loopback через свой APM (NS-гейтинг и рушит широкополосную корреляцию; M0-стерео-спайк
прошёл ТОНАМИ — тон через NS живёт, шум — нет). Фикс-кандидат: LOOPBACK_AUDIO_
CONSTRAINTS (raw) на всех 4 местах + referenceSquareSum в статистику ворклета (гейн
тракта в фазовом логе — отличает «обработка портит сигнал» от «в loopback мешается
чужая энергия»). Гейты 314/314 + typecheck + build. Перепроверка pending.**
**ВЕРДИКТ СПАЙКА (четвёртый прогон, 2026-09-18): GO — ГИПОТЕЗА APM ПОДТВЕРДИЛАСЬ.**
Raw-констрейнты сняли потолок целиком: L-only 34.1 дБ / R-only 33.8 дБ / stereo 47.8 дБ
(было ~3), gain тракта 0.1–0.2 дБ (loopback несёт наш сигнал в эталонном уровне —
посторонней энергии нет), quality 0.11→0.33, лаги 10064 стоят. Verdict: SUPPRESSED —
продакшн-раунд жизнеспособен. **Сопутствующая находка: боевой шар-звук (комната+звонок)
ДО этого гнался через Chromium APM (NS/AGC по loopback!) — LOOPBACK_AUDIO_CONSTRAINTS
на всех 4 местах захвата заодно вылечил качество реального шар-звука** (M0-стерео-спайк
этого не ловил: тон через NS проходит, широкополосный шум — нет). Тон-фаза УДАЛЕНА из
самотеста (периодичная корреляция неоднозначна — проба принципиально кривая, шумовые
фазы доказывают всё; чирп был бы дрейф-пробой при возврате нужды). Самотест снова ~9 с.
Гейты 314/314 + typecheck + build.

**Продакшн-раунд #483 (2026-09-18, код готов, смоук pending).** Боевой шар (комната SFU
+ звонок 1:1) публикует residual (десктоп минус наш клиент) вместо сырого loopback.
Юзер-решения: вычитание БЕЗУСЛОВНО — БЕЗ тумблера (кейс «шар со звуком, но наш звук
внутри» не существует: зритель шара всегда участник голосовой комнаты и слышит канал
напрямую, в шаре это чистое эхо; тумблер был инженерная перестраховка, убран вместе с
полем ClientSettings.shareAudioSubtraction); звуки UI (динь/стуки/чайм/рингбек) — В
референсе. **Архитектура
референса:** плayout элементный (M0), поэтому референс = РЕКОНСТРУКЦИЯ: RoomAudio на
каждый chain параллельно анализу цепляет `analysisSource → referenceGain →
referenceDest (MediaStreamDestination)`; referenceGain ЗЕРКАЛИТ element.volume в
единственной точке `applyChainVolume(chain)` (сигнатура расширена с (element, volume);
deafen зануляет обе); `roomAudio.getReferenceStream()` (ленивый dest; пустой = честная
тишина). NotificationHub получил ШИНУ mixBus (все 5 master.connect(destination) →
ensureMixBus; ringback-обход фабрики контекста заодно починен — теперь через
ensureAudioContext c sink'ом) + `getReferenceStream()`. **Встройка:** `buildSubtracted-
ShareStream(display, "room"|"call")` — читает настройку на СТАРТЕ шара, строит
subtractor с референсами [RoomAudio, NotificationHub], отдаёт `new MediaStream([video,
residual])` — sfu.ts/peer-call.ts НЕ тронуты (стерео-мунж по track id ловит residual
as-is; в звонке replaceTrack на предсогласованном слоте); FALLBACK: падение subtractor'а
НЕ роняет шар — лог + сырой звук. Dispose: stopShareInternal/teardownVoice (комната),
stopCallShareInternal/call-teardown (звонок). **Silence-gate** в ворклете и чистом
зеркале: счётчик тишины > delay+HALF → фильтр-циклы пропускаются (окно гарантированно
из нулей, passthrough математически тот же) — CPU в простое «никто не говорит» ≈ 0;
+тест. **Телеметрия:** diag-строка `sub` (кэш 1с-интервалом, readStats сбрасывает окно)
+ [share-sub]-лог каждые 10 с и на старте/стопе. API subtractor'а: references МАССИВОМ
(соединения в input 1 суммируются самим WebAudio). Гейты 315/315 + typecheck + build.
Смоук: шар с звуком → зритель НЕ слышит голосовой канал и стуки входа (в комнате и в
звонке — там это само-АЕС); diag `sub` живой; смена громкости пира/deafen на живом
шаре — краткая сходимость и снова чисто; медиа-плеер аттачей в шаре ОСТАЁТСЯ (играет
мимо референса — осознанно: это «десктопный» звук).
**Смоук-фикс, итерация 5 (живой репорт 2026-09-18: у зрителя звук шара чист пока он
молчит, но при ЕГО речи — «плыл», «в одно ухо», «электронный скрежет»).** Диагноз:
корреляция на РЕЧИ МНОГО-ПИКОВАЯ (квазипериодичность: алиасы каждые ~240–480 сэмплов
= период питча) — глобальный поиск максимума прыгал между алиасами; прыжок ≤384
сэмплов сдвигал окно фильтра С СОХРАНЕНИЕМ табов (сходимых под старое выравнивание)
→ вычиталась кривая копия; L и R оценивали НЕЗАВИСИМО и запирали разные алиасы →
стерео перекашивало в одно ухо. Белый шум самотеста одно-пиковый — класс не ловился;
удалённый тон-зонд предупреждал ровно об этом (ошибка: вывод «шум доказал всё»).
Фикс: (1) **ОДИН дилэй на оба канала** — корреляция по L+R моно-сумме (SharedTracker
в ворклете), «в одно ухо» невозможно по построению; (2) политика ре-центровки
stability-first в ЧИСТОМ `domain/logic/share-recenter.ts` (+тесты, копия в ворклете
keep-in-sync): лок однажды по доверенному пику (quality ≥ 0.3), дальше поиск ТОЛЬКО
в окне delay±256 (алиасы питча за окном), |shift|≤8 игнор, больше — ТОЛЬКО после
гистерезиса (2 согласных замера), гейт трека 0.25; (3) **отказ-детектор** в ворклете
(внутренние 1с-окны поверх статистики, НЕ сбрасываемые readStats): при активном
референсе residual/loopback > 0.5 три окна подряд → лок сброшен, полный ре-поиск
(самовосстановление после реального дрейфа/смены устройства) + [share-sub] warn
«delay lock lost»; (4) crossCorrelationPeak получил minLag/maxLag (поиск в диапазоне);
(5) stats переработаны: delaySamples/locked/correlationQuality/lagHistory — ОБЩИЕ
(top-level), каналы несут только энергии/активность; (6) самотест += фаза
«voice-like» (шум с питч-огибающей 150 Гц через modulatedNoise — воспроизводит
много-пиковость речи): логирует дБ + вердикт стабильности лагов (spread ≤ 16 =
STABLE / JUMPING = баг вернулся), в вердикт шумовых фаз НЕ входит; тест ~13 с.
Гейты 325/325 (+10) + typecheck + build. Перепрогон смоука pending. **Самотест
перепрогнан (2026-09-18 вечер): L 33.2 / R 43.7 / stereo 47.9 / voice-like 46.9 дБ
STABLE, дилэй 9488 стоит — фикс подтверждён в синтетике.** Консольные ERROR
`wgc_capture_source CreateForWindow failed / Source is not capturable` — НЕ наш баг:
это Chromium WGC ПРОБИРУЕТ окна при перечислении (UWP/cloaked/повышенные не годятся,
E_INVALIDARG — пропускаются; та же механика = пустые превью у части тайлов пикера).
Сопутствующий твик: `space-capture:sources(types?)` — самотест просит только экраны
(без перечисления окон → без спама и заметно быстрее старт; пикер по-прежнему оба).
**Фикс восстановления аудио-устройств (юзер-репорт 2026-09-18: микр/колонки всегда
слетали в дефолт между запусками, движок NS — нет).** Диагноз: настройки СОХРАНЯЛИСЬ
(в KV лежали хэши), но deviceId-хэши Chromium НЕ ЖИВУТ между перезапусками приложения
(лог: «saved microphone unavailable in this window» при КАЖДОМ заходе в голос) — exact-id
падал в Overconstrained → фолбэк на дефолт, и UI показывал дефолт (id не находился в
списке). NS-движок — строковый enum, потому выживал. Фикс = пара (id, label):
`domain/logic/device-match.ts` (matchDeviceId: точный id → фолбэк по label среди
реальных устройств (синтетику default/communications не матчит); deviceLabelFor; +тесты);
ClientSettings += microphoneLabel/speakerLabel/cameraLabel (пишутся вместе с id);
DeviceSelect показывает РЕЗОЛВНУТЫЙ id (точный id → фолбэк label) и отдаёт пару; runtime:
resolvedDevices-кэш + resolveSavedDevices (enumerateDevices; пустые id = до-пермиссия =
пропуск) + watchDeviceSettings (ре-резолв на Apply и на devicechange, спикер
переприменяется) — ВСЕ точки чтения (openSession-спикер, sfu.microphoneDeviceId,
captureCallMic, обе камеры) берут резолвер. Гейты 330/330 (+5) + typecheck + build.
Смоук: выбрать микр/колонки → Apply → рестарт → выбор на месте, в голосе нужный мик,
в логе нет «unavailable».
**Смоук-фикс, итерация 6 (живой репорт: голос себя больше НЕ слышен ✓, но зритель
слышал звуки шарящего — мут/анмут; телеметрия: окно «-43.9 dB (delay 512,
searching)» = адаптация ДО лока с мусорным дилэем, затем лок на 3933 при
элементном пути ~9500).** Корень: наш клиент играет через ДВА домена с РАЗНОЙ
латентностью — remote-треки через <audio>-элементы (~200 мс), UI-звуки через
AudioContext NotificationHub (~80 мс); оба референса смешивались в ОДИН вход
ворклета → один трекер лочится на домене, заговорившем первым, второй домен
навсегда вне ±512-окна табов (→ свипы просачивались). Фикс: (1) ворклет =
КАСКАД ДВУХ доменов (CancellerDomain: свой tracker+taps+failure-detector на
домен; input 0=loopback, 1=elements (RoomAudio), 2=contexts (NotificationHub);
домен без референса = автоматический passthrough; contexts едят residual
elements); (2) АДАПТАЦИЯ ЗАПРЕЩЕНА до лока домена (adaptEnabled на каналах,
ставится трекером при локе; при отказ-анлоке табы СБРАСЫВАЮТСЯ — лечит и
pre-lock окно −43.9 дБ); (3) API references = {elements:[], contexts:[]};
stats: каналы несут только финальные lb/res (аккумуляторы процессора), домены —
delay/locked/quality/lagHistory/referenceSquareSum (гейн тракта теперь на
домене); телеметрия: `live X dB (el 9500✓, ctx 3900✓)`. Гейты 330/330 +
typecheck + build.
**Итерация 7 (репорт: «артефакты остались — металлический лязг при речи, тишина
чистая»; телеметрия: el-домен залочился на 4465 при самотестовом элементном
пути 9488 и окно −26 дБ).** Корень: продакшн-референс ехал ТРЕКОМ через границу
AudioContext'ов (RoomAudio-контекст → трек → контекст субтрактора) — доставка
между часами Chromium с выравнивающими вставками/дропами = референс «дышит» на
сэмплы → фильтр вычитает чуть съехавшую копию → металлическая гребёнка; в
тишину silence-gate → чисто. Самотест не ловил (один контекст, узел напрямую);
loopback-пересечение при этом СТАБИЛЬНО (доказано тем же самотестом). Фикс:
граф субтрактора строится В КОНТЕКСТЕ RoomAudio (createShareSubtraction(…,
roomAudio.getAudioContext())), элементный референс — УЗЛОМ
(RoomAudio.getReferenceBus(): шина referenceBus, chains кормят её,
MediaStreamDestination теперь ЛЕНИВО подключается от шины для
getReferenceStream-потребителей); контекстный домен (NotificationHub) остаётся
треком — короткие UI-звуки, дрейф допустим. Гейты 330/330 + typecheck + build.
**Итерация 8 (репорт: «рёв перегруженных колонок» на онсете после тишины, при
непрерывной речи нормализуется; телеметрия: el-локи скачут 0→5806→5806,
residual/loopback 1.00 при верном лаге, финал ratio 1235 = взрыв оценки).**
Диагноз: доставка loopback-трека внутрь AudioContext ПЕРЕЗАБАЗИРУЕТСЯ через
длинную тишину (буфер доставки осушается и наполняется новой глубиной) — на
каждом онсете фактический дилэй скачет; замороженные табы бьют мимо (рёв),
отказ-детектор за 3 с разлочивал → ре-лок → схождение при непрерывной речи.
Фикс = принцип «худший исход — короткая утечка начала фразы (как до фичи),
никогда мусор»: **ONS HOLD-OFF** — на фронте референса (тишина→активность)
каналы домена переходят в ПАСТРУ (bypass), через 100 мс (ONSET_SHOT_DELAY)
запускается FULL-RANGE корреляция-верификация: подтверждённый лок (лаг в
окне ±256) → холдофф снимается, тёплые табы сразу вычитают; скачок дилэя
(качество ≥ lock-гейта, лаг вне окна) → применяется НЕМЕДЛЕННО (без
гистерезиса, single shot) + resetTaps; недоверенный замер → повтор через 100 мс,
пасстру продолжается; всплеск умер до верификации → холдофф снят. Отказ-детектор
ускорен: окна 1с×3 → 0.5с×3 (1.5 с), при отказе тоже включается холдофф до
верификации. maybeRecenter(channels, verifyOnset) возвращает исход
(idle/confirmed/relocked/locked/untrusted). Гейты 330/330 + typecheck + build.
**ВЕРДИКТ: pure-DSP-вычитание — NO-GO для продакшна (юзер-решение 2026-09-18,
после 8 итераций; финальный прогон: домены лока согласованы el 5392/ctx 5453,
а вычитание живьём 2.4 дБ при самотестовых 33–48 + взрыв оценки ratio 1878).**
Корень не в DSP (математика доказана самотестом и симуляцией), а в ТОПОЛОГИИ
Chromium: живой путь проходит несколько доменов часов (плеер элементов, рендер-
контексты, доставка loopback-трека, публикующий WebRTC-пайплайн), чьё согласование
не сэмпл-стабильно — каждый слой invalidated адаптивное состояние новым способом
(расходимость → алиасы питча → два домена → кросс-контекстный дрейф → pre-lock
мусор → перезабазирование доставки через тишину). **УРОК: GO-вердикт спайка
опирался на самотест, не моделировавший живой тракт — спайк обязан проверять
именно продакшн-топологию сигнальных путей.** ОТКАТ продакшн-проводки: шары снова
публикуют СЫРОЙ loopback (в обоих путях), вычитание НЕ строится; ОСТАЮТСЯ: raw-
констрейнты LOOPBACK_AUDIO_CONSTRAINTS (отдельный реальный фикс качества шара),
самотест + чистые модули + ворклет (дормант в diag), референс-шины RoomAudio/
NotificationHub mixBus (mixBus — ещё и фикс рингбек-sink), фикс аудиоустройств.
Следующий раунд (юзер-решение): НАТИВНЫЙ СПАЙК port-loopback — ядро WASAPI из
oak-client + N-API обёртка (EXCLUDE-свой-PID для экранов = та же семантика «десктоп
минус наш клиент» на уровне ОС; INCLUDE для окон = per-app звук, oak-парити).

**Нативный спайк #485: WASAPI process-loopback через koffi, БЕЗ своего C++ (2026-09-18,
фаза 0+2 GREEN, обвязка готова, смоук pending).** Юзер-вопрос «почему oak'у хватило
Java» вскрыл: oak писал логику на Java ЧЕРЕЗ JNA (runtime-FFI, никакого своего
нативного кода — JNA-колбэки собирают COM-хендлер); Node-эквивалент JNA = **koffi**
(prebuilt N-API FFI, npm install — первый СТОРОННИЙ prebuilt-нативный деп, своих
нативных модулей по-прежнему ноль, node-gyp/MSVC не нужны). **Фаза 0 (пробник
`scripts/koffi-sysaudio-probe.cjs`, чистый node): ЧУЖОПОТОЧНЫЙ COM-колбэк koffi
доставляет в JS-цикл (документированное поведение — подтверждено живьём), активация
VAD\Process_Loopback с exclude-self прошла С ПЕРВОГО раза (спека oak байт-точная).
Фаза 2: полный цикл GetActivateResult→IAudioClient→Initialize(48k/стерео/16бит,
AUTOCONVERT, нулевые длительности)→Start→дрен 117k сэмплов/2с→Stop→чистый teardown.
Трюк: чтение памяти по произвольному адресу — msvcrt.memcpy в скретч (raw-read у
koffi нет); vtable-вызовы через koffi.call.** Продакшн-обвязка: `electron/
system-audio.ts` (guarded require koffi; availability = win32 + build ≥ 19041;
bindings/COM-хендлер создаются ОДИН раз на процесс, хендлер-стабы не фришатся —
oak/vlcj правило; сессия: активация → Initialize → event-дрен таймером 10 мс БЕЗ
нативного потока, пакеты батчатся; teardown в oak-порядке; Int16-копии кадром в
колбэк); IPC `space-sysaudio:available/start/stop` + fire-and-forget
`space-sysaudio:frame` (Int16Array+silent, webContents.send — паттерн space-hotkey);
koffi в rollup external main-бандла. Renderer: `media/system-audio-source.ts` —
инжектор-ворклет (port-fed стерео-кольцо 1 с, underrun→тишина+счёт, overflow→дроп
старых; stats RMS/канал раз в 1 с) → MediaStreamDestination → track (класс
NS-пайплайна); monitor-выход на destination (TAP — дубль безопасен). Диаг: кнопки
«System-audio self-test» (3 фазы: тишина ≈−∞ / музыка СНАРУЖИ живая / ТОЛЬКО звуки
space ≈−∞ — контракт exclude-self) и «Sys-audio monitor» (уши). Гейты 330/330 +
typecheck + build. Смоук pending. Продакшн-встройка (подмена трека на шве shareTarget,
INCLUDE-окна+HWND→PID, liveness-watchdog, AEC-референс мика против акустического
дубля) — отдельный раунд после вердикта. ГРАБЛЯ: у koffi register хочет тип
koffi.pointer(proto), а НЕ сам proto. **ГРАБЛЯ EXTERNAL BUFFERS (живой крах,
первый запуск в Electron): `koffi.view()` — ArrayBuffer поверх НАТИВНОЙ памяти —
в Electron ЗАПРЕЩЁН и фаталит процесс (`FATAL napi_get_last_error_info`); в чистом
node разрешён — потому пробник был зелёный, а приложение упало. Модуль переписан
БЕЗ единого view: запись — koffi.encode (включая 'void *' с BigInt), чтение
скаляров — koffi.decode.int32/uint32, чтение произвольного адреса — msvcrt.memcpy
с `_Out_ void *dest` + Node Buffer (документированная output-идиома: копия C→JS
после вызова), сравнение GUID — memcmp по нативным ячейкам (ни байта в JS).**
**ВЕРДИКТ СПАЙКА #485: GO (живой самотест 2026-09-18, фазы с lead-in-пейсингом
~27 с: подсказка → 5 с подготовка → «WINDOW OPEN»-маркер → окно 5 с).** (а)
baseline −96.7 dBFS (цифровой ноль); (б) внешняя музыка −29.3 dBFS; (в) ТОЛЬКО
звуки space (мут-тогглы) −96.7 dBFS — **EXCLUDE-SELF КОНТРАКТ ДОКАЗАН: наш
клиент акустически невидим для захвата, остальное пишется чисто**; dropped=0;
underruns при тишине — кольцо осушается, выход честные нули (безвредно). Полный
путь: WASAPI(48k/stereo/16bit, koffi, drain-таймер 10 мс) → IPC Int16 →
инжектор-ворклет → RMS. Продакшн-раунд (решение за юзером): подмена аудио-трека
на шве shareTarget/callShareTarget (new MediaStream([video, nativeTrack]) —
хендлер Electron кастомный трек не отдаёт), INCLUDE-режим для окон (HWND→PID) =
per-app звук oak-парити, liveness-watchdog 500 мс для оконных шар, AEC-референс
мика (захваченное играет в колонках → акустический дубль в мик без него),
availability-гейт в UI, koffi в упаковке #470 (node_modules должен ехать в
dist или external).

**Продакшн-встройка #485 (2026-09-18, код готов, смоук pending): шар публикует
НАТИВНЫЙ трек — экраны exclude-self, ОКНА per-app (INCLUDE).** На шве
shareTarget/callShareTarget (комната + звонок) после getDisplayMedia:
`acquireNativeShareAudioTrack(sourceId?)` (НОВЫЙ `src/media/native-share-audio.ts`
— менеджер: availability → защитный stop от утёкшей сессии →
createSystemAudioSource → sink навешивается ДО start (кадры идут с первого тика
дрен-таймера) → bridge.start; ЛЮБОЙ фейл = null) → при успехе display-аудио-трек
`.stop()` (Chromium-loopback умирает неопубликованным) и в sfu/peer-call уходит
`new MediaStream([displayVideo, nativeTrack])` — оба читают `getAudioTracks()[0]`,
подмена прозрачна; стерео-мунж по track id ловит synthesized-трек as-is.
**Два режима** (system-audio.ts: `startSystemAudio(onFrame, onEnded?, {sourceId?})`
→ `SystemAudioStartResult{started, mode, pid}`): БЕЗ sourceId = EXCLUDE-self
(весь десктоп минус наш процесс, блоб mode=1 pid=наш) — экраны; С sourceId
окна (`window:HWND:…`, HWND десятичный, второй сегмент) = INCLUDE (mode=0,
pid=целевого дерева) — per-app звук oak-парити: HWND→PID через user32
`GetWindowThreadProcessId` (koffi; мёртвое окно → null → фолбэк), окна вообще
НЕ просят Chromium-аудио (native-трек их единственный звук, фейл = video-only
как в M4). Фолбэк на любом шаге: экраны → сырой loopback, окна → video-only —
шар НИКОГДА не ломается из-за фичи. Teardown: stopShareInternal /
stopCallShareInternal / teardownVoice / teardownCall / catch-пути обоих швов →
releaseNativeShareAudio() (IPC-stop + dispose контекста инжектора). Логи:
renderer `[share] publishing screen … (audio: native process-loopback (desktop
minus this client))` / `native per-app process-loopback` и `[call] share
publishing …`; main `[sysaudio] native capture started (desktop minus this
process | per-app pid N)/FAILED/stopped/DIED(reason)` (startSystemAudio получил
onEnded-колбэк — дрен-catch раньше умирал молча). UI: подсказка вкладки Windows
в пикере теперь availability-aware («carry only that application's audio…
native per-app capture» / старый текст при недоступности), подсказка Screens
упоминает «minus this client's own sounds». **Liveness-watchdog оконного шара
(живой баг 2026-09-18: шарящий закрыл окно → у смотрящего ВЕЧНЫЙ замороженный
кадр, «Watch screen»/«sharing screen» на призраке; юзер вспомнил фикс того же
в oak).** Корень: в Electron трек getDisplayMedia при закрытии захваченного
окна НЕ стреляет "ended" — WGC морозит последний кадр, публикация продолжается,
фид у Janus честно жив (вывод «доминирующий путь закрыт ended-треком» был
неверен). Фикс = oak-парити (SfuService: «IsWindow every 2 s → the ordinary
stop path»): НОВЫЙ `electron/window-liveness.ts` (koffi user32 IsWindow, поллинг
500 мс — oak 2 с, но вызов наносекундный; один watch, арм нового заменяет
старый; `parseWindowHwnd` вынесен сюда и переиспользован в system-audio INCLUDE);
IPC `space-capture:watchSource(sourceId|null)` + event `space-capture:sourceDead`
(webContents.send + `[share] watched window died` в лог); renderer: арм на
ОКОННОМ шаре обоих швов после успешного publish, `installSourceDeadListener`
(bootstrap) гейтит по совпадению sourceId (стейл-события старого шара игнор) и
маршрутизирует в ОБЫЧНЫЙ stop (callSharing? stopCallShareInternal :
stopShareInternal); отмена во всех teardown-путях рядом с
releaseNativeShareAudio. **ПЕРЕДИАГНОЗИРОВАНО ПО ЛОГАМ (второй прогон
2026-09-19): ended у видео-трека при закрытии окна ВСЁ-ТАКИ СТРЕЛЯЕТ** —
`[sysaudio] native capture stopped` в секунду закрытия (stopShareInternal
успел раньше 500-мс поллинга, потому watchdog-строк в логе нет; watchdog
остаётся страховкой, oak-парити). Настоящий корень призрака был НА ЗРИТЕЛЕ,
две дыры: (1) UI считал «есть экран» как `streams.some(type==="video")` БЕЗ
`!disabled` — Janus при стопе шара помечает стримы фида DISABLED, но
оставляет их в списке (лог: `streams=[audio:0/m0 video:1/m1! audio:2/m2!]
(update)` — `!` = disabled), фид-апдейт ДОЕЗЖАЛ и обрабатывался (ренегошка
`subscriptions +0/-2` в ту же секунду), но «Watch screen»/«N screens»/
voice-bar-бейдж/ПКМ-меню продолжали видеть призрак; фиксы: `feedHasLiveVideo`
в classifier.ts (+тест) на всех четырёх точках (VoiceRoom screenCount/screens/
tile-hasVideo/memberMenu, Sidebar ПКМ); (2) ЗАМОРОЖЕННЫЙ КАДР: после отписки
remote-видео-трек уходит в muted (НЕ ended) → handleRemoteTrackEnded не
стреляет, `<video>` держит последний кадр, viewingFeedId никто не чистит;
фикс: `pruneDeadView(feeds)` в onParticipants-колбэке SfuSession — просмотр
гасится, если фид пропал ИЛИ его видео disabled (покрывает и уход пира из
комнаты). Гейты 332/332 + typecheck + build.
**Итерация 3 (живой репорт 2026-09-19): очистка работает, НО ре-вотч второй
итерации пуст — «Watch screen» → тайл с plate "Screen sharing…" без кадра,
off/on лечит.** Корень — Janus РЕЦИКЛИТ m-line подписчика для следующего шара
паблишера: тот же transceiver/receiver → ТОВ ЖЕ объект трека (замолчал →
размолчал с новым контентом) → **ontrack повторно НЕ стреляет**, а
attachShareVideo был сброшен pruneDeadView; off/on работает потому, что
unsubscribe рвёт m-line и новая подписка создаёт СВЕЖИЙ transceiver → ontrack →
доставка. Заодно вскрылся КЛАСТЕР в RoomAudio: attachVoiceTrack/
attachShareTrack начинались с detachFeed (обе цепи) — attach share УБИВАЛ
voice-цепь пира (голос шарящего у смотрящего умирал с момента просмотра —
маскировалось тем, что голос слышен внутри loopback-шара), а «share ended»
(→detachFeed) добивал всё. Фиксы: (1) RoomAudio — РАЗДЕЛЬНЫЙ teardown
(detachVoiceFeed/detachShareFeed приватные, attach* чистит только свою цепь,
detachFeed = обе для ухода фида); (2) runtime — УДЕРЖАНИЕ треков
(feedVideoTracks/feedShareAudioTracks, калл-паттерн callPeerVideoTrack):
доставка пишет, pruneDeadView чистит только фиды-небитые (disabled-видео
держит — рецикл вернёт именно этот объект), teardownVoice чистит всё;
setViewingFeed(on) ре-аттачит удержанный share-audio, VoiceRoom — флип-эффект
[viewingFeedId, participants] ре-биндит удержанное видео в смонтированный
<video> (getFeedVideoTrack экспорт); свежий трек при доставке просто
переопределяет. Гейты 332/332 + typecheck + build.
**Итерация 4 (живой репорт 2026-09-21, три бага):** (1) «звук шара идёт СРАЗУ,
без Watch» — КОРЕНЬ: pruneDeadView чистил viewingFeedId в appStore, но НЕ
говорил SfuSession (viewedFeedIds жил) → следующий шар того же пира попадал в
wantedStreams и автоподписывался (лог: subscriptions +2 в секунду announce,
клик был на 5 с позже). Фикс: pruneDeadView вызывает sfuSession.setViewingFeed
(null) — setViewingFeed сам синкает подписки. (2) «голос шарящего с задержкой
2-3 с при включении просмотра» — вероятный корень: ПЕРЕСОЗДАНИЕ <audio>-
элемента при повторном аттаче ТОГО ЖЕ трека (watch-flip ре-аттач + повторная
доставка рецикл-трека строили свежий элемент = спин-ап плейаута с нуля). Фикс:
ИДЕМПОТЕНТНОСТЬ attachVoiceTrack/attachShareTrack — цепи хранят track, тот же
объект = no-op (перестройка только при новом треке). (3) «лишние люди в
комнате» после жёсткого закрытия клиентов — СЕРВЕР голос чистит корректно
(VoiceMembershipTracker.onDisconnect → exit(sessionId)); призраки = Janus-
сторона: мёртвые publisher-сессии висят до собственного session-timeout Janus
(~минута), room view тайлы питаются от Janus-фидов (лог: фиды с m1!/m2!
disabled и вечным STILL muted WARN). Артефакт смоук-стенда (жёсткий kill);
живём, чистый прогон = выходить из комнаты перед закрытием. Гейты 332/332 +
typecheck + build. **Решения по хвостам раунда (юзер, 2026-09-21): AEC-референс
мика — НЕ ДЕЛАЕМ** (акустический дубль «колонки→воздух→мик» — pre-existing и у
сырого loopback, вне процессов, API инъекции референса в Chromium APM нет;
решение юзера — наушники; собственный AEC-ворклет отвергнут из-за риска
повторить #483 — кросс-доменная адаптивная фильтрация); **koffi в упаковке —
ПОДЗАДАЧА #470**, отдельной работы нет: asarUnpack node_modules/koffi +
npmRebuild:false (N-API prebuild) + packaged-смоук на чистой машине (проверить
`[sysaudio] native capture started` и тихий fail-soft), риск — AV-эвристики на
FFI-бинарник. Нативная линия #485 закрыта полностью.
**СМОУК-ВЕРДИКТ продакшн-раунда #485 (2026-09-18, юзер: «протестировал, как
будто всё работает»): PASS.** Лог instance-b: screen-шар native exclude-self →
`monitor on (attached to the live share capture)` → чистый stop; ушами: видео
в мониторе есть, кю/голос — по одному разу (дублей = утечек нет). Окна per-app
в том же прогоне стартовали/стопались чисто (pid разрешён), наушная проверка —
тем же монитором при желании.

**ГРАБЛЯ СМОУК-СТЕНДА (живой смоук 2026-09-18): два инстанса на одной машине =
ЦИФРОВОЙ ФИДБЕК-ЛУП.** Захват A — цифровой TAP рендера процессов минус дерево
A; инстанс-B — ДРУГОЙ процесс, и ВСЁ, что он воспроизводит (шар-звук, голос
комнаты), A захватывает и снова публикует → зритель слышит копии «множество
раз как эхо» (круг ≈ сотни мс). Deafen ШАРЯЩЕГО и мут ПРИНИМАЮЩЕГО НЕ РВУТ луп
(первый и так исключён из своего захвата; второй не при делах — луп не через
микрофон); наушники тоже — захват цифровой, до устройства вывода. Рвёт луп
только глушение РЕНДЕРА принимающего (deafen B / громкость шара в 0) — но тогда
B не слышит и негативный контракт ушами B на одной машине НЕПРОВЕРИМ в принципе.
Рецепт одной машины: B deafen; A при живом шаре жмёт diag «Sys-audio monitor» —
монитор играет через процесс A → из захвата исключён → единственный безлуповый
пост прослушивания: музыка ЕСТЬ, голос/UI-звуки НЕТ = негативный контракт
доказан на стороне источника. Для этого монитор УЧИЛ цепляться к живому шару
(monitorActiveShare/isNativeShareActive в native-share-audio; раньше onFrame
ВОРОВАЛ единственный IPC-синк шара, а второй bridge.start() фейлился на
single-session — монитор при живом шаре убивал звук шара); старт шара гасит
standalone-монитор (stopStandaloneMonitorForShare на обоих швах). Для реальных
юзеров (разные машины) лупа не существует — у A нет доступа к рендеру машины B
(Discord на одной машине ведёт себя так же). **Грабля монитора-по-дефолту
(живая, та же): монитор играл в системный ДЕФОЛТ (колонки), а не в выбранный
в клиенте спикер** — на смоук-стенде дефолт часто и есть устройство контента:
прямой звук + отставшая TAP-копия в ОДНИХ колонках читаются как «эхо» (это НЕ
луп — монитор рендерит наш процесс, из захвата исключён). Фикс: контекст
system-audio-source принимает monitorSinkId (AudioContext.setSinkId, структурный
тайп как у NotificationHub) + setMonitorSink на живом источнике; прокинуто из
швов (resolvedDevices.speaker), standalone-монитор тоже; watchDeviceSettings
переприменяет (setActiveShareMonitorSink). Публикуемый трек —
MediaStreamDestination, sink на него не влияет.

**Share-пикер: спиннер загрузки + живое превью камеры (2026-09-18).** (1) Перечисление
источников на Windows занимает 0.5–2 с, а пикер сразу рисовал «No screens found» — теперь
`sourcesLoading`/`camerasLoading`: спиннер (`.picker-loading`, md-refresh на keyframes
sp-spin — тот же, что у upload-строки), «No … found» ТОЛЬКО после завершения перечисления
(и не показывается при ошибке перечисления — её объясняет error-line). (2) Вкладка Camera
получила ЖИВОЕ превью (раньше его не было никогда — M4-коммит `eb59ddc`, юзер помнил
oak-клиент): один getUserMedia-стрим 640×360 → muted `<video>` в чёрном 16:9-боксе над
списком; превьюруется ВЫБРАННАЯ камера, при отсутствии выбора — первая (Share по-прежнему
требует явного клика); смена камеры бесшовна (старый стрим стопается после успеха нового),
уход с вкладки/закрытие модала/Share останавливают стрим (устройство чисто переходит
реальному захвату 1280×720); ошибка открытия → «Camera preview unavailable», список жив.
**Про «живые» превью экранов (вопрос юзера, решение НЕ принималось — опции на будущее):**
у Discord миниатюры дёшевы, потому что Windows DWM-композитор отдаёт уже отрисованные
поверхности; Electron/Chromium к DWM-миниатюрам доступа не даёт — только capture-пайплайн.
Опция A «псевдо-live»: main по таймеру 1–2 fps перечисляет источники заново и пушит свежие
dataUrl, пока пикер открыт (только тип активной вкладки) — простая, десятки мс CPU на
sweep, выглядит слайдшоу. Опция B «настоящее live-видео»: getDisplayMedia на источник
(через preview-грант в существующем хендлере — renderer-констрейнты ненадёжны при живом
хендлере, грабля M4); один поток выбранного тайла стоит как низкобитрейт-шар (единицы %
CPU), все тайлы сразу = N пайплайнов полного разрешения — тяжело. Гейт 307/307 +
typecheck + build. Смоук pending.

**Второй шаг пикера — Quality + анти-фриз гранта (2026-09-21, код готов, смоук pending).**
Портирован oak ScreenSourcePicker.Picker (Java прочитана) + юзер-решения сверх oak:
(1) вариант **«Source»** в ряду Resolution (натив без кап — пол для источников меньше
720p, дискорд-идиома; у oak нет); (2) дефолт **Medium** 24fps/1080p/3Mbps (oak: High) с
клампом к наивысшему доступному; (3) **отсечение разрешений по возможностям источника**
(oak не отсекает): экраны — display_id → screen.getAllDisplays() (size×scaleFactor =
физика), окна — HWND → koffi `user32.GetClientRect` (client area = что захватывает WGC;
НОВЫЙ getClientSize в window-liveness.ts рядом с IsWindow), камера — getCapabilities()
живого превью (width.max — ULongRange, НЕ maxWidth, TS-грабля); неизвестный размер =
полная лестница. (4) качество применяется и к КАМЕРЕ (oak-парити). Чистая логика
`domain/logic/share-quality.ts` (+25 тестов): builtin Low/Medium/High, ряды fps
15/24/30/45/60/75/90 · Source/720p/1080p/1440p/2160p · 1.5/3/6/8/12/16 Mbps,
resolveQuality (тронутый сегмент побеждает пресет = Custom), feasibleResolutions/
clampQualityToSource, describe/presetLabel, upsertPreset (кап 30),
displayVideoConstraints (max-семантика — Chromium НЕ апскейлит меньший источник) и
cameraVideoConstraints (ideal — ближайшая capability). **UI**: SharePickerModal стал
двухшаговым (шаг 1 источник → Next; шаг 2 Quality: пресет-комбо builtin+saved+Custom,
сегментные ряды пилюлями с ТОЧНОЙ подсветкой, Save-строка (Enter = Save), чекбокс звука,
summary «Streaming at …», Back/Cancel/Share); НОТЫ шага 1 про звук УДАЛЕНЫ — инфо
переехало в чекбокс + tooltip (экраны: «minus this client's own sounds»); чекбокс виден:
экраны всегда, окна только при native-доступности, камера никогда; сид per-kind из
настроек, запись по Share (oak commitShare). **Персист**: ClientSettings +=
sharePresets (санация в load: не-массив → []), shareScreenAudio/shareWindowAudio
(дефолт true). **Проводка**: ShareTarget += quality/includeAudio; getDisplayMedia обоих
швов (комната + звонок) идёт с displayVideoConstraints; includeAudio гейтит звук ЦЕЛИКОМ
(экраны не просят loopback, окна пропускают acquireNativeShareAudioTrack — video-only
шар честный); видео-битрейт на сендеры: sfu.startShare/startCamera получили параметр
(raiseSenderBitrate), peer-call — applyVideoCeiling (MLINE_VIDEO-слот ПЕРСИСТЕНТЕН:
null = СБРОС потолка, иначе потолок шара каптил бы следующую камеру). **Анти-фриз
гранта (живой репорт «курсор фризит 2–3 с на старте шара»)**: по [perf]-логам рендерер
в этот момент ЧИСТ (все longtask — на заходе в голос, dfn3-спинап) — фриз уровня
OS/GPU; главный устранимый вклад: хендлер гранта ПЕРЕЧИСЛЯЛ ВСЕ ИСТОЧНИКИ ЗАНОВО при
каждом Share (desktopCapturer.getSources screen+window = WGC-пробинг каждого окна,
0.5–2 с GPU-churn) — теперь `space-capture:sources` (полная энумерация) сеет КЭШ на
30 с, грант берёт источник из кэша (оконные хиты валидируются IsWindow — мёртвое окно
= промах → старый путь перечисления), лог-маркер «(picker cache)»; неустранимый
остаток — создание WGC-сессии (DWM-изоляция окна) + раскрутка энкодера, кап качества
её уменьшает. Гейты 357/357 + typecheck + build (глифы уже были, icons.css не тронут).
**Смоук-итерация 1 (2026-09-21, юзер-репорты):** (1) Save-кнопка пресета теперь
**primary (blurple)** когда активна (была ghost; disabled = штатный серый
button.primary:disabled). (2) **Удаление пресетов** (юзер-запрос, у oak нет):
комбо переделано из нативного select в КАСТОМНЫЙ дропдаун (select не умеет
интерактивные элементы в строках) — триггер-кнопка в стиле scope-селекта,
меню absolute с чеком у активного и КРЕСТИКОМ (mdi-close, hover красный) у
КАЖДОГО СОХРАНЁННОГО пресета (builtin — код, без крестика); удаление = фильтр
settingsStore.sharePresets (удалённый выбранный → комбо в Custom, качество не
дёргается — сегменты несут те же значения); меню НЕ закрывается по крестику
(чистить несколько подряд), закрывается по выбору/клику-вне/Escape (capture +
stopPropagation — модал жив). (3) **Вердикт юзера по фризу курсора: принять
как платформенный** («раз ничего сделать нельзя — пусть останется»); кэш
гранта остаётся (убирает 0.5–2 с лишнего WGC-пробинга независимо от
восприятия). (4) **«15 vs 90 fps на глаз не меняется»** — добавлен
диагностический лог реальных настроек трека после гранта (`[share] capture
settings: W×H @ R fps`, оба шва); рабочая гипотеза: fps-ряд это ПОТОЛОК, а
энкодер при 3 Mbps/1080p в движении сам не тянет выше ~15 fps → выбор 15/90
визуально совпадает; проверка: 90 fps + 16 Mbps (+ Source/1440p) — и смотреть
R в логе (не меняется = констрейнт не доходит до захватчика, следующий рычаг
искать отдельно). Гейты 357/357 + typecheck + build. **Смоук-итерация 1б
(вопрос юзера про кэш vs новые окна):** кэш НЕ мешает свежести — его сеет то же
перечисление, что рисует пикер при каждом открытии (повторный шар = новая
энумерация = новые окна), живёт он только в зазоре «пикер показал → Share»
(≤30 с) и читается только грантом; окно, родившееся при открытом пикере,
появится после переоткрытия (M4-поведение, не менялось). Попутно закрыта ДЫРА
M4: грант на УМЕРШЕЕ в зазоре окно молча проваливался на ПЕРВИЧНЫЙ ЭКРАН
(публиковался не тот источник) — теперь честный отказ (callback({}) →
renderer-путь «share failed», лог «picked source … is gone»); primary-fallback
остался только для self-test-гранта без выбора. Гейты зелёные. **Смоук-итерация 2
(2026-09-21, fps/битрейт-прогон; лог паблишера живёт в instance-b/space.log —
инстансы делят userData подпапками instance-*): КАПЫ ДОХОДЯТ ДО ЗАХВАТЧИКА,
доказано диагностикой:** выбранные 75/15 fps → `capture settings: 1920×1080 @
75/15 fps` ровно, video ceiling 3/6/8 Mbps в [sfu]-строках, каждый грант
«(picker cache)»; «на глаз разницы нет» = статичный десктоп-контент (15↔75
различимо только в быстром движении — видео/драг окон), НЕ баг проводки;
объективный тест для юзера = видео 60fps на шаре. **Смоук-итерация 3 (вечер
2026-09-21): репорт «окно с видео — у паблишера плавно, у зрителя РВАНО на
максимальных битрейте/фпс» → добавлена ТЕЛЕМЕТРИЯ ВИДЕО-РТП (числа вместо
прилагательных): SfuSession.getShareOutCounters/getInboundVideoCounters
(двуххоп-матчинг rtp.trackId → track-stats → trackIdentifier; fps/размер на
track-entry, байты/кадры/потери/джиттер на rtp-entry), runtime-поллер 1 Гц
(лениво стартует с первым открытием diag-панели) → diag-строки **share out**
(«W×H · in 75 fps · enc NN fps · N Mbps» — голодание энкодера = enc ≪ in) и
**share in** («W×H · dec NN fps · N Mbps · drop N · loss N · jit N ms»,
зрительский трек = viewingFeedId → feedVideoTracks), каждые 10 с в лог
[share-stats]. Попап-просмотр исключён (JPEG 12 fps by design — в логе
зрителя popout-записей нет, смотрел живой тайл). Гипотезы на прогон: enc ≪ in
= VP8-энкодер не тянет (CPU) → снижать fps/разрешение осознанно; dec/loss/jit
= сеть/декод. Гейты 357/357 + typecheck + build. **Смоук-итерация 4 — КОРЕНЬ
«РВАНОСТИ» НАЙДЕН (юзер-вопрос «допускает ли Janus высокий фпс?»): videoroom
fps НЕ ограничивает (чистый SFU, пакеты вперёд as-is), но ДЕФОЛТНЫЙ ПОТОЛОК
БИТРЕЙТА ПАБЛИШЕРА = 1 Мбит/с** — oak-server ensureRoom создаёт комнаты БЕЗ
`bitrate`, Janus доводит потолок до энкодера Chromium'а REMB-фидбеком, и тот
подчиняется: ВСЕ пресеты 3/6/8/16 Мбит/с фактически кодировались в ~1 Мбит/с
(объясняет разом и «рваное» на максималках, и «15 vs 90 fps одинаково», и
«битрейт не видно» — всё шло по одному и тому же зажатому каналу; у oak та же
дыра — их applyScreenBitrate тоже сендер-side). Фикс (клиент-only, БЕЗ
парного деплоя): PUBLISHER_BITRATE_CEILING_BPS = 20 Мбит/с в body publisher-
join И каждой configure (публикация/ренего) — константа НАД максимальным
пресетом пикера, поэтому единственный эффективный кап остаётся выбранный в
пикере sender maxBitrate; регрессия в sfu.test.ts (bitrate в join+configure).
Альтернатива не сделана: room-level `bitrate` в ensureRoom (oak-server) —
защитила бы любых клиентов, но требует деплоя и избыточна при клиентской.
ПРОВЕРКА на прогоне: [share-stats] out … Mbps теперь должен следовать выбору
(3/6/8/16), а не стоять в ~1.0; рваность на видео 60fps обязана уйти. Гейты
357/357 + typecheck + build. **Смоук-итерация 5 — ПОПАУТ был узким горлом
всей истории с fps (живой репорт: «в превью комнаты плавно, в ОТДЕЛЬНОМ ОКНЕ
рвано»): зритель смотрел через pop-out, а он с M4 — JPEG-релей НАСОСОМ из
главного окна (canvas ≤1280, q0.75, 80 мс = 12.5 fps BY DESIGN — MediaStream
не переходит между renderer-процессами). Юзер-решение: НЕ поднимать насос, а
дать попапу СВОЮ ВИДЕОРУМ-ПОДПИСКУ. РЕАЛИЗОВАНО:** НОВЫЙ `core/
popout-viewer.ts` (PopoutViewer: собственный JanusClient → attach videoroom
→ join subscriber ТОЛЬКО video-стримом по mid — звук остаётся у главного
окна, дубль невозможен; vanilla-ICE answer + start; onTrack/onGone; тестовые
швы janusFactory/peerConnectionImpl, +4 теста). Попап (PopoutScreen) строит
`<video>` живьём; цель подписки (janusUrl/roomId/token/pin/feedId/videoMid)
main-окно пушит через IPC (`space-window:retargetPopout` → main хранит +
форвардит `popout:retarget`; инволк `popoutParams` при монтировании —
закрывает гонку «событие раньше листенера»); VoiceRoom-эффект [popoutActive,
viewingFeedId, participants] держит цель в синке со смотримым (retarget по
feed-change ПАРИТЕТ старого насоса; JSON-фингерпринт режет повторные
идентичные retarget'ы — апдейт ростера не ресабскрайбит); feed умер →
onGone → «Waiting for the video…», юзер переоткрывает. УДАЛЕНО: JPEG-насос
(POPOUT_FRAME_INTERVAL_MS/MAX_WIDTH, popout:frame IPC в main+preload,
sendPopoutFrame, onFrame). SfuSession.getRoom() для параметров; тонкость:
`null ?? "x"` в тест-фабрике съедает pin-null (использовать `!== undefined`).
Гейты 361/361 + typecheck + build. **Смоук-итерация 6 (живой репорт: «сохранил
пресет с дефолтными значениями под своим именем — появился ВТОРОЙ Medium»):**
корень — ГРАБЛЯ СТРУКТУРНОГО ПОДТИПА: resolveQuality при чистых сегментах
возвращал САМ объект пресета (SavedSharePreset проходит как ShareQuality),
утёкшее поле `name: "Medium"` ехало спредом `{name: trimmed, ...quality}`
ПОВЕРХ введённого имени и перезаписывало его. Фиксы: resolveQuality строит
ЧИСТЫЙ ShareQuality (4 поля); upsertPreset — явная запись без спреда
(утёкшее name не может победить сохраняемое); комбо-матчинг selected в
SharePickerModal теперь ПО ИМЕНИ+значениям (иначе сохранённый с ЗНАЧЕНИЯМИ
билтина подсвечивал builtin-строку — builtin в списке первым); +2
регрессионных теста (strip + upsert-имя). Гейты 363/363 + typecheck + build.

**Мини-раунд юзер-фиксов (2026-09-21, вечер):** (1) **СТУК ДЛЯ ДРУГИХ**
(юзер-запрос): вход/выход СОБЕСЕДНИКА из МОЕЙ голосовой комнаты тоже стучит
(Discord-семантика; раньше — только свои переходы). Механика: SessionHooks +=
onVoiceMemberEvent (стреляет из /topic/voice-подписки), runtime-хук гейтит
`isActive() && event.channelId === activeVoiceChannelId && username !==
ownUsername && soundEnabled` — свои стуки играют на месте join/leave (нет
дубля), чужие каналы молчат. (2) **Выпадайка сервера в шапке сайдбара**
(юзер-решение): к названию сервера над списком каналов добавлен ШЕВРОН
(mdi-chevron-down), клик по шапке открывает ContextMenu под ней; в неё
ПЕРЕНЕСЕНО всё из ПКМ по иконке сервера в рейле (Server Settings с гейтом,
Re-login, Delete + модалки переехали в Sidebar.tsx); ПКМ-меню в ServerRail
УДАЛЕНО целиком (управление фоновыми серверами = свитч + выпадайка). (3)
**Account settings** — новый пункт выпадайки: открывает UserSettingsModal в
scope "account" ( ТОЛЬКО General + Account; nav-титул «Account Settings»);
⚙ user-bar открывает scope "client" (остальные секции) — секции РАЗДЕЛЕНЫ,
не продублированы (юзер-решение «перенесём»). Механика: appStore +=
userSettingsScope ("client"|"account"), runtime openAccountSettings(),
toggleUserSettings ставит client; UserSettingsModal фильтрует SECTIONS по
scope + fallback активной секции. Гейты 363/363 + typecheck + build. **Баг-фиксы
(2026-09-21, живые репорты):** (1) **Server Settings показывал ЛОГИНЫ** (rename-модель
нарушена в трёх местах): Roles → Members (список держателей + пикер кандидатов + сортировка)
и Channels → Access (строки «Members with access» + пикер) рендерили member.username;
Kick/Ban-confirm-модалки цитировали логин. Всё → member.nickname (Avatar остаётся на
username — это КЛЮЧ ростера, не дисплей; usernames-map в Access хранит логин для ключей,
лейбл = grantedUserLabel() → nickname ?? override-логин ?? #id). Members-секция уже была
на никнеймах. (2) **Отобранная роль оставляла мёртвый канал в списке**: /topic/roles (и
/topic/members — там едет assignRoles) дёргали только memberRefresh+permissions, а
GET /api/channels VIEWER-ФИЛЬТРОВАН — теперь оба топика additionally зовут refetchChannels()
(applySnapshot + ensureActiveChannelExists уводит с исчезнувшего активного; refetch сам
дотягивает refreshPermissions). Гейты 363/363 + typecheck + build. **Продолжение
(2б, живой репорт «рестарт клиента, сидевшего в отобранном канале — та же 403-ошибка»):**
корень — реставрация lastChannelId не проверяла LOCKED (отнятый READ оставляет канал
в списке, но залоченным) + ensureActiveChannelExists считал «живым» любой существующий.
Сделано СЛОЯМИ (юзер: «либо фолбэк, либо сообщение» — фолбэк основной, сообщение
терминальное): restoreLastChannel предпочитает сохранённый канал только при
!locked, иначе первый незалоченный TEXT; ensureActiveChannelExists трактует
locked-активный как мёртвый → pickFallbackTextChannel (тоже только !locked);
pendingOpenChannel (клик фонового тоста) не открывает locked; ТЕРМИНАЛЬНОЕ
состояние (доступных каналов нет вообще) — ChatPane-заглушка различает
формулировки: «You have no permission to watch this chat.» (каналы есть, все
locked) vs старая «No text channel…» (текст-каналов нет), .chat-empty уже
flex-centered серым. Гейты 363/363 + typecheck + build.

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
  DM-unread (oak: только DM); confirm-модали на Remove
  friend/Block (oak бьёт из меню сразу); OS-нотификации вовсе УДАЛЕНЫ — канал
  «поверх всего» один, наше always-on-top окно тостов (2026-09-13). Аудит-раунд
  7 (2026-09-13): дефолт per-server notification-режима — Mentions only (oak:
  All messages) — юзер-решение против спама фоновых серверных тостов, юзер
  включает ALL осознанно; не-mention в ФОКУСНОМ окне не тостит (oak показывает
  тихую карточку на не-открытый канал) — юзер-решение «не дёргать
  сфокусированное окно»; фоновые сессии применяют suppressEveryoneHere к
  красному бейджу (oak в фоне prefs не применяет — ограничение их фона).

**Окно тостов поверх всего (oak NotificationToast, 2026-09-13):** тосты
переехали из DOM главного окна в ОТДЕЛЬНОЕ always-on-top окно (юзер-решение:
OS-нотификации отклонены — в oak окно было воркэраундом мёртвого TrayIcon, у
нас это архитектурный выбор). Main: frameless+transparent+`alwaysOnTop
("screen-saver")`+skipTaskbar+**нефокусируемое**, lazy-create на первом тосте,
`hide()` при пустом стеке, умирает вместе с главным окном; позиция — правый-
нижний угол экрана главного окна; высота подстраивается под стек
(bottom-anchored setBounds по репорту геометрии). **Клик-сквозность**:
`setIgnoreMouseEvents(true, {forward:true})` всегда, экран тостов хит-тестит
mousemove по карточкам/чипу и репортит hover → main флипает интерактивность
(оверлей-паттерн: прозрачные зоны не едят клики окон ниже). Контент — тот же
бандл по маршруту `#toasts` (`ToastStackScreen`: стек+«Hide all»+TTL+трим
maxToasts); клики маршрутизируются ПО id через main в главный renderer (реестр
`cardCallbacks` в NotificationHub — колбэки замыкаются на runtime главного
окна; клик = window.focus() + действие). `showSystem`/OS-Notification путь
УДАЛЁН целиком. ГРАБЛИ (все живые): StrictMode на #toasts-маршруте удваивал
подписку IPC → дубль-карточки (popout-окна тоже без StrictMode; preload'
каналы toast:* делают removeAllListeners перед подпиской — одноканальная
идемпотентность); `empty()` на монтажном прогоне с нулём карточек прятал
freshly-shown окно → первый тост невидим до второго сообщения (теперь empty
только на ПЕРЕХОДЕ к пустому, seenCardsRef); карточки посланные до загрузки
страницы терялись → буфер в main до `space-toast:ready` (showInactive тоже
только после ready); геометрия рапортится как высота+16 (стек на bottom:8px —
голая высота смещала окно вверх и резала чип «Hide all»).

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
- **Pinned messages + discussions/threads (2026-09-22, ДЕПЛОЙ ПАРНЫЙ с oak-server + зеркало
  oak-client; серверная часть — oak-server/CLAUDE.md).** Две фичи, сервер+клиент.
  **(A) ПИНЫ:** юзер-решения — карусель «последний пин + стрелки ‹ › + счётчик i/N» (не
  Discord-список!), кап 50 с 400-ошибкой. `Message` += `pinned/pinnedBy/pinnedAt` (append-only);
  НОВЫЙ `PinnedStore` (Map по каналу, pinnedAt-ASC): снапшот из `GET /messages/pinned` на
  открытии канала (`session.loadPinned`, DM включительно), live-обновления — `.edited`-пуш
  кормит `applyFromMessage` ПРЯМО из подписки (НЕ через messageStore.applyEdited — старые
  пины обычно ВНЕ загруженного окна, applyEdited их молча вернёт false); дедуп «эхо после
  REST-ответа» сравнивает ТОЛЬКО рендерящиеся поля (pinnedBy/pinnedAt/content/fileNames) —
  presigned-URL переподписываются на каждый fetch, байт-сравнение ложно-положительное.
  **PinCard.tsx**: `.pin-card` (now-playing-идиома, margin 4px 16px) МЕЖДУ chat-error и
  NowPlayingBar — первый сиблинг владеет верхним слотом, при стечении пин НАД аудио
  (юзер-спека); клик по телу → `openChannelAtMessage` (готовое ?around=-окно #481);
  карусель — `domain/logic/pinned-view.ts` (defaultPinIndex=count-1, stepPinIndex с
  заворотом, pinSnippet 120 симв. + фолбэк на имя аттача) + тесты. ПКМ Pin/Unpin
  (гейт dm || MANAGE_MESSAGES; 400 от капа → тост). Глиф mdi-pin (icons.css 47 глифов).
  **(B) ОБСУЖДЕНИЯ (НЕ-Discord UI, юзер-спека):** тред = канал DISCUSSION на сервере;
  клиент видит его только через discussion-API. `types.ts` += `Discussion` (11 полей,
  tracked viewer-scoped) + `DiscussionEvent` (CREATED/ACTIVITY/REMOVED на родительском
  `.discussions`-топике). НОВЫЙ `DiscussionsStore`: карты byOrigin/byId + снапшот mine
  (СЫРЬЁ разделяется между видами), события upsert/purge, setTracked оптимистично,
  `version`-счётчик (emit override) — селектор для императивных чтений (сторон —
  синглтон, useStore по самому стору не триггерится); forParent/mineForParent
  производные НА СПРОС (useMemo в компоненте — селектор-идентичность). Чистая логика
  `discussions-view.ts` (groupMineByChannel для бейджей, sortMineByActivity nulls-last,
  tileReplyLabel) + тесты. **Сессия:** `.discussions`-подписка в ensureChannelTopicFamily
  (store.applyEvent + опц. хук `onDiscussionEvent`); НОВОЕ семейство
  `ensureDiscussionTopicFamily(discussionId)` — ОТДЕЛЬНАЯ подписка на топики треда:
  хендлеры пишут ТОЛЬКО в messageStore, `hooks.onLiveMessage` НЕ вызывается
  (структурная защита: непрочитанные треда не бампят бейдж родителя, тосты не летают);
  StompClient НЕ умеет unsubscribe — сет-guard от дублей, подписка живёт до сокета,
  при РЕКОННЕКТЕ сет чистится и накатывается заново (guard иначе скипнул бы re-subscribe —
  грабля поймана до смоука). Методы fetch/start(409 наружу)/track/untrack(оптимистично)/
  close(локальный purge)/openDiscussion(loadHistory); forgetChannel дропает треды канала;
  resyncAfterReconnect: mine-рефетч + ре-подписки + ТИХИЙ tail-хил тредов (mergeTail без
  onLiveMessage). **runtime:** AppState += `activeDiscussion {channelId,discussionId}` +
  `sidebarDiscussions`; сброс в teardown, чистка в setActiveChannel (обе ветки)/openDm/
  toggleHomeMode; `openDiscussion` (parent становится active-каналом — подсветка сайдбара;
  around чистится), `closeDiscussionView`, `closeDiscussionForEveryone` (Close-кнопка);
  хук `onDiscussionEvent`: REMOVED по открытому → кик из вида + тост «Discussion was closed»
  (REMOVED — единственный close-сигнал; bare-Long на channel.{id}.deleted отклонён:
  числовое пространство id сообщений/каналов пересекается). **Sidebar:** малая кнопка
  `mdi-comment-text-outline` (`.sidebar-toggle`) в server-header ДО шеврона
  (stopPropagation — клик по шапке открывает меню сервера; 22px — 37px-инвариант высоты);
  режим обсуждений = плитки `.discussion-tile` (search-hit-идиома: #родитель + автор +
  2 строки сниппета) с крестиком отписки, «No tracked discussions…» пусто-состояние;
  бейдж `.channel-badge.discussions` (глиф+число МОИХ тредов канала) рядом с unread.
  **ChatPane:** при открытом треде чат-поверхность (список/композер/пикер/селекшн) вяжется
  на Channel-адаптер `chatChannel` (id треда; права сервер делегирует родителю —
  композер-гейты родителя валидны as-is); **PinCard скрыт**, вместо него
  `DiscussionOriginPanel` (замороженный снапшот исходника + Назад mdi-arrow-left +
  «Отслеживать/Отписаться от обсуждения» + Close (гейт MANAGE_MESSAGES, для всех));
  тайл `.message-discussion-tile` (глиф + «Discussion · N replies») под reactions-row
  через `discussion`-проп MessageRow (стабильная разделяемая строка — memo-ряд
  перерисуется на флипе); оценка высоты строки += флаг тайла (+24), источник — useMemo
  по version стора (СЕЛЕКТОР-ИДЕНТИЧНОСТЬ: производное в селекторе = infinite rerender).
  ПКМ: «Start a discussion» (гейт sendMessages, не DM, не внутри треда) / «Open
  discussion» если есть; 409 → fetchChannelDiscussions + открыть существующий (гонка).
  REST += 7 методов; icons.css 47 глифов (mdi-pin, mdi-comment-text-outline, mdi-arrow-left).
  Гейты: клиент 383/383 + typecheck + build; сервер 313/313; oak-client 247/247 (зеркало).
  **Смоук-фиксы 1 (2026-09-22, три юзер-репорта):** (1) **второй клиент не видел чужие новые
  треды до собственного Start** — CREATED/ACTIVITY несли counts-only, а стор игнорировал
  события без локальной строки; теперь `DiscussionEvent` несёт ПОЛНУЮ строку обсуждения
  (+`actorUsername`; REMOVED — null-строка), стор апсертит её напрямую (tracked локальной
  строки ПОБЕЖДАЕТ broadcast-false — трекинг viewer-scoped); плитка/пункт «Open discussion»
  появляются у пира из одного пуша. (2) **mentions в тредах не приходили** — само семейство
  подписок треда не звало onLiveMessage (by design); добавлен хук `onDiscussionLiveMessage`:
  runtime гоняет handleMessage с serverMode-полом MENTIONS (даже при ALL — трекнутый тред
  НЕ тостит на каждое сообщение, только mention-путь; decider даёт non-mention → none),
  заголовок тоста `#канал · discussion`, клик → openDiscussion; свой пост и открытый тред
  гасят пинг. (3) **тред на чужом сообщении = mention автору исходника при первом ответе**
  — сервер авто-джойнит автора исходника участником при create (тред сразу в его /mine,
  интеграционный тест), а runtime-хук onDiscussionEvent на ACTIVITY с replyCount==1 и
  originAuthorId==self шлёт mention-тост+bell (кроме случая своего первого ответа/открытого
  треда) и локально setTracked; отправитель своего поста тоже локально setTracked после
  send (сервер уже авто-джойнит — зеркало без рефетча mine). Гейты: сервер 314/314, клиент
  384/384 + typecheck + build. Смоук продолжается. **Смоук-итерация 2 (юзер-решения):**
  (а) Follow/Unfollow/Close в панели обсуждения — ГЛИФЫ (юзер выбрал «глаз+крест»):
  mdi-eye-plus-outline / mdi-eye-off-outline / mdi-close, tooltip англ. «Follow discussion»
  / «Unfollow discussion» / «Close discussion for everyone» (UI только англ. — русские
  надписи кнопок были моим отступлением); Close-hover красный (danger-идиома).
  (б) Переключатель каналы↔обсуждения ПЕРЕЕХАЛ: кнопка в шапке сервера УДАЛЕНА; заголовок
  секции «Channels» кликабелен как название сервера (hover — text-only brighten,
  `.sidebar-section-link`) и открывает выпадайку с единственным пунктом «Discussions»
  (в режиме обсуждений — заголовок «Discussions» → пункт «Channels»); бейдж
  `.channel-badge.discussions` на строке канала КЛИКАБЕЛЕН — клик (stopPropagation, канал
  не открывается) переключает колонку в обсуждения; runtime: toggleSidebarDiscussionsMode →
  `setSidebarDiscussions(boolean)`. icons.css 49 глифов (+eye-plus/off). Гейты: 384/384 +
  typecheck + build. **Смоук-итерация 3 (юзер-решения):** (1) **упоминание в треде
  подписывает и пингует упомянутого**: сервер в publishActivityCreated парсит USER-упоминания
  и авто-джойнит их участниками (интеграционный тест); ACTIVITY-событие теперь несёт ПОЛНОЕ
  сообщение (MessageResponse) — клиенты, не подписанные на топик треда, гоняют по нему ту же
  формулу упоминания (mentionsIdentity: @user/@held-role/unsuppressed-@everyone) →
  setTracked + тост+bell; гейты: свой пост/открытый тред гасят, автор-исходника-на-первом-
  ответе пингует РАНЬШЕ и один раз (без дубля тостов); фоновой инстанс тостит с тегом
  сервера, клик = `openDiscussionOnInstance` (НОВЫЙ pendingOpenDiscussion в AppState +
  потребление в consumePendingOpen). Декаплинг: MessageService больше НЕ зависит от
  DiscussionService — хук переехал в Spring-событие `MessagePostedInDiscussion`
  (@EventListener), иначе цикл бинов (DiscussionService → MessageService для ленивого
  создания). (2) **Ленивое создание (юзер-правило)**: «Start discussion» НЕ создаёт ничего
  на сервере — открывается ЛОКАЛЬНЫЙ черновик (`activeDiscussion.discussionId === null` +
  originMessageId; панель исходника рендерится из списка родителя с тегом «draft», вместо
  MessageList — подсказка); первое сообщение уходит одним вызовом `startDiscussionWithMessage`
  (REST create несёт content/attachments/idempotencyKey) — сервер создаёт тред ВМЕСТЕ с
  сообщением (replyCount=1), а КОНФЛИКТ переиспользует чужой тред (200, сообщение не
  теряется; голый messageId сохранил 409 для API-поверхности). Клиентский 409-путь убран
  полностью. (3) **Confirm-модал на закрытие** («Close discussion? …permanently removes its
  messages», Cancel/Close) — глиф Close открывает модал, не бьёт сразу. Гейты: сервер
  318/318 (+4: lazy-create, conflict-reuse, mention-subscribe, юниты), клиент 384/384 +
  typecheck + build. Серверный рестарт нужен (код), миграций нет.

- **Offline-старт: аватарки из кэша + boot-лестница автореконнекта (2026-09-23,
  юзер-репорт «сервер не запущен при старте клиента»).** Два корня у одного симптома.
  (1) **Фоллбеки аватарок серверов при оффлайне**: диск-кэш картинок ЖИВЁТ в
  main-процессе (window.spaceMedia, общий для всех сессий), но `useAttachmentImage`
  при `session === null` (авто-резюм упал → сессии нет вообще) даже не пытался
  читать — рейл рисовал инициалы. Фикс: НОВЫЙ синглтон `dormantAttachmentCache()`
  (`media/attachment-cache.ts`, `rest: () => null`) — disk-only читалка без сессии;
  хук при null-сессии падает на него (url=null → disk-hit или тишина, НИКОГДА не
  сеть). Бюджет дорзанного инстанса дефолтный НАМЕРЕННО: он не пишет, видит только
  то, что дисциплина живых сессий (purge при 0 МБ) оставила на диске. (2) **Нет
  автоконнекта при подъёме сервера**: bootstrapApp → openSession падал на REST-фазе
  → teardownSession → ВСЁ, ретраев нет (лестница StompClient стартует только после
  успешного старта; первый connect-failure вообще не занимается рекконектом).
  Фикс: **boot-лестница** в runtime — сетевой провал авто-резюма (токены живы!)
  вооружает `retryBootResume`: повторяет openSession через 2с → 2/4/8/16 → каждые 30с
  БЕЗТЕРМИНАЛЬНО (у пустого экрана нет ↻, а «сервер ещё не подняли» может длиться
  сколь угодно); останавливается юзер-действием (сессия появилась/рекорд удалён)
  или смертью токен-семьи (логин-модал уже открыт). `bootResumeRecordId` также
  ИСКЛЮЧАЕТ запись из startBackgroundSessions — фоновый старт той же записи мог
  быть PROMOTED наполовину-стартованным (гонка promote-пути openSession).
  EmptyMainScreen при stompState=connecting (единственный источник без сессии —
  эта лестница) пишет «Connecting to <имя>…» вместо «No server connected…».
  Бонус того же корня: упавший старт ФОНОВОЙ сессии больше не смертелен — тихий
  revival-проход каждые 30с (`scheduleBackgroundRevival`, каденс как у фонового
  onStompExhausted-рестарта). Тесты: НОВЫЙ `test/attachment-cache.test.ts` (4:
  disk-hit при url=null, miss → null без сети, memory-only скипает диск,
  синглтон-идентичность; node-stub window.spaceMedia, Node 24 имеет
  URL.createObjectURL). Гейты: 388/388 + typecheck + build.

- **Settling-лестница прыжков к сообщению (2026-09-23, юзер-репорт: первый клик по
  пину после холодного старта уводит в «непонятное место», второй — попадает).**
  Корень: первый скролл считается по ОЦЕНКАМ высот (окно ?around= только что заменило
  список — ни одна строка не измерена), реальные высоты (переносы текста, поздние
  декоды картинок) сдвигают контент ПОД вьюпортом уже после; reconcile-цикл
  tanStack-virtual останавливается после ОДНОГО стабильного кадра — поздний дрейф
  никто не корректирует. Второй клик точен, потому что itemSizeCache ключуется по
  key строки и переживает замену списка + картинки уже в кэше. Фикс: НОВАЯ
  `scheduleSettlingJump(listRef, key, onAttempt?)` в ChatPane — переподтверждение
  центрированного скролла с затуханием [0, 120, 360, 840, 1800, 3000] мс (каждый
  аттамп перечитывает СВЕЖИЕ измерения → сходится к цели даже при поздних ресайзах);
  ЛЮБОЙ ввод пользователя (wheel/pointerdown/keydown, capture, once) отменяет лестницу
  — она не дерётся с читателем; ключ исчез из списка (сменён канал) — самозакрытие.
  Один реф `settlingJumpCancelRef` на MessageList: новый прыжок гасит предыдущую
  лестницу; unmount — финальный cancel. Заменены ВСЕ ТРИ сайта прыжка (around-окно
  пинов/поиска, back-filled jump, jumpTo по цитате) — старая лестница 4×30 мс; подсветка
  цели перезапускается на каждом аттампе (строка может войти во вьюпорт только на
  позднем). Первый-layout скролл на unread-делитель остался на старых таймерах
  (не репортился; тот же класс дрейфа — если всплывёт, обернуть той же лестницей).
  Гейты: 388/388 + typecheck + build.

- **Серверное меню: ПКМ на аватарке в рейле возвращён (2026-09-24, юзер-просьба —
  «сохранить и текущую реализацию, и добавить старую»).** Меню поднято из локального
  стата Sidebar в appStore: `serverMenu {recordId,x,y} | null` + `openServerMenu/
  closeServerMenu`. НОВЫЙ `ServerMenu.tsx` (монтируется в App рядом с LoginModal —
  работает и без живой сессии) рендерит dropdown + ReloginModal + delete-confirm
  (переехали из Sidebar дословно). ДВА триггера: клик по шапке сервера в Sidebar
  (якорь под шапкой, активная запись) и ПКМ по `.rail-wrap` в рейле (курсор, ЛЮБАЯ
  запись). Состав per-record: Re-login / Delete (любая) — и настройки: Server Settings
  (гейт `canManageServerSettingsOfRecord` — маска САМОЙ записи: активная сессия или её
  живая фоновая; без живой сессии пункт скрыт — свитч всё равно уйдёт в логин-модал) /
  Account settings (безгейтовый). На НЕактивной записи оба пункта настроек СНАЧАЛА
  переключают на неё, потом открывают (юзер-просьба 2026-09-24):
  `switchAndOpenServerSettings/switchAndOpenAccountSettings` — switchConnection глотает
  свои ошибки (логин-модал уже открыт), поэтому настройки открываются ТОЛЬКО если свитч
  приземлился (`activeSession.recordId === recordId`) — иначе упавший свитч открыл бы
  настройки ПРЕДЫДУЩЕГО сервера против мёртвой binding. Sidebar постройчал:
  serverMenuItems/reloginTarget/deleteServerTarget/ReloginModal удалены, импорты
  почищены. ContextMenu закрывается ДО action — модалки рендерятся ВНЕ menu-null-гейта.
  Гейты: 388/388 + typecheck + build.

- **Микро-фикс: треугольник Play в круге аудио-плитки смещён вниз-вправо (2026-09-24).**
  `.audio-play` не переопределял глобальный `button { padding: 8px 14px }` — контент-бокс
  сжимался до 8px, глиф переливался ВПРАВО за него + висел на базовой линии (вниз).
  Фикс: flex-центрирование как у `.icon-button` (inline-flex + center + padding:0) и
  оптический нудж `margin-left: -1px` только для mdi-play (чернильный центр треугольника
  в 24-сетке — 13.5 против 12 у бокса; пауза симметрична — без нуджа).
  Гейты: 388/388 + typecheck + build.

- **Server Settings → Members: кнопка снятия роли со строки роли (2026-09-24,
  юзер-просьба: mdi-close у правого края каждой строки).** Гейт-зеркало серверного
  assignRoles: MANAGE_MEMBERS + иерархия над целью (canActOn, как у rename) + топ-роль
  актора СТРОГО выше снимаемой (формула canAssignRole; OWNer-строка кнопки не имеет —
  OWNER не в roleIds, у неё свой ряд). Действие = full-replacement PUT минус одна роль
  (паттерн RoleMembers.setHolding), пуш /topic/members перерисовывает панель, ошибка —
  window.alert (идиома панели). CSS `.member-role-remove` (margin-left:auto, компактный
  паддинг, hover красный). Подсказка над списком упрощена до «Roles» (роли теперь
  управляются и здесь, не только в Roles → Members). @everyone в roleIds НЕ входит
  (маска резолвится имплицитно) — все строки списка = явные кастомные роли.
  Заодно: класс строки `.friend-row` переименован в НЕЙТРАЛЬНЫЙ `.list-row` (8 мест:
  CSS ×2, FriendsPane, ServerSettingsPane ×5 — класс родился во friends-панели и
  годами реюзился в сеттингс; `.add-friend-row` не тронут — он действительно друзья).
  Гейты: 388/388 + typecheck + build.

- **Сага про DM-лист Home (2026-09-24, юзер-репорты каскадом; серверная половина —
  oak-server/CLAUDE.md).** Четыре корневых бага, найденных каскадом через временную
  [layout]-диагностику (DOM-дампы сайдбара в space.log — добавлена, довела до
  диагноза, СНЯТА перед коммитом). (1) **Протухшие dm-row над каналом/над заголовком
  DM**: после promote записи её live-binding/запись в socialDirectory не убирались →
  АКТИВНАЯ запись присутствовала в background-снапшотах → mergeDmRows сливал её DM
  дважды → дубли ключей `recordId:dmId` → React терял владение узлами. Фикс-инвариант
  (openSession, обе ветки): `unbindLiveBackgroundSession(promoted)` +
  `socialDirectory.drop(promoted)`; demoted-сессия наоборот ПРИВЯЗЫВАЕТСЯ
  (`bindLiveBackgroundSession`, гвард от двойной подписки). Ремни: DmSidebar/FriendsPane
  фильтруют свою запись из background ДО слияния (вне селектора — идентичность!).
  (2) **Пульсация длины списка при переключении**: bind/unbind уходили в 1-секундный
  coalesced rebuild → строки демоут-записи пропадали на секунду. Фикс: bind/unbind
  rebuild СРАЗУ (структурное изменение), коалесирование — только для дельт сторов.
  (3) **«4 разговора с admin23»**: сервер отдал в `/api/channels/dm` DISCUSSION-каналы
  (трекинг = те же channel_participants) — клиент, не найдя пира, рисовал СВОЙ ник.
  Фикс на сервере (тип-гейт), клиент не менялся. (4) **Перетасовка порядка строк**:
  сортировка по lastMessageAt оставляла равных в порядке ВХОДА (зависит от того,
  какая запись активна). Фикс: полная детерминированная лестница в mergeDmRows —
  свежесть → имя (dmDisplayName) → сервер → recordId → dm.id; mergeFriendRows —
  username → recordId → userId. Тест: зеркальные композиции дают одинаковый порядок.
  (5) **Моргание фоллбеков аватарок при переключении**: путь загрузки зависел от
  активности строки (фоновая = presigned `<img>`, активная = кэш сессии) — promote
  менял путь, у нового кэша память пустая → кадры инициалов. Фикс: все аватарки
  агрегированных списков (DmSidebar/FriendsPane) через ОДИН дорзанный кэш
  (`session={null}`, override несёт key+url; disk → fetch url → objectURL, LRU 128 —
  конструктор-параметр memoryCap); uncached-`<img>` остался страховкой пока кэш
  резолвится (Avatar: `cachedUrl ?? uncachedUrl`). Гейты: клиент 389/389 + typecheck
  + build; сервер 319/319. Диагностика снята.

- **Ресайз окна: белое моргание + прыжки чата (2026-09-24, юзер-репорт).** Два корня.
  (1) **Белые вспышки**: `html`-канва по умолчанию БЕЛАЯ — body (100vh) на кадр
  отстаёт от нового размера окна, оголённая полоса красилась белым (backgroundColor
  BrowserWindow уже стоял, body уже тёмный — а уровень html никто не красил). Фикс:
  `html { background: var(--sp-darkest) }` + сброс для прозрачного toast-оверлея
  (`html:has(.toast-stack)` в один гвард с body). (2) **«Чат открывается в рандомных
  местах»**: смена ШИРИНЫ перепаковывает текст в каждой строке → весь кэш измерений
  протух, но переразмериваются сами только ОТРЕНДЕРЕННЫЕ строки (вне окна — старые
  высоты) → офсеты фикция, вьюпорт улетал; плюс браузерный clamp scrollTop на
  просадке totalSize. Фикс в VirtualList: ResizeObserver на контейнер; на смене
  ширины (порог 1px, высотные ресайзы игнорируются) — `virtualizer.measure()` (полная
  очистка кэша высот) + ЯКОРЬ на первый видимый ряд через `scrollToIndex(idx, start)`:
  встроенный reconcile-цикл tanStack ведёт якорь сквозь каскад переразмеров и сам
  останавливается по стабилизации; drag-ресайз просто перевзводит якорь. Гейты:
  389/389 + typecheck + build.

- **Ресайз-раунд — ВЕРДИКТ (2026-09-24, каскад юзер-репортов; диагностика [resize]/[gpu]/[win]
  добавлялась, довела до истины, СНЯТА; для бисекта писался одноразовый resize-probe).**
  (1) **Прыжки чата при ресайзе — ФИКС, но не тот, что планировался**: лог показал, что
  scrollTop коллапсировал (9748→4804→3002) от МОЕГО measure-по-затуханию + scrollToIndex-якоря —
  офсет считался по ОЦЕНКАМ высот (вдвое меньше реальных на чатах с картинками). Вся ручная
  машинерия ширины УДАЛЕНА: переразмер строк + компенсацию скролла tanStack делает сам
  (per-row ResizeObserver + applyScrollAdjustment) — после удаления скролл стал плавче
  исходного; в VirtualList оставлен NOTE-предостережение против повторения. (2) **Моргание
  окна — КОРЕНЬ НАЙДЕН, ФИКС = will-resize-гвард**: во время живого драга РЕАЛЬНЫЕ границы
  окна ([win]-лог из main) флипали `1257×659 → 44×132 → 1256×659 → …` на КАЖДОМ тике —
  окно программно схлопывалось в ~44px-полоску (высота трекала реальную; юзер видел её как
  «прямоугольник слева», контент улетал). Схлопывание НЕ проходит через JS-API Electron
  (прототип-ловушка setBounds/setSize/resize/setContentSize со стеком — ноль срабатываний) —
  оно нативное; `will-resize` — единственная точка перехвата. Гвард: ширина <300 при текущей
  >500 за один шаг = preventDefault (настоящий драг идёт лесенкой тиков и никогда не
  прыгает так; пошаговое сжатие юзером проходит свободно). (3) **Белое моргание — ФИКС**:
  `nativeTheme.themeSource = "dark"` (DWM immersive-dark: оголённое перестало краситься
  белым светлой темы Windows) + ремни `html{background}` (канва html белая; гвард
  toast-оверлея) и `hookWindowMessage(0x14)`. МЕТОДИКА (сработала): голое окно-пробник с
  тумблерами → страница+preload → картинки → свежий профиль → [win]-лог границ → гвард-щит
  → прототип-ловушка. Исключены попутно: GPU (работает; ГРАБЛЯ: `getGPUFeatureStatus()` при
  ready врёт «всё software» до асинхронного init GPU-процесса — перечитывать отложенно),
  композитор/флаги (`--disable-direct-composition` и `CalculateNativeWinOcclusion` отвергнуты:
  первый МЕНЯЛ артефакт на полосу-заморозку), картинки/тексты (longtask ноль), тост-оверлей,
  протокол/хоткеи (жили до логина, чистого). НЕНАЙДЕННЫЙ ИСТОЧНИК нативного коллапса — в
  очередь #470 (кандидат: koffi-нативщики в main-процессе; вскрытие = WinAPI-сабклассинг);
  до тех пор гвард держит. Гейты: 389/389 + typecheck + build.

- **Медиа-раунд: скролл не зависит от вложений (2026-09-25, юзер-репорт «фриз на видео без
  превью в чате 111, страх сетевой задержки в проде»; серверная половина — oak-server/CLAUDE.md;
  ДЕПЛОЙ ПАРНЫЙ сервер↔клиент, oak-client НЕ поддерживается — зеркало НЕ обновляется).**
  Четыре фазы. **(A) Негативный кэш AttachmentCache**: виртуальный список перемонтирует строки
  на каждом проходе скролла — мёртвый объект (404) прежде прогонял всю цепочку
  диск→fetch→mint→fetch на КАЖДЫЙ проход (тот самый фриз). Теперь: 404, верифицированный по
  СВЕЖЕМУ mint'у (первый 404 → перевыпуск ссылки → повтор; 404 без mint-возможности — тоже
  приговор) → ключ мёртв до конца сессии (стабильный фолбек, ноль трафика); transient-сбои
  (сеть/5xx) → backoff 30с, НЕ навсегда (оффлайн-минута не должна отравлять кэш); успех
  реабилитирует. Ошибки — в файловый лог `[media]` (раньше только в консоли — в space.log их
  не было видно). Тесты: 404-два-fetch-и-тишина / no-mint-вариант / backoff-окно с fake timers.
  **(B) Точный резерв через wire-размеры** (ПАРНЫЙ wire: `AttachmentRef/Response` += width/height,
  сервер passthrough): аплоадер измеряет — видео тем же декодом, что генерит превью (фулл-размер
  кадра, НЕ капнутого превью), картинки через `createImageBitmap`; оба upload-сайта (send + ленивый
  тред) + кросс-инстанс форвард несут размеры (байты те же — размеры валидны). Рендер: одиночная
  картинка строит ПЕРВЫЙ бокс из wire-размеров (не квадрат-заглушка), видеокарта держит
  зарезервированный бокс `.video-thumb-loading` пока превью в полёте (16:9-плитка — только когда
  аспект неизвестен), `estimateRowHeight` считает по реальному аспекту (видео через
  `reservedVideoThumbBox(480,320)` + 24; одиночная картинка через `singleTileBox`). ЛЕГАСИ-строки
  (без wire-размеров): доучивающийся кэш `renderer/media-dims.ts` (localStorage, ключ→[w,h], кап
  2000, insertion-trim) — первый декод картинки/превью записывает (превью разделяет аспект кадра),
  следующий рендер резервирует точно. Мозаика 2+ картинок остаётся count-based (квадратные кропы —
  аспект не участвует). **(C) Idle-префетч** `session.scheduleMediaPrefetch(channelId)` (запускается
  из ChatPane после loadHistory): requestIdleCallback → очередь превью-then-картинки из загруженных
  сообщений канала, параллелизм 2, peek-скип закэшированного, негативный кэш сам глушит мёртвые,
  свежий вызов отменяет предыдущий sweep. **(D)** Доки/гейты. Тесты: `media-dims.test.ts` (6:
  reservedVideoThumbBox ландшафт/вертикаль/маленький/16:9-фолбэк + кэш remember/recall/round-trip).
  Гейты: клиент 398/398 + typecheck + build; сервер 320/320. Смоук: старый чат с тяжёлыми
  аттачами — скролл плавный без фризов на мёртвых превью ([media]-строки в логе), новые аттачи
  не прыгают по высоте при загрузке, вертикальные видео сразу узкие.

  **Медиа-раунд, итерация 2 (2026-09-25, смоук-репорт: «по-прежнему фризит» + «при
  выключенном дисковом кеше аватарки серверов не грузятся до смены сервера»).** (1)
  **ГЛАВНЫЙ КОРЕНЬ ФРИЗОВ — СИНХРОННЫЙ FS В MAIN-ПРОЦЕССЕ**: весь disk-кеш
  (space-cache:put/get/trim) стоял на writeFileSync/readFileSync/readdirSync+statSync,
  и trim гонялся ПОСЛЕ КАЖДОЙ записи (полный обход кеш-директории со stat'ами);
  IPC-хендлеры живут на main thread → скролл по кешированному чату ставил в очередь
  десятки синхронных чтений, а idle-префетч (фаза C) ещё и штормил тримами — рендерер
  простаивал в ожидании IPC-ответов и ронял кадры (в space.log это выглядело «чисто»:
  longtask в рендерере НЕТ — затор в main). Фикс: put/get/trim → fs.promises (get:
  readFile + best-effort utimes; trim: async readdir/stat/unlink), trim после put →
  ДЕБАУНС 30с в рендерере (`scheduleTrim` в AttachmentCache; setDiskBudget остался
  немедленным — purge при 0); лог main тоже переведён на ordered-async appendFile
  (цепочка промисов, порядок сохранён). (2) **Аватарки серверов при cache Off**:
  неактивная запись рейла грузилась через кеш АКТИВНОЙ сессии с url=null → при disk-miss
  (а с Off — всегда) doLoad даже не пытался mint'нуть → transient-backoff → инициалы
  до ручного свитча. Фикс двумя половинами: (а) `AttachmentCache.doLoad` при url===null
  СНАЧАЛА пробует mintFreshLink (dormant без rest — как раньше, backoff); (б) ServerRail
  резолвит для КАЖДОЙ записи ЕЁ СОБСТВЕННУЮ сессию — НОВЫЙ `sessionsIndex` Emitter в
  runtime (version-bump на sessionMap set/delete/switch) + `sessionForRecord(recordId)`
  (активная → фоновая → null); RailRow через `useRecordSession` — аватарка мintится и
  качается через СВОЙ rest (чужой инстанс-ключи не вытянет активная сессия), запись
  без живой сессии падает на dormant disk-only как при оффлайн-старте. (3)
  **Диагностика фризов** (до итерации было: [perf]-лог видит только main-thread
  рендерера): frame-stall зонд в renderer/main.tsx — rAF-цикл, 2+ подряд кадра ≥34мс
  открывают серию, нормальный кадр закрывает: `[perf] frame-stall <total>ms over N
  frames (longest Kms)` — видит и композиторные/растеризационные дропы (декод
  картинок), невидимые longtask; gap ≥1с игнорируется (окно было скрыто, rAF
  throttled). Плюс `[media] activity: N disk hits, N disk misses, N fetches (KB,
  worst ms), N dead-skips, N backoff-skips` — 5-секундные окна реальной работы
  кеша (корреляция фрейм-столлов с диском/сетью). (4) **rememberDims дебаунс 500мс**:
  каждый первый декод картинки стрингифил ВЕСЬ кэш (до 2000 записей) в localStorage
  синхронно — теперь одна запись на пачку декодов. Тесты: mint-при-null-url
  (memory-only + fetch по свежей ссылке), round-trip под дебаунсом (fake timers;
  ГРАБЛЯ: предыдущий тест оставлял РЕАЛЬНЫЙ таймер — advanceTimers его не видит,
  тест обязан начинать с vi.resetModules). Гейты: 399/399 + typecheck + build.

  **Медиа-раунд, итерация 3 (2026-09-25, смоук-репорт: «чат плавнее ✓, аватарки
  серверов НЕ грузятся вообще, даже при переключении»).** Два корня. (1) **Серверный
  `/api/attachments/link` валидирует attachmentExists — только MESSAGE-аттачи**;
  ключи `server-avatars/…` mint'ом НЕ достаются (всегда 404). Итерация-2 mint-ветка
  при url=null была для них обречена: mint-null → markBackoff(30с); плюс финальный
  markBackoff фазы-A глушил и простые url=null-попытки. Цепочка смерти: ранний рендер
  (profile ещё null → url=null) → backoff → профиль приезжает (directory.update
  РЕ-РЕНДЕРИТ рейл, url становится живым) → doLoad молчит в backoff → триггеров
  больше нет → инициалы НАВСЕГДА (переключение сервера не помогало: url у строки уже
  не менялся — эффект не перезапускался). Фикс: **url=null → тихий return null БЕЗ
  mint и БЕЗ backoff** (disk-only строка; URL приедет с профилем); mint внутри цикла
  живёт только для message-аттачей (404-детект мёртвых превью, фаза A). Тест
  «null-URL row NEVER mints» закрепил семантику. (2) **Префетч качал БЕЗ капа**:
  activity-лог показал 164 fetches / 221 МБ за одно 5-секундное окно (канал 111 —
  сотни полноразмерных оригиналов; это и была «прогрузка с фризами» даже при
  выключенном кеше); теперь MEDIA_PREFETCH_MAX_ITEMS=24, очередь НОВЕЙШИЕ-ПЕРВЫМИ
  (читатель стартует снизу). Старт-чек: transient-шум исчез, аватарка докачалась
  fetch'ем по живому URL (157KB), longtask при старте нет. Гейты: 399/399 +
  typecheck + build.

- **Попап шара приведён к общему стилю окна (2026-09-25, юзер-репорт «Open in window
  не в стиле приложения»).** Главное окно — borderless с фирменной шапкой CaptionBar
  (32px #1e1f22, SPACE, кнопки 46×32, close-hover красный), а попап шара выезжал с
  НАТИВНОЙ системной рамкой. Теперь: попап `frame: false` + рендерит ТОТ ЖЕ CaptionBar
  (с subtitle «Screen share» — проп, .caption-subtitle dim); IPC window-контролов
  (space-window:minimize/maximize/close) резолвят окно по SENDER'у
  (BrowserWindow.fromWebContents(event.sender)) — раньше хардкод mainWindowRef, кнопки
  попапа закрывали бы главное; maximize/unmaximize-события теперь летят и в webContents
  попапа (глиф restore flip работает); попапу зеркальны защиты главного окна:
  hookWindowMessage(0x14) (белые вспышки при ресайзе) и will-resize sliver-гвард;
  minWidth 420 / minHeight 300; лэйаут .popout-frame (caption + flex-тело .popout-root
  с чёрным видео). Гейты: 399/399 + typecheck + build.

- **Попап шара: громкость + fullscreen (2026-09-25, юзер-просьба).** (1) **Громкость —
  ПУЛЬТ к плейауту главного окна** (попап подписан video-only, «один звучащий стрим» —
  дубль аудио невозможен по архитектуре): PopoutTarget += shareUsername (feed.display =
  username паблишера) / shareAudio / shareVolume (persistedGain share на момент
  ретаргета; volume НЕ является dep fingerprint-детектора ретаргет-эффекта — смены
  громкости не перезапускают подписку попапа); НОВАЯ чистая `feedHasShareAudio(feed)`
  в classifier.ts (enabled audio ≥2 = voice+share по инварианту classifyFeed;
  видео-only шар → false → слайдер DISABLED, глиф mdi-volume-off, тултип «This share
  has no audio» — юзер-выбор «показывать но дизейблить»); цепочка: слайдер → IPC
  space-window:popoutVolume → main (кламп 0..1, типы) → `popout:volume` в главное
  окно → installPopoutVolumeListener (bootstrap, рядом с sourceDead) →
  `setShareVolume(username, gain)` — ТОТ ЖЕ путь, что слайдер ростера: живая цепь +
  персист в запись (цепи нет → персист применится при следующем attach). (2)
  **Fullscreen**: кнопка в тулбаре (IPC space-window:toggleFullscreen, sender-based
  setFullScreen), enter/leave-full-screen → `space-window:fullscreen` в webContents
  попапа (глиф fullscreen↔fullscreen-exit); Esc в fullscreen — выход (keydown;
  Chromium не выходит сам из программного setFullScreen). Тулбар — пилюля
  лайтбокс-идиомы rgba(128,128,128,.45) внизу-справа видео-области (.popout-root
  position:relative), иконка динамика + range 0..1 + кнопка. icons.css 51 глиф
  (+fullscreen/-exit). Гейты: 399/399 + typecheck + build.

- **Попап шара, раунд 2: ре-открытие + ховер-тулбар + зеркало voice-panel + живой
  синк громкости (2026-09-25, три юзер-репорта).** (1) **Баг «закрыл крестиком →
  Waiting for video»**: fingerprint-детектор ретаргет-эффекта НЕ сбрасывался при
  закрытии попапа, а main ещё и дропал сохранённый target → повторное открытие ТОГО ЖЕ
  фида не перепушивало ничего (fingerprint совпал). Фикс: onClosed-обработчик сбрасывает
  `popoutTargetFingerprintRef` (ref переименован) — ретаргет уезжает заново. (2)
  **Тулбар по ховеру**: opacity 0 + pointer-events none → показ при .popout-root:hover
  (и :focus-within). (3) **Зеркало voice-panel в попапе**: слева от слайдера
  mute/deafen/NS (те же глифы и on-семантика панели: mute/deafen КРАСНЫЙ фон, NS
  ЗЕЛЁНЫЙ при живом движке); состояние едет каналом `popout:voiceState`
  {muted: UNION self+mod (как панель), deafened, nsEngine} — пушится из runtime при
  КАЖДОМ изменении (onOwnVoiceControlState — echo сервера, и settingsStore.subscribe
  для NS-движка) + начальный invoke (main хранит последний); клики обратно
  `popout:voiceAction` (toggle-mute/toggle-deafen = runtime toggleSelfMute/Deafen — тот
  же путь что хоткеи; ns-engine = settingsStore.apply с валидацией каталога); NS-кнопка
  открывает ТО ЖЕ NsEngineMenu (проп-овый компонент из VoiceRoom, fixed-координаты).
  Camera/share/leave в попап СОЗНАТЕЛЬНО не зеркалились (сессий-управление из
  попапа просмотра не нужно). (4) **Живой синк громкости в обе стороны**: НОВАЯ стора
  `volumeChanges` (runtime, Emitter {kind, username, gain, nonce}) — setVoiceVolume/
  setShareVolume публикуют; ОТКРЫТАЯ карточка роста (VoiceMemberCard → VolumeRow
  += remoteGain-проп с useEffect) двигает слайдер при изменении ИЗ ПОПАПА; обратно
  `popout:volumeSync` (setShareVolume → push в попап) обновляет слайдер попапа при
  изменении в главном, с GRACE-окном 400мс (эхо собственного драга не должно драться
  с ползунком; username-фильтр через ref, не замыкание). Слайдер попапа 0..2 (как
  карточка — гейны до 200%). Гейты: 399/399 + typecheck + build.

- **Попап шара, раунд 3 — показ тулбара (2026-09-25, два юзер-репорта: «появляется
  при наведении на окно, а не на плашку» + «hover умирает после выхода из
  fullscreen»).** CSS `:hover` УБРАН полностью: reveal ведёт POINTER-ТЕСТ по
  прямоугольнику самой плашки (window pointermove → getBoundingClientRect →
  inside → класс .visible; скрытая плашка pointer-events:none, показанная auto).
  Причины: (а) юзер хочет появление строго при наведении на ПЛАШКУ, не на всё
  окно; (б) ГРАБЛЯ CHROMIUM: hover-состояние ЗАЛИПАЕТ после leave-fullscreen —
  селектор .popout-root:hover переставал срабатывать вовсе, pointermove живёт
  всегда. Держатели видимости: курсор внутри плашки ИЛИ фокус на её контроле
  (слайдер с клавиатуры) ИЛИ открыто NS-меню (курсор уходит в fixed-карточку над
  плашкой; nsMenuAt в deps эффекта — подписка перезаводится при открытии/закрытии).
  **Итерация 2 (юзер-репорт «в fullscreen и после выхода панель перестаёт
  СКРЫВАТЬСЯ»): при развороте/выходе окно меняет размеры — плашка у corner-anchor
  ПЕРЕПРЫГИВАЕТ, курсор неподвижен, pointermove не стреляет → видимость никто не
  пересчитывает. Фикс: onFullscreenChange и window-resize ГАСЯТ плашку (следующее
  движение курсора проявит её снова, если накрывает).** **Итерация 3 (юзер-репорт
  «в fullscreen hover не работает вообще; после выхода показывается и не
  скрывается»): focus-держатель toolbar.contains(activeElement) был источником
  залипания — клик по кнопке плашки оставлял фокус в ней, и ЛЮБОЙ pointermove
  держал visible навсегда; в fullscreen юзер нащупывал плашку по оконным
  координатам, а она сместилась на высоту шапки. Финальная семантика
  (видеоплеерная): ОКОННЫЙ режим — показ при курсоре в прямоугольнике плашки
  ±24px хит-зона, скрытие по уходу курсора; FULLSCREEN — ЛЮБОЕ движение курсора
  показывает плашку, автоскрытие через 2.5с бездействия (таймер перевзводится
  каждым pointermove); focus-держатель УДАЛЁН, единственный не-курсорный держатель —
  открытое NS-меню; fullscreen-флип и resize по-прежнему гасят (якорь
  перепрыгивает под неподвижным курсором).** **Итерация 4 (юзер-репорты: «плашку
  по центру снизу», «в оконном режиме курсор УШЁЛ ИЗ ОКНА с плашки — плашка не
  гаснет», «в fullscreen курсор не прячется при бездействии»): плашка
  left:50%+translateX(-50%) по центру низа; document mouseleave (стреляет при
  уходе курсора ИЗ ОКНА — pointermove там больше не приходит, последний тест
  говорил inside) гасит плашку (держатель — только открытое NS-меню); скрытие
  КУРСОРА в fullscreen синхронизировано с плашкой — класс .hide-cursor
  (cursor:none) на .popout-root когда fullscreen && !toolbarVisible: бездействие
  уводит и плашку, и курсор; движение возвращает обоих.** Гейты: 399/399 +
  typecheck + build.

- **Graceful close: выход из голоса/звонка при закрытии клиента (2026-09-25,
  юзер-репорт «закрыл клиент в комнате → фантомы ~минуту»; прежний вердикт:
  артефакт жёсткого kill — теперь закрытие крестиком УМНОЕ).** Механика: main
  ПЕРЕХВАТЫВАЕТ первый close главного окна (preventDefault + флаг), шлёт
  renderer `app:closing` и РЕАЛЬНО закрывает через 900мс (webContents мёртв —
  сразу); renderer в этом окне делает fire-and-forget teardownCall() +
  teardownVoice() → STOMP `/app/voice.leave` — ключевое janusClient.destroy()
  (HTTP POST) убивает janus-сессию СРАЗУ → фиды у всех пиров умирают
  мгновенно, серверный список чистится своим WS-exit-трекером как прежде.
  Жёсткий kill (краш/taskkill) по-прежнему платит janus-таймаут ~1мин —
  клиенту там нечем работать; задокументированное ограничение платформы.
  Мост: WindowBridge.onClosing ← preload removeAllListeners-идемпотентно.
  Гейты: 399/399 + typecheck + build. **Полиш (юзер-репорт: «Waiting for the
  video…» не по центру после смерти шара): мёртвый поток оставлял <video>
  РАЗМЕРОМ (замороженный кадр) в центрящем flex-е — строка ожидания становилась
  вторым flex-ребёнком и уезжала вбок; видео теперь display:none при !hasVideo
  (элемент остаётся в DOM — onTrack назначает srcObject в него как раньше).**
  Гейты: 399/399 + typecheck + build.

- **Кастомные эмодзи, фаза 1 из 3 — клиент (2026-09-25; серверная половина —
  oak-server/CLAUDE.md; деплой: сервер первым, клиент следом, НЕ строго парный —
  старый сервер → getEmojis 404 → `EmojiStore.markUnsupported()`, кнопка пикера и секция
  настроек скрываются, один warn в логе).** Осознанные v1-отступления: клавиатурная
  навигация в пикере (мышь-only), инлайн-редактор без пикера, тосты/превью поиска
  показывают `:name:` текстом. **(C1) Фундамент:** types.ts += `CustomEmoji` +
  MANAGE_EMOJIS_PERMISSION; rest.ts += getEmojis (**404→null** — толерантность),
  requestEmojiUploadSlot/createEmoji/deleteEmoji; НОВЫЙ `EmojiStore` — снапшот несёт
  САМИ производные (emojis + names: ReadonlySet + byName: ReadonlyMap, ребилд ТОЛЬКО в
  applySnapshot — идентичность для useStore-селекторов, грабля M6) + supported-флаг;
  ConnectionSession += emojiStore + emojiRefresh (CoalescingRefresher; фетч в start()
  рядом с memberRefresh, подписка `/topic/emojis` → ping-рефетч, resyncAfterReconnect,
  публичный refreshEmojis() для секции). **(C2) Парсинг и рендер:** сегментер +=
  `{kind:"emoji"}`-сегмент, сигнатура `segmentMessageContent(content, mentions,
  emojiNames?)` — эмодзи-пас ПОСЛЕ splitLinks (URL-порт `:8080:` не режется) exec-циклом
  с `lastIndex = match.index + 1` на непопавший токен (`:a:b:` находит `:b:`; matchAll
  так не умеет); без сета — байт-идентичное старое поведение. MessageRow (memo!)
  подписан на `state.names` стора — upload/delete перекрашивает СМОНТИРОВАННЫЕ строки;
  НОВЫЙ `InlineEmoji` (поиск по byName + useAttachmentImage; null → текст `:name:`, без
  битых картинок) + `.inline-emoji` ФИКСИРОВАННЫЙ em-бокс 1.375em (нулевой layout shift —
  медиа-раунд-урок; estimateRowHeight не тронут). Картинки едут через attachmentCache:
  re-mint валиден (серверный /link-OR), негативный кеш глушит удалённые. **(C3) Пикер
  композера:** НОВАЯ чистая `domain/logic/emoji-picker.ts` (emojiNameFromFileName —
  lowercase/strip-ext/invalid→-/кламп-32; filterEmojis — substring-поиск); кнопка
  `mdi-emoticon` (32×32 сосед скрепки; видна при supported, НЕ гейтится ATTACH_FILES);
  попап `.emoji-popup` в mention-popup-слоте НАД картой: поиск-инпут + сетка 8×34px
  (`EmojiTile` — компонент, хуки вне цикла); клик → вставка `:name:` на каретке
  (applyMention-механика: rAF-рефокус), попап ОСТАЁТСЯ открытым (Discord); Escape в
  поиске — stopPropagation; взаимоисключение с @-попапом; useOutsideDismiss закрывает;
  пустой каталог → «No emojis yet — upload them in Server Settings». **(C4) Server
  Settings → Emoji:** appStore-union += "emojis", canManageServerSettings += MANAGE_EMOJIS,
  MANAGE_EMOJIS убран из NOT_IMPLEMENTED (право больше не «future»); НОВАЯ
  `ServerEmojiSection` (ServerStorageSection-идиома): грид `EmojiCatalogCell` (превью +
  `:name:` + × → ConfirmModal «Messages using it will fall back to plain text») →
  rest.deleteEmoji → refreshEmojis; upload: hidden input accept png/gif/webp →
  клиентская лестница (расширение → ≤256KB → measureImageSize warn-only >128px → имя
  из emojiNameFromFileName + regex + локальная уникальность) → слот → uploadBytes →
  createEmoji; ОСОБЕННОСТЬ: pendingKey кешируется — дубль-имени (409) ретраит ТОЛЬКО
  create, не перекачивая байты. **(C5) Тесты:** emoji-segmenter (7: гэп/URL-порт/
  не-в-каталоге/частичный-резюм/смежность/офсеты-упоминаний/без-сета), emoji-store (4:
  сорт+производные/идентичность/ребилд/markUnsupported), emoji-picker (7: санитайз×4+
  фильтр×3), rest-mutations += 3 (404→null/формы слот+create/delete). Гейты: 420/420 +
  typecheck + build. **Смоук-полиш 1 (2026-09-28, 3 юзер-запроса + 1 баг):** (1) кнопка
  эмодзи ПЕРЕМЕЩЕНА на ПРАВЫЙ край composer-карты (за textarea; юзер-решение). (2) **Jumbo-
  рендер** (репорт «гиф 288×160 в чате не видно»): сообщение ТОЛЬКО из эмодзи (пробелы
  между токенами не мешают) рендерит токены КРУПНО — `.inline-emoji-large` height 48px /
  width auto (аспект гифа) / max-width 220 + contain (широкая полоса не растягивает строку);
  правило — чистая `isEmojiOnlyMessage(segments)` в emoji-picker.ts (+5 тестов: одиночный/
  с пробелами/текст-деградация/link-деградация/пусто); деградация при удалении эмодзи
  автоматична (сегментер не матчит имя → text-сегмент → не jumbo); estimateRowHeight НЕ
  тронут — оценка head-строки 51px ≈ факт jumbo (~50px), дельта в допуске. (3) Под кнопкой
  Upload emoji — hint-строка требований: «PNG, GIF or WebP · up to 256 KB · name a-z 0-9 _ -
  · larger than 128×128 renders downscaled». (4) **БАГ Roles (не эмодзи):** после blur или
  смены вкладки поле имени роли показывало СТАРОЕ имя (черновик жив до Save Changes, а span
  читал role.name из стора) — span теперь рендерит name-стейт (черновик); Escape и Enter
  ведут себя как раньше. Гейты: 425/425 + typecheck + build. Сервер не тронут — рестарт клиента.
  **Смоук-полиш 2 (2026-09-29, юзер-правки upload-формы):** hint без требований к имени
  (оно живёт в ошибке валидации «The name must be 1-32 chars of a-z, 0-9, _ and -.»);
  форма в ДВЕ строки (имя файла отдельно, поле имени + Save/Cancel строкой ниже —
  .emoji-upload-form-row); суффикс-двоеточие после поля УДАЛЕНО; полю добавлен
  placeholder «name» (виден при пустом автоимени). Гейты: 425/425 + typecheck + build.
  **Полиш 3 (2026-09-29): лимиты подняты — размер ≤1 МБ (клиентская лестница + hint +
  empty-строка), warn-порог рекомендованного размера 128→256px** (сервер лимита размера
  не имеет — presigned-модель; правка клиент-only). Гейты: 425/425 + typecheck + build.
  **Полиш 4 (2026-09-29): НАСТРАИВАЕМЫЙ размер jumbo — чисто КЛИЕНТСКАЯ настройка**
  (юзер-решение после взвешивания «серверная vs клиентская»: размер влияет только на
  смотрящего; Discord-канон — платформенная константа, кастомизация локальна; серверная
  версия требовала бы V7/wire/пуш без выгоды). Settings → Appearance → «Jumbo emoji
  size»: слайдер 18–96px (шаг 2), дефолт 48 (= Discord jumboable; минимум ≈ инлайн
  1.375em), STAGED-модель секции (Apply коммитит через settingsStore.apply);
  ClientSettings += `emojiJumboSize` (санация clampJumboEmojiSize в load — garbage→48).
  Рендер: height ушёл из CSS-класса в инлайн-стиль (InlineEmoji подписан на настройку;
  max-width 220 и vertical-align остались в .inline-emoji-large). **Превентивный
  анти-джамп: estimateRowHeight += jumboEmojiEstimateExtra(content, jumboPx)** — чистая
  функция: emoji-only контент (regex-надмножество сегментера) доплачивает max(0,
  jumboPx−48); ≤48px доплаты НЕТ (живой смоук доказал: 48px вписывается в обычную
  head-строку без дрейфа), выше — линейно по размеру; MessageList подписан на настройку
  и передаёт её в estimate (рендер и оценка меняются одним кадром). Тесты: clamp
  (в-диапазоне/за/мусор) + estimate (emoji-only 18/48→0, 96→48; текст/null→0;
  отсутствующий-в-каталоге токен всё равно доплачивает — лёгкая переоценка до меры).
  Гейты: 431/431 + typecheck + build. **Полиш 5 (2026-09-29): закрытие пикера**
  (2 репорта): (1) повторный клик по кнопке эмодзи РЕОТКРЫВАЛ пикер — гонка
  «outside-dismiss (pointerdown, capture) закрыл → onClick-тоггл открыл»; фикс =
  НОВЫЙ опциональный 3-й параметр useOutsideDismiss `anchorRef` (якорь-триггер
  считается ВНУТРИ поверхности — его пресс не дисмиссит, тоггл честно закрывает);
  кнопке добавлен emojiButtonRef. (2) отправка сообщения закрывает пикер (в
  УСПЕШНОЙ ветке submit — провал сохраняет черновик И пикер). Гейты: 431/431 +
  typecheck + build. **Полиш 6 / БАГ реакций (2026-09-29, репорт «admin23 пишет, но
  реакции не ставятся»): КОРЕНЬ СЕРВЕРНЫЙ** — @everyone живой dev-БД засеян ДО бита
  ADD_REACTIONS (сидер идемпотентен по presence и существующую строку не чинил; см.
  oak-server/CLAUDE.md — там ensureEveryoneAddReactions-ремонт). Клиентская половина
  бага — НЕСИММЕТРИЯ гейтов: hover-кнопка гейтится canReact (dm || ADD_REACTIONS), а
  ПКМ-пункт «Add reaction…» был виден ВСЕМ → плебей открывал пикер, PUT ловил 403,
  а `.catch(() => undefined)` глотал его молча («ничего не происходит»). Фиксы:
  пункт «Add reaction…» гейтится canReact (extra.canReact, симметрия с hover-кнопкой);
  оба toggleReaction-catch логируют `[reactions] toggle … failed` в space.log вместо
  молчания. Гейты: сервер 333/333 (+1 регрессионный), клиент 431/431 + typecheck +
  build. **Деплой: рестарт сервера (ремонт @everyone в логе) → рестарт клиента.**
  **Полиш 7 (2026-09-29):** (1) сердце реакций было БЕСЦВЕТНЫМ — глиф `"❤"` (U+2764)
  без VS16 рендерится Chromium'ом текстовой монохромной формой; фикс `+ U+FE0F`
  (эмодзи-презентация; единственный текстовый кодпоинт каталога — остальные 9
  полно-эмодзи). (2) Hint jumbo-слайдера без скобочной справки + кнопка «Reset to
  default» (disabled на 48; staged-модель — коммит по Apply); итерация 2: кнопка
  переведена с ghost на ВИДИМУЮ серую пилюлю `.jumbo-reset` (--sp-control,
  keybinds-reset-идиома — ghost читался как текст). Гейты: 431/431 +
  typecheck + build.

- **Кастомные стикеры с паками, фаза 2 из 3 (2026-09-29, код готов, смоук pending;
  серверная половина — oak-server/CLAUDE.md; ДЕПЛОЙ: сервер первым, клиент следом —
  новый клиент на старом сервере прячет кнопку/секцию по 404 каталога).** Юзер-решения:
  гейт управления — существующий `MANAGE_EMOJIS` (лейбл стал «Manage Emojis &
  Stickers», новых битов нет); **отправка — мгновенная по клику в трее** (стикер-only
  сообщение, черновик текста НЕ трогается, вооружённый reply переносится) — без
  chip-состояния в композере. Осознанные v1-границы: rename/перемещение паков нет,
  клавиатурной навигации в трее нет (мышь-only, как эмодзи-пикер). **(Фундамент)**
  types.ts += `Sticker`/`StickerPack`/`StickerRef` + `Message.sticker` (последним
  полем); rest.ts += getStickerPacks (**404→null**)/createStickerPack/
  deleteStickerPack/requestStickerUploadSlot/createSticker/deleteSticker;
  sendMessage-body += `stickerId`. НОВЫЙ `StickerStore` (снапшот несёт паки (name-сорт,
  стикеры внутри пака тоже дефенсивно сорт-порядок — wire уже отсортирован, но не
  доверяем), плоский список + byId ТОЛЬКО в applySnapshot — идентичность, грабля M6;
  totalStickers для счётчика; markUnsupported). ConnectionSession: stickerStore +
  stickerRefresh (CoalescingRefresher; фетч в start(), подписка `/topic/stickers` →
  ping-рефетч, resyncAfterReconnect, публичный refreshStickers) + НОВЫЙ
  `sendMessageWithSticker(channelId, sticker, replyToId?)` (content null + stickerId +
  idempotencyKey → applyLive). **(Чистая логика)** `domain/logic/sticker-picker.ts`:
  filterStickerPacks (substring по имени стикера, пак без матчей дропается при
  непустом query), STICKER_RENDER_PX=160 + stickerEstimateExtra (фикс-высота →
  преплата точна: медиа-урок), stickerForwardFileName (хвост ключа, dotless→.png —
  классификатору тайлов нужно расширение). **(Трей композера)** кнопка `mdi-sticker`
  СЛЕВА от эмодзи-кнопки (icons.css реген, 52 глифа; видна при supported, НЕ гейтится
  ATTACH_FILES); трей `.sticker-tray` (372px, max-height 380) в emoji-popup-слоте:
  поиск + секции по пакам (заголовок имя+счётчик) с сеткой `StickerTile` 96px (хук вне
  цикла, disabled при busy, фолбэк-инициалы); `sendSticker` делит `busy` с submit
  (Enter и клик не interleav'ятся), успех закрывает трей, провал — composer-error и трей
  жив; useOutsideDismiss с anchorRef (тоггл-гонка); взаимоисключение трёх попапов.
  **(Рендер)** `InlineSticker`: `.message-sticker` height 160px ФИКС / width auto /
  max-width 240 / contain; мёртвый объект → tombstone `.message-sticker-dead` (dim-плейт
  с mdi-sticker + именем — «что умерло», не серый квадрат); блок после attachmentView до
  reactions-row В ОБЕИХ ветках (ForwardCard-children и плоский фрагмент), рендерится и
  при редактировании (стикер не редактируется); estimateRowHeight +=
  stickerEstimateExtra (пересечений с jumbo нет — стикер вне сегментера).
  **(Кросс-инстанс форвард стикер-only** — иначе сервер 400 «Forward must have content
  or an attachment»): ForwardDialog.submit, кросс-ветка — при отсутствии контента и
  аттачей байты стикера ре-аплоадятся как обычная картинка (freshAttachmentLink →
  downloadBytes → forwardRequestUpload → forwardUploadBytes; fileName =
  stickerForwardFileName; размеры null) — копия рендерится картинкой на чужом сервере.
  **(Server Settings → Stickers)** секция между Emoji и Server (гейт MANAGE_EMOJIS);
  шапка: New pack (input+Create pack) + счётчик «N / 200 · M / 20»; вертикальный стек
  пак-блоков (header имя/счётчик/Upload sticker/🗑 + грид ячеек 96px c :name: и ×);
  upload-лестница = эмодзи-калька с warn-порогом 512px и уникальностью имени В ПАКЕ;
  pendingKey кешируется на 409-ретрай; ConfirmModal на стикер/пак («will show a
  placeholder»). **(Тосты)** `toastBodyFallback` в logic/toast-preview.ts: без текста →
  `[Sticker] name` (формат серверной reply-цитаты), иначе `(attachment)` — заменяет
  оба `content ?? "(attachment)"` в runtime + notifications. Тесты: sticker-store (4),
  sticker-picker (6: фильтр×3/estimate×1/fileName×2), rest-mutations += «RestClient
  stickers» (5: 404→null/пак-маршруты/слот+create-тела/delete/sendMessage-stickerId
  точное тело), toast-preview += toastBodyFallback (3); фабрики Message в 9 тест-файлах
  + runtime-seed += `sticker: null`. Гейты: клиент **449/449** + typecheck + build;
  сервер 355/355. **Смоук-сценарий в плане (goofy-leaping-sutton.md): A(owner) пак+стикер
  → мгновенная отправка с черновиком → B трей/рендер без перезагрузки → tombstone на
  удаление → форварды intra/cross → GC слот.** **Смоук-полиш 1 (2026-09-30, 2
  юзер-репорта):** (1) пустой трей — «No stickers yet.» БЕЗ хвоста «upload them in
  Server Settings» (подсказка бессмысленна для плебея без MANAGE_EMOJIS — секции у него
  нет); (2) стикер-only карточка поиска больше не пустая плитка с одним ником — метка
  `[Sticker] name` (единый формат с reply-цитатой и тостом; `.search-hit-sticker` dim,
  НЕ link-синий имён файлов — это ярлык, а не скачиваемое). Гейты: 449/449 +
  typecheck + build. **Итерация 2 (репорт «по-прежнему пустая»): ГРАБЛЯ — условие
  рендера было `segments.length === 0`, но `highlightSegments("")` возвращает массив
  ИЗ ОДНОГО пустого сегмента (контракт #481 «null/empty query yields one plain
  segment»), длина всегда 1 → ветка не срабатывала никогда; правильный гейт —
  `preview.length === 0`. Урок: пустая строка ≠ пустой массив сегментов.** Гейты:
  449/449 + typecheck + build. **Полиш 2 (2026-09-30, не стикеры — поиск #481):**
  Ctrl+F открывал панель поиска с ПУСТОЙ строкой, а крестик `.search-clear`
  показывался только при непустом query → вернуть ростер без «что-нибудь напечатать»
  было нельзя (юзер-репорт); условие рендера крестика переведено с `query.length > 0`
  на `searchOpen` (крестик = Escape: чистит поле + гасит панель). Гейты: 449/449 +
  typecheck + build. **Полиш 3 — ОБЪЕДИНЁННЫЙ ПИКЕР ВЫРАЖЕНИЙ (2026-09-30, юзер-решение
  по модели Discord):** кнопка-стикер УДАЛЕНА, осталась ОДНА кнопка-смайл справа;
  единый попап `.composer-picker` (ФИКС ширина 372px, прижат ВПРАВО к content pane —
  `align-self: flex-end`, юзер-замечание; попапы прежде были разной ширины: эмодзи
  во всю, стикеры фикс-слева): вверху вкладки **Emoji | Stickers** андэрлайном
  (`.picker-tab`, settings-tab-идиома из Roles — юзер сам предложил), общий поиск
  `.picker-search`, единый скролл-владелец `.picker-body` (эмодзи-грид 8×34 без
  собственного скролла — класс переименован `.emoji-popup-grid`→`.emoji-tile-grid`;
  стикерные секции паков как были). Асимметрия клика СОХРАНЕНА (юзер подтвердил):
  эмодзи — вставка `:name:`, попап живёт; стикер — мгновенная отправка, попал
  закрывается, черновик цел. ВКЛАДКА ПЕРЕЖИВАЕТ ПЕРЕЗАПУСК (юзер-решение: не сессия,
  глобально): `ClientSettings.pickerLastTab: "emoji" | "stickers"` (дефолт emoji,
  санация в load — мусор/переименование → emoji), пишется ТИХО при переключении
  (`settingsStore.apply` — категория persistedGain, в окне настроек не светится);
  запомненный Stickers при unsupported-стикерах фолбэкится на Emoji. Стейты
  Composer схлопнулись: `emojiPickerOpen`+`stickerTrayOpen`+2 query → `pickerOpen` +
  `pickerQuery` (+ вкладка из стора); `closePicker()` один на все пути (Escape,
  outside, тоггл, submit, sendSticker). Юзер-оговорка: «старого сервера» не
  проектируем — клиент и сервер всегда парные (существующие supported-гейты
  остались, но новых усложнений под толерантность не добавляем). **Итерация 2 (2
  репорта):** (1) пикер всё равно прижимался ВЛЕВО — ГРАБЛЯ: `.composer` был обычным
  block, `align-self` на нём НЕ работает (фикс-ширина → левый край); фикс =
  `.composer` стал column-flex (карта/mention-popup/error сохраняют полную ширину
  через stretch, пикер честно прижался вправо); (2) вкладки пикера 12→13px — тот же
  кегль, что поиск (один голос внутри попапа). **Итерация 3 (репорт «контент слева от
  пикера пропадает»): поток-сиблинг фикс-ширины ВЫТАЛКИВАЛ список и оставлял пустую
  полосу слева от себя — пикер переведён в ABSOLUTE-оверлей (Discord-модель:
  перекрывает список, а не сдвигает): `.composer` position:relative,
  `.composer-picker` absolute right:0 bottom:calc(100%+4px) (право = край карты с
  учётом 8px-паддинга композера), z-index 5 + тень; column-flex композера откатен
  (больше не нужен).** **Итерация 4:** карточки каталога эмодзи в Server Settings
  сужены 140→96px — выровнены со стикерными ячейками (юзер-репорт «слишком широкие»;
  140 был произволом фазы 1, длинные `:name:` и так ellipsis'ятся). Гейты: build.

- **Кастомные эмодзи в реакциях, фаза 3 из 3 (2026-09-30, код готов, смоук pending;
  серверная половина — oak-server/CLAUDE.md; ДЕПЛОЙ: сервер первым (V8), клиент
  следом).** Юзер-решения: **единый пикер реакций** в стиле композерного (фикс 372px,
  поиск, секции Built-in + Custom, клик = мгновенный toggle + закрытие, БЕЗ вкладки
  Stickers) и **кап 20 различных реакций на сообщение** (серверный 400 на 21-ю — у
  клиента это варн-лог `[reactions] toggle … failed`). **(C1) Чистая логика** НОВЫЙ
  `domain/logic/reaction-picker.ts`: `customEmojiNameOfReactionSlug` (анкер
  `^:[a-z0-9_-]{1,32}:$` → имя | null; голые встроенные слаги → null, `heart` и
  `:heart:` — разные), `filterBuiltInReactions` (substring по slug),
  `REACTION_PICKER_WIDTH_PX=372`/`MAX_HEIGHT_PX=420`, `reactionPickerPosition` (вниз →
  флип-вверх → вертикальный кламп, margin 8/зазор 4 — чистая, тестирована; CSS
  max-height min(420, 100vh−16) страхует низкое окно). **(C2) rest.ts**:
  add/removeReaction кодируют слаг `encodeURIComponent` — `:cat:` едет как `%3Acat%3A`
  (Spring декодит; ГРАБЛЯ ТЕСТОВ: MockMvc НЕ декодирует %3A в path-variable — нет
  контейнера, — потому wire-кодирование закреплено ЗДЕСЬ, клиентским rest-тестом, а не
  серверным). **(C3) Чипы**: НОВЫЙ `ReactionChipLabel({session, slug})` (хуки
  безусловны — built-in ранний return их не перескакивает; EmojiTile-дисциплина):
  встроенный → глиф из REACTION_GLYPH_BY_SLUG (fallback — сырое имя, как было); кастом
  → EmojiStore.byName + useAttachmentImage → `img.reaction-chip-emoji` 16px; мимо
  каталога/мёртвый объект → текст `:name:` — чип остаётся КНОПКОЙ (dangling-снятие
  работает: onClick тогглит по сырому слагу, сервер remove каталог не проверяет);
  live-обновление на /topic/emojis автоматом (компонент подписан на byName). **(C4)
  Пикер**: `.emoji-picker`-полоска УДАЛЕНА (классы .emoji-choice тоже); `.reaction-
  picker` = fixed-попап по inline-координатам из `reactionPickerPosition` (якорится к
  сообщению, не к композеру), структура композерная: `.picker-search` (Escape = close;
  query сбрасывается эффектом на закрытие — любой путь) → единый скролл `.picker-body`
  → `.picker-section` c `.picker-section-title` (sticker-pack-title-идиома): Built-in
  (тайлы `.emoji-tile` + `span.emoji-tile-glyph` 20px) + Custom при supported (грид
  существующего `EmojiTile` — onPick уже был с фазы 2, рефактор не понадобился);
  `pickReaction(message, slug)` — mine из снапшота + warn-catch (403/кап не молчат) +
  setPicker(null); пусто по query → «Nothing matches.», каталог пуст/unsupported →
  только Built-in. Якоря: hover-кнопка теперь `y: rect.bottom`, ПКМ-пункт `y: menu.y`
  (было +120, откалиброванное под старую 48px-полоску) — зазор живёт в ОДНОМ месте,
  в reactionPickerPosition. **(C5) CSS**: +`.reaction-picker`/`.picker-section`/
  `.picker-section-title`/`.emoji-tile-glyph`/`.reaction-chip-emoji`;
  −`.emoji-picker`/`.emoji-choice`; icons.css НЕ менялся (новых mdi-глифов нет).
  Тесты: НОВЫЙ `test/reaction-picker.test.ts` (11: дискриминатор×4 — вкл. `::cat::` и
  32-симв границу / filter×3 / позиция×4 — флип/клампы вкл. окно 400px) +
  rest-mutations += `%3Acat%3A`-путь PUT+DELETE. Гейты: клиент **461/461** + typecheck
  + build; сервер 365/365. Смоук-сценарий в плане (goofy-leaping-sutton.md).
  **Смоук-полиш 1 (2026-09-30, смоук фазы 3 пройден, 3 юзер-запроса):** (1)
  **Асимметрия закрыта: built-in эмодзи в пикере композера** — вкладка Emoji ALWAYS
  (её Built-in-секция чисто клиентская, каталого-независимая), кнопка-смайл видна
  ВСЕГДА; секция Built-in (10 глифов, клик = вставка ГЛИФА на каретку — у встроенных
  нет `:name:`-токена; `insertAtCaret` — обобщение applyEmoji) зеркалит попап реакций.
  (2) **Latest — общий MRU использованных выражений**: `ClientSettings.
  recentExpressions: string[]` (слаг-словарь: голый built-in ИЛИ `:name:`, MRU-first,
  кап 8, санация в load — `sanitizeRecentExpressions`); пишется ТИХО на каждом
  использовании (`recordRecentExpression` — модульный хелпер, снапшот на момент
  вызова; persistedGain-категория); питают ОДИН список оба попапа: клики реакций
  (pickReaction) И вставки эмодзи в композере (кастом + built-in). Рендер: секция
  «Latest» ВВЕРХУ обоих попапов (`.expression-tile-grid`), мёртвые кастомы роняются
  на РЕНДЕРЕ (`resolveRecentExpressionEntries` по живому byName — ре-аплоад
  воскрешает место), query фильтрует Latest как и остальные секции. (3) **Ряд
  встроенных больше не «обрезан»**: грабля — `.emoji-tile-grid` фикс 8×34 переносил
  10-й тайл на вторую строку (8+2); НОВАЯ `.expression-tile-grid` = 10 флюид-колонок
  (`repeat(10, minmax(0,1fr))`, тайл width:100%/height:32) — дефолтный набор читается
  ОДНОЙ строкой при любой фактической внутренней ширине попапа; использует её и
  Latest (смешанный ряд глифы+картинки). Компоненты: `BuiltInEmojiTile` (глиф-тайл) +
  `RecentExpressionTile` (переключатель вида) — переиспользованы обоими попапами;
  пустое состояние пикера реакций/вкладки Emoji учитывает все три секции. Тесты:
  reaction-picker += pushRecentExpression/sanitizeRecentExpressions/
  resolveRecentExpressionEntries (8 новых). Гейты: **469/469** + typecheck + build
  (клиент-only, сервер не тронут).

- **Экспорт/импорт паков выражений (2026-09-30, код готов, смоук pending;
  КЛИЕНТ-ONLY — сервер oak-server не тронут ВООБЩЕ: ни эндпоинтов, ни миграций,
  ни зависимостей).** Владельцы серверов обмениваются архивами. Юзер-решения: экспорт
  СЕКЦИОНЕН — Export all на странице Emoji выгружает ТОЛЬКО эмодзи, на странице
  Stickers — ТОЛЬКО все стикер-паки (плюс per-pack Export в заголовке каждого пака);
  кнопки — ОБЫЧНЫЕ дефолтные серые кнопки того же размера, что Upload emoji / Create
  pack (грабля была в ghost-прозрачности «читается как текст», keybind-reset-урок, а
  НЕ в размере — компактная пилюля рядом с полноразмерными соседями выглядела чужой);
  импорт — через МОДАЛКУ ПРЕДПРОСМОТРА: планнер вердиктит каждый
  элемент по живым каталогам, импортируемое подсвечено BLURPLE, клик по плитке
  исключает/возвращает её, заблокированное планнером затемнено с причиной (name
  exists/limit/invalid) и не кликается, внизу Cancel + «Import N» (0 выбрано →
  disabled); конфликты при импорте — ПРОПУСК + зелёная строка-отчёт («Imported 38,
  skipped 3 (name exists), 2 skipped (limit), 1 invalid, 1 failed · created 2 packs»,
  только ненулевые сегменты); архитектура — КЛИЕНТСКИЙ zip (сервер байтов не касается:
  экспорт качает по свежим presigned-ссылкам как Lightbox, импорт льёт СУЩЕСТВУЮЩЕЙ
  лестницей слот→PUT→create — все серверные гейты/капы/пинги работают как при ручной
  загрузке; брошенный при 409 слот подбирает ночной GC). **(Формат)** zip с `pack.json`
  (formatVersion 1, kind emojis|stickers|sticker-pack — информационное, импорт
  тотален, legacy expressions парсится но не производится; чужая version → весь архив
  отвергнут, лишние поля tolerated): `emojis/<name>.<ext>` + `stickers/<NN>/<name>.<ext>`
  (NN = индекс пака — имена паков free-text, в файловые пути не годятся); расширение
  восстанавливается из хвоста ключа, вайтлист png/gif/webp, неразрешимое → элемент
  пропущен (unavailable в отчёте). **(Логика)** НОВЫЙ `domain/logic/expression-pack.ts`
  (единственный сайт fflate): entry-нейминг, sanitizeFileBaseName (имя выгружаемого
  zip-файла; ГРАБЛЯ: `\u0000`-эскейп в исходнике коллапсируется в реальный NUL-байт и
  файл становится «бинарным» — контроль-чарс через unicode-property `[\p{C}…]`/u),
  build/parse архива (fflate SYNC API zipSync/unzipSync, level 0 STORE — контент уже
  сжат; детерминизм в vitest-node без worker'ов), планнер `planPackImport` (per-item
  лестница: грамматика → ext → файл есть → ≤1MB → дубль в манифесте (первый выигрывает)
  → имя занято → кап 200/200/20; паки: точное по trim имя → MERGE в существующий пак,
  20 паков → весь пак в skippedPacks; два пака с одним именем в манифесте → слиты в один
  план; эмодзи/стикер-имена — НЕЗАВИСИМЫЕ пространства), репорт-билдеры
  (tallyPlannedSkips — считаются ТОЛЬКО скипы, import-решения обнуляются до рантайма;
  tallyRuntimeOutcome: 409 на сервере = conflict → skippedNames; formatImport/ExportReport).
  **(Оркестратор)** НОВЫЙ `renderer/expression-exchange.ts` (без React, social-aggregate-
  прецедент): exportExpressionPack(scope: emojis|stickers|pack; freshAttachmentLink →
  downloadBytes; dead-link/ошибка сети → unavailable++, архив не валится; пак, у которого
  выжили не все файлы, едет с выжившими, у которого НИ ОДНОГО — из манифеста выпадает,
  чтобы импорт не плодил пустые паки; saveFile через OS-диалог, cancel ≠ ошибка) и
  разрезанный на два шага импорт: readPackArchive (256MB-кап + parse, ничего не делает)
  → importPackArchive(аргив; планнер по свежим снапшотам — вердикты предпросмотра
  ПРЕДПРОСМОТРИТЕЛЬНЫ, конфликты между просмотром и подтверждением = runtime-conflict
  в отчёте; пак create при 409 → переиспользование по имени из свежего getStickerPacks;
  провал создания пака → его запланированные импорты конвертируются в skip-limit; в
  конце refreshEmojis+refreshStickers); catalogSnapshotOf — общий снапшот каталогов для
  планнера. Cancel-кнопки у ПРОГОНА НЕТ: прогон ограничен капами, закрытие настроек —
  лестница докручивается в фоне (setState на unmounted = no-op). **(UI)**
  ServerSettingsPane: хук `useExpressionExchange` (общий busy/прогресс-строка
  `.exchange-status`/зелёный отчёт `.exchange-report`/previewArchive-стейт; терминальные
  ошибки — в error-line секции) + скрытые `.zip`-инпуты (по одному на секцию) +
  `ImportPreviewModal` (планнер в useMemo, вердикты из planPackImport — эмодзи по
  индексу, стикеры по имени плана (merged-паки делят вердикт — косметика для
  hand-made дублей); превью-миниатюры blob-URL из байтов архива СЕТЬ не трогают,
  revoke на unmount; Confirm строит ОТФИЛЬТРОВАННЫЙ манифест — невыбранные выпадают,
  опустевшие паки удаляются, пустых паков не плодим). `npm run icons` не нужен.
  **fflate ^0.8.3** — первый zip-деп проекта (dependencies). Тесты: НОВЫЙ
  `test/expression-pack.test.ts` (28: нейминг/экспорт-энтри/манифест/sanitize;
  parse-лестница вкл. мусор вне вайтлиста, version-гейты и kind-юнион; планнер —
  капы/merge/дубли/invalid×5/слияние одноимённых паков; репорт-билдеры). Гейты:
  **497/497** + typecheck + build. Смоук: экспорт → zip читаем; чистый импорт;
  повторный импорт того же архива («Imported 0, skipped N (name exists)»); импорт пака
  с существующим именем (merge); предпросмотр с исключением части плиток; битый zip
  (error-line); dead-link при экспорте (unavailable в отчёте).

- **Инвайт-регистрация: диалог Add a server с 3 вкладками + секция Invites (2026-09-30,
  код готов, смоук pending; ДЕПЛОЙ ПАРНЫЙ с oak-server — сервер первым (V9 + гейт
  register: на непустом инстансе старый клиент без inviteSecret получает 403), клиент
  следом; серверная половина — oak-server/CLAUDE.md).** Юзер-решения: регистрация на
  имеющемся сервере — ТОЛЬКО по пригласительной ссылке (`http://host:port/#invite=
  <secret>`, сервер собирает из advertised connectionHost/Port с fallback на Host);
  пустая ссылка в форме = bootstrap-регистрация ПЕРВОГО юзера свежего сервера
  (OWNER — живёт до client provisioning, вкладка Create = заглушка `.not-implemented`,
  provisioning в backlog вместе с созданием овнера одной командой и TLS-схемой ссылок);
  TTL ретроактивен; список только активных. **(Чистая логика)** НОВЫЙ
  `domain/logic/invite-link.ts`: `parseInviteLink` (lenient-парсер вставленной руками
  ссылки: секрет из hash `#invite=` canonical / `?invite=` tolerated, до `&`;
  автопрефикс `http://` при отсутствии схемы (иначе URL читает «host:» как протокол);
  origin из `url.origin` — сам нормализует trailing slash и IPv6-скобки; пустой
  секрет/мусор → null), `buildInviteLink` (зеркало InviteController.buildLink,
  round-trip-тест), `formatExpiresIn(expiresAt, now)` («45m»/«3h 12m»/«2d 5h»/
  «expired»; now-параметр — тестируемость). **(rest/types)** `register(username,
  password, options?: {nickname?, inviteSecret?})` — поля в тело ТОЛЬКО когда заданы
  (голая bootstrap-регистрация сохраняет legacy 2-поле wire); `getInvites`/
  `createInvite`/`revokeInvite`/`expireAllInvites`/`updateInviteSettings`; типы
  `InviteLink` (несёт secretPreview — полный секрет на провод не ездит, Copy копирует
  собранный link) + `InvitesStatus{ttlHours, invites}` одним GET. **(runtime)**
  `startSession` += 5-й параметр `RegisterSessionOptions` → проброс в register
  (дедуп записи/openSession не тронуты). **(LoginModal)** 3 вкладки underline-идиомой
  (`.settings-tabs.login-tabs` — юзер просил «как в Server Settings → Roles»):
  Create (текстовая заглушка; юзер-решение ×2: овнер нового сервера будет создаваться
  АВТОМАТИЧЕСКИ при создании сервера из клиента — отдельной регистрации первого юзера
  в форме НЕТ), Log in (прежняя форма), Register — Invite link (**ОБЯЗАТЕЛЬНО**, первым
  полем) + Nickname (опц., «Same as username if empty») + Username + Password;
  **адреса-поля НЕТ ВООБЩЕ — адрес = origin ссылки** (под валидной ссылкой dim-строка
  «Server: <origin>»; пустая/невалидная ссылка → локальная ошибка в error-line:
  «Paste an invite link to register.» / «That invite link does not look valid.»;
  appStore.loginError); Enter в пароле = Register; hint «Ask a member with the
  "Manage Members" permission for an invite link.». Серверный bootstrap-гейт
  (count()==0 → OWNER без секрета) ОСТАЁТСЯ API-контрактом для будущего provisioning —
  клиент его больше не использует. **(ServerSettingsPane → Invites)**
  секция после Members, гейт MANAGE_MEMBERS (юзер: «ссылки раздаёт тот, кто может
  добавлять членов»); TTL-строка (number 1..720 + «hours» + SaveButton; invalid-черновик
  держит Save disabled — dirty только при валидном; после Save refresh — TTL
  ретроактивен, выжившие ссылки могут смениться/умереть) + Create invite (primary) +
  Expire all (ConfirmModal); список `.list-row.invite-row`: secretPreview (mono, title=
  полная ссылка), «by {createdBy}», «expires in {formatExpiresIn}», справа Copy
  (`navigator.clipboard.writeText(link).catch(() => undefined)` — ChatPane-идиома;
  фидбек mdi-content-copy→mdi-check на 1.5 с по copiedId) и Expire (ghost, mdi-close);
  пусто-состояние «No active invites…»; каждая мутация → единый refresh() (стора НЕТ —
  локальный стейт, поверхность одного админа; /topic/invites-пинг сервера — задел на
  будущее live). Иконки уже были (npm run icons НЕ нужен). Тесты: НОВЫЙ
  `test/invite-link.test.ts` (16: hash/query/автопрефикс/IPv6/&-обрезка/пустой-секрет/
  не-ссылка/whitespace/build-symmetry/expiresIn-лестница) + rest-mutations += 3
  (register-тела legacy/с-инвайтом; все 5 invite-маршрутов с точными телами; registerFake
  ветвится по path — register 201 → авто-login 200). Гейты: **516/516** + typecheck +
  build. Смоук: owner создаёт инвайт → Copy; второй клиент → «+» → Register → вставка
  ссылки (адрес сам заполнился) → ник/логин/пароль → вход; повтор ссылки → 403
  «already used»; Expire одной/всех; TTL 2 → Save → «expires in 2h»; register без
  ссылки на непустом сервере → 403 с текстом.

  **Раунд 2 (смоук-репорты юзера, 2026-10-01; ДЕПЛОЙ ПАРНЫЙ с oak-server — сервер
  первым: V10 + ttlMinutes-wire + afterCommit-пинги).** (1) **Использованная ссылка
  исчезает из списка LIVE** (репорт «нужно перезаходить в Server settings»): НОВЫЙ
  `InvitesStore` per-session (снапшот {loaded, ttlMinutes, invites} — wire-ответ
  дословно, идентичность тривиальна) + подписка `/topic/invites` в ConnectionSession
  (ping = рефреш; рефетч НЕ на старте — чтение админское, секция тянет первый снапшот
  сама; 403 плебеев в doRefreshInvites глотается ТИХО — пинг доходит всем) +
  resyncAfterReconnect + публичный refreshInvites(); сервер пингует AFTER COMMIT
  (в т.ч. AuthService после claim) — иначе рефетч опережал коммит и строка «used»
  оставалась до следующего события. (2) **TTL задаётся в МИНУТАХ** (юзер-решение):
  поле number 1..525600, СПРАВА живой перевод `formatTtlWords` («5 mo 2 d 3 h 4 min»,
  только ненулевые сегменты, месяц = плоские 30 дней — год-кап 525600 рендерится
  «12 mo 5 d»; чистая функция в invite-link.ts + тесты); **Save changes — ОТДЕЛЬНОЙ
  строкой под полем** (юзер-репорт; раньше в одной строке с input); черновик поля
  не перезатирается входящими снапшотами, пока юзер редактирует (ttlTouchedRef).
  (3) **Удаление АКТИВНОГО сервера свитчит на выжившего** (репорт «No server
  connected, хотя есть другой сервер»): removeConnection после teardown+remove зовёт
  switchConnection(самая свежая запись) — живая фоновая сессия промоутится мгновенно,
  мёртвая семья → логин-модал с префиллом; записей нет → empty-экран честен. Тесты:
  invite-link += formatTtlWords (7); rest-mutations ttlMinutes. Гейты: **520/520** +
  typecheck + build. **Раунд 3 (юзер-решения, 2026-10-01; ДЕПЛОЙ ПАРНЫЙ — сервер
  первым: V11 + DELETE-claim):** (1) **форматы без месяцев**: formatTtlWords =
  d/h/min только (кап 525600 = «365 d», плоский год); formatExpiresIn = дни+часы
  («2d 5h»), цельные часы без минут («3h»), и только в ПОСЛЕДНИЙ час — минуты
  («45m»). (2) **TTL-строка перестроена** (юзер-макет): [label][КОЛОНКА: input +
  «min» + Save changes справа в строке / перевод словами ровно ПОД полем]; input
  фикс-ширины 128px — под ним влезает самый длинный перевод («364 d 23 h 59 min»),
  набор цифр ничего не сдвигает. (3) Сервер: claim стал DELETE (потраченной строки
  больше не существует — повтор ссылки читается как «not valid»), истёкшие/
  отозванные сносит InvitesCleanup по расписанию PT6H (см. oak-server/CLAUDE.md).

- **Тройной раунд (2026-10-01, код готов, смоук pending; ДЕПЛОЙ ПАРНЫЙ с oak-server —
  сервер первым (V12 + sizeBytes-wire + /voice.invite), клиент следом).** Порядок A→B→C.
  **(A) Плитка не-медиа файла:**Attachment += `sizeBytes` (wire-append-only; размер знает
  только отправитель — File.size, модель доверия width/height; легаси-строки = null →
  плитка без размера). Отправка кладёт sizeBytes для ВСЕХ файлов (оба upload-сайта
  sendMessageWithFiles/startDiscussionWithMessage + кросс-инстанс форвард bytes.byteLength
  + edit-путь несёт размер дальше). НОВЫЙ `FileCardView` (AudioCardView-калька):
  круглая blurple `.file-download` (mdi-download, busy = mdi-refresh спин) →
  fresh-link → downloadBytes → saveFile (OS-диалог, лайтбокс-рецепт; openExternal
  УДАЛЁН из плитки — скачивание только через клиент, юзер-требование), `.file-name`
  + `.file-size` (humanByteSize — ВЫНЕСЕНА из Lightbox в `domain/logic/file-size.ts`).
  estimateRowHeight чип 40 → 56. `.file-chip` удалён.
  **(B) Категории каналов + drag (Discord-парити; юзер выбрал сразу drag, меню переноса
  нет):** Channel += `parentId`/`position`; ChannelType += "CATEGORY". Чистые
  `domain/logic/channel-groups.ts` (groupChannelsByCategory: uncatText → uncatVoice →
  categories; ВНУТРИ категории text сверху/voice снизу — юзер-решение; ребёнок СКРЫТОЙ
  категории падает в uncategorized, не исчезает; flattenGroupsForPersist — детерминированный
  обход для PUT) и `channel-drag.ts` (applyChannelDrop: subject channel|category + DropTarget
  {list, categoryId, beforeId|null}; нормализация типа — text над voice-строкой → append в
  text-лист того же блока; дроп канала НА заголовок категории = ВНУТРЬ (Discord); no-op →
  null — ссылки-идентичность). ChannelStore.applyCreated — вставка по (position,id) вместо
  id; sameChannel += parentId/position. Sidebar: CategoryBlock (collapse-шеврон rotate,
  локальный Set без персиста, «+» создаёт канал В категории, ПКМ rename/delete, пустая
  категория видна ТОЛЬКО менеджеру), CreateChannelModal: третий kind CATEGORY
  (mdi-folder-outline) + select категории для TEXT/VOICE; POINTER-drag (роли-механика:
  порог 4px, ghost-абсолют ЧЕРЕЗ ПОРТАЛ fixed — скроллящийся сайдбар клипает absolute
  (rail-bubble-урок), drop-gap строка, ESC-отмена, body.channel-dragging); drag-handle
  voice-блока — ТОЛЬКО name-row (участники не участвуют; data-drag-list/data-drag-channel-id
  на ВНЕШНЕМ .voice-channel); хит-тест по контейнеру сайдбара, ниже-середины → before
  следующей строки ТОГО ЖЕ списка; collapsed-категория: дроп ниже заголовка = append внутрь
  (через «categories»-нормализацию). Оптимистичный preview (persist PUT /api/channels/order
  полным списком {id,parentId}; catch → откат+лог; catch-up «стор догнал» по flatten-
  равенству).
  **(C) Hover-кнопка приглашения в голос (Discord invite-to-voice; только ОНЛАЙН-друзья —
  живая карточка без persist, офлайн не доходит):** кнопка `.voice-invite-button`
  (mdi-account-plus) в name-row voice-канала (opacity 0→hover, stopPropagation, скрыта на
  locked) → `VoiceInvitePickerModal` (FRIEND ∩ presence — чистая onlineFriendCandidates в
  `domain/logic/voice-invite.ts`; отправка ПО ОДНОМУ `session.sendVoiceInvite(channelId,
  username)` → /app/voice.invite; сервер штампует from и резолвит channelName — стора
  получателя может не быть). Приём: подписка /user/queue/voice.invite → hooks.onVoiceInvite
  (ОБЕ записи — активная и фоновая) → `showVoiceInviteCard` (showIncomingCallCard-паттерн:
  палитра-инициал → аватар dataUrl с гейтом живости; лёгкий bell под soundEnabled) →
  `{kind:"voice-invite", card}` в тост-окно: СТЕКИТСЯ с message-тостами (не глушит ничего),
  TTL 60с + pause-on-hover, Join (blurple mdi-location-enter) / Dismiss (mdi-close) → IPC
  `toast:voiceInviteAction` (ручное пробрасывание в 4 местах: bridges/preload/main/
  ToastStackScreen — известная грабля). Join: активная запись → channelStore-гейты (VOICE,
  !locked) → joinVoiceGuarded; фоновая → pendingVoiceJoin + switchConnection → ветка в
  consumePendingOpen; dispose фоновой сессии чистит её карточки и Map. Гейты: сервер
  **392/392**, клиент **547/547** + typecheck + build; icons.css 54 глифа (+folder-outline,
  account-plus, location-enter). Смоук: A — .zip в канал → плитка имя+размер → скачать
  через диалог; B — категория → drag каналов/категорий, второй клиент live, delete непустой
  400; C — два клиента: hover → пикер → карточка → Join (активная и фоновая записи),
  Dismiss, TTL, офлайн — тишина.

- **Тройной раунд 2: удаление участника + передача овнера + AFK-канал (2026-10-01, код
  готов, смоук pending; ДЕПЛОЙ ПАРНЫЙ с oak-server — сервер первым; серверная половина —
  oak-server/CLAUDE.md).** **(A) Kick → «Remove from server» (навсегда):** `MemberKickEvent`
  += `removed?`, `ServerMember` += `removed?` (true только в строках /bans), MemberEvent
  += "removed". `rest.removeMember` → POST /api/members/{id}/remove (kickMember удалён).
  НОВЫЙ чистый `domain/logic/moderation-reason.ts`: memberKickTitle/memberKickReasonText —
  3 ветки (removed — БЕЗ подсказки реконнекта / banned / disconnect); `onMemberKicked`
  использует обе. UI: MembersPane пункт «Remove from server» + ModerationModal «Remove»
  («…permanently removed and will not be able to rejoin»); MembersSection кнопка +
  ConfirmModal + PERMISSION_DESCRIPTIONS.KICK_MEMBERS «Removal is permanent» + блок
  **«Removed»** внизу списка (getBannedMembers filtered removed===true, рефеч по
  members-снапшоту, REMOVED-бейдж, без действий; `.removed-badge` серый близнец
  banned-бейджа). Сообщения НЕ тронУТЫ: автор удалённого рендерится вечно через
  /api/users (tombstone «Deleted-User-N» — сервер анонимизирует, ник освобождается,
  подмены авторства нет по построению). **(B) Передача овнерства:** типы
  OwnershipTransfer/PendingOwnershipTransfer/OwnershipEvent; rest 5 методов; НОВЫЙ
  `OwnershipStore` ({loaded, pending}, InvitesStore-идиома) + `ownershipRefresh`
  (CoalescingRefresher) с фетчем в start() (заявка переживает офлайн получателя) и
  resyncAfterReconnect; подписка /user/queue/ownership → hooks.onOwnershipEvent +
  рефреш; session.offerOwnershipTransfer/accept/decline/cancel (каждый сам рефечит).
  runtime: AppState += ownershipModalOpen + ownershipPreselect (+open/closeOwnershipTransfer,
  сброс в teardown); хук onOwnershipEvent — тост «You are now the owner» на ACCEPTED мне
  (username берётся из connectionDirectory — hooks-фабрика не имеет session, грабля
  фоновых звонков); короны/правила flip едут на members-рефече (MemberEvent
  rolesChanged — оба участника). UI (юзер-решение смоук-раунда: точка входа —
  Server Settings → Members, НЕ ServerMenu): кнопка «Transfer ownership» в строке
  Member actions — видна ТОЛЬКО овнеру (НЕ disabled, а НЕ ВИДНА остальным), скрыта на
  banned/owner-строке; открывает НОВЫЙ `TransferOwnershipModal` с preselect (модал
  стартует сразу в confirm-стадии выбранного; без preselect — пикер transferCandidates,
  чистая logic/ownership-transfer.ts: кроме self и banned, сорт по нику; confirm «You
  will lose the owner role. Only the new owner can transfer it back»; исходящая
  PENDING → карточка «Pending transfer to X» + Cancel); Modal += `elevated`-проп
  (z-110, поверх settings-overlay). Баннер `OwnershipBanner` в Sidebar ПОД
  server-header (persistent, только при pending.toUserId === selfUserId; 👑 + «X
  offers you ownership of this server» + Accept/Decline; `.ownership-banner`
  voice-bar-идиома, `.ownership-warning` amber).
  **Смоук-фикс 1 (живой репорт «ник удалённого в чате остался старым»): ростер
  обновляется по id корректно, но ЗАГРУЖЕННЫЕ сообщения несли СТАРЫЙ authorUsername →
  рендер через displayNameOf падал в fallback и показывал старый логин.** Лекарь:
  обработчик /topic/users при СМЕНЕ username (tombstone) зовёт
  `MessageStore.renameAuthor(userId, nextUsername)` (патчит authorUsername по
  стабильному authorId во всех loaded-каналах, один emit) + socialStore.applyUserRename
  по СТАРОМУ ключу тоже. **Смоук-фикс 2: серверная OWNERSHIP_QUEUE потеряла ложный
  /user-префикс — см. oak-server/CLAUDE.md.**
  **(C) AFK-канал:** `VoiceControlEvent.type` → "KICKED"|"MOVED", `byUsername:
  string | null`; `AfkSettings` + rest get/updateAfkSettings. Electron: powerMonitor в
  import main + `ipcMain.handle("space-idle:time")` + preload `spaceIdle`-бридж +
  `IdleBridge` в bridges.ts. НОВЫЙ чистый `domain/logic/afk-activity.ts`:
  `isAfkActive(idleSeconds, speaking) = speaking || idle < 60` (активность = системный
  ввод ВСЕГО компьютера ИЛИ говорение — юзер-критерий «активно пользуется ПК»).
  runtime: `startAfkReporting/stopAfkReporting` — интервал 30с, выход без
  activeSession/activeVoiceChannelId; `idleSeconds = spaceIdle ?
  getSystemIdleTime() : +Infinity` (нет моста → speaking-only, НИКОГДА ложный
  «активен»); `speaking = roomAudio.speakingSnapshot().has(ownUsername)`; активен →
  `/app/voice.activity`. Старт в joinVoice после voice.join-сенда, стоп в
  teardownVoice (покрывает все выходы). Приём: connection-session ветка MOVED →
  `hooks.onVoiceMoved(channelId)`; runtime-хук (onVoiceKicked-паттерн): isActive-гейт,
  cancelVoiceRejoin (лестница могла целить СТАРУЮ комнату), гейты канала (VOICE/!locked
  → joinVoice — его внутренний cancel+свежий /room; иначе leaveVoice), тост «You were
  moved to #имя»; поздний session-lost видит уже НОВЫЙ канал — самолечение.
  **Раунд-2 переделка AFK-UI (юзер-решения, 2026-10-02; Discord-факты проверены
  поиском: AFK-канал МОЖЕТ жить в категории, server-mute не снимается юзером, стрим
  запрещён):** настройка AFK = свойство КАНАЛА, а не глобальный селектор. `Channel` +=
  `afk?` (8-е wire-поле ChannelResponse, пинг channels.changed после PUT). НОВЫЙ
  `CreateChannelModal.tsx` (ВЫНЕСЕН из Sidebar — переиспользуется Server Settings →
  Channels): для kind VOICE тоггл «AFK channel — idle members are moved here» →
  появляется select таймаута (AFK_TIMEOUT_PRESETS 5m..7d); submit = create + при
  тоггле `updateAfkSettings(channel.id, timeout)` (провал PUT оставляет канал живым,
  ошибка inline). Server Settings → Channels: заголовок получил «+» (Roles-идиома
  section-add → тот же CreateChannelModal); строка VOICE-канала с `afk` несёт бейдж
  **AFK** (amber, `.afk-badge` — Members-бейдж-идиома); в ChannelEditor ТРЕТЬЯ вкладка
  **AFK** (только VOICE): тоггл «This channel is the AFK channel» + таймаут + Save
  (снятие = PUT null); если AFK уже назначен ДРУГОЙ канал — вкладка read-only с его
  именем (юзер-правило «настраивать только если такого ещё нет»). СТАРЫЙ
  AfkSettingsBlock (idle-панель с глобальным селектором) УДАЛЁН — «Select a channel»
  вернулся. Супресс: сервер шлёт mod-mute в AFK (см. oak-server) — клиентский рендер
  красной марки сам; кнопка Share/Camera (единая voice-toggle share) в VoiceBar
  СКРЫТА в AFK-канале (`channelAfk`-подписка на channelStore).
  Тесты: moderation-reason (3), ownership-transfer (3), ownership-store (3),
  afk-activity (3), rest-mutations += remove/ownership×5/afk×2. Гейты: сервер **428/428**,
  клиент **567/567** + typecheck + build; иконки не менялись (👑 — юникод-глиф).
  **Смоук-фиксы раунда 3 (2026-10-02, три юзер-репорта):** (1) **бейдж AFK не появлялся**
  — `ChannelStore.sameChannel` не сравнивал `afk` → applySnapshot считал рефеч
  «неизменным» и держал старую ссылку строки (та же грабля, что однажды стирала бейдж
  мьюта); лекарь — сравнение afk + регрессионный тест (designate/snapshot→emit).
  (2) **AFK-мьют не действовал** — сервер шлёт мьют-стейт ДО MOVED-пуша, а клиент на
  MOVED запускает joinVoice, чей clearUser/compliance-reset ЗАТИРАЛ только что
  пришедший мод-мьют; лекарь с двух сторон: сервер гонит applyOnEnter ПОСЛЕ MOVED
  (TCP-порядок одного сокета), клиент в joinVoice при заходе в afk-канал НЕ чистит
  свои метки и НЕ сбрасывает mic-комплаенс (enteringAfkRoom-гейт). (3) **овнер не
  смещался после accept** — сервер пушил MemberEvent/OwnershipEvent ВНУТРИ tx →
  рефеч читал докоммитное (invites-грабля); ВСЕ пуши OwnershipTransferService переведены
  в pushAfterCommit (см. oak-server/CLAUDE.md). — **клиент 568/568, сервер 428/428**.
  **Смоук-фиксы раунда 4 (2026-10-02):** (1) **каскад отмены/передачи овнерства**
  (юзер-решение): TransferOwnershipModal переведён на стейдж-машину
  (`cancel {thenTransferTo} | confirm {targetUserId} | picker`): повторное открытие на
  ПОЛУЧАТЕЛЕ живой заявки = подтверждение отмены; на ДРУГОМ = «Cancel & continue» —
  отмена, ЗАТЕМ confirm-диалог передачи новому (два диалога последовательно, модал не
  закрывается между ними); в MembersSection строка получателя живой заявки меняет кнопку
  на danger «Cancel ownership transfer» (isOutgoingPending по ownershipStore).
  (2) **застрявший AFK-мьют после снятия designation** — мод-метки живут в трекере
  пер-канально и ре-сиидятся при каждом заходе; снятие designation ничего не чистило
  (сервер): AfkController.update при уходе designation со старого канала зовёт
  `tracker.clearModeratorMutes(old)` (НОВЫЙ метод трекера: снять mod-mute КАЖДОМУ
  меченому, включая несидящих — иначе ре-сиид воскрешал мьют вечно) + moderateAudio
  unmute сидящим (см. oak-server/CLAUDE.md). — **клиент 568/568, сервер 430/430**.
  **Смоук-фикс раунда 5 (2026-10-02): ЖИВОЙ шаринг не гас при ретро-назначении AFK**
  (юзер шарил, комнату назначили AFK — мьют пришёл, шаринг остался): в VoiceBar
  useEffect [inCall, channelAfk, sharing, cameraOn] — при флаге afk живого канала
  камера/шаринг немедленно останавливаются (stopShare/toggleCamera). КООПЕРАТИВНО:
  серверного видео-мьюта в Janus-обвязке нет (moderateAudio режет только аудио
  m-line; полный kick — единственный форс, осознанно не используем) — та же модель
  доверия, что у селф-тумблеров. Плюс сервер: ретро-мьют сидящих при landing-
  designation (AfkController → applyOnEnter по каждому сидящему; см.
  oak-server/CLAUDE.md). — **клиент 568/568, сервер 431/431**.

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
