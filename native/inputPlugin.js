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

function getVisiblePageRange() {
    const pageLabel = document.querySelector('.MuiToolbar-root.padded-left .MuiChip-label')
        ?.textContent?.trim() ||
        document.querySelector('.paging .pagingText')?.textContent?.trim() ||
        document.querySelector('.paging')?.textContent?.trim();
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

const PAGE_PICKER_TRIGGER_ATTR = 'data-jmp-page-picker-trigger';
const PAGE_PICKER_OVERLAY_CLASS = 'jmp-page-picker';
const PAGE_PICKER_STYLE_ID = 'jmp-page-picker-style';
const DEFAULT_LIBRARY_PAGE_SIZE = 100;

let pagePickerOverlay = null;
let pagePickerState = null;
let pagePickerTriggerObserver = null;
let pagePickerTriggerFrame = null;

function getCurrentLibraryId() {
    const query = window.location.hash.split('?')[1] || window.location.search.slice(1);
    const routeParams = new URLSearchParams(query);
    return routeParams.get('topParentId') || routeParams.get('parentId');
}

function getLibraryPageSize(visibleRange) {
    const userId = window.ApiClient?.getCurrentUserId?.();
    const keys = userId ? [`${userId}-libraryPageSize`] : [];
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key?.endsWith('-libraryPageSize')) {
            keys.push(key);
        }
    }

    for (const key of keys) {
        const pageSize = parseInt(window.localStorage.getItem(key), 10);
        if (Number.isInteger(pageSize) && pageSize > 0) {
            return pageSize;
        }
    }

    if (visibleRange.endIndex < visibleRange.total) {
        return visibleRange.endIndex - visibleRange.startIndex;
    }

    return DEFAULT_LIBRARY_PAGE_SIZE;
}

function getPagePickerState(trigger) {
    if (!document.querySelector('.libraryPage')) {
        return null;
    }

    const visibleRange = getVisiblePageRange();
    if (!visibleRange) {
        return null;
    }

    const pageSize = getLibraryPageSize(visibleRange);
    const totalPages = Math.ceil(visibleRange.total / pageSize);
    if (totalPages < 2) {
        return null;
    }

    return {
        trigger,
        libraryId: getCurrentLibraryId(),
        pageSize,
        total: visibleRange.total,
        totalPages,
        currentPage: Math.floor(visibleRange.startIndex / pageSize) + 1
    };
}

function getPageRangeLabel(pageNumber, state) {
    const firstItem = (pageNumber - 1) * state.pageSize + 1;
    const lastItem = Math.min(pageNumber * state.pageSize, state.total);
    return `${firstItem}\u2013${lastItem}`;
}

