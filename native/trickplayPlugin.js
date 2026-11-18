(function() {
// Replaces the trickplay images in the video OSD with frames that are extracted
// on demand from the stream by the native player. This is the fallback: when
// the server already knows the trickplay layout of an item, its tiles are used
// instead -- one tile download covers a whole window of the timeline, while
// every native frame costs a seek of the video stream.
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
// Sweeping the seek bar crosses many buckets. Waiting for the pointer to slow
// down turns that into one or two seeks instead of one per bucket.
const HOVER_REQUEST_DELAY_MS = 120;
// The worker answers every request it receives, but a lost answer must not block
// previews for good. This has to stay above the worker's own load + seek budget
// (30s + 15s), otherwise big/slow files get superseded while they are still
// being read and never produce a frame.
const IN_FLIGHT_TIMEOUT_MS = 50000;
const REQUEST_TIMEOUT_MS = 60000;

function debugEnabled() {
    return window.jmpInfo?.settings?.video?.['debug.trickplay_timings'] === true;
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

function isPreviewEnabled() {
    // Client Settings > Video > Seek Bar Previews. Missing settings (older
    // configs) keep the feature on.
    return window.jmpInfo?.settings?.video?.trickplay_preview !== false;
}

function preferServerTrickplay() {
    const settings = window.jmpInfo?.settings?.video;
    if (settings?.prefer_server_trickplay === false) {
        return false;
    }

    // Never trade a working local preview for a broken tile set.
    return isPreviewEnabled();
}

function previewTranscoded() {
    // Seeking an HLS stream pulls whole segments, lands on the wrong frame and
    // cannot be cancelled cheaply, so previews stay off unless asked for.
    return window.jmpInfo?.settings?.video?.['debug.preview_transcoded'] === true;
}

function isHlsPlayback(state, url) {
    const playlist = /\.m3u8(\?|$)/i;
    if (playlist.test(String(url))) {
        return true;
    }

    const transcodingUrl = state?.MediaSource?.TranscodingUrl;
    return typeof transcodingUrl === 'string' && playlist.test(transcodingUrl);
}

function hasUsableTrickplay(manifest, mediaSourceId) {
    if (!manifest || typeof manifest !== 'object') {
        return false;
    }

    const resolutions = manifest[mediaSourceId];
    if (!resolutions || typeof resolutions !== 'object') {
        return false;
    }

    return Object.values(resolutions).some((info) => Boolean(info)
        && info.Width > 0
        && info.Height > 0
        && info.TileWidth > 0
        && info.TileHeight > 0
        && info.Interval > 0
        && info.ThumbnailCount > 0);
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
        this.hoverTimer = undefined;
        this.warnedNoInfo = false;
        this.loggedFailures = new Set();
        this.loggedItem = null;
        this.loggedRequestItem = null;
        this.loggedRender = null;
        this.loggedSkip = null;
        this.loggedImageItem = null;
        this.lastHoverLogAt = 0;
        this.hooks = new WeakMap();
        this.loggedStaleOsd = false;
        this.loggedHandlerError = null;
        this.lastFrame = null;
        this.direction = 1;
        this.patchScheduled = false;
        this.patchCount = 0;
        this.lastItemKey = null;
        this.preparedKey = null;
        this.producedItems = new Set();
        this.itemFailures = new Map();
        this.failedItems = new Set();
        this.loggedHookItem = null;
        this.loggedServerItem = null;
        this.loggedServerUnused = null;
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
        window.setInterval(() => {
            this.patchSlider();
            this.schedulePrepare();
        }, 500);
    }

    debug(message) {
        if (debugEnabled()) {
            console.info(message);
        }
    }

    async init() {
        try {
            this.api = await window.apiPromise;
        } catch (error) {
            console.error('Trickplay Preview: could not access native API', error);
            return;
        }

        if (!this.api?.trickplay) {
            console.warn('Trickplay Preview: native component unavailable');
            return;
        }

        this.api.trickplay.thumbnailReady.connect((cacheKey, dataUrl, width, height, finalFrame) => {
            this.onThumbnailReady(cacheKey, dataUrl, width, height, finalFrame);
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
        // Every playback loads the video OSD again, and the page of the
        // previous one can stay in the document. A plain querySelector then
        // keeps returning the seek bar of that dead page, which is why previews
        // only worked for the first video of a session.
        const sliders = document.querySelectorAll('#videoOsdPage .osdPositionSlider');

        for (let index = 0; index < sliders.length; ++index) {
            this.hookSlider(sliders[index]);
        }

        if (sliders.length > 1 && !this.loggedStaleOsd) {
            this.loggedStaleOsd = true;
            this.debug('Trickplay Preview: ' + sliders.length
                + ' video OSD pages are in the document, watching all of their seek bars');
        }
    }

    hookSlider(slider) {
        let record = this.hooks.get(slider);

        if (record && slider.updateBubbleHtml === record.wrapped) {
            this.slider = slider;
            return;
        }

        const plugin = this;

        if (!record) {
            // Adopt the handler the client installed before we got here.
            record = { original: slider.updateBubbleHtml || null };

            record.wrapped = function(bubble, value) {
                if (typeof record.original === 'function') {
                    // Run the client's handler first: it sizes and positions
                    // the bubble. The preview below then replaces its content.
                    try {
                        record.original.call(this, bubble, value);
                    } catch (error) {
                        // The handler of a closed playback must not take the
                        // preview down with it.
                        if (plugin.loggedHandlerError !== String(error)) {
                            plugin.loggedHandlerError = String(error);
                            console.warn('Trickplay Preview: the client bubble handler failed (' + error + ')');
                        }
                    }
                }

                return plugin.onSliderBubbleUpdate(this, bubble, value);
            };

            this.hooks.set(slider, record);
        } else {
            // The client replaced the property, so our accessor is gone.
            record.original = slider.updateBubbleHtml;
        }

        this.slider = slider;

        // The video player assigns updateBubbleHtml whenever the OSD view is
        // initialized, and it is called both while hovering and while dragging
        // the slider. An accessor keeps the wrapper in place across those
        // assignments.
        try {
            Object.defineProperty(slider, 'updateBubbleHtml', {
                configurable: true,
                enumerable: true,
                get() {
                    return record.wrapped;
                },
                set(fn) {
                    record.original = fn;
                }
            });
        } catch (error) {
            console.error('Trickplay Preview: could not hook the seek bar', error);
            return;
        }

        this.patchCount += 1;
        this.debug('Trickplay Preview: hooked the seek bar (' + this.patchCount + (
            this.patchCount === 1 ? ')' : ', the client had changed the handler)'
        ));
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

        if (!previewTranscoded() && isHlsPlayback(state, url)) {
            this.noPreviewReason = 'transcoded playback';
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
            mediaSourceId,
            interval,
            durationMs,
            cacheKey: (item.ServerId || '') + '|' + item.Id + '|' + mediaSourceId
        };
    }

    schedulePrepare() {
        if (!this.api?.trickplay?.prepare || !isPreviewEnabled()) {
            return;
        }

        const info = this.getPlaybackInfo();
        if (!info || this.preparedKey === info.cacheKey) {
            return;
        }

        // Nothing will be requested from the worker when the bubble is filled
        // from the server's own trickplay images, so opening a second stream
        // would only hold a connection and a demuxer cache open for nothing.
        if (preferServerTrickplay() && hasUsableTrickplay(info.item?.Trickplay, info.mediaSourceId)) {
            this.preparedKey = info.cacheKey;
            this.debug('Trickplay Preview: server trickplay is available, not opening the stream');
            return;
        }

        // Opening the stream costs a connection and a header read, so it only
        // happens once the player has a source of its own. After that the first
        // hover only pays for a seek.
        this.preparedKey = info.cacheKey;
        this.debug('Trickplay Preview: opened the stream ahead of the first hover');

        try {
            this.api.trickplay.prepare(info.url);
        } catch (error) {
            console.warn('Trickplay Preview: could not open the stream ahead of time', error);
        }
    }

    onSliderBubbleUpdate(slider, bubble, value) {
        if (!this.api?.trickplay || !isPreviewEnabled()) {
            if (!this.loggedDisabled) {
                this.loggedDisabled = true;
                this.debug('Trickplay Preview: hook ran but previews are off ('
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
                this.debug('Trickplay Preview: nothing to preview (' + (this.noPreviewReason || 'unknown') + ')');
            }
            this.hover = null;
            this.prefetchQueue = [];
            return false;
        }

        this.warnedNoInfo = false;

        if (this.useServerFrames(info, bubble)) {
            // The client's own handler already rendered the server tile before
            // calling us. Claim the bubble -- returning false would make the
            // slider replace the tile with its plain time text.
            if (this.hover || this.prefetchQueue.length || this.hoverTimer !== undefined) {
                this.stopPreviewing(bubble);
            }

            if (this.loggedServerItem !== info.cacheKey) {
                this.loggedServerItem = info.cacheKey;
                this.debug('Trickplay Preview: using the server trickplay tiles for item ' + info.item.Id);
            }

            return true;
        }

        if (this.loggedHookItem !== info.cacheKey) {
            this.loggedHookItem = info.cacheKey;
            this.debug('Trickplay Preview: hook is active for item ' + info.item.Id);
        }

        const positionMs = info.durationMs * value / 100;
        if (!Number.isFinite(positionMs) || positionMs < 0) {
            if (!this.loggedBadValue) {
                this.loggedBadValue = true;
                this.debug('Trickplay Preview: unusable slider value ' + value
                    + ' (duration ' + info.durationMs + ' ms)');
            }
            return false;
        }

        this.loggedBadValue = false;

        const bucket = Math.floor(positionMs / info.interval) * info.interval;

        // Direction drives the prefetch and the last bucket of the previous
        // item would point the wrong way on the first hover of the next one.
        if (this.lastItemKey !== info.cacheKey) {
            this.lastItemKey = info.cacheKey;
            this.lastBucket = null;
            this.direction = 1;
        }

        if (this.lastBucket !== null && bucket !== this.lastBucket) {
            this.direction = bucket > this.lastBucket ? 1 : -1;
        }
        this.lastBucket = bucket;

        const key = info.cacheKey + '|' + bucket;
        const cached = this.lookupThumbnail(key);

        this.hover = { bubble, key, positionMs, info, slider };
        this.logHover(bucket, cached ? (cached.final === false ? 'keyframe' : 'cached') : (this.findNearby(info, bucket) ? 'nearby' : (this.lastFrameThumbnail(info) ? 'last' : 'none')));

        if (cached) {
            this.renderThumbnail(slider, bubble, info, positionMs, cached);

            if (cached.final === false) {
                // This frame came from the keyframe before the position. Ask
                // again now that the pointer came to rest here.
                this.scheduleHoverRequest(info, bucket, key);
            } else {
                this.schedulePrefetch(info, bucket);
            }
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

        this.scheduleHoverRequest(info, bucket, key);
        return true;
    }

    useServerFrames(info, bubble) {
        if (!preferServerTrickplay() || !hasUsableTrickplay(info.item?.Trickplay, info.mediaSourceId)) {
            return false;
        }

        // The client rendered its own bubble before calling us, so stay out of
        // the way only when it actually put a trickplay tile in there.
        const tile = bubble?.querySelector?.('.chapterThumbWrapper');
        const rendered = Boolean(tile && String(tile.style.backgroundImage).includes('/Trickplay/'));

        if (!rendered && this.loggedServerUnused !== info.cacheKey) {
            this.loggedServerUnused = info.cacheKey;
            this.debug('Trickplay Preview: the server has trickplay tiles for this item but the client did not render one, using native frames');
        }

        return rendered;
    }

    scheduleHoverRequest(info, bucket, key) {
        this.cancelHoverRequest();
        this.hoverTimer = window.setTimeout(() => {
            this.hoverTimer = undefined;

            // A sweep of the seek bar crosses bucket after bucket; only the
            // position the pointer came to rest on is worth a seek.
            if (!this.hover || this.hover.key !== key) {
                return;
            }

            this.requestThumbnail(info, bucket, key, false);
        }, HOVER_REQUEST_DELAY_MS);
    }

    cancelHoverRequest() {
        if (this.hoverTimer !== undefined) {
            window.clearTimeout(this.hoverTimer);
            this.hoverTimer = undefined;
        }
    }

    logHover(bucket, source) {
        if (!debugEnabled()) {
            return;
        }

        const now = performance.now();
        if (this.lastHoverLogAt && now - this.lastHoverLogAt < 300) {
            this.lastHoverLogSource = source;
            return;
        }

        this.lastHoverLogAt = now;
        console.info('Trickplay Preview: hover ' + formatTime(bucket) + ' served from ' + source);
    }

    verifyImage(bubble, info) {
        if (!debugEnabled() || this.loggedImageItem === info.cacheKey) {
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

        let frame = bubble.firstElementChild;
        if (!frame || !frame.classList.contains('jmpTpBubble')) {
            // Styled inline, after YouTube's seek preview: a hairline white
            // frame around a rounded thumbnail with the time below, and no box
            // around the whole thing.
            bubble.style.background = 'transparent';
            bubble.style.borderRadius = '0';
            bubble.style.boxShadow = 'none';
            bubble.style.overflow = 'visible';
            bubble.style.padding = '0';

            bubble.innerHTML =
                '<div class="jmpTpBubble" style="display:flex;flex-direction:column;align-items:center;">' +
                    '<div class="jmpTpFrame" style="border:1px solid #fff;border-radius:9px;' +
                        'overflow:hidden;line-height:0;">' +
                        '<img class="jmpTpImage" alt="" ' +
                            'style="display:block;border-radius:8px;" />' +
                    '</div>' +
                    '<div class="jmpTpTime" style="margin-top:24px;color:#eee;font-size:1.05em;' +
                        'font-weight:500;letter-spacing:0.01em;line-height:1.2;' +
                        'text-shadow:0 1px 3px rgba(0,0,0,0.95);"></div>' +
                '</div>';

            frame = bubble.firstElementChild;
        }

        // The bubble is rebuilt only once: replacing it on every pointer move
        // would throw away the decoded frame and make the preview flicker,
        // while swapping the src keeps the previous frame on screen until the
        // new one is decoded.
        const image = frame.querySelector('.jmpTpImage');
        const time = frame.querySelector('.jmpTpTime');

        if (image.getAttribute('src') !== thumbnail.dataUrl) {
            image.setAttribute('src', thumbnail.dataUrl);
        }

        if (image.style.width !== width + 'px') {
            image.style.width = width + 'px';
            image.style.height = height + 'px';
        }

        const label = formatTime(positionMs);
        if (time.textContent !== label) {
            time.textContent = label;
        }

        this.verifyImage(bubble, info);

        if (this.loggedRender !== info.cacheKey) {
            this.loggedRender = info.cacheKey;
            const style = window.getComputedStyle(bubble);
            this.debug(
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
                if (key) {
                    const thumbnail = this.lookupThumbnail(key);
                    if (thumbnail) {
                        return thumbnail;
                    }
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
        // A worker that cannot read this item would otherwise be asked again
        // for every bucket the pointer crosses.
        if (this.failedItems.has(info.cacheKey)) {
            return;
        }

        if (background) {
            if (this.cache.has(key) || this.pending.has(key)) {
                return;
            }
            this.dispatchThumbnail(info, bucket, key, true);
            return;
        }

        const cached = this.cache.get(key);
        if (cached && cached.final !== false) {
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

            this.debug(`Trickplay Preview: no answer for ${Math.round(elapsed)}ms, retrying`);
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
            this.debug('Trickplay Preview: requesting a frame at ' + formatTime(bucket));
        }

        this.lastRequestedKey = key;
        this.inFlight = { itemKey: info.cacheKey, key, startedAt: performance.now() };
        this.dispatchThumbnail(info, bucket, key, false);
    }

    dispatchThumbnail(info, bucket, key, background) {
        const timer = window.setTimeout(() => {
            this.pending.delete(key);
            if (this.inFlight?.key === key) {
                this.inFlight = null;
                this.requestHoveredThumbnail();
            }
            this.pumpPrefetch();
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(key, { timer, background });

        try {
            // A background frame is only a guess at where the pointer goes
            // next, so it is not worth decoding up to that position.
            this.api.trickplay.requestThumbnail(info.url, bucket, REQUEST_WIDTH, key, !background);
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
        if (!hover) {
            return;
        }

        const cached = this.cache.get(hover.key);
        if (cached && cached.final !== false) {
            return;
        }

        if (this.inFlight?.key === hover.key) {
            return;
        }

        this.requestThumbnail(hover.info, splitKey(hover.key).bucket, hover.key, false);
    }

    onThumbnailReady(cacheKey, dataUrl, width, height, finalFrame) {
        const final = finalFrame !== false;

        this.storeThumbnail(cacheKey, { dataUrl, width, height, final });

        const { itemKey, bucket } = splitKey(cacheKey);
        this.lastFrame = { itemKey, thumbnail: this.cache.get(cacheKey) };
        this.producedItems.add(itemKey);

        // The frame at the keyframe before the position arrives first. The
        // exact frame is still being generated, so the request stays pending
        // and the background queue stays paused until it is delivered.
        if (!final) {
            // A speculative request asked for this frame only, so it is done
            // and must not hold the queue back.
            if (this.pending.get(cacheKey)?.background) {
                this.clearPending(cacheKey);
                this.pumpPrefetch();
            }

            if (this.hover?.key === cacheKey) {
                this.refreshBubble();
            }
            return;
        }

        this.clearPending(cacheKey);
        this.dropSupersededRequest();

        if (this.loggedItem !== itemKey) {
            this.loggedItem = itemKey;
            this.debug('Trickplay Preview: frames are being generated for this item');
        }

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
            console.warn('Trickplay Preview: native preview failed: ' + failure);
        }
        this.clearPending(cacheKey);
        this.dropSupersededRequest();
        if (this.lastRequestedKey === cacheKey) {
            this.lastRequestedKey = null;
        }

        this.recordFailure(splitKey(cacheKey).itemKey);

        // Only chase the pointer again when the failure was not for the frame
        // under it. Retrying the hovered frame right away would spin on a video
        // the worker cannot read.
        if (this.hover?.key !== cacheKey) {
            this.requestHoveredThumbnail();
        }

        this.pumpPrefetch();
    }

    recordFailure(itemKey) {
        // A frame that could not be refined is not a broken item: the keyframe
        // frame is already on screen and later positions may work.
        if (this.producedItems.has(itemKey)) {
            return;
        }

        const failures = (this.itemFailures.get(itemKey) || 0) + 1;
        this.itemFailures.set(itemKey, failures);
        if (failures < 2) {
            return;
        }

        this.failedItems.add(itemKey);
        this.debug('Trickplay Preview: giving up on this item, no frame could be read from it');
        this.stopPreviewing();
    }

    stopPreviewing(bubble) {
        // Let the standard tooltip come back and stop any background work.
        this.resetBubbleStyles(bubble || this.hover?.bubble);
        this.hover = null;
        this.prefetchQueue = [];
        this.cancelPrefetchTimer();
        this.cancelHoverRequest();
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
                this.debug('Trickplay Preview: frame ready but the bubble is detached');
            }
            return;
        }

        const thumbnail = this.lookupThumbnail(key)
            || this.findNearby(info, splitKey(key).bucket)
            || this.lastFrameThumbnail(info);

        if (thumbnail) {
            this.renderThumbnail(slider, bubble, info, positionMs, thumbnail);
        }
    }

    lookupThumbnail(key) {
        const thumbnail = this.cache.get(key);
        if (!thumbnail) {
            return null;
        }

        // Re-insert so the least recently used frame is evicted first.
        this.cache.delete(key);
        this.cache.set(key, thumbnail);
        return thumbnail;
    }

    storeThumbnail(key, thumbnail) {
        const { itemKey, bucket } = splitKey(key);
        this.cache.delete(key);
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
        const request = this.pending.get(cacheKey);
        if (request) {
            window.clearTimeout(request.timer);
            this.pending.delete(cacheKey);
        }
    }
}

window._trickplayPlugin = trickplayPlugin;
})();
