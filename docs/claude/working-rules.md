# Правила работы, механики и отступления — решения

## Юзер-правила
- **Библиотека после двух осечек:** ~2 неудачных ручных фикса одного корня → третий шаг не новый фикс, а общепринятая библиотека/штатный механизм платформы (прецедент: скролл-джанки → @tanstack/react-virtual). Порог именно две осечки — зависимости не тащатся с первого чиха.
- **Ленивое создание сущностей:** «Start discussion» ничего не создаёт на сервере — локальный черновик; первое сообщение = один вызов startDiscussionWithMessage; сервер создаёт тред вместе с сообщением; конфликт переиспользует чужой (200; 409 — только голый messageId).
- **UI только английский:** русские подписи — отступление ассистента, не юзера.
## Осознанные отступления от oak (юзер-решения, НЕ «чинить» при сверках)
- room view: нет «· N screens» при нуле шаров (oak: «0 screens»).
- speaking-рамка: CSS-fade (oak свапает мгновенно).
- forward-карточка: ЖЁЛТАЯ полоса, не blurple как reply — различимость лучше.
- плейсхолдер композера: динамический, имя канала (oak: статичное «Message...»).
- цвет ника автора: цвет высшей роли (oak: палитра по нику).
- порядок каналов: серверный, без алфавита внутри типа (oak: case-insensitive алфавит).
- «(you)» в голос-строках сайдбара (oak: self только в ростере/тайлах).
- ростер скрыт в dmMode (oak: остаётся видимым — их недоделка, не тащить).
- Members: аватары у строк (oak: имя + бейджи).
- «Reset to inherit» удалена (сброс = всё Inherit + Save).
- User Settings: Apply слева у контента (oak: справа-снизу); APM-тоггл удалён (флаг — только NS-кнопка); General-аватар = Overview-идиома (без Profile/dnd/Re-crop); Notifications — «All messages/Mentions only/Nothing» (oak: сырые enum).
- Home-бейдж: DM-unread + pending friend requests (oak: только DM).
- confirm-модали на Remove friend/Block (oak бьёт сразу).
- OS-нотификации удалены вовсе — канал «поверх всего» один: окно тостов.
- дефолт per-server уведомлений: Mentions only (oak: All) — анти-спам; ALL включают осознанно.
- не-mention в фокусном окне не тостит (oak: тихая карточка) — не дёргать фокус.
- фоновые применяют suppressEveryoneHere к красному бейджу (oak в фоне prefs не применяет).
- медиа-раунд: парный деплой только сервер↔клиент; зеркало oak-client НЕ обновляется.
## Окно тостов поверх всего
Отдельное always-on-top окно, не DOM главного и не OS-нотификации (в oak — воркэраунд мёртвого TrayIcon, у нас архитектурный выбор). Frameless+transparent+alwaysOnTop("screen-saver")+skipTaskbar+нефокусируемое; lazy-create на первом тосте, hide() при пустом стеке; правый-низ экрана; высота под стек (bottom-anchored setBounds). Сквозность: `setIgnoreMouseEvents(true,{forward:true})`; #toasts-экран хит-тестит mousemove → main флипает интерактивность. Клики — ПО id через main в renderer (cardCallbacks; клик = focus + действие). Грабли: StrictMode дублировал IPC-подписку → дубль-карточки (popout тоже без StrictMode; preload toast:* — removeAllListeners перед подпиской); empty() на монтаже прятал окно → первый тост невидим (empty только на переходе к пустому); тосты до загрузки страницы терялись → буфер в main до `space-toast:ready`; геометрия = высота+16.
## Фоновые STOMP-сессии
Каждая учётка записи держит живую ConnectionSession; свитч сервера промоутит фоновую без teardown (каналы из живых сторов). Гейт isActive() (makeSessionHooks): глобальный UI (статус/voice/звонки/роутинг) — только активная; фоновые ведут свои счётчики, DM-строки и тосты с prefs записи, кик = тихий dispose + REST-фолбэк. Агрегат: троттлинг 1 с → socialDirectory; REST — записи без сессии. Лестница фоновых реконнектов тихо перезапускается (пауза 30 с).
## Пины
Карусель «последний пин + ‹› + i/N» (НЕ Discord-список), кап 50. Снапшот `GET /messages/pinned` при открытии (DM тоже); live: `.edited`-пуш → applyFromMessage ПРЯМО, не messageStore.applyEdited. Дедуп эха — только рендерящиеся поля: presigned-URL переподписывается на каждый fetch, байт-сравнение ложно. PinCard над NowPlayingBar; клик → openChannelAtMessage; ПКМ Pin/Unpin (dm || MANAGE_MESSAGES).
## Обсуждения/треды (НЕ-Discord UI)
Тред = DISCUSSION-канал; виден только через discussion-API. События (CREATED/ACTIVITY/REMOVED на `.discussions` родителя) несут ПОЛНУЮ строку: tracked локальной строки ПОБЕЖДАЕТ broadcast-false (трекинг viewer-scoped). ACTIVITY несёт ПОЛНОЕ сообщение → неподписанные гоняют формулу упоминания → setTracked + тост + bell; упомянутый подписывается и пингуется (сервер авто-джойнит; автор исходника — на первом ответе, один раз); свой пост/открытый тред гасят. Store: version-счётчик для императивных селекторов (useStore по синглтону не триггерится); производные на СПРОС. Подписка топиков треда пишет только в messageStore, onLiveMessage НЕ зовётся (бейдж родителя не бампается, тосты не летят); StompClient без unsubscribe → сет-guard, реконнект накатывает заново. Mention-хук: serverMode=MENTIONS даже при ALL. REMOVED — единственный close-сигнал; bare-Long на channel.{id}.deleted отклонён; закрытие — confirm-модал. UI: чат треда — адаптер chatChannel (права от родителя); вместо PinCard — панель исходника (Follow/Unfollow/Close, гейт MANAGE_MESSAGES); 409 → открыть существующий; фоновый тост → openDiscussionOnInstance.
## Оффлайн-старт и boot-лестница
Кэш картинок в main; session=null → синглтон dormantAttachmentCache: только диск, никогда сеть. Провал авто-резюма (токены живы) → retryBootResume: 2 с → 2/4/8/16 → каждые 30 с бесконечно; стоп: сессия/удаление записи/смерть токенов; bootResumeRecordId исключает из startBackgroundSessions. Мёртвый старт фоновой — revival каждые 30 с.
## Прыжки к сообщению (around/jumpTo)
Первый скролл после around-замены неточен (оценки высот; reconcile стопится после одного кадра) → scheduleSettlingJump: затухающие повторы центрирования со свежими измерениями; ввод отменяет; все 3 сайта заменены.
## Серверное меню рейла (ПКМ)
serverMenu в appStore; ServerMenu.tsx работает без сессии; триггеры — клик по шапке и ПКМ по .rail-wrap (любая запись); Server Settings — гейт по маске самой записи. На неактивной: сначала свитч, открыть только если приземлился — иначе настройки ПРЕДЫДУЩЕГО сервера.
## DM-лист Home: инварианты
Промоут: unbindLiveBackgroundSession + socialDirectory.drop — иначе активная в background-снапшотах, DM сливается дважды, дубли recordId:dmId роняют React-владение; демоут привязывается с гвардом. Свою запись фильтровать из background ДО слияния (вне селектора — идентичность). bind/unbind — rebuild сразу; коалесинг 1 с — только дельты сторов. Сортировка mergeDmRows: свежесть → dmDisplayName → сервер → recordId → dm.id. Аватарки агрегатов — ОДИН дорзанный кэш (session=null + override key/url; Avatar: cachedUrl ?? uncachedUrl; иначе promote моргает инициалами).
## Ресайз окна
Белые вспышки: `html{background:var(--sp-darkest)}` (канва html белая) + сброс для toast-оверлея; ремни: themeSource="dark" (DWM), hookWindowMessage(0x14). Прыжки чата: ручная компенсация (measure+якорь) удалена; tanStack сам переразмеривает и компенсирует скролл. Нативный коллапс окна в ~44px на тике драга — мимо JS-API; will-resize-гвард: <300 при >500 за шаг = preventDefault (драг — лесенка тиков); источник не найден (кандидат koffi).
## Медиа: кэш, размеры, префетч
Негативный кэш: 404 (по свежему mint) → ключ мёртв до конца сессии; transient → backoff 30 с; успех реабилитирует. Резерв бокса: wire width/height (парный деплой) — первый бокс из wire, видео — reserved до превью; легаси — media-dims.ts. Префетч: idle, параллелизм 2, новейшие-первыми, КАП 24. Корень фризов — синхронный FS в main (writeFileSync, trim после каждой записи; longtask в рендерере НЕТ — затор в main): fs.promises, trim-дебаунс 30 с. url=null → тихий null БЕЗ mint/backoff — link минтит только MESSAGE-аттачи, mint-нуль для server-аватаров давал вечный backoff (инициалы навсегда). Аватарка записи — через СВОЮ сессию: sessionForRecord (активная→фоновая→null), без сессии dormant.
## Попап шара
frame:false + общий CaptionBar; IPC контролов — по SENDER (fromWebContents), не хардкод mainWindowRef; защиты главного зеркальны (0x14, will-resize). Громкость — пульт плейауту главного окна (попап video-only): слайдер → IPC → popout:volume → setShareVolume — путь слайдера ростора (персист). feedHasShareAudio (audio ≥2): видео-only → DISABLED + «no audio» (показывать, но дизейблить); volume НЕ в fingerprint детектора — громкость не перезапускает подписку. Fullscreen: Esc — выход (Chromium сам не выходит). Грабля: fingerprint сбрасывать на onClosed — иначе повторное открытие того же фида пусто.
## Мелочи и конвенции
`button{padding:8px 14px}` бьёт иконки — inline-flex+center+padding:0. Снятие роли: MANAGE_MEMBERS + canActOn + топ-роль актора выше снимаемой (OWNER без кнопки); PUT full-replacement минус роль; window.alert; @everyone не в roleIds. Нейтральный .list-row (не .friend-row). Временная диагностика снимается перед коммитом. fake timers → vi.resetModules сначала.