function injectPagePickerStyle() {
    if (document.getElementById(PAGE_PICKER_STYLE_ID)) {
        return;
    }

    const style = document.createElement('style');
    style.id = PAGE_PICKER_STYLE_ID;
    style.textContent = `
        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}] {
            height: 2rem;
            padding: 0 12px 0 15px;
            border: 0;
            border-radius: 8px;
            background-color: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.95);
            font-size: 0.9rem;
            font-variant-numeric: tabular-nums;
            cursor: pointer;
            transition: background-color 120ms ease-out;
        }

        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}] > .MuiChip-label {
            padding: 0;
            font-size: inherit;
            line-height: 1;
        }

        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}]::after {
            content: '';
            flex: none;
            width: 0.5em;
            height: 0.5em;
            margin-left: 10px;
            border-right: 2px solid currentColor;
            border-bottom: 2px solid currentColor;
            transform: translateY(-0.16em) rotate(45deg);
            opacity: 0.85;
        }

        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}]:hover {
            background-color: rgba(255, 255, 255, 0.16);
        }

        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}]:active {
            background-color: rgba(255, 255, 255, 0.22);
        }

        .MuiChip-root[${PAGE_PICKER_TRIGGER_ATTR}]:focus-visible {
            outline: 2px solid #00a4dc;
            outline-offset: 2px;
        }

        .${PAGE_PICKER_OVERLAY_CLASS} {
            position: fixed;
            inset: 0;
            z-index: 20000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.72);
        }

        .jmp-page-picker-panel {
            display: flex;
            flex-direction: column;
            width: min(720px, 90vw);
            max-height: 80vh;
            border-radius: 12px;
            background: #1f1f1f;
            color: #fff;
            box-shadow: 0 18px 48px rgba(0, 0, 0, 0.55);
            overflow: hidden;
        }

        .jmp-page-picker-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px 8px;
            font-size: 1.2rem;
        }

        .jmp-page-picker-close {
            padding: 0 6px;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: inherit;
            font-size: 28px;
            line-height: 1;
            cursor: pointer;
        }

        .jmp-page-picker-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
            gap: 8px;
            padding: 8px 20px 20px;
            overflow-y: auto;
        }

        .jmp-page-picker-page {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
            padding: 8px 10px;
            border: 1px solid rgba(255, 255, 255, 0.16);
            border-radius: 8px;
            background: rgba(255, 255, 255, 0.04);
            color: inherit;
            font: inherit;
            font-size: 1rem;
            text-align: left;
            cursor: pointer;
        }

        .jmp-page-picker-page:hover {
            background: rgba(255, 255, 255, 0.12);
        }

        .jmp-page-picker-page[aria-current='page'] {
            border-color: #00a4dc;
            background: rgba(0, 164, 220, 0.18);
        }

        .jmp-page-picker-page small {
            font-size: 0.75rem;
            opacity: 0.65;
        }

        .jmp-page-picker-close:focus-visible,
        .jmp-page-picker-page:focus-visible {
            outline: 2px solid #00a4dc;
            outline-offset: 2px;
        }
    `;
    const head = document.head || document.documentElement;
    head.appendChild(style);
}

function buildPagePicker(state) {
    const overlay = document.createElement('div');
    overlay.className = PAGE_PICKER_OVERLAY_CLASS;

    const panel = document.createElement('div');
    panel.className = 'jmp-page-picker-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'jmp-page-picker-title');

    const header = document.createElement('div');
    header.className = 'jmp-page-picker-header';

    const title = document.createElement('span');
    title.id = 'jmp-page-picker-title';
    title.textContent = 'Select page';

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'jmp-page-picker-close';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.textContent = '\u00d7';
    closeButton.addEventListener('click', closePagePicker);

    header.append(title, closeButton);

    const grid = document.createElement('div');
    grid.className = 'jmp-page-picker-grid';

    for (let pageNumber = 1; pageNumber <= state.totalPages; pageNumber++) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'jmp-page-picker-page';
        button.dataset.page = String(pageNumber);
        button.setAttribute('aria-label',
            `Page ${pageNumber}, items ${getPageRangeLabel(pageNumber, state)}`);
        if (pageNumber === state.currentPage) {
            button.setAttribute('aria-current', 'page');
        }

        const number = document.createElement('span');
        number.textContent = String(pageNumber);
        const range = document.createElement('small');
        range.textContent = getPageRangeLabel(pageNumber, state);
        button.append(number, range);
        button.addEventListener('click', () => selectPage(pageNumber));
        grid.appendChild(button);
    }

    panel.append(header, grid);
    overlay.appendChild(panel);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) {
            closePagePicker();
        }
    });

    return { overlay, grid };
}

function openPagePicker(trigger) {
    removePagePicker();

    const state = getPagePickerState(trigger);
    if (!state) {
        return;
    }

    const { overlay, grid } = buildPagePicker(state);
    document.body.appendChild(overlay);
    pagePickerOverlay = overlay;
    pagePickerState = state;

    const currentPage = grid.querySelector('[aria-current="page"]') || grid.firstElementChild;
    currentPage?.focus();
    currentPage?.scrollIntoView?.({ block: 'nearest' });
}

