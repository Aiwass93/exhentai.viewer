// ==UserScript==
// @name         ExHentai Viewer
// @version      8.0
// @description  keyboard driven, highly customizable user script for e-hentai and exhentai.
// @author       Alison Andre aka John Cake
// @match        https://exhentai.org/s/*
// @match        https://g.e-hentai.org/s/*
// @match        https://e-hentai.org/s/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────────────
    const CONFIG = {
        PRELOAD_COUNT: 10,
        DEFAULT_DIRECTION: 'rtl',
        TOAST_DURATION: 1400,
        KEY_STORAGE: 'exh_reader_keys_v2',
        OPTION_STORAGE: 'exh_reader_opts_v1',
        DEFAULT_OPTIONS: {
            bg: '#0a0a0a',
            gap: 4,
            preloadCount: 10,
            toastDuration: 2000,
            direction: 'rtl',
            viewMode: 'spread'
        },
        DEFAULT_KEYS: {
            openMenu: ['m'],
            toggleDirection: ['d'],
            adjustPrev: [']'],
            adjustNext: ['['],
            nextSpread: ['ArrowLeft'],   // "next" (forward)
            prevSpread: ['ArrowRight'],  // "previous" (backward)
            backToGallery: ['g'],
            focusImage: ['c'],           // Shift+key = focus fullscreen
            enterViewer: ['v'],
            quitViewer: ['x'],
            fullscreen: ['f'],
            exitFullscreen: ['q'],
            toggleViewMode: ['s'],
            openJump: ['/', 'Shift+:']
        }
    };

    const initialOptions = loadOptions();

    // ─────────────────────────────────────────────────────────────
    // STATE
    // ─────────────────────────────────────────────────────────────
    const state = {
        pages: [],
        index: 0,
        direction: initialOptions.direction,
        urlToIndex: new Map(),
        loading: false,
        loadingPromise: null,
        loadingKind: null,
        focusActive: false,
        viewerActive: true,
        configOpen: false,
        hoveredImage: null,
        galleryUrl: null,
        keys: loadKeys(),
        options: initialOptions,
        viewMode: initialOptions.viewMode,
        totalPages: null,
        totalPagesLoading: false,
        jumpOpen: false,
    };

    // ─────────────────────────────────────────────────────────────
    // HELPERS: keys
    // ─────────────────────────────────────────────────────────────
    function normalizeCombo(str) {
        if (!str) return '';
        const parts = str.split('+').map(p => p.trim()).filter(Boolean);
        if (!parts.length) return '';

        let key = parts.pop();
        if (key === ' ') key = 'Space';
        if (key.length === 1) key = key.toLowerCase();

        const modMap = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta' };
        const order = ['Ctrl', 'Alt', 'Shift', 'Meta'];
        const mods = parts
            .map(p => modMap[p.toLowerCase()] || p)
            .filter(m => order.includes(m));

        const unique = new Set(mods);
        const ordered = order.filter(m => unique.has(m));

        return [...ordered, key].join('+');
    }

    function normalizeKeyList(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value.map(normalizeCombo).filter(Boolean);
        return [normalizeCombo(value)].filter(Boolean);
    }

    function comboFromEvent(e) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.metaKey) parts.push('Meta');
        if (e.shiftKey) parts.push('Shift');
        let key = e.key;
        if (key === ' ') key = 'Space';
        return normalizeCombo([...parts, key].join('+'));
    }


    function comboMatches(eventCombo, list) {
        const norm = normalizeCombo(eventCombo);
        const arr = Array.isArray(list) ? list : [list];
        return arr.some(k => normalizeCombo(k) === norm);
    }

    function comboHasShift(combo) {
        return normalizeCombo(combo).split('+').includes('Shift');
    }

    function stripShift(combo) {
        const parts = normalizeCombo(combo).split('+').filter(Boolean);
        const key = parts.pop() || '';
        const mods = parts.filter(m => m !== 'Shift');
        return [...mods, key].filter(Boolean).join('+');
    }

    function parsePageNumFromUrl(url) {
        const m = String(url).match(/-(\d+)(?:[?#]|$)/);
        if (!m) return null;
        const n = parseInt(m[1], 10);
        return Number.isFinite(n) ? n : null;
    }

    function extractPageInfo(doc, url) {
        let pageNum = parsePageNumFromUrl(url);
        let pageCount = null;

        const candidates = [];
        ['i1', 'i2', 'i3', 'i4'].forEach(id => {
            const el = doc.querySelector('#' + id);
            if (el) candidates.push(el.textContent || '');
        });
        if (doc.title) candidates.push(doc.title);

        for (const text of candidates) {
            const m = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)/i);
            if (m) {
                const a = parseInt(m[1], 10);
                const b = parseInt(m[2], 10);
                if (Number.isFinite(a)) pageNum = pageNum || a;
                if (Number.isFinite(b)) { pageCount = b; break; }
            }
        }

        return { pageNum, pageCount };
    }

    function pickNavUrl(doc, dir, currentNum) {
        // 1) Prefer rel=prev/next if present
        const relLink = doc.querySelector(`link[rel="${dir}"]`);
        if (relLink && relLink.href) return relLink.href;

        const relAnchor = doc.querySelector(`a[rel="${dir}"]`);
        if (relAnchor && relAnchor.href) return relAnchor.href;

        // 2) Fallback to the nav container
        const container = doc.querySelector(dir === 'prev' ? '#i2' : '#i3');
        if (!container) return null;

        const anchors = Array.from(container.querySelectorAll('a[href]'));
        if (!anchors.length) return null;

        // 3) Choose by page number (avoid << and >>)
        if (Number.isFinite(currentNum)) {
            let bestHref = null;
            let bestNum = dir === 'prev' ? -Infinity : Infinity;

            for (const a of anchors) {
                const n = parsePageNumFromUrl(a.href);
                if (!Number.isFinite(n)) continue;

                if (dir === 'prev') {
                    if (n < currentNum && n > bestNum) {
                        bestNum = n;
                        bestHref = a.href;
                    }
                } else {
                    if (n > currentNum && n < bestNum) {
                        bestNum = n;
                        bestHref = a.href;
                    }
                }
            }
            return bestHref; // null at boundaries
        }

        // 4) Last resort: first link
        return anchors[0].href || null;
    }

    function loadKeys() {
    // 1. Start with the defaults
        let merged = { ...CONFIG.DEFAULT_KEYS };

    // 2. Try to merge in saved data from localStorage
        try {
            const saved = localStorage.getItem(CONFIG.KEY_STORAGE);
            if (saved) {
                const parsed = JSON.parse(saved);
                merged = { ...merged, ...parsed };
            }
        } catch (_) { /* ignore errors, keep defaults */ }

    // 3. Normalize every action into an array (The logic from your guide)
        const normalized = {};
        for (const [k, v] of Object.entries(merged)) {
            normalized[k] = normalizeKeyList(v);
        }

        return normalized;
    }

    function saveKeys(keys) {
        try {
            localStorage.setItem(CONFIG.KEY_STORAGE, JSON.stringify(keys));
        } catch (_) { /* ignore */ }
    }

    function clampInt(value, min, max, fallback) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function loadOptions() {
        let merged = { ...CONFIG.DEFAULT_OPTIONS };
        try {
            const saved = localStorage.getItem(CONFIG.OPTION_STORAGE);
            if (saved) merged = { ...merged, ...JSON.parse(saved) };
        } catch (_) {}

        merged.preloadCount = clampInt(merged.preloadCount, 2, 40, CONFIG.DEFAULT_OPTIONS.preloadCount);
        merged.toastDuration = clampInt(merged.toastDuration, 400, 5000, CONFIG.DEFAULT_OPTIONS.toastDuration);
        merged.gap = clampInt(merged.gap, 0, 24, CONFIG.DEFAULT_OPTIONS.gap);
        merged.direction = merged.direction === 'ltr' ? 'ltr' : 'rtl';
        merged.viewMode = merged.viewMode === 'single' ? 'single' : 'spread';

        if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(merged.bg)) {
            merged.bg = CONFIG.DEFAULT_OPTIONS.bg;
        }

        return merged;
    }

    function saveOptions(opts) {
        try {
            localStorage.setItem(CONFIG.OPTION_STORAGE, JSON.stringify(opts));
        } catch (_) {}
    }

    // ─────────────────────────────────────────────────────────────
    // STYLES
    // ─────────────────────────────────────────────────────────────
    function injectStyles() {
        const css = `
            body.reader-lock { overflow: hidden !important; }

            #reader {
                position: fixed;
                inset: 0;
                background: var(--reader-bg, #0a0a0a);
                z-index: 99990;
                display: flex;
                justify-content: center;
                align-items: center;
            }
            #reader.hidden { display: none; }

            #spread {
                display: flex;
                height: 100vh;
                max-width: 100vw;
                justify-content: center;
                align-items: center;
                gap: var(--reader-gap, 4px);
            }

            #reader.single-mode .page { max-width: 100vw; }
            #reader.single-mode #page-right { display: none; }
            .page {
                max-height: 100vh;
                max-width: calc(50vw - 2px);
                height: auto;
                width: auto;
                object-fit: contain;
                user-select: none;
                -webkit-user-drag: none;
            }
            .page.hidden { display: none; }

            .nav-zone {
                position: absolute;
                top: 0;
                height: 100%;
                width: 50%;
                cursor: pointer;
            }
            .nav-zone.left { left: 0; }
            .nav-zone.right { right: 0; }

            #toast {
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(20, 20, 20, 0.92);
                color: #e0e0e0;
                padding: 10px 18px;
                border-radius: 8px;
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                z-index: 100020;
                pointer-events: none;
                opacity: 0;
                transition: opacity 0.2s ease;
                border: 1px solid rgba(255,255,255,0.08);
            }
            #toast.visible { opacity: 1; }

            #jump-overlay {
                position: fixed;
                bottom: 64px;
                left: 50%;
                transform: translateX(-50%);
                display: none;
                z-index: 100025;
            }
            #jump-overlay.show { display: flex; }
            #jump-box {
                background: rgba(20, 20, 20, 0.92);
                color: #e0e0e0;
                padding: 8px 10px;
                border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.12);
                display: flex;
                align-items: center;
                gap: 8px;
                font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            #jump-meta { color: #cfcfcf; }
            #jump-input {
                width: 84px;
                background: #1b1b1b;
                border: 1px solid rgba(255,255,255,0.12);
                color: #f0f0f0;
                border-radius: 8px;
                padding: 6px 8px;
            }

            /* Menu toggle */
            #menu-toggle {
                position: fixed;
                top: 12px;
                right: 12px;
                width: 34px;
                height: 34px;
                border-radius: 8px;
                background: rgba(30,30,30,0.9);
                border: 1px solid rgba(255,255,255,0.12);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #e5e5e5;
                cursor: pointer;
                z-index: 100010;
                backdrop-filter: blur(6px);
            }
            #menu-toggle:hover { background: rgba(45,45,45,0.95); }

            /* Config overlay */
            #config-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0,0,0,0.55);
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 100030;
            }
            #config-overlay.show { display: flex; }
            #config-card {
                background: #111;
                color: #eee;
                width: min(540px, calc(100% - 32px));
                max-height: calc(100vh - 40px);
                overflow: auto;
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 14px 40px rgba(0,0,0,0.4);
                border: 1px solid rgba(255,255,255,0.08);
                font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }
            #config-card h2 { margin: 0 0 12px; font-size: 16px; }

            #config-options {
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 8px 12px;
                align-items: center;
                margin-bottom: 12px;
            }
            #config-options select,
            #config-options input {
                padding: 6px 8px;
                border-radius: 8px;
                background: #1b1b1b;
                border: 1px solid rgba(255,255,255,0.12);
                color: #f0f0f0;
                min-width: 140px;
            }
            #config-sep {
                height: 1px;
                background: rgba(255,255,255,0.08);
                margin: 8px 0 12px;
            }

            #config-grid {
                display: grid;
                grid-template-columns: 1fr auto;
                gap: 8px 12px;
                align-items: center;
            }
            .key-btn {
                padding: 6px 10px;
                border-radius: 8px;
                background: #1b1b1b;
                border: 1px solid rgba(255,255,255,0.12);
                color: #f0f0f0;
                cursor: pointer;
                min-width: 120px;
                text-align: center;
            }
            .key-btn.listening {
                border-color: #4ea3ff;
                box-shadow: 0 0 0 2px rgba(78,163,255,0.25);
            }
            .config-buttons {
                margin-top: 12px;
                display: flex;
                gap: 8px;
                flex-wrap: wrap;
            }
            .pill {
                padding: 8px 12px;
                border-radius: 10px;
                border: 1px solid rgba(255,255,255,0.12);
                background: #181818;
                color: #f0f0f0;
                cursor: pointer;
            }
            .pill.secondary { background: #131313; color: #cfcfcf; }

            /* Focus overlay */
            #focus-overlay {
                position: fixed;
                inset: 0;
                background: #000;
                display: none;
                align-items: center;
                justify-content: center;
                z-index: 100015;
            }
            #focus-overlay.show { display: flex; }
            #focus-img {
                max-width: 100vw;
                max-height: 100vh;
                object-fit: contain;
                user-select: none;
            }
        `;
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ─────────────────────────────────────────────────────────────
    // PAGE FETCHER
    // ─────────────────────────────────────────────────────────────
    const PageFetcher = {
        cache: new Map(),
        imgCache: new Map(),

        async fetch(url) {
            if (this.cache.has(url)) return this.cache.get(url);
            try {
                const response = await fetch(url, { credentials: 'include' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const imgEl = doc.querySelector('#img');
                if (!imgEl) return null;

                const info = extractPageInfo(doc, url);
                const prevUrl = pickNavUrl(doc, 'prev', info.pageNum);
                const nextUrl = pickNavUrl(doc, 'next', info.pageNum);

                const data = {
                    url,
                    img: imgEl.src,
                    next: nextUrl,
                    prev: prevUrl,
                    title: doc.title,
                    pageNum: info.pageNum,
                    pageCount: info.pageCount
                };

                this.cache.set(url, data);
                return data;
            } catch (err) {
                console.error('[Reader] Fetch failed:', url, err);
                return null;
            }
        },

        preloadImage(src) {
            if (!src) return null;
            const cached = this.imgCache.get(src);
            if (cached) return cached;

            const img = new Image();
            img.decoding = 'async';
            img.loading = 'eager';
            img.src = src;

            const p = (img.decode
                ? img.decode().catch(() => {})
                : new Promise(res => {
                    img.onload = res;
                    img.onerror = res;
                })
            ).then(() => {
                this.imgCache.set(src, true);
            });

            this.imgCache.set(src, p);
            return p;
        }

    };

    // ─────────────────────────────────────────────────────────────
    // PAGE MANAGER
    // ─────────────────────────────────────────────────────────────
    const PageManager = {
        get(index) {
            return state.pages[index] || null;
        },

        async _runLoad(kind, task) {
            while (state.loadingPromise) {
                if (state.loadingKind === kind) return state.loadingPromise;
                await state.loadingPromise;
            }
            state.loadingKind = kind;
            state.loadingPromise = (async () => {
                state.loading = true;
                try { return await task(); }
                finally {
                    state.loading = false;
                    state.loadingPromise = null;
                    state.loadingKind = null;
                }
            })();
            return state.loadingPromise;
        },

        async discoverAhead(count) {
            return this._runLoad('ahead', async () => {
                const last = state.pages[state.pages.length - 1];
                if (!last || !last.next) return 0;

                let url = last.next;
                let added = 0;

                for (let i = 0; i < count && url; i++) {
                    if (state.urlToIndex.has(url)) break;
                    const page = await PageFetcher.fetch(url);
                    if (!page) break;
                    state.urlToIndex.set(url, state.pages.length);
                    state.pages.push(page);
                    if (page.pageCount) state.totalPages = page.pageCount;
                    PageFetcher.preloadImage(page.img);
                    url = page.next;
                    added++;
                }
                return added;
            });
        },

        async discoverBehind(count) {
            return this._runLoad('behind', async () => {
                const first = state.pages[0];
                if (!first || !first.prev) return 0;

                let url = first.prev;
                const newPages = [];

                for (let i = 0; i < count && url; i++) {
                    if (state.urlToIndex.has(url)) break;
                    const page = await PageFetcher.fetch(url);
                    if (!page) break;
                    newPages.push(page);
                    if (page.pageCount) state.totalPages = page.pageCount;
                    PageFetcher.preloadImage(page.img);
                    url = page.prev;
                }

                if (!newPages.length) return 0;

                newPages.forEach(p => state.pages.unshift(p));
                state.index += newPages.length;

                state.urlToIndex.clear();
                state.pages.forEach((p, i) => state.urlToIndex.set(p.url, i));

                return newPages.length;
            });
        },

        async ensureIndex(index) {
            while (index >= state.pages.length) {
                const before = state.pages.length;
                await this.discoverAhead(state.options.preloadCount);
                if (state.pages.length === before) break;
            }
            return index < state.pages.length;
        }

    };

    // ─────────────────────────────────────────────────────────────
    // VIEWER
    // ─────────────────────────────────────────────────────────────
    class Viewer {
        constructor() {
            this.toastTimer = null;
            this.renderVersion = 0;
            this.capturingKey = null;
            this.build();
            this.bind();
            this.init();
        }

        build() {
            // Root
            const root = document.createElement('div');
            root.id = 'reader';
            root.innerHTML = `
                <div id="spread">
                    <img class="page" id="page-left" alt="">
                    <img class="page" id="page-right" alt="">
                </div>
                <div class="nav-zone left"></div>
                <div class="nav-zone right"></div>
                <div id="toast"></div>
                <div id="jump-overlay">
                    <div id="jump-box">
                        <span id="jump-meta"></span>
                        <input id="jump-input" type="text" inputmode="numeric" autocomplete="off" spellcheck="false">
                    </div>
                </div>
                <div id="menu-toggle" title="Menu (config)">${this.gearIcon()}</div>
            `;
            document.body.appendChild(root);

            this.original = document.querySelector('#i1');
            if (this.original) this.original.style.display = 'none';

            // Focus overlay
            const focus = document.createElement('div');
            focus.id = 'focus-overlay';
            focus.innerHTML = `<img id="focus-img" alt="">`;
            document.body.appendChild(focus);

            // Config overlay
            const config = document.createElement('div');
            config.id = 'config-overlay';
            config.innerHTML = `
                <div id="config-card">
                    <h2>Reader Config & Options</h2>
                    <div id="config-options"></div>
                    <div id="config-sep"></div>
                    <div id="config-grid"></div>
                    <div class="config-buttons">
                        <button class="pill" data-action="back">Back to gallery</button>
                        <button class="pill" data-action="quit">Quit viewer</button>
                        <button class="pill" data-action="enter">Enter viewer</button>
                        <button class="pill" data-action="fullscreen">Enter fullscreen</button>
                        <button class="pill" data-action="reset">Reset keys</button>
                        <button class="pill secondary" data-action="close">Close</button>
                    </div>
                </div>
            `;

            document.body.appendChild(config);

            // Cache refs
            this.root = root;
            this.pageLeft = root.querySelector('#page-left');
            this.pageRight = root.querySelector('#page-right');
            this.toast = root.querySelector('#toast');
            this.navLeft = root.querySelector('.nav-zone.left');
            this.navRight = root.querySelector('.nav-zone.right');
            this.menuToggle = root.querySelector('#menu-toggle');
            this.focusOverlay = focus;
            this.focusImg = focus.querySelector('#focus-img');
            this.configOverlay = config;
            this.configGrid = config.querySelector('#config-grid');
            this.configOptions = config.querySelector('#config-options');
            this.jumpOverlay = root.querySelector('#jump-overlay');
            this.jumpInput = root.querySelector('#jump-input');
            this.jumpMeta = root.querySelector('#jump-meta');
            this.jumpInput.addEventListener('keydown', (e) => this.handleJumpInput(e));
            this.jumpInput.addEventListener('input', () => {
                this.jumpInput.value = this.jumpInput.value.replace(/\D+/g, '');
            });
            this.jumpInput.addEventListener('blur', () => this.closeJump());

            [this.pageLeft, this.pageRight].forEach(img => {
                img.decoding = 'async';
                img.loading = 'eager';
            });

            // Build key rows
            this.buildConfigGrid();
            this.buildOptions();
        }

        gearIcon() {
            return `
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 4.754a3.246 3.246 0 1 0 0 6.492 3.246 3.246 0 0 0 0-6.492zM5.754 8a2.246 2.246 0 1 1 4.492 0 2.246 2.246 0 0 1-4.492 0z"/>
                    <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 0 1-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 0 1-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 0 1 .52 1.255l-.16.292c-.892 1.64.902 3.433 2.541 2.54l.292-.159a.873.873 0 0 1 1.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 0 1 1.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 0 1 .52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 0 1-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 0 1-1.255-.52l-.094-.319zm-2.633.283c.246-.835 1.428-.835 1.674 0l.094.319a1.873 1.873 0 0 0 2.693 1.115l.291-.16c.764-.415 1.6.42 1.184 1.185l-.159.292a1.873 1.873 0 0 0 1.116 2.692l.318.094c.835.246.835 1.428 0 1.674l-.319.094a1.873 1.873 0 0 0-1.115 2.693l.16.291c.415.764-.42 1.6-1.185 1.184l-.291-.159a1.873 1.873 0 0 0-2.693 1.116l-.094.318c-.246.835-1.428.835-1.674 0l-.094-.319a1.873 1.873 0 0 0-2.692-1.115l-.292.16c-.764.415-1.6-.42-1.184-1.185l.159-.291A1.873 1.873 0 0 0 1.945 8.93l-.319-.094c-.835-.246-.835-1.428 0-1.674l.319-.094A1.873 1.873 0 0 0 3.06 4.377l-.16-.292c-.415-.764.42-1.6 1.185-1.184l.292.159a1.873 1.873 0 0 0 2.692-1.116l.094-.319z"/>
                </svg>
            `;
        }

        applyOptions() {
            const o = state.options;
            document.documentElement.style.setProperty('--reader-bg', o.bg);
            document.documentElement.style.setProperty('--reader-gap', `${o.gap}px`);
            this.applyViewMode();
        }

        applyViewMode() {
            const mode = state.options.viewMode === 'single' ? 'single' : 'spread';
            state.viewMode = mode;
            this.root.classList.toggle('single-mode', mode === 'single');
        }

        toggleViewMode() {
            state.viewMode = state.viewMode === 'single' ? 'spread' : 'single';
            state.options.viewMode = state.viewMode;
            saveOptions(state.options);
            this.applyViewMode();
            this.render();
            this.showToast(state.viewMode === 'single' ? 'Single page' : 'Spread');
        }

        getStep() {
            return state.viewMode === 'single' ? 1 : 2;
        }

        getPageLabel() {
            const p1 = PageManager.get(state.index);
            const p2 = PageManager.get(state.index + 1);
            const cur = p1 && p1.pageNum ? p1.pageNum : null;
            const next = p2 && p2.pageNum ? p2.pageNum : null;
            const total = state.totalPages || (p1 && p1.pageCount) || (p2 && p2.pageCount) || null;
            return { cur, next, total };
        }

        getPositionToast() {
            const { cur, next } = this.getPageLabel();
            if (state.viewMode === 'single') return cur ? `Page ${cur}` : 'Page';
            if (cur && next) return `Pages ${cur}–${next}`;
            if (cur) return `Page ${cur}`;
            return 'Page';
        }

        async navigateBy(delta, opts = {}) {
            const { toast = false } = opts;
            let targetIndex = state.index + delta;

            if (targetIndex < 0) {
                await PageManager.discoverBehind(state.options.preloadCount);
                targetIndex = state.index + delta;
            }
            if (targetIndex < 0) {
                this.showToast('Beginning of gallery');
                return false;
            }

            const ok = await PageManager.ensureIndex(targetIndex);
            if (!ok) {
                this.showToast('End of gallery');
                return false;
            }

            state.index = targetIndex;
            this.render();
            this.updateHistory();
            PageManager.discoverAhead(state.options.preloadCount);

            if (state.viewMode === 'spread') {
                const rv = this.renderVersion;
                PageManager.ensureIndex(state.index + 1).then(ok2 => {
                    if (!ok2) return;
                    if (this.renderVersion !== rv) return;
                    if (PageManager.get(state.index + 1)) this.render();
                });
            }

            if (toast) this.showToast(this.getPositionToast());
            return true;
        }

        buildOptions() {
            const o = state.options;
            this.configOptions.innerHTML = '';

            const addRow = (labelText, controlEl) => {
                const label = document.createElement('div');
                label.textContent = labelText;
                this.configOptions.appendChild(label);
                this.configOptions.appendChild(controlEl);
            };

            // Reading direction
            const dirSelect = document.createElement('select');
            dirSelect.innerHTML = `
                <option value="rtl">Right-to-Left (Manga)</option>
                <option value="ltr">Left-to-Right</option>
            `;
            dirSelect.value = o.direction;
            dirSelect.onchange = () => {
                o.direction = dirSelect.value === 'ltr' ? 'ltr' : 'rtl';
                saveOptions(o);
                state.direction = o.direction;
                this.render();
            };
            addRow('Reading direction', dirSelect);

            const modeSelect = document.createElement('select');
            modeSelect.innerHTML = `
                <option value="spread">Spread (two pages)</option>
                <option value="single">Single page</option>
            `;
            modeSelect.value = o.viewMode;
            modeSelect.onchange = () => {
                o.viewMode = modeSelect.value === 'single' ? 'single' : 'spread';
                saveOptions(o);
                state.viewMode = o.viewMode;
                this.applyViewMode();
                this.render();
            };
            addRow('View mode', modeSelect);

            // Background
            const bgSelect = document.createElement('select');
            bgSelect.innerHTML = `
                <option value="#000000">Black</option>
                <option value="#0a0a0a">Dark</option>
                <option value="#111111">Dim</option>
            `;
            bgSelect.value = o.bg;
            bgSelect.onchange = () => {
                o.bg = bgSelect.value;
                saveOptions(o);
                this.applyOptions();
            };
            addRow('Background', bgSelect);

            // Page gap
            const gapSelect = document.createElement('select');
            gapSelect.innerHTML = `
                <option value="0">No gap</option>
                <option value="4">Small (4px)</option>
                <option value="8">Medium (8px)</option>
                <option value="12">Large (12px)</option>
            `;
            gapSelect.value = String(o.gap);
            gapSelect.onchange = () => {
                o.gap = parseInt(gapSelect.value, 10) || 0;
                saveOptions(o);
                this.applyOptions();
            };
            addRow('Page gap', gapSelect);

            // Preload count
            const preloadInput = document.createElement('input');
            preloadInput.type = 'number';
            preloadInput.min = '2';
            preloadInput.max = '40';
            preloadInput.value = String(o.preloadCount);
            preloadInput.onchange = () => {
                let n = parseInt(preloadInput.value, 10);
                if (!Number.isFinite(n)) n = CONFIG.DEFAULT_OPTIONS.preloadCount;
                n = Math.max(2, Math.min(40, n));
                preloadInput.value = String(n);
                o.preloadCount = n;
                saveOptions(o);
            };
            addRow('Preload pages', preloadInput);

            // Toast duration
            const toastSelect = document.createElement('select');
            toastSelect.innerHTML = `
                <option value="800">Short</option>
                <option value="1400">Normal</option>
                <option value="2000">Long</option>
            `;
            toastSelect.value = String(o.toastDuration);
            toastSelect.onchange = () => {
                o.toastDuration = parseInt(toastSelect.value, 10) || CONFIG.DEFAULT_OPTIONS.toastDuration;
                saveOptions(o);
            };
            addRow('Toast duration', toastSelect);
        }

        trackHover(e) {
            const x = e.clientX;
            const y = e.clientY;

            const over = (img) => {
                if (!img || img.classList.contains('hidden')) return false;
                const r = img.getBoundingClientRect();
                return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
            };

            if (over(this.pageLeft)) state.hoveredImage = this.pageLeft;
            else if (over(this.pageRight)) state.hoveredImage = this.pageRight;
            else state.hoveredImage = null;
        }

        buildConfigGrid() {
            const actions = [
                { id: 'openMenu', label: 'Toggle config menu' },
                { id: 'toggleDirection', label: 'Toggle reading direction' },
                { id: 'nextSpread', label: 'Navigate Left (direction-aware)' },
                { id: 'prevSpread', label: 'Navigate Right (direction-aware)' },
                { id: 'adjustPrev', label: 'Adjust page (Left)' },
                { id: 'adjustNext', label: 'Adjust page (Right)' },
                { id: 'focusImage', label: 'Focus image (Shift+key to fullscreen)' },
                { id: 'fullscreen', label: 'Enter fullscreen' },
                { id: 'exitFullscreen', label: 'Exit fullscreen' },
                { id: 'backToGallery', label: 'Back to gallery' },
                { id: 'enterViewer', label: 'Enter viewer mode' },
                { id: 'quitViewer', label: 'Quit viewer mode' },
                { id: 'toggleViewMode', label: 'Toggle view mode (spread/single)' },
                { id: 'openJump', label: 'Jump to page' }
            ];

            this.configGrid.innerHTML = '';

            actions.forEach(({ id, label }) => {
                // 1. Create the Label
                const rowLabel = document.createElement('div');
                rowLabel.textContent = label;

                // 2. Create the Container for buttons
                const cell = document.createElement('div');
                cell.className = 'key-list';

                // 3. Generate a button for every existing key combo (to remove)
                // We safely default to [] in case state.keys[id] is undefined
                const currentCombos = state.keys[id] || [];

                currentCombos.forEach(combo => {
                    const kbtn = document.createElement('button');
                    kbtn.className = 'key-btn';
                    kbtn.textContent = combo;
                    kbtn.title = 'Click to remove';
                    kbtn.onclick = () => this.removeKeyCombo(id, combo);
                    cell.appendChild(kbtn);
                });

                // 4. Create the "+" Add Button
                const addBtn = document.createElement('button');
                addBtn.className = 'key-btn';
                addBtn.textContent = '+';
                addBtn.title = 'Add key';
                addBtn.onclick = () => this.startKeyCapture(id, addBtn);
                cell.appendChild(addBtn);

                // 5. Append everything to the grid
                this.configGrid.appendChild(rowLabel);
                this.configGrid.appendChild(cell);
            });
        }

        bind() {
            // Nav clicks
            this.navLeft.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleNav('left');
            });
            this.navRight.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.handleNav('right');
            });

            // Hover tracking for focus (works even with nav overlays)
            this.root.addEventListener('mousemove', (e) => this.trackHover(e));
            this.root.addEventListener('mouseleave', () => { state.hoveredImage = null; });

            // Menu toggle
            this.menuToggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleConfig(true);
            });

            // Focus overlay exit (click anywhere on the overlay to exit)
            this.focusOverlay.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.exitFocus();
            });

            // Config overlay buttons
            this.configOverlay.querySelectorAll('.pill').forEach(btn => {
                btn.addEventListener('click', () => {
                    const act = btn.dataset.action;
                    if (act === 'back') this.backToGallery();
                    else if (act === 'quit') this.quitViewer();
                    else if (act === 'enter') this.enterViewer();
                    else if (act === 'fullscreen') this.enterFullscreen();
                    else if (act === 'reset') this.resetKeys();
                    else if (act === 'close') this.toggleConfig(false);
                });
            });

            // Keydown
            document.addEventListener('keydown', (e) => this.handleKeydown(e), true);

            // Fullscreen change
            document.addEventListener('fullscreenchange', () => {
                // no-op; used by exitFullscreenOrViewer
            });
        }

        // ── KEY CAPTURE ──────────────────────────────────────────
        startKeyCapture(actionId, btnEl) {
            if (this.capturingKey) return;

            this.capturingKey = { actionId, btnEl };
            btnEl.classList.add('listening');
            this.showToast('Press a key for ' + actionId);

            const handler = (e) => {
                e.preventDefault();
                e.stopImmediatePropagation();

                // Allow Escape to cancel capture
                if (e.key === 'Escape') {
                    this.capturingKey = null;
                    btnEl.classList.remove('listening');
                    window.removeEventListener('keydown', handler, true);
                    return;
                }

                // Ignore pure modifiers
                if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;

                const combo = normalizeCombo(comboFromEvent(e));

                const list = state.keys[actionId];
                if (!list.some(k => normalizeCombo(k) === combo)) {
                    list.push(combo);
                    saveKeys(state.keys);
                }

                // 4. Cleanup listeners and state
                this.capturingKey = null;
                btnEl.classList.remove('listening');
                window.removeEventListener('keydown', handler, true);

                // 5. Rebuild the grid to display the newly added key button
                this.buildConfigGrid();
            };

            window.addEventListener('keydown', handler, true);
        }

        removeKeyCombo(actionId, combo) {
            state.keys[actionId] = state.keys[actionId].filter(k => normalizeCombo(k) !== normalizeCombo(combo));
            saveKeys(state.keys);
            this.buildConfigGrid();
        }

        resetKeys() {
            state.keys = { ...CONFIG.DEFAULT_KEYS };
            saveKeys(state.keys);
            this.buildConfigGrid();
            this.showToast('Keys reset');
        }

        openJump() {
            if (state.jumpOpen) return;
            state.jumpOpen = true;
            this.updateJumpMeta();
            this.jumpOverlay.classList.add('show');
            this.jumpInput.value = '';
            this.jumpInput.focus();
            this.jumpInput.select();
            this.ensureTotalPages();
        }

        closeJump() {
            if (!state.jumpOpen) return;
            state.jumpOpen = false;
            this.jumpOverlay.classList.remove('show');
        }

        toggleJump() {
            if (state.jumpOpen) this.closeJump();
            else this.openJump();
        }

        updateJumpMeta() {
            if (!this.jumpMeta) return;
            const { cur, total } = this.getPageLabel();
            const c = cur || '?';
            const t = total || '?';
            this.jumpMeta.textContent = `Page ${c} / ${t}`;
        }

        handleJumpInput(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopImmediatePropagation();
                const n = parseInt(this.jumpInput.value, 10);
                if (Number.isFinite(n)) this.jumpToPage(n);
                else this.showToast('Invalid page');
                this.closeJump();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                this.closeJump();
                return;
            }
            if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
                e.preventDefault();
            }
        }

        async ensureTotalPages() {
            if (state.totalPages || state.totalPagesLoading || !state.galleryUrl) return;
            state.totalPagesLoading = true;
            try {
                const res = await fetch(state.galleryUrl, { credentials: 'include' });
                const html = await res.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const row = Array.from(doc.querySelectorAll('#gdd tr'))
                    .find(tr => /Length/i.test(tr.textContent || ''));
                if (row) {
                    const m = row.textContent.match(/(\d+)/);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        if (Number.isFinite(n)) state.totalPages = n;
                    }
                }
            } catch (_) {
                // Silently fail - totalPages will remain null
            } finally {
                state.totalPagesLoading = false;
            }
            this.updateJumpMeta();
        }

        async jumpToPage(target) {
            if (!Number.isFinite(target) || target < 1) {
                this.showToast('Invalid page');
                return;
            }
            if (state.totalPages && target > state.totalPages) {
                this.showToast('Out of range');
                return;
            }

            const current = PageManager.get(state.index);
            const curNum = current && current.pageNum;
            if (!curNum) {
                this.showToast('Page number unknown');
                return;
            }

            const delta = target - curNum;
            if (delta === 0) {
                this.showToast('Already there');
                return;
            }

            this.showToast(`Jumping to ${target}...`);

            const dir = delta > 0 ? 1 : -1;
            let remaining = Math.abs(delta);

            while (remaining > 0) {
                const batch = Math.min(remaining, state.options.preloadCount);
                const before = state.pages.length;
                if (dir > 0) await PageManager.discoverAhead(batch);
                else await PageManager.discoverBehind(batch);
                if (state.pages.length === before) break;
                remaining -= batch;
            }

            const idx = state.pages.findIndex(p => p.pageNum === target);
            if (idx === -1) {
                this.showToast('Page not found');
                return;
            }

            state.index = idx;
            this.render();
            this.updateHistory();
            PageManager.discoverAhead(state.options.preloadCount);
        }

        // ── INIT ────────────────────────────────────────────────
        async init() {
            // Remember gallery URL (plan A)
            state.galleryUrl = this.findGalleryUrl();

            // Bootstrap from current DOM
            const currentUrl = window.location.href;
            const imgEl = document.querySelector('#img');

            if (!imgEl) {
                console.error('[Reader] Could not find image element');
                return;
            }

            const info = extractPageInfo(document, currentUrl);
            const prevUrl = pickNavUrl(document, 'prev', info.pageNum);
            const nextUrl = pickNavUrl(document, 'next', info.pageNum);

            const firstPage = {
                url: currentUrl,
                img: imgEl.src,
                next: nextUrl,
                prev: prevUrl,
                title: document.title,
                pageNum: info.pageNum,
                pageCount: info.pageCount
            };
            if (info.pageCount) state.totalPages = info.pageCount;

            PageFetcher.cache.set(currentUrl, firstPage);
            state.pages.push(firstPage);
            state.urlToIndex.set(currentUrl, 0);

            // Discover ahead
            await PageManager.discoverAhead(state.options.preloadCount);

            // Initial render
            this.applyOptions();
            this.render();
            this.showToast('← → Navigate | D toggle | [ ] adjust | M menu');
        }

        // ── RENDER ──────────────────────────────────────────────
        render() {
            this.renderVersion++;
            const page1 = PageManager.get(state.index);
            const page2 = PageManager.get(state.index + 1);

            if (state.viewMode === 'single') {
                this.setImage(this.pageLeft, page1);
                this.setImage(this.pageRight, null);
            } else {
                const [leftPage, rightPage] = state.direction === 'rtl'
                    ? [page2, page1]
                    : [page1, page2];

                if (leftPage && rightPage) {
                    this.setSpread(leftPage, rightPage);
                } else {
                    this.setImage(this.pageLeft, leftPage);
                    this.setImage(this.pageRight, rightPage);
                }

                if (page1 && !page2 && page1.next) {
                    const rv = this.renderVersion;
                    PageManager.ensureIndex(state.index + 1).then(ok => {
                        if (!ok) return;
                        if (this.renderVersion !== rv) return;
                        if (PageManager.get(state.index + 1)) this.render();
                    });
                }
            }

            if (page1) document.title = page1.title;
            this.updateJumpMeta();
            if (state.focusActive) this.updateFocusImage();
        }

        setImage(imgEl, pageData) {
            if (pageData) {
                const token = `${this.renderVersion}:${pageData.url}`;
                imgEl.dataset.token = token;
                imgEl.classList.remove('hidden');

                if (imgEl.dataset.src === pageData.img && imgEl.src) return;

                const apply = () => {
                    if (imgEl.dataset.token !== token) return;
                    imgEl.src = pageData.img;
                    imgEl.dataset.src = pageData.img;
                };

                const cached = PageFetcher.imgCache.get(pageData.img);
                if (cached === true) {
                    apply();
                    return;
                }

                const p = PageFetcher.preloadImage(pageData.img);
                if (p && typeof p.then === 'function') p.then(apply);
                else apply();
            } else {
                imgEl.src = '';
                imgEl.classList.add('hidden');
                imgEl.dataset.token = '';
                imgEl.dataset.src = '';
            }
        }

        setSpread(leftPage, rightPage) {
            const leftToken = `${this.renderVersion}:L:${leftPage.url}`;
            const rightToken = `${this.renderVersion}:R:${rightPage.url}`;

            this.pageLeft.dataset.token = leftToken;
            this.pageRight.dataset.token = rightToken;
            this.pageLeft.classList.remove('hidden');
            this.pageRight.classList.remove('hidden');

            const wait = (p) => (p && typeof p.then === 'function') ? p : Promise.resolve();

            const p1 = PageFetcher.preloadImage(leftPage.img);
            const p2 = PageFetcher.preloadImage(rightPage.img);

            Promise.all([wait(p1), wait(p2)]).then(() => {
                if (this.pageLeft.dataset.token !== leftToken) return;
                if (this.pageRight.dataset.token !== rightToken) return;

                this.pageLeft.src = leftPage.img;
                this.pageLeft.dataset.src = leftPage.img;
                this.pageRight.src = rightPage.img;
                this.pageRight.dataset.src = rightPage.img;
            });
        }

        updateHistory() {
            const page = PageManager.get(state.index);
            if (page) history.replaceState(null, page.title, page.url);
        }

        // ── NAVIGATION ──────────────────────────────────────────
        handleNav(side) {
            const isForward = state.direction === 'rtl'
                ? side === 'left'
                : side === 'right';
            if (isForward) this.goForward();
            else this.goBackward();
        }

