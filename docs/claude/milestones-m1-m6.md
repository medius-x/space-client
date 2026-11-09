# Вехи M1–M6 + wire-контракты чата

## Хвост M7: нативный шар-аудио, пикер качества, поп-аут

- Ватчдог оконного шара (`window-liveness.ts`: koffi IsWindow, 500 мс; IPC `watchSource`/`sourceDead`): ended getDisplayMedia при закрытии окна ненадёжен (WGC), страховка oak-парити.
- Призрак шара на зрителе: (1) Janus держит остановленные стримы в списке как DISABLED → «есть экран» = `feedHasLiveVideo`. (2) remote-видео после отписки muted (не ended) → `pruneDeadView` гасит просмотр и чистит viewingFeed. (3) Janus рециклит m-line подписчика → тот же track → ontrack повторно НЕ стреляет → runtime удерживает треки, флип [viewingFeedId, participants] ре-биндит.
- Битрейт: потолок паблишера Janus = 1 Мбит/с (ensureRoom без `bitrate`; REMB) — пресеты кодировались в ~1. Фикс: PUBLISHER_BITRATE_CEILING_BPS=20 Мбит/с в publisher-join и каждой configure → единственный кап = sender maxBitrate пикера; room-level осознанно не сделан.
- Поп-аут — своя videoroom-подписка (`popout-viewer.ts`, только video по mid); JPEG-насос удалён (MediaStream не переходит между процессами).
- Пикер Quality (`share-quality.ts`): дефолт Medium 24fps/1080p/3Mbps (oak: High); «Source» = натив без капа; качество применяется и к камере; звук: экраны всегда, окна при native, камера никогда; Source/удаление пресетов — сверх oak.
- Грант: кэш sources 30 с; умершее окно = честный отказ; стартовый фриз — платформенный; монитор сис-звука — в выбранный спикер.
- Стенд: 2 инстанса на машине = фидбек-луп (TAP рендера минус своё дерево); рвёт только глушение рендера принимающего (B deafen, A монитор). AEC-референс НЕ делаем (нет API; риск #483) — наушники; koffi = #470.

## Мини-раунд UX

- Стук на вход/выход собеседника в моей голосовой (Discord-семантика): onVoiceMemberEvent из /topic/voice (гейт: свой канал, чужой).
- Шапка сайдбара = выпадайка из ПКМ сервера (ПКМ ServerRail удалён); Account settings: scope account (General+Account) / client.
- Server Settings показывает nickname; grantedUserLabel() = nickname ?? логин ?? #id.
- Отобранная роль: /topic/roles и /topic/members зовут refetchChannels() (каналы VIEWER-фильтрованы); restoreLastChannel/ensureActiveChannelExists/pendingOpenChannel игнорят locked.

## M6: друзья, DM, ростер, модерация

- Relationships: GET /api/users/me/relationships (FRIEND|BLOCKED|PENDING_INCOMING|PENDING_OUTGOING); POST /friends {username} (взаимный pending авто-акцепт), accept PUT /friends/{id}, cancel/decline/unfriend = ОДИН идемпотентный DELETE /friends/{id}; блок POST/DELETE /blocks. Пуш /user/queue/relationships: любое событие = refetch; снапшоты после подписок; CoalescingRefresher: событие в полёте переигрывается.
- DM: GET /api/channels/dm (в /api/channels их НЕТ); 1:1 = POST /api/channels/dm {recipientId} (get-or-create); группа = POST /api/channels/group-dm (3–10, создатель owner); rename = ГОЛЫЙ PATCH /api/channels/{id} (у серверных — /{id}/name!); участники = POST/DELETE /{id}/participants[/{userId}] (self = leave; ушедшему нет события → forget); close = DELETE /api/channels/dm/{id} (owner у групп). Пуш /user/queue/dm.channels = refetch; CREATED мержится из пуша; CLOSED — локальный forget. DM-unread = mention-эквивалент (бейдж+колокольчик, Home = сумма).
- UI: Home ⌂ (dmMode; серверный канал ПЕРЕЖИВАЕТ Home — activeDmId отдельно; клик по серверу = exitHomeMode); ChatPane канало-агностичен (dmViewChannel).
- Ростер: GET /api/members (roleIds+owner) + /api/roles (color ARGB int — отрицательные норма; position, hoist); группировка клиентская: hoist по высшей hoist-роли (OWNER/офлайн не hoistит), position desc → Online → Offline; цвет ника = высшая роль с цветом; /topic/members+/topic/roles = ping → refetch.
- Модерация: ПКМ Kick/Ban (owner иммунен; проверяет сервер); жертве /user/queue/member.kick → teardown + логин-скрин. Блокировка: клиент ничего не скрывает (сервер гейтит blockedEitherDirection).
- applyLive: onLiveMessage и при дропе «незагружен» (`inserted || !isLoaded`; молчит только echo) — иначе неоткрытый DM без бейджа/тоста; bumpLive сеет read-state.

## M5: P2P-звонки

- Сигналинг: /app/call.signal → релей в /user/queue/call.signal (штампует from); CallSignal{type, to, sdp?, candidate?}: RING/ACCEPT/REJECT/HANGUP/OFFER/ANSWER/ICE (+статусы CAM/MIC/SCREEN); IceCandidate{sdp, sdpMid, sdpMLineIndex}; ICE/TURN из GET /api/call/config.
- `peer-call.ts`: ренего НЕ существует; m-line initial offer: [0] голос, [1] видео (камера ИЛИ экран — один слот), [2] шар-аудио; старт/стоп = replaceTrack по слотам; stereo=1 в последнюю m=audio; maxBitrate 256k на шаре; trickle-буфер до SRD; входящие треки по слоту m-line.
- Критические инварианты: (1) replaceTrack по слоту, согласованному БЕЗ трека (нет msid), не анонсирует источник — ontrack не стреляет; лечит пассивный бинд receiver.track пустых слотов после каждого SRD; ontrack авторитет только voice-слота. (2) Chromium при SRD может не сматчить пустые транссиверы → адресация по a=mid из SDP, не по индексу.
- ICE-restart только caller (glare невозможен): failed → лестница 1/2/4/8/16 с; транзиентный disconnected игнор.
- runtime: idle/ringing-out/ringing-in/connecting/in-call; busy = авто-REJECT; ring-timeout 60 с; gap-timeout 30 с; эксклюзив комната↔звонок модалами; RoomAudio-цепи фидов -1/-2; call-deafen = setDeafened + implied mute мика (voice-control в P2P нет); трек до монтирования `<video>` держит runtime.
- Presence-гонка: снимки presence/voice-members строго ПОСЛЕ подписок; дельты буферизуются в RosterStore, накатываются поверх; провал снимка закрывает буфер.

## M4: голос-парити

- /app/voice.mute|deafen|kick {channelId, targetUsername, muted?, deafened?}; self-ветка без прав; /topic/voice.state: union muted/deafened + ЯВНЫЕ origin-флаги self*/mod*. Комплаенс voiceCompliance ВНЕ SfuSession (переживает rejoin): мик по union, share-аудио только по modMuted (self-mute музыку не глушит — Discord), deafen = setDeafened; тумблеры читают только self-флаги. KICKED = /user/queue/voice.control → leaveVoice. ПКМ тайла: Server mute/deafen/kick; марки 🔇/🎧 жёлтый self / красный mod.
- Камера: startCamera/stopCamera — второй video m-line, ВЗАИМНОЕ ИСКЛЮЧЕНИЕ с шаром (один видео-слот, oak-модель); у зрителей Watch-семантика.
- Грант шара: единственная точка — setDisplayMediaRequestHandler с pendingGrant (renderer-констрейнты ненадёжны); loopback-аудио только у целых экранов.
- Rejoin: onSessionLost/live-426 → лестница 1/2/4/8/8 с, кап 5 → выход + voice.leave; join-426 = один ретрай через свежий /room. Subscriber-PC connectionState: failed → та же лестница; disconnected-транзиент игнор. Стуки join/leave (knock-sound.ts).

## M3: вложения и медиа

- Аплоад 2-фазный: POST /api/attachments {fileName} → {key, uploadUrl} → голый PUT в MinIO (Content-Type, без авторизации — подпись в query); видео — клиентский JPEG-превью; композер paste + drag-drop, кап 10, гейт ATTACH_FILES.
- Рендер: мозаика 1 / 2–3 в ряд / 4+ грид; видео-модал fresh-link; аудио + NowPlayingBar — ОДИН общий трек (playback.ts: resume без смены src; fresh-link с позицией; стоп при смене канала); файлы → openExternal.
- Кэш (attachment-cache.ts): objectURL LRU 32 → диск (IPC space-cache:*, LRU 256 МБ, ключ = MinIO key — presigned переподписывается) → сеть; fresh-link на 403/404.
- Аватары: оригинал ≤2048 + кроп 256; Re-crop из оригинала (GET /api/users/me/avatar/original); live /topic/users. Кросс-инстанс форвард: downloadBytes → uploadBytes (врем. RestClient).

## M2: глубина чата + VirtualList

- edit (PATCH {content}) / delete (свой или MANAGE_MESSAGES); replies depth-5, live-патчинг цитат ЛОКАЛЬНО (reply-tree.ts; сервер не пушит); forwards: same-instance копирует сервер, cross — снапшот временным RestClient (аттачи — с M3); reactions: 10 слагов, БЕЗ point, toggle-mine; mentions по server-офсетам; read-states (сеяние GET /api/read-states; ack; divider NEW); уведомления: тосты ≤3, OS Notification, колокольчик ТОЛЬКО mention.
- VirtualList = @tanstack/react-virtual 3.14 (джанк-регрессии самописной математики): measureElement; prepend-якорь + 3 layout-прохода; jump-бэкфиллом кап 1000; pointer-events:none строк при скролле. Пагинация вверх (HISTORY_PAGE=50, конец по СЫРОЙ странице); мультиселект. Отложено: markdown-lite, day-dividers, @автодополнение, live-роли.

## M1: ConnectionSession + каналы + чат-ядро

- M0: electron-vite + React 19; сторы Emitter + useSyncExternalStore; runtime-синглтон ВНЕ React-дерева (HMR не роняет голос); React запрещён вне src/renderer.
- KV (JSON в userData); записи connection:{uuid} (токены/lastChannelId/громкости); ConnectionSession = rest+stomp+сторы (Channel/Message/Roster/Permission) на подключение + роутинг топиков; Enter=send, Ctrl+Enter ИЛИ Shift+Enter=newline (контракт oak); create/rename/delete live; композер скрыт без SEND_MESSAGES (GET /api/channels/{id}/permissions/me), «+»/ПКМ каналов — MANAGE_CHANNELS (GET /api/users/me/permissions); громкости в записи.

## Wire-контракты чата (ground truth, выжато из oak-server)

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