## (продолжение механик)

## Инвайты и файлы

- Инпут TTL фикс-ширины 128px (влезает длиннейший перевод, ввод ничего не сдвигает). Claim = DELETE (повтор ссылки = «not valid»); истёкшие чистит InvitesCleanup PT6H.
- Плитка файла: sizeBytes wire append-only (знает только отправитель; легаси null → без размера); скачивание ТОЛЬКО через клиент (OS-диалог), openExternal удалён (юзер-требование).

## Категории каналов

- Порядок: uncategorized text/voice → категории (внутри: text сверху, voice снизу); ребёнок скрытой категории → uncategorized, не исчезает; пустая видна только менеджеру; collapse — Set без персиста. Дроп канала НА заголовок категории = ВНУТРЬ; no-op → null. Персист: PUT /api/channels/order полным списком, оптимистично, catch → откат.
- Drag: порог 4px, ghost ЧЕРЕЗ ПОРТАЛ fixed (скролл клипает absolute — rail-bubble-урок); handle voice-блока только name-row.

## Удаление и овнерство

- Kick = «Remove from server» навсегда. Сообщения не тронуты: автор вечно через /api/users (tombstone, ник освобождается); смена username → renameAuthor по authorId в loaded-каналах + applyUserRename по СТАРОМУ ключу.
- Передача овнерства: вход Settings → Members (не ServerMenu); кнопка видна ТОЛЬКО овнеру (не disabled — НЕ ВИДНА); стейдж-модал (живая заявка: отмена или «Cancel & continue»); OwnershipStore с фетчем в start() — заявка переживает офлайн; username из connectionDirectory (хук-фабрика без session — грабля).
- Пуши не внутри tx — pushAfterCommit (иначе рефеч читает докоммитное).