//        async goForward() {
//            const targetIndex = state.index + 2;
//            const exists = await PageManager.ensureIndex(targetIndex);
//            if (!exists) return this.showToast('End of gallery');
//            state.index = targetIndex;
//            this.render();
//            this.updateHistory();
//            PageManager.discoverAhead(state.options.preloadCount);
//        }

        async goForward() {
            await this.navigateBy(this.getStep());
        }

//        goBackward() {
//            if (state.index === 0) return this.showToast('Beginning of gallery');
//            state.index = Math.max(0, state.index - 2);
//            this.render();
//            this.updateHistory();
//        }

        async goBackward() {
            await this.navigateBy(-this.getStep());
        }

//        async adjustPage(delta) {
//            // 1. Change 'const' to 'let' because targetIndex might change
//            let targetIndex = state.index + delta;

            // 2. Add this NEW block to handle loading previous pages
//            if (targetIndex < 0) {
//                await PageManager.discoverBehind(state.options.preloadCount);
//                // Recalculate because state.index might have shifted
//                targetIndex = state.index + delta;
//            }

            // 3. This check remains, but now it only fires if discovery failed
//            if (targetIndex < 0) return this.showToast('Cannot adjust further');

            // --- The rest of your code stays exactly the same ---
//            const ok = await PageManager.ensureIndex(targetIndex + 1);
//            if (!ok && delta > 0) return this.showToast('No more pages');

