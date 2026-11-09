(function() {
const remap = {
    "play_pause": "playpause",
    "seek_forward": "fastforward",
    "seek_backward": "rewind",
    "host:fullscreen": "togglefullscreen",
    "cycle_audio": "changeaudiotrack",
    "cycle_subtitles": "changesubtitletrack",
    "increase_volume": "volumeup",
    "decrease_volume": "volumedown",
    "step_backward": "previouschapter",
    "step_forward": "nextchapter",
    "enter": "select",
}

let pendingMusicVideoPageAdvance = null;

function getMusicVideosPlaybackQuery(libraryId, librarySettings, startIndex) {
    const filters = librarySettings.Filters || {};

    return {
        parentId: libraryId,
        recursive: true,
        includeItemTypes: ['MusicVideo'],
        sortBy: Array.isArray(librarySettings.SortBy) && librarySettings.SortBy.length
            ? librarySettings.SortBy
            : ['SortName'],
        sortOrder: [librarySettings.SortOrder || 'Ascending'],
        startIndex,
        limit: 1,
        nameLessThan: librarySettings.Alphabet === '#' ? 'A' : undefined,
        nameStartsWith: librarySettings.Alphabet && librarySettings.Alphabet !== '#'
            ? librarySettings.Alphabet
            : undefined,
        filters: filters.Status,
        genres: filters.Genres,
        officialRatings: filters.OfficialRatings,
        tags: filters.Tags,
        years: filters.Years,
        studioIds: filters.StudioIds,
        audioLanguages: filters.AudioLanguages,
        subtitleLanguages: filters.SubtitleLanguages,
        videoTypes: filters.VideoTypes,
        seriesStatus: filters.SeriesStatus,
        hasSubtitles: filters.Features?.includes('HasSubtitles') ? true : undefined,
        hasTrailer: filters.Features?.includes('HasTrailer') ? true : undefined,
        hasSpecialFeature: filters.Features?.includes('HasSpecialFeature') ? true : undefined,
        hasThemeSong: filters.Features?.includes('HasThemeSong') ? true : undefined,
        hasThemeVideo: filters.Features?.includes('HasThemeVideo') ? true : undefined,
        isHd: filters.VideoBasicFilter?.includes('IsHD')
            ? true
            : filters.VideoBasicFilter?.includes('IsSD') ? false : undefined,
        is4K: filters.VideoBasicFilter?.includes('Is4K') ? true : undefined,
        is3D: filters.VideoBasicFilter?.includes('Is3D') ? true : undefined
    };
}

function getVisibleMusicVideosPageRange(itemsContainer) {
    const pageLabel = document.querySelector('.MuiToolbar-root.padded-left .MuiChip-label')
        ?.textContent?.trim();
    const values = pageLabel?.match(/[\d][\d,.\u00a0\u202f]*/g)
        ?.map(value => Number(value.replace(/[^\d]/g, '')));

    if (!values || values.length < 3) {
        return null;
    }

    for (let start = 0; start < values.length; start++) {
        for (let end = start + 1; end < values.length; end++) {
            if (values[start] < 1 || values[end] < values[start]) {
                continue;
            }

            const total = values.find((value, index) => (
                index !== start && index !== end && value >= values[end]
            ));
            if (total !== undefined) {
                return {
                    startIndex: values[start] - 1,
                    endIndex: values[end],
                    total,
                    label: pageLabel
                };
            }
        }
    }

    return null;
}

function advanceMusicVideosPageOnPlayback(playbackManager, playerState) {
    const pendingAdvance = pendingMusicVideoPageAdvance;
    if (!pendingAdvance) {
        return;
    }

    const nowPlayingItem = (playerState || playbackManager.getPlayerState())?.NowPlayingItem;
    console.info('Input Plugin: Checking queued Music Video page advance: ' + JSON.stringify({
        expectedItemId: pendingAdvance.itemId,
        currentItemId: nowPlayingItem?.Id || null,
        libraryId: pendingAdvance.libraryId
    }));
    if (nowPlayingItem?.Id !== pendingAdvance.itemId) {
        return;
    }

    pendingMusicVideoPageAdvance = null;

    const currentRoute = window.location.hash.split('?')[0];
    if (currentRoute === '#/video' && pendingAdvance.pageSize > 0) {
        const settingsKey = `musicvideos - ${pendingAdvance.libraryId}`;
        const librarySettings = {
            ShowTitle: true,
            ShowYear: true,
            ViewMode: 'grid',
            ImageType: 'Primary',
            CardLayout: false,
            SortBy: ['SortName'],
            SortOrder: 'Ascending',
            StartIndex: 0
        };
        try {
            const savedSettings = window.localStorage.getItem(settingsKey);
            if (savedSettings) {
                const parsedSettings = JSON.parse(savedSettings);
                if (!parsedSettings || typeof parsedSettings !== 'object' || Array.isArray(parsedSettings)) {
                    throw new Error('Stored library settings are not an object.');
                }
                Object.assign(librarySettings, parsedSettings);
            }
            librarySettings.StartIndex = Math.floor(pendingAdvance.itemIndex / pendingAdvance.pageSize) *
                pendingAdvance.pageSize;
            window.localStorage.setItem(settingsKey, JSON.stringify(librarySettings));
        } catch (error) {
            console.error('Input Plugin: Could not restore the next Music Videos page:', error);
        }

        console.info('Input Plugin: Saved the Music Videos page containing the queued video.');
    }

    const nextItemIndex = pendingAdvance.itemIndex + 1;
    Promise.resolve()
        .then(() => playbackManager.getItemsForPlayback(
            pendingAdvance.serverId,
            getMusicVideosPlaybackQuery(pendingAdvance.libraryId, pendingAdvance.librarySettings, nextItemIndex)
        ))
        .then(result => {
            const nextId = result?.Items?.[0]?.Id;
            if (!nextId) {
                console.info('Input Plugin: No further Music Video is available to queue.');
                return false;
            }

            pendingMusicVideoPageAdvance = {
                ...pendingAdvance,
                itemId: nextId,
                itemIndex: nextItemIndex
            };
            return playbackManager.queueNext({
                ids: [nextId],
                serverId: pendingAdvance.serverId
            }).then(() => true);
        })
        .then(queued => {
            if (queued) {
                console.info('Input Plugin: Queued the following Music Video.');
            }
        })
        .catch(error => {
            console.error('Input Plugin: Failed to queue the following Music Video:', error);
        });
}

function playVideosFromLibrary(event, playbackManager) {
    const actionElement = event.target?.closest?.('[data-action]');
    const action = actionElement?.getAttribute('data-action');

    if (action !== 'play' && action !== 'resume') {
        return;
    }

    pendingMusicVideoPageAdvance = null;

    if (window.jmpInfo?.settings?.main?.playAllVideosFromLibrary === false) {
        console.warn('Input Plugin: Library queue setting is disabled.');
        return;
    }

    console.warn('Input Plugin: Detected a Play/Resume click: ' + JSON.stringify({
        action,
        setting: window.jmpInfo?.settings?.main?.playAllVideosFromLibrary
    }));

    const card = actionElement.closest('[data-id][data-serverid][data-mediatype="Video"]');
    const itemsContainer = card?.closest('.itemsContainer');

    if (!card || !itemsContainer) {
        console.warn('Input Plugin: Could not handle video play click.', {
            cardFound: !!card,
            itemsContainerFound: !!itemsContainer
        });
        return;
    }

    const siblingCards = itemsContainer.querySelectorAll('[data-id][data-serverid][data-mediatype="Video"]');
    const cardIndex = siblingCards ? Array.prototype.indexOf.call(siblingCards, card) : -1;

    if (cardIndex < 0) {
        console.warn('Input Plugin: Clicked video was not found in its library item list.', {
            visibleVideoCount: siblingCards?.length || 0
        });
        return;
    }

    let nextVideoCard = null;
    for (let i = cardIndex + 1; i < siblingCards.length; i++) {
        if (siblingCards[i].getAttribute('data-mediatype') === 'Video') {
            nextVideoCard = siblingCards[i];
            break;
        }
    }

    let nextVideoId = nextVideoCard?.getAttribute('data-id');
    let nextVideoPromise;
    let musicVideoNextIndex;

    const routeQuery = window.location.hash.split('?')[1] || window.location.search.slice(1);
    const routeParams = new URLSearchParams(routeQuery);
    const libraryId = routeParams.get('topParentId') || routeParams.get('parentId') ||
        itemsContainer.getAttribute('data-parentid');
    const modernLibraryPage = itemsContainer.closest('.libraryPage');
    const isMusicVideosPage = card.getAttribute('data-context') === 'musicvideos' ||
        modernLibraryPage?.id === 'musicvideos' ||
        /(?:^|\/)musicvideos(?:[?#]|$)/.test(
            `${window.location.pathname}${window.location.hash}`
        ) && routeParams.get('tab') === '2';
    const savedSettings = isMusicVideosPage
        ? window.localStorage.getItem(`musicvideos - ${libraryId}`)
        : null;
    let librarySettings = {};
    if (savedSettings) {
        try {
            const parsedSettings = JSON.parse(savedSettings);
            if (parsedSettings && typeof parsedSettings === 'object' && !Array.isArray(parsedSettings)) {
                librarySettings = parsedSettings;
            } else {
                throw new Error('Stored library settings are not an object.');
            }
        } catch (error) {
            console.error('Input Plugin: Could not read Music Videos library view settings:', error);
        }
    }

    const visiblePageRange = isMusicVideosPage
        ? getVisibleMusicVideosPageRange(itemsContainer)
        : null;
    const pageStartIndex = visiblePageRange?.startIndex ?? (Number(librarySettings.StartIndex) || 0);
    const musicVideosPageSize = siblingCards.length;
    if (isMusicVideosPage && nextVideoId) {
        musicVideoNextIndex = pageStartIndex + cardIndex + 1;
    }

    if (!nextVideoId) {
        const pagingText = itemsContainer.parentNode?.querySelector('.paging')?.textContent || '';
        const pageRange = pagingText.match(/([\d,.\u00a0\u202f]+)\s*[-–]\s*([\d,.\u00a0\u202f]+)/);
        const legacyPageEnd = pageRange ? Number(pageRange[2].replace(/[^\d]/g, '')) : 0;
        const pageEnd = isMusicVideosPage
            ? visiblePageRange?.endIndex ?? pageStartIndex + siblingCards.length
            : legacyPageEnd;
        const hasNextPage = isMusicVideosPage
            ? visiblePageRange?.total !== undefined
                ? pageEnd < visiblePageRange.total
                : pageEnd > 0
            : !!itemsContainer.parentNode?.querySelector('.paging .btnNextPage:not([disabled])');

        console.info('Input Plugin: Looking for the next library video: ' + JSON.stringify({
            isMusicVideosPage,
            route: `${window.location.pathname}${window.location.hash}`,
            libraryFound: !!libraryId,
            storedPageStart: librarySettings.StartIndex,
            visiblePageRange: visiblePageRange?.label || null,
            pageStart: pageStartIndex,
            visibleVideoCount: siblingCards.length,
            clickedVideoIndex: cardIndex,
            nextPageOffset: pageEnd,
            hasNextPage
        }));

        if (hasNextPage && pageEnd > 0 && libraryId &&
            typeof playbackManager.getItemsForPlayback === 'function') {
            const query = isMusicVideosPage
                ? getMusicVideosPlaybackQuery(libraryId, librarySettings, pageEnd)
                : {
                    parentId: libraryId,
                    recursive: true,
                    mediaTypes: ['Video'],
                    sortBy: ['SortName', 'ProductionYear'],
                    sortOrder: ['Ascending'],
                    startIndex: pageEnd,
                    limit: 1
                };

            nextVideoPromise = Promise.resolve()
                .then(() => playbackManager.getItemsForPlayback(card.getAttribute('data-serverid'), query))
                .then(result => {
                    const nextId = result?.Items?.[0]?.Id;
                    if (!nextId) {
                        console.warn('Input Plugin: The next-page lookup returned no video.');
                    } else {
                        console.info('Input Plugin: Next-page lookup found a video.');
                        if (isMusicVideosPage) {
                            musicVideoNextIndex = pageEnd;
                        }
                    }
                    return nextId;
                });
        }
    }

    if (!nextVideoId && !nextVideoPromise) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const serverId = card.getAttribute('data-serverid');
    const itemId = card.getAttribute('data-id');
    const startPositionTicks = action === 'resume' ? Number(card.getAttribute('data-positionticks')) : 0;

    const playPromise = Promise.resolve().then(() => playbackManager.play({
        ids: [itemId],
        serverId,
        startPositionTicks: Number.isFinite(startPositionTicks) ? startPositionTicks : 0
    }));

    playPromise.catch(error => {
        console.error('Input Plugin: Failed to play the selected video:', error);
    });

    Promise.resolve(nextVideoId || nextVideoPromise)
        .then(nextId => {
            if (!nextId) {
                console.warn('Input Plugin: No next video was found in the library.');
                return;
            }

            return playPromise.then(() => {
                if (isMusicVideosPage && libraryId && Number.isInteger(musicVideoNextIndex)) {
                    pendingMusicVideoPageAdvance = {
                        itemId: nextId,
                        libraryId,
                        itemIndex: musicVideoNextIndex,
                        pageSize: musicVideosPageSize,
                        librarySettings,
                        serverId
                    };
                }

                return playbackManager.queueNext({
                    ids: [nextId],
                    serverId
                });
            }).then(() => {
                console.info('Input Plugin: Queued the next library video.');
            });
        })
        .catch(error => {
            console.error('Input Plugin: Failed to queue the next library video:', error);
        });
}

class inputPlugin {
    constructor({ inputManager, playbackManager }) {
        this.name = 'Input Plugin';
        this.type = 'input';
        this.id = 'inputPlugin';

        this.durationCheckInterval = null;
        this.positionUpdateInterval = null;
        this.attachedPlayer = null;
        console.warn('Input Plugin: Click handler initialized.');
        this.videoPlayClickHandler = event => playVideosFromLibrary(event, playbackManager);
        document.addEventListener('click', this.videoPlayClickHandler, true);

        (async () => {
            const api = await window.apiPromise;

            api.input.hostInput.connect((actions) => {
                actions.forEach(action => {
                    if (action === 'shuffle') {
                        playbackManager.setQueueShuffleMode('Shuffle');
                    } else if (action === 'sorted') {
                        playbackManager.setQueueShuffleMode('Sorted');
                    } else if (action === 'previous') {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && playbackManager.isPlayingAudio(currentPlayer)) {
                            const currentTime = playbackManager.currentTime(currentPlayer);
                            const currentIndex = playbackManager.getCurrentPlaylistIndex(currentPlayer);

                            if (currentTime >= 5 * 1000 || currentIndex <= 0) {
                                playbackManager.seekPercent(0, currentPlayer);
                            } else {
                                playbackManager.previousTrack(currentPlayer);
                            }
                        } else if (currentPlayer) {
                            playbackManager.previousTrack(currentPlayer);
                        }
                    } else {
                        if (remap.hasOwnProperty(action)) {
                            action = remap[action];
                        }
                        inputManager.handleCommand(action, {});
                    }
                });
            });

            const updateQueueState = function() {
                try {
                    if (!api || !api.player) {
                        return;
                    }

                    const playlist = playbackManager._playQueueManager?.getPlaylist();
                    if (!playlist || !Array.isArray(playlist)) {
                        return;
                    }

                    const currentIndex = playbackManager._playQueueManager?.getCurrentPlaylistIndex();
                    if (currentIndex === undefined || currentIndex === null || currentIndex < 0) {
                        return;
                    }

                    const canNext = currentIndex < playlist.length - 1;

                    const state = playbackManager.getPlayerState();
                    const isMusic = state?.NowPlayingItem?.MediaType === 'Audio';
                    const canPrevious = isMusic ? true : currentIndex > 0;

                    api.player.notifyQueueChange(canNext, canPrevious);
                } catch (e) {
                    console.error('PlayerMedia: Error in updateQueueState:', e);
                }
            };

            let globalListenersAttached = false;
            let lastReportedPosition = 0;

            if (!globalListenersAttached) {
                let lastFullscreenState = window.jmpInfo.settings.main.fullscreen;
                window.jmpInfo.settingsUpdate.push(function(section) {
                    if (section === 'main') {
                        const currentFullscreenState = window.jmpInfo.settings.main.fullscreen;
                        if (currentFullscreenState !== lastFullscreenState) {
                            lastFullscreenState = currentFullscreenState;
                            const currentPlayer = playbackManager._currentPlayer;
                            if (currentPlayer) {
                                window.Events.trigger(currentPlayer, 'fullscreenchange');
                            }
                        }
                    }
                });

                if (window.api && window.api.player) {
                    window.api.player.playbackRateChanged.connect(function(rate) {
                        const currentPlayer = playbackManager._currentPlayer;

                        if (currentPlayer && currentPlayer._playRate !== undefined) {
                            currentPlayer._playRate = rate;
                        }

                        if (window.Events && currentPlayer) {
                            window.Events.trigger(currentPlayer, 'ratechange');
                        }
                    });
                } else {
                    console.log('SystemMedia: Cannot attach playbackRateChanged listener - api:', !!window.api, 'player:', !!window.api?.player);
                }

                if (window.api && window.api.input) {
                    window.api.input.volumeChanged.connect(function(volume) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && typeof currentPlayer.setVolume === 'function') {
                            currentPlayer.setVolume(volume);
                        }
                    });

                    window.api.input.rateChanged.connect(function(rate) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer && typeof currentPlayer.setPlaybackRate === 'function') {
                            currentPlayer.setPlaybackRate(rate);
                        }
                    });

                    // WORKAROUND: MPRIS spec has no "Buffering" playback state
                    // During seek buffering, we set Rate to 0.0 to stop MPRIS clients from
                    // auto-incrementing position. Once buffering completes, we restore Rate to 1.0.

                    window.api.input.positionSeek.connect(function(positionMs) {
                        const currentPlayer = playbackManager._currentPlayer;
                        if (currentPlayer) {
                            const duration = playbackManager.duration();
                            if (duration) {
                                const percent = (positionMs * 10000) / duration * 100;
                                playbackManager.seekPercent(percent, currentPlayer);
                            }
                        }

                        api.player.notifyPosition(Math.floor(positionMs));
                        lastReportedPosition = positionMs;

                        api.player.notifyRateChange(0.0);
                    });
                }

                window.Events.on(playbackManager, 'playlistitemremove', updateQueueState);
                window.Events.on(playbackManager, 'playlistitemadd', updateQueueState);
                window.Events.on(playbackManager, 'playlistitemchange', () => {
                    advanceMusicVideosPageOnPlayback(playbackManager);
                    updateQueueState();
                });

                window.Events.on(playbackManager, 'playbackstop', function(e, playbackStopInfo) {
                    updateQueueState();

                    const isNavigating = !!(playbackStopInfo && playbackStopInfo.nextMediaType);
                    api.player.notifyPlaybackStop(isNavigating);
                });

                globalListenersAttached = true;
            }

            window.Events.on(playbackManager, 'playbackstart', (e, player, state) => {
                if (!player) return;

                state = state || playbackManager.getPlayerState(player);
                advanceMusicVideosPageOnPlayback(playbackManager, state);
                if (state && state.NowPlayingItem) {
                    api.player.notifyMetadata(state.NowPlayingItem);

                    const initialPos = playbackManager.currentTime();
                    if (initialPos !== undefined && initialPos !== null) {
                        api.player.notifyPosition(Math.floor(initialPos));
                        lastReportedPosition = initialPos;
                    }

                    if (player && typeof player.getVolume === 'function') {
                        const volume = player.getVolume();
                        api.player.notifyVolumeChange(volume / 100.0);
                    }
                }

                let lastDuration = 0;
                const checkDuration = function() {
                    const duration = playbackManager.duration();
                    if (duration && duration !== lastDuration) {
                        lastDuration = duration;
                        const durationMs = Math.floor(duration / 10000);
                        api.player.notifyDurationChange(durationMs);
                    }
                };

                if (player !== this.attachedPlayer) {
                    if (this.attachedPlayer) {
                        window.Events.off(this.attachedPlayer, 'shufflequeuemodechange');
                        window.Events.off(this.attachedPlayer, 'repeatmodechange');
                        window.Events.off(this.attachedPlayer, 'playing');
                        window.Events.off(this.attachedPlayer, 'pause');
                        window.Events.off(this.attachedPlayer, 'playbackstop');
                        window.Events.off(this.attachedPlayer, 'volumechange');
                        window.Events.off(this.attachedPlayer, 'ratechange');
                        window.Events.off(this.attachedPlayer, 'timeupdate');
                    }

                    this.attachedPlayer = player;

                    window.Events.on(player, 'shufflequeuemodechange', () => {
                    const mode = playbackManager.getQueueShuffleMode();
                    const enabled = (mode === 'Shuffle');
                    api.player.notifyShuffleChange(enabled);
                });

                window.Events.on(player, 'repeatmodechange', () => {
                    const mode = playbackManager.getRepeatMode();
                    api.player.notifyRepeatChange(mode);
                });

                window.Events.on(player, 'playing', () => {
                    window.NativeShell.setPlaybackActive(true);
                    api.player.notifyPlaybackState('Playing');

                    updateQueueState();

                    api.player.notifyRateChange(1.0);

                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                    }
                    checkDuration();
                    this.durationCheckInterval = setInterval(checkDuration, 1000);

                    const initialPos = playbackManager.currentTime();
                    if (initialPos !== undefined && initialPos !== null) {
                        api.player.notifyPosition(Math.floor(initialPos));
                    }

                    if (this.positionUpdateInterval) {
                        clearInterval(this.positionUpdateInterval);
                    }
                    this.positionUpdateInterval = setInterval(() => {
                        const positionMs = playbackManager.currentTime();
                        if (positionMs !== undefined && positionMs !== null) {
                            const positionDiff = Math.abs(positionMs - lastReportedPosition);
                            if (lastReportedPosition > 0 && positionDiff > 2000) {
                                api.player.notifyRateChange(0.0);
                                api.player.notifySeek(Math.floor(positionMs));
                            } else {
                                api.player.notifyPosition(Math.floor(positionMs));
                            }
                            lastReportedPosition = positionMs;
                        }
                    }, 500);
                });

                window.Events.on(player, 'pause', () => {
                    window.NativeShell.setPlaybackActive(false);
                    api.player.notifyPlaybackState('Paused');
                    api.player.notifyRateChange(0.0);

                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                        this.durationCheckInterval = null;
                    }

                    const currentPos = playbackManager.currentTime();
                    if (currentPos !== undefined && currentPos !== null) {
                        lastReportedPosition = currentPos;
                    }
                });

                window.Events.on(player, 'playbackstop', () => {
                    window.NativeShell.setPlaybackActive(false);
                    if (this.durationCheckInterval) {
                        clearInterval(this.durationCheckInterval);
                        this.durationCheckInterval = null;
                    }

                    if (this.positionUpdateInterval) {
                        clearInterval(this.positionUpdateInterval);
                        this.positionUpdateInterval = null;
                    }

                    lastDuration = 0;
                    lastReportedPosition = 0;
                });

                    window.Events.on(player, 'volumechange', () => {
                        if (player && typeof player.getVolume === 'function') {
                            const volume = player.getVolume();
                            api.player.notifyVolumeChange(volume / 100.0);
                        }
                    });

                    window.Events.on(player, 'ratechange', () => {
                        if (player && typeof player.getPlaybackRate === 'function') {
                            const rate = player.getPlaybackRate();
                            api.player.notifyRateChange(rate);
                        }
                    });

                    window.Events.on(player, 'timeupdate', () => {
                        const positionMs = playbackManager.currentTime();
                        if (positionMs !== undefined && positionMs !== null) {
                            const positionDiff = Math.abs(positionMs - lastReportedPosition);
                            if (lastReportedPosition > 0 && positionDiff > 2000) {
                                // Player-initiated seek - set rate to 0 during buffering
                                api.player.notifyRateChange(0.0);
                                api.player.notifySeek(Math.floor(positionMs));
                            } else if (positionDiff > 100) {
                                api.player.notifyPosition(Math.floor(positionMs));
                            }
                            lastReportedPosition = positionMs;
                        }
                    });
                }
            });

            api.system.hello("jmpInputPlugin");
        })();
    }

    destroy() {
        document.removeEventListener('click', this.videoPlayClickHandler, true);

        if (this.durationCheckInterval) {
            clearInterval(this.durationCheckInterval);
            this.durationCheckInterval = null;
        }

        if (this.positionUpdateInterval) {
            clearInterval(this.positionUpdateInterval);
            this.positionUpdateInterval = null;
        }

        if (this.attachedPlayer) {
            window.Events.off(this.attachedPlayer, 'shufflequeuemodechange');
            window.Events.off(this.attachedPlayer, 'repeatmodechange');
            window.Events.off(this.attachedPlayer, 'playing');
            window.Events.off(this.attachedPlayer, 'pause');
            window.Events.off(this.attachedPlayer, 'playbackstop');
            window.Events.off(this.attachedPlayer, 'volumechange');
            window.Events.off(this.attachedPlayer, 'timeupdate');
            this.attachedPlayer = null;
        }

        if (window.playbackManager) {
            window.Events.off(window.playbackManager, 'playlistitemremove');
            window.Events.off(window.playbackManager, 'playlistitemadd');
            window.Events.off(window.playbackManager, 'playlistitemchange');
            window.Events.off(window.playbackManager, 'playbackstop');
        }

        console.log('SystemMedia: inputPlugin destroyed and cleaned up');
    }
}

window._inputPlugin = inputPlugin;
})();