function removePagePicker() {
    pagePickerOverlay?.remove();
    pagePickerOverlay = null;
    pagePickerState = null;
}

function closePagePicker() {
    const trigger = pagePickerState?.trigger;
    removePagePicker();
    if (trigger?.isConnected) {
        trigger.focus();
    }
}

function getPagePickerColumnCount(grid) {
    const columns = window.getComputedStyle(grid).gridTemplateColumns;
    return columns ? columns.split(' ').filter(Boolean).length : 1;
}

function handlePagePickerKeyDown(event) {
    if (!pagePickerOverlay) {
        return;
    }

    if (event.key === 'Escape' || event.key === 'Esc') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        closePagePicker();
        return;
    }

    if (event.key === 'Tab') {
        const buttons = Array.from(pagePickerOverlay.querySelectorAll('button'));
        if (!buttons.length) {
            return;
        }

        const currentIndex = buttons.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
            ? (currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1)
            : (currentIndex < 0 || currentIndex === buttons.length - 1 ? 0 : currentIndex + 1);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        buttons[nextIndex].focus();
        return;
    }

    const grid = pagePickerOverlay.querySelector('.jmp-page-picker-grid');
    const pageButtons = Array.from(grid?.querySelectorAll('.jmp-page-picker-page') || []);
    const currentIndex = pageButtons.indexOf(document.activeElement);
    if (currentIndex < 0) {
        return;
    }

    const columns = getPagePickerColumnCount(grid);
    let nextIndex;
    if (event.key === 'ArrowLeft') {
        nextIndex = currentIndex - 1;
    } else if (event.key === 'ArrowRight') {
        nextIndex = currentIndex + 1;
    } else if (event.key === 'ArrowUp') {
        nextIndex = currentIndex - columns;
    } else if (event.key === 'ArrowDown') {
        nextIndex = currentIndex + columns;
    } else if (event.key === 'Home') {
        nextIndex = 0;
    } else if (event.key === 'End') {
        nextIndex = pageButtons.length - 1;
    } else {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const nextButton = pageButtons[Math.max(0, Math.min(pageButtons.length - 1, nextIndex))];
    nextButton.focus();
    nextButton.scrollIntoView?.({ block: 'nearest' });
}

function getLibrarySettingsCandidates(startIndex, libraryId) {
    const suffix = libraryId ? ` - ${libraryId}` : null;
    const candidates = [];
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || (suffix && !key.endsWith(suffix))) {
            continue;
        }

        try {
            const settings = JSON.parse(window.localStorage.getItem(key));
            if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
                continue;
            }
            if (Number(settings.StartIndex) === startIndex) {
                candidates.push({ key, settings });
            }
        } catch {
            // Ignore localStorage entries that are not library view settings.
        }
    }
    return candidates;
}

function setLibraryStartIndex(key, settings, startIndex) {
    window.localStorage.setItem(key, JSON.stringify({
        ...settings,
        StartIndex: startIndex
    }));
    window.dispatchEvent(new StorageEvent('local-storage', { key }));
}

function getVisiblePageLabel() {
    return document.querySelector('.MuiToolbar-root.padded-left .MuiChip-label')
        ?.textContent?.trim() || null;
}

function waitForLibraryPageStart(expectedStartIndex, timeout = 10000) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const check = () => {
            const range = getVisiblePageRange();
            if (range?.startIndex === expectedStartIndex) {
                resolve(true);
                return;
            }
            if (Date.now() - startedAt >= timeout) {
                resolve(false);
                return;
            }
            window.setTimeout(check, 100);
        };
        check();
    });
}

function waitForLibraryPageStateChange(previousLabel, timeout = 500) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const check = () => {
            const label = getVisiblePageLabel();
            if (label !== null && label !== previousLabel) {
                resolve(true);
                return;
            }
            if (Date.now() - startedAt >= timeout) {
                resolve(false);
                return;
            }
            window.setTimeout(check, 50);
        };
        check();
    });
}

