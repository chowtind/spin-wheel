/*!
 * spin-wheel.js v1.0.0 — zero-dependency canvas wheel spinner
 * https://github.com/chowtind/spin-wheel
 * MIT © chowtind
 *
 * Design notes (the parts that make this different from a naive spinner):
 *
 * 1. Result-first fairness. The winner is drawn with crypto.getRandomValues +
 *    rejection sampling BEFORE the animation starts; the spin angle is then
 *    solved backwards to land on it. No modulo bias, and a janky frame never
 *    changes the outcome — the animation is only the reveal ceremony.
 *
 * 2. Composite-only rotation. The disc is painted once on a canvas (repainted
 *    only when entries/size change). Rotation is a single Web Animations API
 *    transform on the rotor, so every frame of the spin is composited off the
 *    main thread. Idle state keeps zero rAF loops, zero timers, zero observers.
 *
 * 3. Layout-free ticks. To fire the click sound at slice boundaries, the
 *    current angle is evaluated analytically from anim.currentTime by inverting
 *    the cubic-bezier easing (Newton's method) — never reads styles or layout.
 *
 * 4. Accessible-ish by default: result announced via aria-live, labels
 *    overridable (34-language production sites ship this engine), honors
 *    prefers-reduced-motion (short spin, no confetti, no tick sound).
 */

const VERSION = '1.0.0';

const MAX_ENTRIES = 150;

/* Candy palette: light slices + dark ink labels (white halo for contrast) */
const DEFAULT_PALETTE = ['#ffb3ab', '#ffd8a8', '#ffec99', '#c3f0c8', '#99e9de', '#a5d8ff', '#d0bfff', '#fcc2d7'];
const INK = '#2c3242';
const PAPER = '#ffffff';
const EASE = [0.16, 0.78, 0.08, 1];   /* fast start, long tail — "settles" */
const SPIN_MS = [4100, 5300];          /* randomized duration range */
const TURNS = [5, 7];                  /* randomized full-turn range */

/* ── helpers ── */
const norm360 = (deg) => ((deg % 360) + 360) % 360;

/* crypto rejection sampling: uniform int in [0, n).
   (2^32 is not divisible by n, so plain modulo would be biased) */
function randIndex(n) {
    const buf = new Uint32Array(1);
    const limit = Math.floor(4294967296 / n) * n;
    let v = 0;
    do {
        crypto.getRandomValues(buf);
        v = buf[0];
    } while (v >= limit);
    return v % n;
}
function randRange(lo, hi) { return lo + randIndex(hi - lo + 1); }

/* Invert a cubic-bezier (x(t) -> t via Newton, then y) to map animation
   progress to eased progress. Used for layout-free tick timing. */
function bezierSolver(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return function (p) {
        if (p <= 0) return 0;
        if (p >= 1) return 1;
        let t = p;
        for (let i = 0; i < 8; i++) {
            const x = sampleX(t) - p;
            if (Math.abs(x) < 1e-5) break;
            const d = sampleDX(t);
            if (Math.abs(d) < 1e-6) break;
            t -= x / d;
        }
        return sampleY(t);
    };
}

/* URL-safe base64 (share links carry the wheel inside the URL hash) */
const b64enc = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

/* localStorage wrapper that never throws (private mode / storage disabled) */
const store = {
    get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* noop */ } },
};

/* ── WebAudio: short ticks + winner chime (context created on first gesture) ── */
function makeAudio() {
    let ac = null;
    const ensure = () => {
        if (!ac) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            ac = new Ctx();
        }
        if (ac.state === 'suspended') ac.resume();
        return ac;
    };
    const tone = (freq, at, dur, vol, type) => {
        const ctx = ensure();
        if (!ctx) return;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || 'triangle';
        o.frequency.value = freq;
        g.gain.setValueAtTime(vol, at);
        g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
        o.connect(g).connect(ctx.destination);
        o.start(at);
        o.stop(at + dur + 0.02);
    };
    return {
        tick(alt) {
            const ctx = ensure();
            if (!ctx) return;
            tone(alt ? 1560 : 2130, ctx.currentTime, 0.045, 0.055);
        },
        win() {
            const ctx = ensure();
            if (!ctx) return;
            const t = ctx.currentTime + 0.02;
            [523.25, 659.25, 783.99].forEach((f, i) => tone(f, t + i * 0.085, 0.5, 0.075, 'sine'));
        },
    };
}

