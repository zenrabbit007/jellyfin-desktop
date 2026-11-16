(function() {
// Replaces the server-generated trickplay images in the video OSD with frames
// that are extracted on demand from the stream by the native player. While the
// setting is enabled the native frames are always used, even for items that the
// Jellyfin trickplay scheduled task already processed.
const REQUEST_WIDTH = 400;
const BUBBLE_MAX_WIDTH = 320;
const BUBBLE_MAX_HEIGHT = 220;
const SHORT_VIDEO_MS = 30 * 60 * 1000;
const SHORT_VIDEO_INTERVAL_MS = 5000;
const LONG_VIDEO_INTERVAL_MS = 10000;
const CACHE_LIMIT = 500;
const NEARBY_BUCKETS = 3;
const PREFETCH_FRAMES = 2;
const PREFETCH_DELAY_MS = 350;
// The worker answers every request it receives, but a lost answer must not block
// previews for good. This has to stay above the worker's own load + seek budget
// (30s + 15s), otherwise big/slow files get superseded while they are still
// being read and never produce a frame.
const IN_FLIGHT_TIMEOUT_MS = 50000;
const REQUEST_TIMEOUT_MS = 60000;

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

function isPreviewEnabled() {
    // Client Settings > Video > Seek Bar Previews. Missing settings (older
    // configs) keep the feature on.
    return window.jmpInfo?.settings?.video?.trickplay_preview !== false;
}

function splitKey(key) {
    const separator = key.lastIndexOf('|');
    return {
        itemKey: key.slice(0, separator),
        bucket: Number(key.slice(separator + 1))
    };
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
        this.bucketsByItem = new Map();
        this.pending = new Map();
        this.prefetchQueue = [];
        this.lastRequestedKey = null;
        this.lastBucket = null;
        this.inFlight = null;
        this.prefetchTimer = undefined;
        this.warnedNoInfo = false;
        this.loggedFailures = new Set();
        this.loggedItem = null;
        this.loggedRequestItem = null;
        this.wrappedUpdateBubbleHtml = null;
        this.loggedRender = null;
        this.loggedSkip = null;
        this.loggedImageItem = null;
        this.lastHoverLogAt = 0;
        this.originalUpdateBubbleHtml = null;
        this.lastFrame = null;
        this.direction = 1;
        this.patchScheduled = false;
        this.patchCount = 0;
        this.loggedHookItem = null;
        this.loggedDisabled = false;
        this.loggedBadValue = false;

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

        // The client assigns its bubble handler once per playback, and the seek
        // bar it belongs to can be replaced (or lose our accessor) without any
        // DOM mutation the observer would see. A cheap identity check keeps the
        // hook alive for the second and every later video of a session.
        window.setInterval(() => this.patchSlider(), 500);
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
        this.api.trickplay.thumbnailFailed.connect((cacheKey, reason) => {
            this.onThumbnailFailed(cacheKey, reason);
        });

        // Turning the setting off should stop background prefetching right
        // away, not only on the next pointer move.
        window.jmpInfo?.settingsUpdate?.push((section) => {
            if (section === 'video' && !isPreviewEnabled()) {
                this.stopPreviewing();
            }
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
        if (!slider) {
            return;
        }

        // Only skip while our wrapper is still the live handler. The client
        // drops it between playbacks (deleting the property or assigning the
        // prototype method again), which an "already patched" marker on the
        // element cannot detect; a silent miss means no previews at all.
        if (slider === this.slider && slider.updateBubbleHtml === this.wrappedUpdateBubbleHtml) {
            return;
        }

        this.slider = slider;
        this.originalUpdateBubbleHtml = slider.updateBubbleHtml === this.wrappedUpdateBubbleHtml
            ? this.originalUpdateBubbleHtml
            : slider.updateBubbleHtml;

        this.patchCount += 1;
        console.info('Trickplay Preview: hooked the seek bar (' + this.patchCount + (
            this.patchCount === 1 ? ')' : ', the client had dropped the previous handler)'
        ));

        const plugin = this;
        const wrapped = function(bubble, value) {
            const original = plugin.originalUpdateBubbleHtml;
            if (typeof original === 'function') {
                // Run the client's handler first: it sizes and positions the
                // bubble. The preview below then replaces its content.
                original.call(this, bubble, value);
            }

            return plugin.onSliderBubbleUpdate(this, bubble, value);
        };

        this.wrappedUpdateBubbleHtml = wrapped;

        // The video player assigns updateBubbleHtml whenever the OSD view is
        // initialized, and it is called both while hovering and while dragging
        // the slider. An accessor keeps the wrapper in place across those
        // assignments.
        try {
            Object.defineProperty(slider, 'updateBubbleHtml', {
                configurable: true,
                enumerable: true,
                get() {
                    return wrapped;
                },
                set(fn) {
                    plugin.originalUpdateBubbleHtml = fn;
                }
            });
        } catch (error) {
            console.error('Trickplay Preview: could not hook the seek bar', error);
        }
    }

    getPlaybackInfo() {
        const playbackManager = this.playbackManager;
        const player = playbackManager?._currentPlayer;

        this.noPreviewReason = 'no player';
        if (!player) {
            return null;
        }

        let state;
        try {
            state = playbackManager.getPlayerState(player);
        } catch (error) {
            this.noPreviewReason = 'no player state';
            return null;
        }

        const item = state?.NowPlayingItem;
        if (!item || item.MediaType !== 'Video') {
            this.noPreviewReason = 'not a video';
            return null;
        }

        // Live streams have no fixed timeline to preview.
        if (item.Type === 'TvChannel' || item.IsLive) {
            this.noPreviewReason = 'live stream';
            return null;
        }

        const durationTicks = item.RunTimeTicks || state.MediaSource?.RunTimeTicks || 0;
        if (!(durationTicks > 0)) {
            this.noPreviewReason = 'unknown duration';
            return null;
        }

        const url = typeof player.currentSrc === 'function' ? player.currentSrc() : player._currentSrc;
        if (!url) {
            this.noPreviewReason = 'no stream url';
            return null;
        }

        this.noPreviewReason = null;

        const mediaSourceId = state.MediaSource?.Id || item.Id;
        const durationMs = durationTicks / 10000;
        const interval = durationMs <= SHORT_VIDEO_MS
            ? SHORT_VIDEO_INTERVAL_MS
            : LONG_VIDEO_INTERVAL_MS;

        return {
            item,
            url,
            interval,
            durationMs,
            cacheKey: (item.ServerId || '') + '|' + item.Id + '|' + mediaSourceId
        };
    }

    onSliderBubbleUpdate(slider, bubble, value) {
        if (!this.api?.trickplay || !isPreviewEnabled()) {
            if (!this.loggedDisabled) {
                this.loggedDisabled = true;
                console.info('Trickplay Preview: hook ran but previews are off ('
                    + (!this.api?.trickplay ? 'native component unavailable' : 'setting disabled') + ')');
            }

            if (this.hover || this.prefetchQueue.length) {
                this.stopPreviewing(bubble);
            }
            return false;
        }

        this.loggedDisabled = false;

        const info = this.getPlaybackInfo();
        if (!info) {
            if (!this.warnedNoInfo) {
                this.warnedNoInfo = true;
                console.info('Trickplay Preview: nothing to preview (' + (this.noPreviewReason || 'unknown') + ')');
            }
            this.hover = null;
            this.prefetchQueue = [];
            return false;
        }

        this.warnedNoInfo = false;

        if (this.loggedHookItem !== info.cacheKey) {
            this.loggedHookItem = info.cacheKey;
            console.info('Trickplay Preview: hook is active for item ' + info.item.Id);
        }

        const positionMs = info.durationMs * value / 100;
        if (!Number.isFinite(positionMs) || positionMs < 0) {
            if (!this.loggedBadValue) {
                this.loggedBadValue = true;
                console.info('Trickplay Preview: unusable slider value ' + value
                    + ' (duration ' + info.durationMs + ' ms)');
            }
            return false;
        }

        this.loggedBadValue = false;

        const bucket = Math.floor(positionMs / info.interval) * info.interval;

        if (this.lastBucket !== null && bucket !== this.lastBucket) {
            this.direction = bucket > this.lastBucket ? 1 : -1;
        }
        this.lastBucket = bucket;

        const key = info.cacheKey + '|' + bucket;
        const cached = this.cache.get(key);

        this.hover = { bubble, key, positionMs, info, slider };
        this.logHover(bucket, cached ? 'cached' : (this.findNearby(info, bucket) ? 'nearby' : (this.lastFrameThumbnail(info) ? 'last' : 'none')));

        if (cached) {
            this.renderThumbnail(slider, bubble, info, positionMs, cached);
            this.schedulePrefetch(info, bucket);
            return true;
        }

        // Keep an image in the bubble while the exact frame is generated:
        // prefer a frame next to the pointer, otherwise the newest frame we
        // have. Without this a drag would flash the plain time text.
        const placeholder = this.findNearby(info, bucket) || this.lastFrameThumbnail(info);

        if (placeholder) {
            this.renderThumbnail(slider, bubble, info, positionMs, placeholder);
        } else {
            this.renderDefaultBubble(slider, bubble, value, positionMs);
        }

        this.requestThumbnail(info, bucket, key, false);
        return true;
    }

    logHover(bucket, source) {
        const now = performance.now();
        if (this.lastHoverLogAt && now - this.lastHoverLogAt < 300) {
            this.lastHoverLogSource = source;
            return;
        }

        this.lastHoverLogAt = now;
        console.info('Trickplay Preview: hover ' + formatTime(bucket) + ' served from ' + source);
    }

    verifyImage(bubble, info) {
        if (this.loggedImageItem === info.cacheKey) {
            return;
        }

        this.loggedImageItem = info.cacheKey;
        window.requestAnimationFrame(() => {
            const image = bubble.querySelector('.jmpTpImage');
            console.info(
                'Trickplay Preview: image ' + (image ? image.naturalWidth + 'x' + image.naturalHeight + ' complete=' + image.complete : 'missing')
            );
        });
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

        // Styled inline, after YouTube's seek preview: a hairline white frame
        // around a rounded thumbnail with the time below, and no box around
        // the whole thing.
        bubble.style.background = 'transparent';
        bubble.style.borderRadius = '0';
        bubble.style.boxShadow = 'none';
        bubble.style.overflow = 'visible';
        bubble.style.padding = '0';

        bubble.innerHTML =
            '<div class="jmpTpBubble" style="display:flex;flex-direction:column;align-items:center;">' +
                '<div class="jmpTpFrame" style="border:1px solid #fff;border-radius:9px;' +
                    'overflow:hidden;line-height:0;">' +
                    '<img class="jmpTpImage" src="' + thumbnail.dataUrl + '" alt="" ' +
                        'style="display:block;width:' + width + 'px;height:' + height + 'px;' +
                        'border-radius:8px;" />' +
                '</div>' +
                '<div class="jmpTpTime" style="margin-top:24px;color:#eee;font-size:1.05em;' +
                    'font-weight:500;letter-spacing:0.01em;line-height:1.2;' +
                    'text-shadow:0 1px 3px rgba(0,0,0,0.95);">' +
                    formatTime(positionMs) + '</div>' +
            '</div>';

        this.verifyImage(bubble, info);

        if (this.loggedRender !== info.cacheKey) {
            this.loggedRender = info.cacheKey;
            const style = window.getComputedStyle(bubble);
            console.info(
                'Trickplay Preview: rendered ' + width + 'x' + height + ' into a '
                + Math.round(bubble.offsetWidth) + 'x' + Math.round(bubble.offsetHeight)
                + ' bubble (display ' + style.display + ', visibility ' + style.visibility
                + ', hidden ' + bubble.classList.contains('hide') + ')'
            );
        }

        // The slider positions the bubble before filling it, so its width may
        // have changed by now. Re-center it with the new size.
        window.requestAnimationFrame(() => {
            repositionBubble(slider, bubble, positionMs, info);
        });
    }

    findNearby(info, bucket) {
        const buckets = this.bucketsByItem.get(info.cacheKey);
        if (!buckets) {
            return null;
        }

        for (let step = 1; step <= NEARBY_BUCKETS; ++step) {
            for (const offset of [step, -step]) {
                const key = buckets.get(bucket + offset * info.interval);
                if (key && this.cache.has(key)) {
                    return this.cache.get(key);
                }
            }
        }

        return null;
    }

    schedulePrefetch(info, bucket) {
        // Fill the frames around the hovered position so moving the pointer --
        // or dragging the slider -- finds them already cached.
        const queue = [];
        const seen = new Set();

        for (let step = 1; step <= NEARBY_BUCKETS; ++step) {
            for (const offset of [this.direction, -this.direction]) {
                const target = bucket + offset * step * info.interval;
                if (target < 0 || target > info.durationMs) {
                    continue;
                }

                const key = info.cacheKey + '|' + target;
                if (seen.has(key) || this.cache.has(key) || this.pending.has(key)) {
                    continue;
                }

                seen.add(key);
                queue.push({ info, bucket: target, key });
                if (queue.length >= PREFETCH_FRAMES) {
                    break;
                }
            }
            if (queue.length >= PREFETCH_FRAMES) {
                break;
            }
        }

        this.prefetchQueue = queue;

        // Only warm up the cache once the pointer has settled: prefetching
        // while it moves would seek (and re-read) the stream for nothing.
        if (this.prefetchTimer === undefined) {
            this.prefetchTimer = window.setTimeout(() => {
                this.prefetchTimer = undefined;
                this.pumpPrefetch();
            }, PREFETCH_DELAY_MS);
        }
    }

    cancelPrefetchTimer() {
        if (this.prefetchTimer !== undefined) {
            window.clearTimeout(this.prefetchTimer);
            this.prefetchTimer = undefined;
        }
    }

    pumpPrefetch() {
        if (this.pending.size > 0) {
            // An interactive request is in flight; background work would
            // cancel it. Resume once it is answered.
            return;
        }

        const next = this.prefetchQueue.shift();
        if (!next) {
            return;
        }

        const current = this.getPlaybackInfo();
        if (!current || current.cacheKey !== next.info.cacheKey) {
            this.prefetchQueue = [];
            return;
        }

        this.requestThumbnail(next.info, next.bucket, next.key, true);
    }

    requestThumbnail(info, bucket, key, background) {
        if (background) {
            if (this.cache.has(key) || this.pending.has(key)) {
                return;
            }
            this.dispatchThumbnail(info, bucket, key);
            return;
        }

        if (this.cache.has(key)) {
            return;
        }

        if (this.lastRequestedKey === key && this.pending.has(key)) {
            return;
        }

        // The frame under the pointer is still being generated. Dispatching it
        // again supersedes the request in the worker, so the work restarts from
        // the beginning -- on a large (4K) file it would never finish.
        if (this.inFlight && this.inFlight.key === key) {
            return;
        }

        // Let the request that is already running finish. Cancelling it on
        // every pointermove means no frame is ever produced while the pointer
        // moves -- the next one starts from scratch again. When it is done,
        // requestHoveredThumbnail() asks for wherever the pointer is by then.
        if (this.inFlight && this.inFlight.itemKey === info.cacheKey) {
            const elapsed = performance.now() - this.inFlight.startedAt;

            // An answer can get lost (superseded in the native worker, or the
            // item changed under us). Never let that block previews for good.
            if (elapsed < IN_FLIGHT_TIMEOUT_MS) {
                return;
            }

            console.info(`Trickplay Preview: no answer for ${Math.round(elapsed)}ms, retrying`);
        }

        // The hovered frame wins over any queued background work.
        this.prefetchQueue = [];

        // The worker only keeps the latest request alive, so the ones it
        // dropped will never be answered.
        for (const pendingKey of Array.from(this.pending.keys())) {
            this.clearPending(pendingKey);
        }

        if (this.loggedRequestItem !== info.cacheKey) {
            this.loggedRequestItem = info.cacheKey;
            console.info('Trickplay Preview: requesting a frame at ' + formatTime(bucket));
        }

        this.lastRequestedKey = key;
        this.inFlight = { itemKey: info.cacheKey, key, startedAt: performance.now() };
        this.dispatchThumbnail(info, bucket, key);
    }

    dispatchThumbnail(info, bucket, key) {
        const timer = window.setTimeout(() => {
            this.pending.delete(key);
            if (this.inFlight?.key === key) {
                this.inFlight = null;
                this.requestHoveredThumbnail();
            }
            this.pumpPrefetch();
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(key, timer);

        try {
            this.api.trickplay.requestThumbnail(info.url, bucket, REQUEST_WIDTH, key);
        } catch (error) {
            console.error('Trickplay Preview: request failed', error);
            window.clearTimeout(timer);
            this.pending.delete(key);
            if (this.inFlight?.key === key) {
                this.inFlight = null;
            }
        }
    }

    requestHoveredThumbnail() {
        const hover = this.hover;
        if (!hover || this.cache.has(hover.key)) {
            return;
        }

        if (this.inFlight?.key === hover.key) {
            return;
        }

        this.requestThumbnail(hover.info, splitKey(hover.key).bucket, hover.key, false);
    }

    onThumbnailReady(cacheKey, dataUrl, width, height) {
        this.clearPending(cacheKey);
        this.dropSupersededRequest(cacheKey);

        this.storeThumbnail(cacheKey, { dataUrl, width, height });

        const { itemKey, bucket } = splitKey(cacheKey);
        if (this.loggedItem !== itemKey) {
            this.loggedItem = itemKey;
            console.info('Trickplay Preview: frames are being generated for this item');
        }
        this.lastFrame = { itemKey, thumbnail: this.cache.get(cacheKey) };

        const hover = this.hover;
        if (hover && hover.key === cacheKey) {
            this.refreshBubble();

            // The pointer stopped here, so warm up the frames around it.
            this.schedulePrefetch(hover.info, bucket);
            return;
        }

        // The pointer moved on while this frame was generated: show it anyway
        // and ask for the frame under the pointer.
        this.refreshBubble();
        this.requestHoveredThumbnail();
        this.pumpPrefetch();
    }

    dropSupersededRequest() {
        // The worker answers one request at a time and silently drops what it
        // superseded. Whatever arrives, the request we were waiting for is
        // either answered or obsolete, so it must not hold the pipeline back.
        this.inFlight = null;
    }

    onThumbnailFailed(cacheKey, reason) {
        // The worker has no other way to report why a video produced no frame,
        // log every distinct reason once so a failing video can be diagnosed.
        const failure = reason || 'unknown';
        if (!this.loggedFailures.has(failure)) {
            this.loggedFailures.add(failure);
            console.info('Trickplay Preview: native preview failed: ' + failure);
        }
        this.clearPending(cacheKey);
        this.dropSupersededRequest(cacheKey);
        if (this.lastRequestedKey === cacheKey) {
            this.lastRequestedKey = null;
        }

        // Only chase the pointer again when the failure was not for the frame
        // under it. Retrying the hovered frame right away would spin on a video
        // the worker cannot read.
        if (this.hover?.key !== cacheKey) {
            this.requestHoveredThumbnail();
        }

        this.pumpPrefetch();
    }

    stopPreviewing(bubble) {
        // Let the standard tooltip come back and stop any background work.
        this.resetBubbleStyles(bubble || this.hover?.bubble);
        this.hover = null;
        this.prefetchQueue = [];
        this.cancelPrefetchTimer();
        this.inFlight = null;
        this.lastRequestedKey = null;

        for (const pendingKey of Array.from(this.pending.keys())) {
            this.clearPending(pendingKey);
        }
    }

    resetBubbleStyles(bubble) {
        if (!bubble) {
            return;
        }

        // The preview styles are inline, so they have to be dropped again or
        // the client's own tooltip would render without its background.
        bubble.style.background = '';
        bubble.style.padding = '';
        bubble.style.borderRadius = '';
        bubble.style.boxShadow = '';
        bubble.style.overflow = '';

        if (bubble.querySelector('.jmpTpBubble')) {
            // Our preview is still in the bubble; the client rebuilds it on the
            // next update, but it must not linger while previews are off.
            bubble.innerHTML = '';
        }
    }

    lastFrameThumbnail(info) {
        return this.lastFrame?.itemKey === info.cacheKey ? this.lastFrame.thumbnail : null;
    }

    refreshBubble() {
        const hover = this.hover;
        if (!hover) {
            return;
        }

        const { bubble, info, positionMs, slider, key } = hover;
        if (!bubble.isConnected) {
            if (this.loggedSkip !== info.cacheKey) {
                this.loggedSkip = info.cacheKey;
                console.info('Trickplay Preview: frame ready but the bubble is detached');
            }
            return;
        }

        const thumbnail = this.cache.get(key)
            || this.findNearby(info, splitKey(key).bucket)
            || this.lastFrameThumbnail(info);

        if (thumbnail) {
            this.renderThumbnail(slider, bubble, info, positionMs, thumbnail);
        }
    }

    storeThumbnail(key, thumbnail) {
        const { itemKey, bucket } = splitKey(key);
        this.cache.set(key, thumbnail);

        let buckets = this.bucketsByItem.get(itemKey);
        if (!buckets) {
            buckets = new Map();
            this.bucketsByItem.set(itemKey, buckets);
        }
        buckets.set(bucket, key);

        while (this.cache.size > CACHE_LIMIT) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);

            const oldest = splitKey(oldestKey);
            const itemBuckets = this.bucketsByItem.get(oldest.itemKey);
            if (itemBuckets && itemBuckets.get(oldest.bucket) === oldestKey) {
                itemBuckets.delete(oldest.bucket);
            }
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