## AFK-канал

- AFK = свойство канала (не глобальный селектор); назначен другому → вкладка read-only. Discord-факты: AFK живёт и в категории, server-mute юзером не снимается, стрим запрещён.
- Активность = ввод всего ПК ИЛИ говорение (idle < 60, юзер-критерий); нет idle-моста → +Infinity (никогда ложный «активен»); репорт 30с.
- joinVoice в afk НЕ чистит мод-метки/комплаенс (мьют приходит ДО MOVED). Снятие designation: трекер чистит mod-mute каждому меченому, включая несидящих. Ретро-назначение: сервер мьютит сидящих, клиент гасит шар/камеру. Серверного видео-мьюта в Janus нет — модель доверия селф-тумблеров.
- sameChannel сравнивает ВСЕ wire-поля (afk, бейджи) — иначе applySnapshot держит старую ссылку; тот же гейл в PermissionStore-дедупе.

## Пермишшены

- NOT_IMPLEMENTED = только реальные never-enforced; RESTRICT скрыт у @everyone (бит на базовой роли игнорируется сервером — чекбокс был бы ложью); держатель MANAGE_SERVER открывает Settings.
- Запрет ЛС: self-блок везде, peer-блок ТОЛЬКО 1:1 (группа жива); фильтры пикера ВНЕ селектора в useMemo (M6-грабля); история/тосты DM не тронуты.
- Редактор роли: единый RoleDraft над вкладками, ОДНА Save — один PATCH на всё; контракт «color безусловен, null = сброс» → color-less PATCH не существует; ошибка → черновик НЕ откатывается; Members вне черновика.
- Dirty-чек: двусторонее равенство (union == оба размера) — односторонний subset ловил только добавление бита.
- SPEAK/STREAM: micLocked = permMuted || channelAfk (хоткей — тихий return); canStream `?? true` — неехавший бит читается разрешающим (сервер авторитет); кнопка скрыта при запрете, но живёт пока идёт шар; потеря STREAM гасит шар; DM не гейтит шар; joinVoice дотягивает ensureChannelPermissions.