/* ── one-shot confetti on its own canvas; rAF lives ~1.7s then is removed ── */
function confettiBurst(host, palette) {
    const box = host.getBoundingClientRect();
    if (box.width < 40) return;
    const cv = document.createElement('canvas');
    cv.className = 'sw-confetti';
    cv.width = box.width;
    cv.height = box.height;
    cv.setAttribute('aria-hidden', 'true');
    host.appendChild(cv);
    const ctx = cv.getContext('2d');
    const cx = cv.width / 2;
    const pieces = [];
    for (let i = 0; i < 84; i++) {
        const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
        const sp = 3 + Math.random() * 5.4;
        pieces.push({
            x: cx, y: cv.height * 0.34,
            vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
            w: 4 + Math.random() * 5, h: 6 + Math.random() * 6,
            rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3,
            c: palette[i % palette.length],
        });
    }
    let raf = 0;
    const step = () => {
        ctx.clearRect(0, 0, cv.width, cv.height);
        let alive = 0;
        for (const p of pieces) {
            p.vy += 0.14;
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.vr;
            if (p.y < cv.height + 24) {
                alive++;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.fillStyle = p.c;
                ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
                ctx.restore();
            }
        }
        if (alive > 0) {
            raf = requestAnimationFrame(step);
        } else {
            cancelAnimationFrame(raf);
            cv.remove();
        }
    };
    raf = requestAnimationFrame(step);
}

/* pointer SVG (inline — no external asset) */
const POINTER_SVG = '<svg viewBox="0 0 30 46" width="100%" height="100%" focusable="false" aria-hidden="true">'
    + '<path d="M15 45 L2.6 7.8 A4.6 4.6 0 0 1 7 .6 h16 a4.6 4.6 0 0 1 4.4 7.2 Z" fill="#e7483a" stroke="#ffffff" stroke-width="2.6" stroke-linejoin="round"/></svg>';

export default class SpinWheel {
    /**
     * @param {Element|string} mount    container element or selector
     * @param {object} [options]
     * @param {string[]} [options.entries]       initial entries
     * @param {'full'|'wheel'} [options.layout]  'full' = wheel + entries card + history,
     *                                           'wheel' = wheel only (drive via API)
     * @param {boolean} [options.eliminate]      remove winner after each spin
     * @param {boolean} [options.sound=true]     tick + winner sounds
     * @param {boolean} [options.confetti=true]  confetti on win
     * @param {string[]} [options.palette]       slice colors (cycled)
     * @param {number[]} [options.spinDuration]  [minMs, maxMs] randomized
     * @param {number[]} [options.turns]         [min, max] full turns randomized
     * @param {number} [options.maxEntries=150]
     * @param {string|null} [options.persist]    localStorage key; null disables
     * @param {boolean} [options.shareUrl=true]  read/write wheel via URL hash (#w=)
     * @param {function} [options.onSpin]        (index, name) — fired at spin start
     * @param {function} [options.onSpinEnd]     ({index, name, removed}) — after settle
     * @param {object} [options.ui]              label overrides, e.g. { spin: 'GO' }
     */
    constructor(mount, options) {
        const opts = options || {};
        this.mount = typeof mount === 'string' ? document.querySelector(mount) : mount;
        if (!this.mount) throw new Error('SpinWheel: mount element not found');

        this.layout = opts.layout === 'wheel' ? 'wheel' : 'full';
        this.maxEntries = Math.max(2, Math.min(500, opts.maxEntries || MAX_ENTRIES));
        this.palette = Array.isArray(opts.palette) && opts.palette.length ? opts.palette.slice() : DEFAULT_PALETTE;
        this.spinDuration = Array.isArray(opts.spinDuration) && opts.spinDuration.length === 2 ? opts.spinDuration.slice() : SPIN_MS.slice();
        this.turns = Array.isArray(opts.turns) && opts.turns.length === 2 ? opts.turns.slice() : TURNS.slice();
        this.ui = Object.assign({
            spin: 'SPIN',
            entries: 'Entries',
            entries_hint: 'One entry per line',
            shuffle: 'Shuffle',
            sort: 'Sort A–Z',
            reset: 'Reset',
            results: 'Results',
            clear: 'Clear',
            winner: 'Winner',
            removed: 'removed from the wheel',
            need_two: 'Add at least two entries to spin.',
            remove_after: 'Remove winner',
            sound: 'Sound',
            share: 'Share this wheel',
            fullscreen: 'Fullscreen',
            copied: 'Link copied — the wheel travels inside it.',
            hint: 'Press Space to spin. The result is locked in before the wheel stops.',
        }, opts.ui || {});
        this.onSpin = typeof opts.onSpin === 'function' ? opts.onSpin : null;
        this.onSpinEnd = typeof opts.onSpinEnd === 'function' ? opts.onSpinEnd : null;
        this._eliminate = opts.eliminate === true;
        this.persistKey = opts.persist === undefined ? 'spinwheel.' + (this.mount.id || 'wheel') : opts.persist;
        this.shareUrl = opts.shareUrl !== false;
        this.soundEnabled = opts.sound !== false;
        this.confettiEnabled = opts.confetti !== false;

        this.easeAt = bezierSolver(EASE[0], EASE[1], EASE[2], EASE[3]);
        this.audio = makeAudio();
        this.reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this._docListeners = [];
        this._raf = 0;
        this._rsTimer = 0;

        this._buildDom();

        this.entries = [];
        this.base = [];
        this.rotation = 0;
        this.busy = false;
        this.logNo = 0;

        this._startup(opts.entries || []);
    }