async function setLibraryPage(state, targetStartIndex) {
    const currentRange = getVisiblePageRange();
    if (!currentRange) {
        return false;
    }

    const candidates = getLibrarySettingsCandidates(currentRange.startIndex, state.libraryId);
    for (const candidate of candidates) {
        const previousValue = window.localStorage.getItem(candidate.key);
        setLibraryStartIndex(candidate.key, candidate.settings, targetStartIndex);
        if (await waitForLibraryPageStateChange(currentRange.label)) {
            await waitForLibraryPageStart(targetStartIndex);
            return true;
        }

        if (previousValue === null) {
            window.localStorage.removeItem(candidate.key);
        } else {
            window.localStorage.setItem(candidate.key, previousValue);
        }
        window.dispatchEvent(new StorageEvent('local-storage', { key: candidate.key }));
    }

    return false;
}

function clickLibraryPagination(direction) {
    const groups = Array.from(
        document.querySelectorAll('.MuiToolbar-root.padded-left .MuiButtonGroup-root')
    );
    const group = groups.find(candidate => candidate.querySelector('svg[data-testid="NavigateNextIcon"]')) ||
        groups[groups.length - 1];

    let button;
    if (group) {
        const buttons = Array.from(group.querySelectorAll('button'));
        button = direction === 'next' ? buttons[buttons.length - 1] : buttons[0];
    } else {
        button = document.querySelector(direction === 'next' ? '.paging .btnNextPage' : '.paging .btnPrevPage');
    }

    if (!button || button.disabled) {
        return false;
    }
    button.click();
    return true;
}

function snapshotLibrarySettings() {
    const snapshot = new Map();
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key) {
            continue;
        }
        try {
            const settings = JSON.parse(window.localStorage.getItem(key));
            if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
                snapshot.set(key, Number(settings.StartIndex));
            }
        } catch {
            // Ignore localStorage entries that are not library view settings.
        }
    }
    return snapshot;
}

function findUpdatedLibrarySettings(snapshot, startIndex) {
    for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (!key || snapshot.get(key) === startIndex) {
            continue;
        }
        try {
            const settings = JSON.parse(window.localStorage.getItem(key));
            if (settings && typeof settings === 'object' && !Array.isArray(settings) &&
                Number(settings.StartIndex) === startIndex) {
                return { key, settings };
            }
        } catch {
            // Ignore localStorage entries that are not library view settings.
        }
    }
    return null;
}

function waitForLibrarySettingsUpdate(snapshot, expectedStartIndex, timeout = 3000) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const check = () => {
            const updated = findUpdatedLibrarySettings(snapshot, expectedStartIndex);
            if (updated) {
                resolve(updated);
                return;
            }
            if (Date.now() - startedAt >= timeout) {
                resolve(null);
                return;
            }
            window.setTimeout(check, 100);
        };
        check();
    });
}

async function stepLibraryPage(state, targetStartIndex) {
    const range = getVisiblePageRange();
    if (!range) {
        return false;
    }

    const goingForward = range.startIndex < targetStartIndex;
    const expectedStepStartIndex = goingForward
        ? range.startIndex + state.pageSize
        : Math.max(0, range.startIndex - state.pageSize);

    const snapshot = snapshotLibrarySettings();
    if (!clickLibraryPagination(goingForward ? 'next' : 'previous')) {
        return false;
    }

    // Moving one page makes the web client persist the active view's settings key.
    const updated = await waitForLibrarySettingsUpdate(snapshot, expectedStepStartIndex);
    if (!updated) {
        return false;
    }

    if (expectedStepStartIndex !== targetStartIndex) {
        setLibraryStartIndex(updated.key, updated.settings, targetStartIndex);
        await waitForLibraryPageStart(targetStartIndex);
    }

    return true;
}