//            state.index = targetIndex;
//            this.render();
//            this.updateHistory();

//            const p1 = state.index + 1;
//            const p2 = state.index + 2;
//            this.showToast(`Pages ${p1}–${p2}`);
//        }
        async adjustPage(delta) {
            await this.navigateBy(delta, { toast: true });
        }

        toggleDirection() {
            state.direction = state.direction === 'rtl' ? 'ltr' : 'rtl';
            state.options.direction = state.direction;
            saveOptions(state.options);
            this.buildOptions();
            this.render();
            const label = state.direction === 'rtl'
                ? '← Right-to-Left (Manga)'
                : '→ Left-to-Right';
            this.showToast(label);
        }

        // ── FULLSCREEN ──────────────────────────────────────────
        enterFullscreen() {
            const el = document.documentElement;
            if (!document.fullscreenElement && el.requestFullscreen) {
                el.requestFullscreen().catch(() => {});
            }
        }
        exitFullscreen() {
            if (document.fullscreenElement && document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            }
        }
        exitFullscreenOrViewer() {
            if (document.fullscreenElement) {
                this.exitFullscreen();
            } else {
                this.quitViewer();
            }
        }

        // ── FOCUS IMAGE ─────────────────────────────────────────
        focusImage(wantFullscreen) {
            const target = state.hoveredImage && !state.hoveredImage.classList.contains('hidden')
                ? state.hoveredImage
                : (this.pageRight && !this.pageRight.classList.contains('hidden')
                    ? this.pageRight
                    : this.pageLeft);

            if (!target || !target.src) {
                this.showToast('No image to focus');
                return;
            }

            const idx = this.getIndexForImage(target);
            if (idx !== null) {
                state.index = idx;
                this.render();
                this.updateHistory();
            }

            // Set state to active so other inputs know we are focused
            state.focusActive = true;

            this.focusImg.src = target.src;
            this.focusOverlay.classList.add('show');

            if (wantFullscreen && this.focusOverlay.requestFullscreen) {
                this.focusOverlay.requestFullscreen().catch(() => {});
            }
        }

        exitFocus() {
            // Clear the state
            state.focusActive = false;

            this.focusOverlay.classList.remove('show');
            if (document.fullscreenElement === this.focusOverlay) {
                document.exitFullscreen().catch(() => {});
            }
        }

        getIndexForImage(imgEl) {
            const src = imgEl && imgEl.dataset && imgEl.dataset.src;
            if (!src) return null;
            const idx = state.pages.findIndex(p => p.img === src);
            return idx >= 0 ? idx : null;
        }

        updateFocusImage() {
            const page = PageManager.get(state.index);
            if (page && page.img) this.focusImg.src = page.img;
        }

        async focusNavigate(delta) {
            const ok = await this.navigateBy(delta);
            if (ok) this.updateFocusImage();
        }

        // ── VIEWER MODE ─────────────────────────────────────────

        enterViewer() {
            state.viewerActive = true;
            this.root.classList.remove('hidden');
            document.body.classList.add('reader-lock');
            this.showToast('Viewer on');

            if (this.original) this.original.style.display = 'none';
        }
        quitViewer() {
            state.viewerActive = false;
            this.root.classList.add('hidden');
            document.body.classList.remove('reader-lock');
            this.configOverlay.classList.remove('show');
            this.exitFocus();
            if (document.fullscreenElement) this.exitFullscreen();
            this.showToast('Viewer off');

            if (this.original) this.original.style.display = '';

            PageFetcher.cache.clear();
            PageFetcher.imgCache.clear();
        }

        // ── BACK TO GALLERY ─────────────────────────────────────
        backToGallery() {
            if (state.galleryUrl) {
                window.location.href = state.galleryUrl;
            } else {
                history.back();
            }
        }

        findGalleryUrl() {
            const ref = document.referrer;
            const pat = /\/g\/\d+\/[0-9a-f]+/i;
            if (pat.test(ref)) return ref;
            const anchor = Array.from(document.querySelectorAll('a'))
                .find(a => pat.test(a.href));
            return anchor ? anchor.href : null;
        }

        // ── CONFIG UI ───────────────────────────────────────────
        toggleConfig(forceState) {
            const next = typeof forceState === 'boolean'
                ? forceState
                : !state.configOpen;
            state.configOpen = next;
            this.configOverlay.classList.toggle('show', next);
        }

        // ── TOAST ───────────────────────────────────────────────
        showToast(message) {
            this.toast.textContent = message;
            this.toast.classList.add('visible');
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => {
                this.toast.classList.remove('visible');
            }, state.options.toastDuration);
        }

        // ── KEY HANDLER ─────────────────────────────────────────
        handleKeydown(e) {
            const tag = e.target.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            if (this.capturingKey) return;

            const combo = comboFromEvent(e);
            const k = state.keys;
            const consume = () => {
                e.preventDefault();
                e.stopImmediatePropagation();
            };

            const focusCombos = k.focusImage || [];
            const baseFocusCombos = focusCombos.filter(c => !comboHasShift(c));
            const focusMatch = comboMatches(combo, focusCombos);
            const shiftMatch = e.shiftKey && baseFocusCombos.length && comboMatches(stripShift(combo), baseFocusCombos);

            const focusOpen = state.focusActive || this.focusOverlay.classList.contains('show');
            if (focusOpen) {
                if (comboMatches(combo, k.exitFullscreen) || e.key === 'Escape' || focusMatch || shiftMatch) {
                    consume();
                    this.exitFocus();
                    return;
                }
                if (comboMatches(combo, k.nextSpread)) {
                    consume();
                    this.focusNavigate(1);
                    return;
                }
                if (comboMatches(combo, k.prevSpread)) {
                    consume();
                    this.focusNavigate(-1);
                    return;
                }
                if (comboMatches(combo, k.adjustPrev)) {
                    consume();
                    const delta = (state.direction === 'rtl') ? 1 : -1;
                    this.focusNavigate(delta);
                    return;
                }
                if (comboMatches(combo, k.adjustNext)) {
                    consume();
                    const delta = (state.direction === 'rtl') ? -1 : 1;
                    this.focusNavigate(delta);
                    return;
                }
                return;
            }

            if (comboMatches(combo, k.openMenu)) {
                consume();
                this.toggleConfig();
                return;
            }

            if (state.configOpen) {
                if (comboMatches(combo, k.openMenu) || comboMatches(combo, k.exitFullscreen) || e.key === 'Escape') {
                    consume();
                    this.toggleConfig(false);
                }
                return;
            }

            if (!state.viewerActive) {
                if (comboMatches(combo, k.enterViewer)) {
                    consume();
                    this.enterViewer();
                }
                return;
            }

            if (comboMatches(combo, k.openJump)) {
                consume();
                this.toggleJump();
                return;
            }

            if (comboMatches(combo, k.exitFullscreen) || e.key === 'Escape') {
                consume();
                this.exitFullscreenOrViewer();
                return;
            }

            if (comboMatches(combo, k.fullscreen)) {
                consume();
                if (document.fullscreenElement) this.exitFullscreen();
                else this.enterFullscreen();
                return;
            }

            if (comboMatches(combo, k.backToGallery)) {
                consume();
                this.backToGallery();
                return;
            }

            if (focusMatch || shiftMatch) {
                consume();
                this.focusImage(shiftMatch && !focusMatch);
                return;
            }

            if (comboMatches(combo, k.quitViewer)) {
                consume();
                this.quitViewer();
                return;
            }

            if (comboMatches(combo, k.toggleDirection)) {
                consume();
                this.toggleDirection();
                return;
            }

            if (comboMatches(combo, k.toggleViewMode)) {
                consume();
                this.toggleViewMode();
                return;
            }

            if (comboMatches(combo, k.nextSpread)) {
                consume();
                this.handleNav('left');
                return;
            }
            if (comboMatches(combo, k.prevSpread)) {
                consume();
                this.handleNav('right');
                return;
            }

            if (comboMatches(combo, k.adjustPrev)) {
                consume();
                const delta = (state.direction === 'rtl') ? 1 : -1;
                this.adjustPage(delta);
                return;
            }
            if (comboMatches(combo, k.adjustNext)) {
                consume();
                const delta = (state.direction === 'rtl') ? -1 : 1;
                this.adjustPage(delta);
                return;
            }
        }
    }

    // ─────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────
    injectStyles();
    const viewer = new Viewer();
})();