    /* ── DOM ─────────────────────────────────────────────── */
    _buildDom() {
        const root = document.createElement('div');
        root.className = 'sw-app' + (this.layout === 'wheel' ? ' sw-bare' : '');
        this.root = root;

        const t = (k) => this.ui[k];

        root.innerHTML = this.layout === 'full'
            ? '<output class="sw-result" role="status" aria-live="polite"></output>'
            + '<div class="sw-deck">'
            + '<div class="sw-wheelhouse"><div class="sw-rotor"><canvas class="sw-disc"></canvas></div>'
            + '<span class="sw-pointer">' + POINTER_SVG + '</span>'
            + '<button class="sw-hub" type="button"><span class="sw-hub-word"></span></button></div>'
            + '<p class="sw-hint"></p></div>'
            + '<aside class="sw-card">'
            + '<div class="sw-card-head"><h2 class="sw-card-title"></h2><span class="sw-count">0</span></div>'
            + '<textarea class="sw-entries" rows="10" spellcheck="false"></textarea>'
            + '<div class="sw-rowbtns"><button class="sw-minibtn" data-sw="shuffle" type="button"></button>'
            + '<button class="sw-minibtn" data-sw="sort" type="button"></button>'
            + '<button class="sw-minibtn" data-sw="reset" type="button"></button></div>'
            + '<button class="sw-go" type="button"></button>'
            + '<div class="sw-opts">'
            + '<label class="sw-switch"><input type="checkbox" data-sw="elim"><span class="sw-switch-box" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg></span><span class="sw-switch-label"></span></label>'
            + '<label class="sw-switch"><input type="checkbox" data-sw="sound" checked><span class="sw-switch-box" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="M4 9v6h4l5 4.4V4.6L8 9H4z"/><path d="M16.2 8.2a5.4 5.4 0 0 1 0 7.6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg></span><span class="sw-switch-label"></span></label>'
            + '<span class="sw-optgap"></span>'
            + '<button class="sw-toolbtn" data-sw="share" type="button"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.6 13.2l6.8 3.9M15.4 6.9L8.6 10.8"/><circle cx="18" cy="5.2" r="2.9" fill="currentColor" stroke="none"/><circle cx="6" cy="12" r="2.9" fill="currentColor" stroke="none"/><circle cx="18" cy="18.8" r="2.9" fill="currentColor" stroke="none"/></svg></button>'
            + '<button class="sw-toolbtn" data-sw="full" type="button"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 3.5h-5v5M15.5 3.5h5v5M8.5 20.5h-5v-5M15.5 20.5h5v-5"/></svg></button>'
            + '</div>'
            + '<section class="sw-history"><div class="sw-card-head"><h3 class="sw-card-title"></h3>'
            + '<button class="sw-minibtn" data-sw="clearlog" type="button"></button></div>'
            + '<ol class="sw-log"></ol></section>'
            + '</aside>'
            : '<div class="sw-deck"><div class="sw-wheelhouse"><div class="sw-rotor"><canvas class="sw-disc"></canvas></div>'
            + '<span class="sw-pointer">' + POINTER_SVG + '</span>'
            + '<button class="sw-hub" type="button"><span class="sw-hub-word"></span></button></div></div>';

        this.mount.appendChild(root);

        this.$q = (sel) => root.querySelector(sel);
        this.result = this.$q('.sw-result');
        this.rotor = this.$q('.sw-rotor');
        this.disc = this.$q('.sw-disc');
        this.house = this.$q('.sw-wheelhouse');
        this.ctx2d = this.disc.getContext('2d');
        this.countBox = this.$q('.sw-count');
        this.entriesBox = this.$q('.sw-entries');
        this.logBox = this.$q('.sw-log');

        /* localized labels */
        this.$q('.sw-hub-word').textContent = t('spin');
        if (this.layout === 'full') {
            this.$q('.sw-card-title').textContent = t('entries');
            this.entriesBox.placeholder = t('entries_hint');
            this.entriesBox.setAttribute('aria-label', t('entries'));
            this.$q('[data-sw="shuffle"]').textContent = t('shuffle');
            this.$q('[data-sw="sort"]').textContent = t('sort');
            this.$q('[data-sw="reset"]').textContent = t('reset');
            this.$q('.sw-go').textContent = t('spin');
            const elimLabel = root.querySelectorAll('.sw-switch-label');
            elimLabel[0].textContent = t('remove_after');
            elimLabel[1].textContent = t('sound');
            this.$q('[data-sw="elim"]').setAttribute('aria-label', t('remove_after'));
            this.$q('[data-sw="sound"]').setAttribute('aria-label', t('sound'));
            this.$q('[data-sw="share"]').title = t('share');
            this.$q('[data-sw="full"]').title = t('fullscreen');
            this.$q('.sw-history .sw-card-title').textContent = t('results');
            this.$q('[data-sw="clearlog"]').textContent = t('clear');
            this.$q('.sw-hint').textContent = t('hint');
        }

        this._wireEvents();
    }

