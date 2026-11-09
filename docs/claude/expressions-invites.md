# Эмодзи, стикеры, реакции, паки и инвайты — решения

## Попап шара

Контролы зеркалят главный клиент: mute/deafen/NS — подписки (onOwnVoiceControlState, settingsStore.subscribe) + начальный invoke (main хранит последнее); клики — IPC `popout:voiceAction` (toggleSelfMute/Deafen = путь хоткеев; ns-engine = settingsStore.apply); NS-кнопка — тот же NsEngineMenu. Camera/share/leave СОЗНАТЕЛЬНО не зеркалились: управление сессиями из попапа просмотра не нужно. Громкость — обе стороны: стора `volumeChanges`; карточка едет за попапом (remoteGain-проп); обратно `popout:volumeSync` с GRACE-окном 400мс — эхо своего драга не дерётся с ползунком; username-фильтр через ref.

Тулбар: `:hover` УБРАН — reveal по POINTER-ТЕСТУ прямоугольника плашки (pointermove → getBoundingClientRect). Показ строго при наведении на ПЛАШКУ; ГРАБЛЯ CHROMIUM: hover ЗАЛИПАЕТ после leave-fullscreen — pointermove живёт всегда. Семантика: оконный — курсор на плашке; fullscreen — ЛЮБОЕ движение показывает, автоскрытие 2.5с. Focus-держатель УДАЛЁН (клик оставлял фокус → visible навсегда); не-курсорный держатель — NS-меню. Fullscreen-флип и resize ГАСЯТ плашку: якорь перепрыгивает, pointermove молчит. Document mouseleave гасит; скрытие курсора в fullscreen синхронно с плашкой.

## Graceful close голоса

Закрытие крестиком УМНОЕ: main перехватывает первый close (preventDefault + флаг), шлёт `app:closing`, реально закрывает через 900мс; renderer — fire-and-forget teardownCall() + teardownVoice() → STOMP /app/voice.leave; janusClient.destroy() (HTTP POST) убивает janus-сессию сразу → фиды пиров умирают мгновенно, серверный список чистит WS-exit-трекер. Жёсткий kill (краш/taskkill) платит janus-таймаут ~1мин. Мост: WindowBridge.onClosing ← preload removeAllListeners-идемпотентно.

## Кастомные эмодзи

Деплой: сервер первым, клиент следом, НЕ строго парный — старый сервер → getEmojis 404 → markUnsupported(): кнопка и секция скрыты. v1-отступления: клавиатуры в пикере нет (мышь-only), тосты/превью поиска — `:name:` текстом.

Каталожная стор-идиома (Emoji/Sticker/Invites): снапшот несёт САМИ производные (имена/byName/byId-мапы), ребилд ТОЛЬКО в applySnapshot — идентичность для useStore-селекторов; supported-флаг; ConnectionSession += стор + CoalescingRefresher (фетч в start(), /topic/… → ping-рефетч, resyncAfterReconnect).

Сегментер: emoji-пас ПОСЛЕ splitLinks (URL-порт `:8080:` не режется), exec-цикл с lastIndex = match.index + 1 на непопавший токен (`:a:b:` находит `:b:`; matchAll не умеет); без сета имён — байт-идентично прежнему. MessageRow (memo!) подписан на state.names — upload/delete перекрашивает СМОНТИРОВАННЫЕ строки. InlineEmoji: byName + useAttachmentImage; null → текст `:name:`; ФИКС em-бокс 1.375em — нулевой layout shift; картинки через attachmentCache (re-mint валиден, негативный кеш глушит удалённые). Upload-лестница: png/gif/webp → ≤1МБ (сервер лимита не имеет — presigned) → warn-only >256px → имя (a-z0-9_- 1-32 + уникальность) → слот → create; pendingKey кешируется — 409-дубль ретраит ТОЛЬКО create.