## Безопасность

- SSRF-гейт preview: private/loopback/link-local/CGNAT v4+v6, непарсящееся блокируется (fail closed); только http/https; DNS-резолв ДО запроса; редиректы manual с перепроверкой каждого Location (лимит 4); блок → тихий no-preview. Резидуал (документирован): DNS-ребайндинг TOCTOU.
- KV connection:* шифруются safeStorage (enc:v1:); plaintext мигрирует при первом письме; недоступен → как есть + ОДИН WARN; шифротекст без кейчина = ОТСУТСТВУЮЩИЙ (needs-re-login).
- logoutAll НЕ в UI (локальное удаление записи не должно убивать сессии других машин); removeConnection ревокует refresh ДО remove. Дроп-оверлей без ATTACH_FILES скрыт; preventDefault безусловен.

## Голосовой UI

- Приглашение в голос: только онлайн-друзья (карточка без persist), отправка по одному; приём — тост-карточка (стекится, TTL 60с); IPC-действие прокидывается вручную в 4 местах — известная грабля.
- Просмотр шара = ОТДЕЛЬНОЕ окно отовсюду (in-app поверхности нет — юзер-вердикт); retargetPopout СИНХРОННО ДО openPopout — ноль React-эффектов; закрытие окна = конец просмотра; onClosed в bootstrap.
- Видео шара не дублируется в main: wantedStreams только share-AUDIO (у попапа своя подписка); «video»-ветка handleRemoteTrack — WARN-канарейка регресса.
- Рецикл m-line (Janus повторно не стреляет ontrack): deliverRemoteTrack — единый путь с дедупом feedId:trackId; свип транссиверов после каждого setRemoteDescription и attached/updated. Глиф mdi-monitor-eye (arrow-down читается «скачать»).

## Логи и диагностика

- Ротация: часовые бакеты space-YYYYMMDD-HH.log (UTC), чистка старше 24ч скользящим окном; boot-строка с версией/ОС. Невидимые фейлы логируются: любой не-OK REST (5xx/429 warn, 4xx info), аудио-play (DOMException с name), window error + unhandledrejection; бенигн-teardown не трогаем.
- Выгрузки: client-logs-/server-logs-<stamp>.zip; клиентские — IPC + zipSync level 6; cancel ≠ error; серверные — authedBytes, таймаут 120с; блок Logs в Settings → Server — всё в одном месте (юзер-решение).
- Логи клиента — не серверное дело: Diagnostics доступна каждому без прав; «Address to enter» без advertised = фактический hostUrl записи. В логах нет токенов/контента; postgres bind-значения глушатся log_parameter_max_length=0. Service health: 404 → поллинг стоп (старый сервер), иначе retry 30с.

## Конвенции

- Закреплённый футер (Roles/Channels/Keybinds): список flex:1 + min-height:0 до черты, Save прижата к низу. Обсуждения: вход только бейдж-глифом, выход — back-кнопка; «назад» = последний текстовый канал.
- Гейт фазы: npm test + typecheck (UI — ещё build); новые файлы сразу git add; коммиты по явной команде; без single-letter имён (кроме i/j, T/E/K/V); тесты на поведение; логика — в чистых функциях, обвязка тонкая.