async function goToLibraryPage(state, pageNumber) {
    const targetStartIndex = Math.min(
        Math.max(0, (pageNumber - 1) * state.pageSize),
        Math.max(0, state.total - 1)
    );

    if (getVisiblePageRange()?.startIndex === targetStartIndex) {
        window.scrollTo(0, 0);
        return;
    }

    window.scrollTo(0, 0);

    if (!(await setLibraryPage(state, targetStartIndex)) &&
        !(await stepLibraryPage(state, targetStartIndex))) {
        console.warn('Input Plugin: Could not change the library page.', {
            targetStartIndex,
            visibleRange: getVisiblePageRange()?.label || null
        });
    }
}

function selectPage(pageNumber) {
    const state = pagePickerState;
    if (!state) {
        return;
    }

    closePagePicker();
    goToLibraryPage(state, pageNumber).catch(error => {
        console.error('Input Plugin: Failed to change the library page:', error);
    });
}

function clearPagePickerTrigger(chip) {
    if (!chip.hasAttribute(PAGE_PICKER_TRIGGER_ATTR)) {
        return;
    }
    chip.removeAttribute(PAGE_PICKER_TRIGGER_ATTR);
    chip.removeAttribute('role');
    chip.removeAttribute('tabindex');
    chip.removeAttribute('title');
    chip.removeAttribute('aria-haspopup');
}

function ensurePagePickerTrigger() {
    const chip = document.querySelector('.MuiToolbar-root.padded-left .MuiChip-root');
    if (!chip) {
        return;
    }

    if (!document.querySelector('.libraryPage') || !getVisiblePageRange()) {
        clearPagePickerTrigger(chip);
        return;
    }

    if (!chip.hasAttribute(PAGE_PICKER_TRIGGER_ATTR)) {
        chip.setAttribute(PAGE_PICKER_TRIGGER_ATTR, 'true');
        chip.setAttribute('role', 'button');
        chip.setAttribute('tabindex', '0');
        chip.setAttribute('title', 'Select page');
        chip.setAttribute('aria-haspopup', 'dialog');
    }
}

function schedulePagePickerTriggerUpdate() {
    if (pagePickerTriggerFrame !== null) {
        return;
    }
    pagePickerTriggerFrame = window.requestAnimationFrame(() => {
        pagePickerTriggerFrame = null;
        ensurePagePickerTrigger();
    });
}

function handlePagePickerTriggerClick(event) {
    const trigger = event.target?.closest?.(`[${PAGE_PICKER_TRIGGER_ATTR}]`);
    if (!trigger) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openPagePicker(trigger);
}