Jumbo: сообщение ТОЛЬКО из эмодзи рендерится КРУПНО (правило — isEmojiOnlyMessage; деградация при удалении автоматична). Размер — ЧИСТО КЛИЕНТСКАЯ настройка (юзер: влияет только на смотрящего; серверный вариант — wire/пуш без выгоды): слайдер 18–96, дефолт 48, STAGED. Анти-джамп: estimateRowHeight += jumboEmojiEstimateExtra — доплата max(0, jumboPx−48); рендер и оценка меняются одним кадром.

## Стикеры с паками

Юзер-решения: гейт — существующий MANAGE_EMOJIS (новых бит нет); отправка — мгновенная по клику (стикер-only сообщение, черновик НЕ трогается, вооружённый reply переносится), БЕЗ chip-состояния; v1: rename/перемещение паков и клавиатуры нет. sendMessageWithSticker: content null + stickerId + idempotencyKey → applyLive. Рендер: height 160px ФИКС / max-width 240 / contain (фикс-высота → преплата estimate точна; с jumbo не пересекается); мёртвый объект → tombstone; блок до reactions-row. Кросс-инстанс форвард стикер-only: иначе сервер 400 — байты ре-аплоадятся картинкой (fileName = хвост ключа; dotless→.png). sendSticker делит busy с submit; тосты/поиск без текста: `[Sticker] name`. Грабли: «пусто» гейтить preview.length === 0, НЕ segments.length (highlightSegments("") даёт ОДИН пустой сегмент); крестик Ctrl+F — гейт searchOpen, не query.length.

## Единый пикер выражений

Юзер-решение (модель Discord): ОДНА кнопка-смайл (кнопка-стикер удалена); попап ФИКС 372px, вкладки Emoji | Stickers андэрлайном. Асимметрия клика СОХРАНЕНА (юзер подтвердил): эмодзи — вставка `:name:`, попап живёт; стикер — мгновенная отправка, попап закрыт, черновик цел. Вкладка переживает перезапуск ГЛОБАЛЬНО: pickerLastTab, пишется ТИХО; Stickers при unsupported → фолбэк Emoji. Грабли: align-self: flex-end не работал (.composer был block); поток-сиблинг фикс-ширины ВЫТАЛКИВАЛ список → ABSOLUTE-оверлей (Discord: перекрывает, не сдвигает). Юзер-правило: «старого сервера» НЕ проектируем — клиент и сервер всегда парные; supported-гейты остались, новых усложнений под толерантность не добавляем.

## Реакции

Симметрия гейтов (баг): hover-кнопка гейтится canReact (dm || ADD_REACTIONS), ПКМ-пункт «Add reaction» был виден ВСЕМ → 403 глотался молча; фикс: пункт гейтится canReact, catch логирует.

Кастом: пикер реакций в стиле композерного (372px, поиск, Built-in + Custom, клик = toggle + закрытие, БЕЗ Stickers); кап 20 реакций на сообщение (сервер 400 на 21-ю). customEmojiNameOfReactionSlug: `^:[a-z0-9_-]{1,32}:$` → имя | null; голые built-in слаги → null (`heart` ≠ `:heart:`). Слаг кодируется encodeURIComponent (`:cat:` → %3Acat%3A; ГРАБЛЯ: MockMvc НЕ декодирует %3A в path-variable — кодирование закреплено клиентским rest-тестом). Чипы: хуки БЕЗУСЛОВНЫ (ранний return их не перескакивает); кастом → byName + useAttachmentImage; мимо каталога/мёртвый → текст `:name:`, чип остаётся КНОПКОЙ (onClick тогглит по сырому слагу). Пикер: fixed, якорь — СООБЩЕНИЕ, позиция — чистая reactionPickerPosition (вниз → флип → кламп); pickReaction: mine из снапшота + warn-catch. Вкладка Emoji — ALWAYS (Built-in-секция чисто клиентская); built-in вставляет ГЛИФ (нет `:name:`-токена). Latest — общий MRU (recentExpressions, кап 8, пишется ТИХО, один список на оба попапа). Грабли: повторный клик РЕОТКРЫВАЛ пикер (гонка outside-dismiss(capture) vs тоггл; фикс — anchorRef); отправка закрывает пикер только в УСПЕШНОЙ ветке submit.

