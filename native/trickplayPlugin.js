(function() {
// Replaces the server-generated trickplay images in the video OSD with frames
// that are extracted on demand from the stream by the native player. Server
// trickplay is still used when it is available; this is the fallback for items
// that were never processed by the Jellyfin trickplay scheduled task.
const REQUEST_WIDTH = 400;
const BUBBLE_MAX_WIDTH = 320;
const BUBBLE_MAX_HEIGHT = 220;
const SHORT_VIDEO_MS = 15 * 60 * 1000;
const SHORT_VIDEO_INTERVAL_MS = 5000;
const LONG_VIDEO_INTERVAL_MS = 10000;
const CACHE_LIMIT = 300;
const REQUEST_TIMEOUT_MS = 60000;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTime(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
        return hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    }

    return minutes + ':' + String(seconds).padStart(2, '0');
}

function repositionBubble(slider, bubble, positionMs, info) {
    const track = slider.sliderBubbleTrack;
    if (!track || !(info.durationMs > 0)) {
        return;
    }

    const trackRect = track.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    if (!trackRect.width || !bubbleRect.width) {
        return;
    }

    const fraction = Math.min(Math.max(positionMs / info.durationMs, 0), 1);
    let left = trackRect.width * fraction;

    if (window.getComputedStyle(slider).direction === 'rtl') {
        left = trackRect.width - left;
    }

    left = Math.min(Math.max(left, bubbleRect.width / 2), trackRect.width - bubbleRect.width / 2);
    bubble.style.left = left + 'px';
}

function findChapter(item, positionTicks) {
    let chapter;

    for (const current of item?.Chapters || []) {
        if (positionTicks < current.StartPositionTicks) {
            break;
        }
        chapter = current;
    }

    return chapter;
}

class trickplayPlugin {
    constructor({ playbackManager }) {
        this.name = 'Trickplay Preview';
        this.type = 'trickplay';
        this.id = 'trickplayPlugin';

        this.playbackManager = playbackManager;
        this.api = null;
        this.slider = null;
        this.hover = null;
        this.cache = new Map();
        this.pending = new Map();
        this.lastRequestedKey = null;
        this.patchScheduled = false;

        document.addEventListener('viewshow', () => this.schedulePatch(), true);
        document.addEventListener('DOMContentLoaded', () => this.schedulePatch(), { once: true });

        this.observer = new MutationObserver(() => this.schedulePatch());
        if (document.documentElement) {
            this.observer.observe(document.documentElement, { childList: true, subtree: true });
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                this.observer.observe(document.documentElement, { childList: true, subtree: true });
            }, { once: true });
        }

        void this.init();
    }

    async init() {
        try {
            this.api = await window.apiPromise;
        } catch (error) {
            console.error('Trickplay Preview: could not access native API', error);
            return;
        }

        if (!this.api?.trickplay) {
            console.log('Trickplay Preview: native component unavailable');
            return;
        }

        this.api.trickplay.thumbnailReady.connect((cacheKey, dataUrl, width, height) => {
            this.onThumbnailReady(cacheKey, dataUrl, width, height);
        });
        this.api.trickplay.thumbnailFailed.connect((cacheKey) => {
            this.onThumbnailFailed(cacheKey);
        });

        this.schedulePatch();
    }

    schedulePatch() {
        if (this.patchScheduled) {
            return;
        }

        this.patchScheduled = true;
        window.setTimeout(() => {
            this.patchScheduled = false;
            this.patchSlider();
        }, 50);
    }

    patchSlider() {
        const slider = document.querySelector('#videoOsdPage .osdPositionSlider');
        if (!slider || slider === this.slider) {
            return;
        }

        this.slider = slider;

        if (slider.dataset.jmpTrickplayPatched === '1') {
            return;
        }
        slider.dataset.jmpTrickplayPatched = '1';

        let originalUpdateBubbleHtml = slider.updateBubbleHtml;
        const plugin = this;

        const wrapped = function(bubble, value) {
            const handled = typeof originalUpdateBubbleHtml === 'function'
                ? originalUpdateBubbleHtml.call(this, bubble, value)
                : false;

            if (handled) {
                plugin.hover = null;
                return true;
            }

            return plugin.onSliderBubbleUpdate(this, bubble, value);
        };

        // The video player assigns updateBubbleHtml whenever the OSD view is
        // initialized. Use an accessor so the wrapper survives re-assignment.
        Object.defineProperty(slider, 'updateBubbleHtml', {
            configurable: true,
            enumerable: true,
            get() {
                return wrapped;
            },
            set(fn) {
                originalUpdateBubbleHtml = fn;
            }
        });
    }

    getPlaybackInfo() {
        const playbackManager = this.playbackManager;
        const player = playbackManager?._currentPlayer;

        if (!player) {
            return null;
        }

        let state;
        try {
            state = playbackManager.getPlayerState(player);
        } catch (error) {
            return null;
        }

        const item = state?.NowPlayingItem;
        if (!item || item.MediaType !== 'Video') {
            return null;
        }

        // Live streams have no fixed timeline to preview.
        if (item.Type === 'TvChannel' || item.IsLive) {
            return null;
        }

        const durationTicks = item.RunTimeTicks || state.MediaSource?.RunTimeTicks || 0;
        if (!(durationTicks > 0)) {
            return null;
        }

        const url = typeof player.currentSrc === 'function' ? player.currentSrc() : player._currentSrc;
        if (!url) {
            return null;
        }

        const mediaSourceId = state.MediaSource?.Id || item.Id;
        const interval = durationTicks / 10000 <= SHORT_VIDEO_MS
            ? SHORT_VIDEO_INTERVAL_MS
            : LONG_VIDEO_INTERVAL_MS;

        return {
            item,
            url,
            interval,
            durationMs: durationTicks / 10000,
            cacheKey: (item.ServerId || '') + '|' + item.Id + '|' + mediaSourceId
        };
    }

    onSliderBubbleUpdate(slider, bubble, value) {
        if (!this.api?.trickplay) {
            return false;
        }

        const info = this.getPlaybackInfo();
        if (!info) {
            this.hover = null;
            return false;
        }

        const positionMs = info.durationMs * value / 100;
        if (!Number.isFinite(positionMs) || positionMs < 0) {
            return false;
        }

        const bucket = Math.floor(positionMs / info.interval) * info.interval;
        const key = info.cacheKey + '|' + bucket;
        const cached = this.cache.get(key);

        this.hover = { bubble, key, positionMs, info, slider };

        if (cached) {
            this.renderThumbnail(slider, bubble, info, positionMs, cached);
            return true;
        }

        // Keep the regular bubble (time/chapter) visible while the frame is
        // generated in the native player.
        this.renderDefaultBubble(slider, bubble, value, positionMs);
        this.requestThumbnail(info, bucket, key);
        return true;
    }

    renderDefaultBubble(slider, bubble, value, positionMs) {
        let html;

        try {
            html = typeof slider.getBubbleHtml === 'function' ? slider.getBubbleHtml(value) : null;
        } catch (error) {
            html = null;
        }

        bubble.innerHTML = html || '<h1 class="sliderBubbleText">' + formatTime(positionMs) + '</h1>';
    }

    renderThumbnail(slider, bubble, info, positionMs, thumbnail) {
        const sourceWidth = thumbnail.width || 1;
        const sourceHeight = thumbnail.height || 1;
        const scale = Math.min(BUBBLE_MAX_WIDTH / sourceWidth, BUBBLE_MAX_HEIGHT / sourceHeight);
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const chapter = findChapter(info.item, Math.round(positionMs * 10000));
        const chapterName = chapter?.Name ? escapeHtml(chapter.Name) : '';

        bubble.innerHTML =
            '<div class="chapterThumbContainer" style="position:relative;width:' + width + 'px;">' +
                '<div class="chapterThumbWrapper" style="overflow:hidden;width:' + width + 'px;height:' + height + 'px;background:#000;">' +
                    '<img src="' + thumbnail.dataUrl + '" alt="" style="display:block;width:100%;height:100%;object-fit:contain;" />' +
                '</div>' +
                '<div class="chapterThumbTextContainer">' +
                    '<div class="chapterThumbText chapterThumbText-dim">' + chapterName + '</div>' +
                    '<h2 class="chapterThumbText">' + formatTime(positionMs) + '</h2>' +
                '</div>' +
            '</div>';

        // The slider positions the bubble before filling it, so its width may
        // have changed by now. Re-center it with the new size.
        window.requestAnimationFrame(() => {
            repositionBubble(slider, bubble, positionMs, info);
        });
    }

    requestThumbnail(info, bucket, key) {
        // Stay on the same bucket while the pointer moves: no need to ask
        // again. Moving back to a key while another request is in flight does
        // need a new request, because the native worker only keeps the latest
        // one alive.
        if (this.lastRequestedKey === key && this.pending.has(key)) {
            return;
        }

        // The abandoned requests will never be answered, so drop them now
        // instead of letting them block this key for the whole timeout.
        for (const pendingKey of Array.from(this.pending.keys())) {
            this.clearPending(pendingKey);
        }

        this.lastRequestedKey = key;

        const timer = window.setTimeout(() => {
            this.pending.delete(key);
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(key, timer);

        try {
            this.api.trickplay.requestThumbnail(info.url, bucket, REQUEST_WIDTH, key);
        } catch (error) {
            console.error('Trickplay Preview: request failed', error);
            window.clearTimeout(timer);
            this.pending.delete(key);
        }
    }

    onThumbnailReady(cacheKey, dataUrl, width, height) {
        this.clearPending(cacheKey);

        const thumbnail = { dataUrl, width, height };
        this.cache.set(cacheKey, thumbnail);

        while (this.cache.size > CACHE_LIMIT) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        const hover = this.hover;
        if (!hover || hover.key !== cacheKey) {
            return;
        }

        const { bubble, info, positionMs, slider } = hover;
        if (!bubble.isConnected || bubble.classList.contains('hide')) {
            return;
        }

        this.renderThumbnail(slider, bubble, info, positionMs, thumbnail);
    }

    onThumbnailFailed(cacheKey) {
        this.clearPending(cacheKey);
        if (this.lastRequestedKey === cacheKey) {
            this.lastRequestedKey = null;
        }
    }

    clearPending(cacheKey) {
        const timer = this.pending.get(cacheKey);
        if (timer !== undefined) {
            window.clearTimeout(timer);
            this.pending.delete(cacheKey);
        }
    }
}

window._trickplayPlugin = trickplayPlugin;
})();
