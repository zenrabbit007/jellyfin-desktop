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
let pendingMusicVideoReturn = null;

function getMusicVideosPlaybackQuery(libraryId, librarySettings, startIndex, limit = 1) {
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
        limit,
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

function getItemIdsAfterAnchor(items, anchorId) {
    if (!Array.isArray(items)) {
        return [];
    }

    const anchorIndex = items.findIndex(item => item.Id === anchorId);
    if (anchorIndex < 0) {
        return [];
    }

    return items.slice(anchorIndex + 1).map(item => item.Id).filter(Boolean);
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

function returnToMusicVideosLibrary(event, playbackManager) {
    const pendingReturn = pendingMusicVideoReturn;
    if (!pendingReturn?.libraryRoute || window.location.hash.split('?')[0] !== '#/video') {
        return;
    }

    const backButton = event.target?.closest?.('.videoOsd-appBar button');
    const toolbar = backButton?.closest('.videoOsd-appBar');
    if (!backButton || toolbar?.querySelector('button') !== backButton) {
        return;
    }

    const playerState = playbackManager.getPlayerState();
    const currentItemId = playerState?.NowPlayingItem?.Id;
    if (pendingMusicVideoPageAdvance?.itemId === currentItemId) {
        advanceMusicVideosPageOnPlayback(playbackManager, playerState);
    }

    console.info('Input Plugin: Returning from the active Music Video: ' + JSON.stringify({
        currentItemId: currentItemId || null,
        savedItemId: pendingMusicVideoReturn?.itemId || null,
        currentIndex: pendingMusicVideoReturn?.itemIndex ?? null,
        targetStartIndex: pendingMusicVideoReturn?.startIndex ?? null
    }));
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.location.hash = pendingMusicVideoReturn?.libraryRoute || pendingReturn.libraryRoute;
    console.info('Input Plugin: Returning to the Music Videos library from the video control.');
}

function refreshMusicVideosLibraryOnReturn() {
    const pendingReturn = pendingMusicVideoReturn;
    if (!pendingReturn) {
        return;
    }

    const route = window.location.hash;
    const routeParams = new URLSearchParams(route.split('?')[1] || '');
    if (!/(?:^|#\/)musicvideos(?:[?#]|$)/.test(route) ||
        routeParams.get('topParentId') !== pendingReturn.libraryId) {
        return;
    }

    window.dispatchEvent(new StorageEvent('local-storage', {
        key: `musicvideos - ${pendingReturn.libraryId}`
    }));
    console.info('Input Plugin: Refreshed Music Videos library settings after returning from video.');
    advanceMusicVideosLibraryPageOnReturn(pendingReturn);
}

function advanceMusicVideosLibraryPageOnReturn(pendingReturn) {
    if (pendingReturn !== pendingMusicVideoReturn || pendingReturn.pageCheckScheduled) {
        return;
    }

    pendingReturn.pageCheckScheduled = true;
    window.setTimeout(() => {
        pendingReturn.pageCheckScheduled = false;
        const currentRoute = window.location.hash;
        const routeParams = new URLSearchParams(currentRoute.split('?')[1] || '');
        if (!/(?:^|#\/)musicvideos(?:[?#]|$)/.test(currentRoute) ||
            routeParams.get('topParentId') !== pendingReturn.libraryId) {
            return;
        }

        const visibleRange = getVisibleMusicVideosPageRange();
        if (visibleRange?.startIndex === pendingReturn.startIndex) {
            const activeCard = Array.from(document.querySelectorAll('.card[data-id], .listItem[data-id]'))
                .find(card => card.getAttribute('data-id') === pendingReturn.itemId);
            if (activeCard) {
                if (!activeCard.hasAttribute('tabindex')) {
                    activeCard.setAttribute('tabindex', '-1');
                }
                activeCard.focus();
                activeCard.scrollIntoView({ block: 'center', inline: 'nearest' });
            } else {
                console.warn('Input Plugin: Could not find the active Music Video in the restored library page.', {
                    itemId: pendingReturn.itemId,
                    startIndex: pendingReturn.startIndex
                });
            }
            pendingMusicVideoReturn = null;
            console.info('Input Plugin: Returned to the active Music Video in the library.');
            return;
        }

        if (pendingReturn.pageChecks >= 40) {
            console.error('Input Plugin: Could not advance to the Music Videos page containing the queued video.', {
                expectedStartIndex: pendingReturn.startIndex,
                visibleRange: visibleRange?.label || null
            });
            pendingMusicVideoReturn = null;
            return;
        }

        if (!visibleRange) {
            if (pendingReturn.pageChecks === 0) {
                console.warn('Input Plugin: Waiting for the Music Videos page range to appear after returning.');
            }
        } else if (!pendingReturn.pageChangeRequested) {
            const isPreviousPage = visibleRange.startIndex > pendingReturn.startIndex;
            const expectedLabel = isPreviousPage ? 'Previous' : 'Next';
            const buttons = Array.from(document.querySelectorAll('button'));
            const paginationButton = buttons.find(button => (
                [button.title, button.getAttribute('aria-label')]
                    .some(label => label?.trim().toLowerCase() === expectedLabel.toLowerCase())
            ));

            if (pendingReturn.pageChecks === 0) {
                console.info('Input Plugin: Checking Music Videos return pagination: ' + JSON.stringify({
                    expectedStartIndex: pendingReturn.startIndex,
                    visibleRange: visibleRange.label,
                    buttonCount: buttons.length,
                    buttonLabels: buttons
                        .map(button => button.title || button.getAttribute('aria-label') || '')
                        .filter(Boolean)
                        .slice(-12),
                    paginationLabel: expectedLabel,
                    paginationButtonFound: !!paginationButton,
                    paginationButtonDisabled: paginationButton?.disabled ?? null
                }));
            }

            if (paginationButton && !paginationButton.disabled) {
                pendingReturn.pageChangeRequested = true;
                paginationButton.click();
                console.info('Input Plugin: Requested the Music Videos pagination control to show the queued video page.');
            }
        }

        pendingReturn.pageChecks++;
        window.setTimeout(() => advanceMusicVideosLibraryPageOnReturn(pendingReturn), 250);
    }, 250);
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
            librarySettings.StartIndex = pendingAdvance.pageStartIndex;
            window.localStorage.setItem(settingsKey, JSON.stringify(librarySettings));
            window.dispatchEvent(new CustomEvent('local-storage', {
                detail: { key: settingsKey }
            }));
            pendingMusicVideoReturn = {
                libraryId: pendingAdvance.libraryId,
                libraryRoute: pendingAdvance.libraryRoute,
                itemId: pendingAdvance.itemId,
                itemIndex: pendingAdvance.itemIndex,
                startIndex: librarySettings.StartIndex,
                pageChecks: 0,
                pageCheckScheduled: false,
                pageChangeRequested: false
            };
        } catch (error) {
            console.error('Input Plugin: Could not restore the next Music Videos page:', error);
        }

        console.info('Input Plugin: Saved the Music Videos page containing the queued video.');
    }

    const nextItemIndex = pendingAdvance.itemIndex + 1;
    const pageOffset = nextItemIndex - pendingAdvance.pageStartIndex;
    const queueMusicVideo = (nextId, pageStartIndex, pageItemIds) => {
        if (!nextId) {
            return;
        }

        const nextAdvance = {
            ...pendingAdvance,
            itemId: nextId,
            itemIndex: nextItemIndex,
            pageStartIndex,
            pageItemIds
        };
        pendingMusicVideoPageAdvance = nextAdvance;
        return playbackManager.queueNext({
            ids: [nextId],
            serverId: pendingAdvance.serverId
        }).catch(error => {
            if (pendingMusicVideoPageAdvance === nextAdvance) {
                pendingMusicVideoPageAdvance = null;
            }
            throw error;
        });
    };

    if (pageOffset >= 0 && pageOffset < pendingAdvance.pageItemIds.length) {
        queueMusicVideo(
            pendingAdvance.pageItemIds[pageOffset],
            pendingAdvance.pageStartIndex,
            pendingAdvance.pageItemIds
        ).catch(error => {
            console.error('Input Plugin: Failed to queue the following Music Video:', error);
        });
        return;
    }

    const nextPageStartIndex = pendingAdvance.pageStartIndex + pendingAdvance.pageItemIds.length;
    const pageAnchorId = pendingAdvance.pageItemIds[pendingAdvance.pageItemIds.length - 1];
    Promise.resolve()
        .then(() => playbackManager.getItemsForPlayback(
            pendingAdvance.serverId,
            getMusicVideosPlaybackQuery(
                pendingAdvance.libraryId,
                pendingAdvance.librarySettings,
                nextPageStartIndex - 1,
                pendingAdvance.pageSize + 1
            )
        ))
        .then(result => {
            const resultItems = result?.Items || [];
            const anchorIndex = resultItems.findIndex(item => item.Id === pageAnchorId);
            const pageItemIds = getItemIdsAfterAnchor(resultItems, pageAnchorId);
            if (!pageItemIds.length && resultItems.length) {
                console.error('Input Plugin: Could not find the previous page anchor in the next-page lookup; refusing to guess the next video.', {
                    pageAnchorId,
                    lookupStartIndex: nextPageStartIndex - 1,
                    responseStartIndex: result?.StartIndex ?? null,
                    firstResultId: resultItems[0]?.Id || null
                });
            }
            const actualNextPageStartIndex = anchorIndex < 0
                ? nextPageStartIndex
                : (result?.StartIndex ?? nextPageStartIndex - 1) + anchorIndex + 1;
            return queueMusicVideo(pageItemIds[0], actualNextPageStartIndex, pageItemIds);
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
    let musicVideoNextPageIds;

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
    const musicVideoPageItemIds = Array.from(
        siblingCards,
        sibling => sibling.getAttribute('data-id')
    );
    const musicVideoCurrentIndex = pageStartIndex + cardIndex;
    if (isMusicVideosPage && nextVideoId) {
        musicVideoNextIndex = musicVideoCurrentIndex + 1;
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
                ? getMusicVideosPlaybackQuery(
                    libraryId,
                    librarySettings,
                    pageEnd - 1,
                    musicVideosPageSize + 1
                )
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
                    const resultItems = result?.Items || [];
                    const anchorId = musicVideoPageItemIds[musicVideoPageItemIds.length - 1];
                    const anchorIndex = isMusicVideosPage
                        ? resultItems.findIndex(item => item.Id === anchorId)
                        : -1;
                    const nextPageItemIds = isMusicVideosPage
                        ? getItemIdsAfterAnchor(resultItems, anchorId)
                        : null;
                    const nextId = isMusicVideosPage ? nextPageItemIds[0] : resultItems[0]?.Id;
                    if (!nextId) {
                        if (isMusicVideosPage) {
                            console.error('Input Plugin: Could not find the last visible video in the next-page lookup; refusing to guess the successor.', {
                                anchorId,
                                lookupStartIndex: pageEnd - 1,
                                responseStartIndex: result?.StartIndex ?? null,
                                firstResultId: resultItems[0]?.Id || null,
                                firstResultName: resultItems[0]?.Name || null,
                                resultCount: resultItems.length
                            });
                        } else {
                            console.warn('Input Plugin: The next-page lookup returned no video.');
                        }
                    } else {
                        musicVideoNextIndex = isMusicVideosPage
                            ? (result?.StartIndex ?? pageEnd - 1) + anchorIndex + 1
                            : musicVideoNextIndex;
                        console.info('Input Plugin: Next-page lookup found a video after the visible anchor: ' + JSON.stringify({
                            anchorId,
                            anchorIndex,
                            responseStartIndex: result?.StartIndex ?? null,
                            nextId,
                            nextName: resultItems.find(item => item.Id === nextId)?.Name || null
                        }));
                        if (isMusicVideosPage) {
                            musicVideoNextPageIds = nextPageItemIds;
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

    if (isMusicVideosPage && libraryId && musicVideosPageSize > 0) {
        pendingMusicVideoReturn = {
            libraryId,
            libraryRoute: window.location.hash,
            itemId,
            itemIndex: musicVideoCurrentIndex,
            startIndex: pageStartIndex,
            pageChecks: 0,
            pageCheckScheduled: false,
            pageChangeRequested: false
        };
    }

    Promise.resolve(nextVideoId || nextVideoPromise)
        .catch(error => {
            console.error('Input Plugin: Failed to find the next library video:', error);
            return null;
        })
        .then(nextId => {
            if (!nextId) {
                console.warn('Input Plugin: No next video was found in the library.');
                pendingMusicVideoPageAdvance = null;
            } else if (isMusicVideosPage && libraryId && Number.isInteger(musicVideoNextIndex)) {
                pendingMusicVideoPageAdvance = {
                    itemId: nextId,
                    libraryId,
                    itemIndex: musicVideoNextIndex,
                    pageSize: musicVideosPageSize,
                    pageStartIndex: musicVideoNextPageIds ? musicVideoNextIndex : pageStartIndex,
                    pageItemIds: musicVideoNextPageIds || musicVideoPageItemIds,
                    librarySettings,
                    serverId,
                    libraryRoute: window.location.hash
                };
            }

            return playbackManager.play({
                ids: nextId ? [itemId, nextId] : [itemId],
                serverId,
                startIndex: 0,
                startPositionTicks: Number.isFinite(startPositionTicks) ? startPositionTicks : 0
            });
        })
        .then(() => {
            console.info('Input Plugin: Started playback with the next library video in the queue.');
        })
        .catch(error => {
            pendingMusicVideoPageAdvance = null;
            console.error('Input Plugin: Failed to start the selected video:', error);
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
        this.videoBackHandler = event => returnToMusicVideosLibrary(event, playbackManager);
        this.musicVideoReturnHandler = () => {
            window.setTimeout(refreshMusicVideosLibraryOnReturn, 100);
        };
        window.addEventListener('hashchange', this.musicVideoReturnHandler);
        document.addEventListener('viewshow', this.musicVideoReturnHandler, true);
        document.addEventListener('click', this.videoBackHandler, true);
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

                    const player = playbackManager._currentPlayer;
                    const state = playbackManager.getPlayerState(player);
                    const playlistPromise = Array.isArray(state?.NowPlayingQueue)
                        ? Promise.resolve(state.NowPlayingQueue)
                        : Array.isArray(player?.playlist)
                            ? Promise.resolve(player.playlist)
                            : playbackManager.getPlaylist(player);

                    Promise.resolve(playlistPromise)
                        .then(playlist => {
                            if (!Array.isArray(playlist)) {
                                throw new Error('Playback manager returned an invalid playlist.');
                            }
                            const currentPlaylistItemId = state?.PlaylistItemId ||
                                (typeof playbackManager.getCurrentPlaylistItemId === 'function'
                                    ? playbackManager.getCurrentPlaylistItemId(player)
                                    : null);
                            let currentIndex = currentPlaylistItemId == null
                                ? -1
                                : playlist.findIndex(item => (
                                    item.PlaylistItemId === currentPlaylistItemId ||
                                    item.Id === currentPlaylistItemId
                                ));
                            if (currentIndex < 0 && typeof player?.getCurrentPlaylistIndex === 'function') {
                                currentIndex = player.getCurrentPlaylistIndex();
                            } else if (currentIndex < 0 &&
                                typeof playbackManager._playQueueManager?.getCurrentPlaylistIndex === 'function') {
                                currentIndex = playbackManager._playQueueManager.getCurrentPlaylistIndex();
                            }
                            if (!Number.isInteger(currentIndex) || currentIndex < 0) {
                                return;
                            }
                            const canNext = currentIndex < playlist.length - 1;

                            const isMusic = state?.NowPlayingItem?.MediaType === 'Audio';
                            const canPrevious = isMusic ? true : currentIndex > 0;

                            api.player.notifyQueueChange(canNext, canPrevious);
                        })
                        .catch(error => {
                            console.error('PlayerMedia: Error in updateQueueState:', error);
                        });
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
                        window.Events.off(this.attachedPlayer, 'playlistitemadd');
                        window.Events.off(this.attachedPlayer, 'playlistitemremove');
                        window.Events.off(this.attachedPlayer, 'statechange');
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

                window.Events.on(player, 'playlistitemadd', updateQueueState);
                window.Events.on(player, 'playlistitemremove', updateQueueState);
                window.Events.on(player, 'statechange', updateQueueState);

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
        document.removeEventListener('click', this.videoBackHandler, true);
        window.removeEventListener('hashchange', this.musicVideoReturnHandler);
        document.removeEventListener('viewshow', this.musicVideoReturnHandler, true);

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
            window.Events.off(this.attachedPlayer, 'playlistitemadd');
            window.Events.off(this.attachedPlayer, 'playlistitemremove');
            window.Events.off(this.attachedPlayer, 'statechange');
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