    _wireEvents() {
        const on = (el, ev, fn) => { el.addEventListener(ev, fn); };
        const doc = (ev, fn) => {
            document.addEventListener(ev, fn);
            this._docListeners.push([ev, fn]);
        };

        /* spin triggers: hub, card button, click on wheel, keyboard */
        on(this.house, 'click', (ev) => {
            if (this.busy) return;
            if (ev.target.closest('button')) return;
            this.spin();
        });
        this.$q('.sw-hub').addEventListener('click', () => this.spin());
        if (this.layout === 'full') {
            this.$q('.sw-go').addEventListener('click', () => this.spin());
            on(this.entriesBox, 'input', () => {
                this.entries = this.entriesBox.value.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, this.maxEntries);
                this._afterEntriesChange();
            });
            this.$q('[data-sw="shuffle"]').addEventListener('click', () => this.shuffle());
            this.$q('[data-sw="sort"]').addEventListener('click', () => this.sort());
            this.$q('[data-sw="reset"]').addEventListener('click', () => this.reset());
            this.$q('[data-sw="clearlog"]').addEventListener('click', () => { this.logBox.textContent = ''; this.logNo = 0; });
            const elim = this.$q('[data-sw="elim"]');
            elim.checked = this._eliminate === true;
            elim.addEventListener('change', () => { this._eliminate = elim.checked; });
            const sound = this.$q('[data-sw="sound"]');
            sound.checked = this.soundEnabled;
            sound.addEventListener('change', () => { this.soundEnabled = sound.checked; });
            this.$q('[data-sw="share"]').addEventListener('click', () => this._share());
            this.$q('[data-sw="full"]').addEventListener('click', () => this._fullscreen());
        }