## Экспорт/импорт паков выражений (клиент-only)

Сервер не тронут вообще. Юзер-решения: экспорт СЕКЦИОНЕН (Emoji → только эмодзи; Stickers → все паки + per-pack Export); кнопки — ОБЫЧНЫЕ серые размера Upload/Create (грабля ghost «читается как текст», не размер); импорт — МОДАЛКА ПРЕДПРОСМОТРА (планнер вердиктит по живым каталогам, клик исключает, блок — с причиной); конфликты — ПРОПУСК + отчёт.

КЛИЕНТСКИЙ zip: сервер байтов не касается; экспорт качает по свежим presigned (dead-link → unavailable++; пак без выживших файлов выпадает из манифеста); импорт — СУЩЕСТВУЮЩЕЙ лестницей слот→PUT→create (гейты/капы как при ручной загрузке; брошенный при 409 слот — ночной GC); Cancel у прогона нет — докручивается в фоне. Формат: zip + pack.json (formatVersion; чужая version → архив отвергнут); NN в путях = индекс пака; расширение из хвоста ключа. fflate SYNC API (STORE).

Планнер: грамматика → ext → файл есть → ≤1MB → дубль в манифесте (первый выигрывает) → имя занято → кап 200/200/20; паки: точное по trim имя → MERGE, кап паков → весь пак в скипы; одноимённые паки — один план; имена эмодзи/стикеров — НЕЗАВИСИМЫЕ. Вердикты предпросмотра ПРЕДПРОСМОТРИТЕЛЬНЫ: конфликт при подтверждении = runtime-conflict; пак create при 409 → переиспользование по имени; провал создания пака → его импорты в skip-limit. Грабли: `\u0000`-эскейп в исходнике коллапсируется в NUL-байт — контроль-чарс ловить `\p{C}`/u; превью — blob-URL из архива; Confirm строит ОТФИЛЬТРОВАННЫЙ манифест.

## Инвайт-регистрация

Регистрация — ТОЛЬКО по ссылке (`#invite=<secret>`, сервер собирает из advertised host/port); пустая ссылка = bootstrap-регистрация ПЕРВОГО юзера (OWNER — до provisioning; Create = заглушка; юзер: овнер создаётся АВТОМАТИЧЕСКИ при создании сервера из клиента — отдельной формы НЕТ). Серверный bootstrap-гейт (count()==0 → OWNER) ОСТАЁТСЯ API-контрактом — клиент не использует.

LoginModal: 3 вкладки underline (как Roles): Create-заглушка / Log in / Register — Invite link (ОБЯЗАТЕЛЬНО, первым полем) + Nickname (опц.) + Username + Password; адреса-поля НЕТ — адрес = origin ссылки. parseInviteLink — lenient: hash/query tolerated, автопрефикс http:// (иначе «host:» читается как протокол). register(..., {nickname?, inviteSecret?}) — поля в тело ТОЛЬКО когда заданы (голая bootstrap = legacy 2-поле wire); InviteLink несёт secretPreview — секрет на провод НЕ ездит, Copy копирует собранный link. Секция Invites: после Members, гейт MANAGE_MEMBERS (юзер: «ссылки раздаёт тот, кто может добавлять членов»); TTL ретроактивен.

Live: InvitesStore + /topic/invites (ping = рефреш; рефетч НЕ на старте — чтение админское; 403 плебеев глотается ТИХО); сервер пингует AFTER COMMIT (иначе рефетч опережает коммит). TTL в МИНУТАХ: живой перевод formatTtlWords (d/h/min, без месяцев); Save — ОТДЕЛЬНОЙ строкой; черновик не перезатирается снапшотами (ttlTouchedRef). Удаление АКТИВНОГО сервера свитчит на выжившего: removeConnection → switchConnection(самая свежая запись) — фоновая сессия промоутится, мёртвая семья → логин-модал.