function handlePagePickerTriggerKeyDown(event) {
    const trigger = event.target?.closest?.(`[${PAGE_PICKER_TRIGGER_ATTR}]`);
    if (!trigger || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    openPagePicker(trigger);
}

function initPagePicker() {
    if (!document.body) {
        window.addEventListener('DOMContentLoaded', initPagePicker, { once: true });
        return;
    }

    injectPagePickerStyle();
    document.addEventListener('click', handlePagePickerTriggerClick, true);
    document.addEventListener('keydown', handlePagePickerTriggerKeyDown, true);
    window.addEventListener('keydown', handlePagePickerKeyDown, true);
    window.addEventListener('hashchange', removePagePicker);
    document.addEventListener('viewshow', removePagePicker, true);

    pagePickerTriggerObserver = new MutationObserver(schedulePagePickerTriggerUpdate);
    pagePickerTriggerObserver.observe(document.body, { childList: true, subtree: true });
    ensurePagePickerTrigger();
}

function returnToMusicVideosLibrary(event, playbackManager) {
    if (!pendingMusicVideoReturn?.libraryRoute || window.location.hash.split('?')[0] !== '#/video') {
        return;
    }

    const backButton = event.target?.closest?.('.videoOsd-appBar button');
    const toolbar = backButton?.closest('.videoOsd-appBar');
    if (!backButton || toolbar?.querySelector('button') !== backButton) {
        return;
    }

    const playerState = playbackManager.getPlayerState();
    if (pendingMusicVideoPageAdvance?.itemId === playerState?.NowPlayingItem?.Id) {
        advanceMusicVideosPageOnPlayback(playbackManager, playerState);
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    window.location.hash = pendingMusicVideoReturn.libraryRoute;
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

        const visibleRange = getVisiblePageRange();
        if (visibleRange?.startIndex === pendingReturn.startIndex) {
            const activeCard = Array.from(document.querySelectorAll('.card[data-id], .listItem[data-id]'))
                .find(card => card.getAttribute('data-id') === pendingReturn.itemId);
            if (activeCard) {
                if (!activeCard.hasAttribute('tabindex')) {
                    activeCard.setAttribute('tabindex', '-1');
                }
                activeCard.focus();
                activeCard.scrollIntoView({ block: 'center', inline: 'nearest' });
            }
            pendingMusicVideoReturn = null;
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

        if (visibleRange && !pendingReturn.pageChangeRequested) {
            const isPreviousPage = visibleRange.startIndex > pendingReturn.startIndex;
            const expectedLabel = isPreviousPage ? 'Previous' : 'Next';
            const paginationButton = Array.from(document.querySelectorAll('button'))
                .find(button => (
                    [button.title, button.getAttribute('aria-label')]
                        .some(label => label?.trim().toLowerCase() === expectedLabel.toLowerCase())
                ));

            if (paginationButton && !paginationButton.disabled) {
                pendingReturn.pageChangeRequested = true;
                paginationButton.click();
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
                startIndex: librarySettings.StartIndex,
                pageChecks: 0,
                pageCheckScheduled: false,
                pageChangeRequested: false
            };
        } catch (error) {
            console.error('Input Plugin: Could not restore the next Music Videos page:', error);
        }
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

    // Let the default single-video playback handle the click when queueing is disabled.
    if (window.jmpInfo?.settings?.main?.playAllVideosFromLibrary === false) {
        return;
    }

    const card = actionElement.closest('[data-id][data-serverid][data-mediatype="Video"]');
    const itemsContainer = card?.closest('.itemsContainer');

    if (!card || !itemsContainer) {
        return;
    }

    const siblingCards = itemsContainer.querySelectorAll('[data-id][data-serverid][data-mediatype="Video"]');
    const cardIndex = Array.prototype.indexOf.call(siblingCards, card);

    if (cardIndex < 0) {
        return;
    }

    const nextVideoCard = siblingCards[cardIndex + 1];

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
        (/(?:^|\/)musicvideos(?:[?#]|$)/.test(
            `${window.location.pathname}${window.location.hash}`
        ) && routeParams.get('tab') === '2');
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
        ? getVisiblePageRange()
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
                    if (!isMusicVideosPage) {
                        return resultItems[0]?.Id;
                    }

                    const anchorId = musicVideoPageItemIds[musicVideoPageItemIds.length - 1];
                    const anchorIndex = resultItems.findIndex(item => item.Id === anchorId);
                    const nextPageItemIds = getItemIdsAfterAnchor(resultItems, anchorId);
                    const nextId = nextPageItemIds[0];
                    if (!nextId) {
                        console.error('Input Plugin: Could not find the last visible video in the next-page lookup; refusing to guess the successor.', {
                            anchorId,
                            lookupStartIndex: pageEnd - 1,
                            responseStartIndex: result?.StartIndex ?? null
                        });
                        return undefined;
                    }

                    musicVideoNextIndex = (result?.StartIndex ?? pageEnd - 1) + anchorIndex + 1;
                    musicVideoNextPageIds = nextPageItemIds;
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

        initPagePicker();

        this.videoBackHandler = event => returnToMusicVideosLibrary(event, playbackManager);
        this.musicVideoReturnHandler = () => {
            window.setTimeout(refreshMusicVideosLibraryOnReturn, 100);
        };
        window.addEventListener('hashchange', this.musicVideoReturnHandler);
        document.addEventListener('viewshow', this.musicVideoReturnHandler, true);
        document.addEventListener('click', this.videoBackHandler, true);
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