        /* global keys: Space spins (when wheel is on screen), Ctrl/⌘+Enter always */
        doc('keydown', (ev) => {
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
                ev.preventDefault();
                this.spin();
                return;
            }
            if (ev.code !== 'Space' || this.busy) return;
            const tag = (ev.target && ev.target.tagName) || '';
            if (/^(INPUT|TEXTAREA|SELECT|BUTTON|A|DETAILS)$/.test(tag) || ev.target.isContentEditable) return;
            const rect = this.house.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > innerHeight) return;
            ev.preventDefault();
            this.spin();
        });

        /* redraw on resize (debounced; DPR changes ride the same path) */
        const rs = () => {
            clearTimeout(this._rsTimer);
            this._rsTimer = setTimeout(() => this.draw(), 140);
        };
        window.addEventListener('resize', rs);
        this._winResize = rs;   /* removed on destroy */
    }

    _fullscreen() {
        const shell = this.root.parentElement || this.root;
        if (!document.fullscreenElement) {
            if (shell.requestFullscreen) shell.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen();
        }
    }

    _share() {
        if (this.entries.length < 2) return;
        const url = location.origin + location.pathname + '#w=' + b64enc(JSON.stringify(this.entries));
        history.replaceState(null, '', url);
        (navigator.clipboard && navigator.clipboard.writeText
            ? navigator.clipboard.writeText(url)
            : Promise.reject()
        ).then(() => this._say(this.ui.copied), () => this._say(this.ui.copied));
    }

    /* ── painting (only on entries/size change) ──────────── */
    draw() {
        const cssSize = this.rotor.clientWidth || 320;
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        const px = Math.round(cssSize * dpr);
        if (this.disc.width !== px) {
            this.disc.width = px;
            this.disc.height = px;
        }
        const S = px;
        const cx = S / 2, cy = S / 2;
        const R1 = S / 2 - Math.max(6, S * 0.02);
        const n = this.entries.length;
        const ctx = this.ctx2d;

        ctx.clearRect(0, 0, S, S);
        ctx.lineJoin = 'round';

        if (n === 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, R1, 0, Math.PI * 2);
            ctx.fillStyle = '#efe9de';
            ctx.fill();
            ctx.lineWidth = Math.max(3, S * 0.008);
            ctx.strokeStyle = INK;
            ctx.stroke();
            return;
        }

        const seg = (Math.PI * 2) / n;
        const hubR = Math.max(30, S * 0.13);   /* hub button covers ~23%; keep 26% clear so labels never sit under it */

        for (let i = 0; i < n; i++) {
            const a0 = -Math.PI / 2 + i * seg;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, R1, a0, a0 + seg);
            ctx.closePath();
            ctx.fillStyle = this.palette[i % this.palette.length];
            ctx.fill();
            if (seg > 0.014) {          /* skip slice borders on very dense wheels */
                ctx.lineWidth = Math.max(2, S * 0.005);
                ctx.strokeStyle = PAPER;
                ctx.stroke();
            }
        }

        /* Labels: radial (following the slice). Horizontally drawn text pokes
           out of the wheel on the left/right slices and collides with
           neighbors — radial text runs along the radius so truncation is real.
           Light slices get dark ink + white halo (double stroke, no shadowBlur:
           shadow paint is a main-thread/TBT hazard). Left-half slices are
           flipped 180° so text stays upright. */
        let font = S * 0.047;
        if (n > 12) font = S * 0.041;
        if (n > 24) font = S * 0.035;
        if (n > 48) font = S * 0.028;
        ctx.font = '600 ' + font.toFixed(1) + 'px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';
        ctx.textBaseline = 'middle';
        const pad = S * 0.035;
        const maxW = R1 - hubR - pad - S * 0.015;
        for (let i = 0; i < n; i++) {
            let label = this.entries[i].length > 30 ? this.entries[i].slice(0, 29) + '…' : this.entries[i];
            while (label.length > 2 && ctx.measureText(label).width > maxW) {
                label = label.slice(0, -2) + '…';
            }
            const a = -Math.PI / 2 + (i + 0.5) * seg;
            const flip = Math.cos(a) < 0;
            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(a + (flip ? Math.PI : 0));
            ctx.textAlign = flip ? 'left' : 'right';
            const x = flip ? -(R1 - pad) : (R1 - pad);
            ctx.lineWidth = font * 0.22;
            ctx.strokeStyle = 'rgba(255,255,255,.95)';
            ctx.strokeText(label, x, 0);
            ctx.fillStyle = INK;
            ctx.fillText(label, x, 0);
            ctx.restore();
        }

        /* rim: soft white ring (body shadow comes from CSS drop-shadow) */
        ctx.beginPath();
        ctx.arc(cx, cy, R1, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(4, S * 0.016);
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.stroke();

        /* hub seat: white circle under the DOM center button */
        ctx.beginPath();
        ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
        ctx.fillStyle = PAPER;
        ctx.fill();
        ctx.lineWidth = Math.max(3, S * 0.008);
        ctx.strokeStyle = 'rgba(44,50,66,.14)';
        ctx.stroke();

        this.disc.setAttribute('aria-label', this.ui.entries + ' · ' + n);
        if (this.countBox) this.countBox.textContent = String(n);
    }

    /* ── status line ─────────────────────────────────────── */
    _say(text) {
        if (!this.result) return;
        this.root.classList.remove('sw-haswin');
        this.result.textContent = text;
    }
    _announceWinner(name, removed) {
        if (!this.result) return;
        this.root.classList.add('sw-haswin');
        this.result.textContent = '';
        const tag = document.createElement('span');
        tag.className = 'sw-result-tag';
        tag.textContent = this.ui.winner;
        const big = document.createElement('strong');
        big.className = 'sw-result-name';
        big.textContent = name;
        this.result.append(tag, big);
        if (removed) {
            const note = document.createElement('span');
            note.className = 'sw-result-note';
            note.textContent = this.ui.removed;
            this.result.append(note);
        }
    }
    _pushLog(name) {
        if (!this.logBox) return;
        this.logNo++;
        const li = document.createElement('li');
        const no = document.createElement('span');
        no.className = 'sw-log-no';
        no.textContent = String(this.logNo);
        const nm = document.createElement('span');
        nm.className = 'sw-log-name';
        nm.textContent = name;
        li.append(no, nm);
        this.logBox.prepend(li);
    }

    _afterEntriesChange(persist) {
        if (persist !== false && this.persistKey) store.set(this.persistKey, this.entries);
        if (this.entriesBox) this.entriesBox.value = this.entries.join('\n');
        this.draw();
    }

    /* ── the spin ────────────────────────────────────────── */
    spin() {
        if (this.busy) return;
        if (this.entries.length < 2) {
            this._say(this.ui.need_two);
            return;
        }
        this.busy = true;
        this.root.classList.add('sw-spinning');

        const n = this.entries.length;
        const seg = 360 / n;
        const winner = randIndex(n);                       /* result FIRST */
        /* land the winner slice center on the pointer (jitter avoids seams),
           plus a randomized number of full turns */
        const jitter = (Math.random() * 2 - 1) * seg * 0.36;
        const need = norm360(-90 - ((-90 + winner * seg + seg / 2) + this.rotation) + jitter);
        const target = this.rotation + randRange(this.turns[0], this.turns[1]) * 360 + need;
        const dur = this.reduceMotion ? 650 : randRange(this.spinDuration[0], this.spinDuration[1]);

        if (this.onSpin) this.onSpin(winner, this.entries[winner]);

        this.rotor.style.transform = 'rotate(' + this.rotation + 'deg)';
        const anim = this.rotor.animate(
            [{ transform: 'rotate(' + this.rotation + 'deg)' }, { transform: 'rotate(' + target + 'deg)' }],
            { duration: dur, easing: 'cubic-bezier(' + EASE.join(',') + ')', fill: 'forwards' }
        );

        /* ticks: rAF maps anim.currentTime -> angle analytically (no layout
           reads); fires a short sound whenever a slice boundary is crossed */
        let raf = 0;
        let lastSegIdx = 0;
        const tickLoop = () => {
            const p = Math.min(1, anim.currentTime / dur);
            const ang = this.rotation + (target - this.rotation) * this.easeAt(p);
            const si = Math.floor(norm360(ang) / seg);
            if (si !== lastSegIdx) {
                lastSegIdx = si;
                if (this.soundEnabled && !this.reduceMotion) this.audio.tick(si % 2 === 0);
            }
            if (p < 1) raf = requestAnimationFrame(tickLoop);
        };
        if (!this.reduceMotion && this.soundEnabled && n <= 90) raf = requestAnimationFrame(tickLoop);

        anim.onfinish = () => {
            cancelAnimationFrame(raf);
            this.rotation = target;
            this.rotor.style.transform = 'rotate(' + this.rotation + 'deg)';
            anim.cancel();
            const winName = this.entries[winner];
            const elim = this._eliminate === true && this.entries.length > 2;
            this._announceWinner(winName, elim);
            this._pushLog(winName);
            if (this.soundEnabled) this.audio.win();
            if (!this.reduceMotion && this.confettiEnabled) confettiBurst(this.house, this.palette);
            if (this.onSpinEnd) this.onSpinEnd({ index: winner, name: winName, removed: elim });
            /* eliminate mode: winner leaves the wheel (floor of 2 entries —
               removing from a 1v1 wheel would leave it empty) */
            if (elim) {
                this.entries.splice(winner, 1);
                this._afterEntriesChange();
            }
            this.busy = false;
            this.root.classList.remove('sw-spinning');
        };
    }

    /* ── public API ──────────────────────────────────────── */
    getEntries() { return this.entries.slice(); }

    setEntries(list) {
        this.entries = (Array.isArray(list) ? list : String(list).split('\n'))
            .map((s) => String(s).trim()).filter(Boolean).slice(0, this.maxEntries);
        this._afterEntriesChange();
        return this;
    }

    shuffle() {
        for (let i = this.entries.length - 1; i > 0; i--) {
            const j = randIndex(i + 1);
            [this.entries[i], this.entries[j]] = [this.entries[j], this.entries[i]];
        }
        this._afterEntriesChange();
        return this;
    }

    sort() {
        this.entries = this.entries.slice().sort((a, b) => a.localeCompare(b));
        this._afterEntriesChange();
        return this;
    }

    reset() {
        this.entries = this.base.slice();
        if (this.persistKey) store.del(this.persistKey);
        this._afterEntriesChange(false);
        this._say('');
        return this;
    }

    get spinning() { return this.busy; }

    destroy() {
        cancelAnimationFrame(this._raf);
        clearTimeout(this._rsTimer);
        for (const [ev, fn] of this._docListeners) document.removeEventListener(ev, fn);
        if (this._winResize) window.removeEventListener('resize', this._winResize);
        this.root.remove();
    }

    /* ── startup: share hash > saved list > initial entries ─ */
    _startup(initial) {
        this.base = (Array.isArray(initial) ? initial : []).map(String).slice(0, this.maxEntries);
        this.entries = this.base.slice();

        let restored = null;
        if (this.shareUrl) {
            const m = /^#w=([A-Za-z0-9_-]+)$/.exec(location.hash || '');
            if (m) {
                try {
                    const arr = JSON.parse(b64dec(m[1]));
                    if (Array.isArray(arr) && arr.length >= 2 && arr.length <= this.maxEntries
                        && arr.every((x) => typeof x === 'string' && x.length <= 60)) {
                        restored = arr.slice(0, this.maxEntries);
                    }
                } catch (e) { restored = null; }
                history.replaceState(null, '', location.pathname + location.search);
            }
        }
        if (!restored && this.persistKey) {
            const saved = store.get(this.persistKey);
            if (Array.isArray(saved) && saved.length >= 1 && saved.length <= this.maxEntries
                && saved.every((x) => typeof x === 'string')) {
                restored = saved.slice(0, this.maxEntries);
            }
        }
        if (restored) this.entries = restored;

        this._afterEntriesChange(false);
        this._say(this.ui.hint);
    }
}

SpinWheel.version = VERSION;
