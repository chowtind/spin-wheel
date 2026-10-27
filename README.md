# spin-wheel.js

A zero-dependency canvas wheel spinner — pick random names, prizes or options
with buttery easing and provably fair shuffling. 6 KB gzipped, no signup, no
tracking, 34 languages in production.

**[Live demo →](https://chowtind.github.io/spin-wheel/)** · **[Try the full app →](https://spinwheelofnames.app)**

![License](https://img.shields.io/badge/license-MIT-green)
![No dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Gzipped](https://img.shields.io/badge/gzip-6_KB-blue)

## Why

Most wheel spinners online are heavy, ad-stuffed or behind a signup. This one:

- **Zero dependencies** — one 16.9 KB file (6.1 KB gzipped) + 1.9 KB of CSS. No framework, no build step required
- **Result-first fairness** — the winner is drawn with `crypto.getRandomValues` + rejection sampling *before* the animation starts, then the landing angle is solved backwards. No modulo bias, and dropped frames can never change the outcome
- **Composite-only rotation** — the disc is painted once per change; rotation is a single Web Animations API transform, so every spin frame is composited off the main thread. Idle state has zero rAF loops, zero timers, zero observers
- **Layout-free ticks** — the click sound fires at slice boundaries by inverting the cubic-bezier easing analytically (Newton's method) from `anim.currentTime`. Never reads styles, never touches layout
- **Real i18n surface** — every UI string is overridable; the engine ships on production sites in 34 languages, including RTL
- **Accessibility effort** — `aria-live` result announcement, keyboard spin (Space / Ctrl+Enter), honors `prefers-reduced-motion`
- **Batteries included** — entries editor, shuffle/sort/reset, eliminate mode (draw without replacement), sound toggle, shareable links (the whole wheel travels inside the URL hash), fullscreen, results log, confetti

## Quick start

### Script tag

```html
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/spin-wheel-js@1/dist/spin-wheel.min.css">
<script src="https://cdn.jsdelivr.net/npm/spin-wheel-js@1/dist/spin-wheel.min.js"></script>

<div id="wheel"></div>
<script>
  new SpinWheel('#wheel', {
    entries: ['Alice', 'Bob', 'Carol', 'Dave'],
  });
</script>
```

### npm / ESM

```sh
npm install spin-wheel-js
```

```js
import SpinWheel from 'spin-wheel-js';
import 'spin-wheel-js/dist/spin-wheel.css';
```

The component mounts itself — it builds its own DOM inside the container. You
bring the data and (optionally) the callbacks.

## Layouts

```js
// full: wheel + entries card + options + results log (default)
new SpinWheel('#app', { entries: names });

// wheel: bare wheel with the center SPIN hub; drive everything via API
const w = new SpinWheel('#embed', { layout: 'wheel', entries: names });
w.spin();
```

## API

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `entries` | `string[]` | `[]` | initial entries (one slice each) |
| `layout` | `'full' \| 'wheel'` | `'full'` | `wheel` = no built-in editor |
| `eliminate` | `boolean` | `false` | remove winner after each spin (floors at 2 entries) |
| `sound` | `boolean` | `true` | tick + winner chime (WebAudio, created on first gesture) |
| `confetti` | `boolean` | `true` | one-shot canvas confetti on win |
| `palette` | `string[]` | candy set | slice colors, cycled |
| `spinDuration` | `[min, max]` ms | `[4100, 5300]` | randomized per spin |
| `turns` | `[min, max]` | `[5, 7]` | full rotations, randomized |
| `maxEntries` | `number` | `150` | hard cap (up to 500) |
| `persist` | `string \| null` | auto key | localStorage key; `null` disables persistence |
| `shareUrl` | `boolean` | `true` | read/write the wheel from `#w=` URL hash |
| `onSpin` | `fn(index, name)` | — | fired when the spin starts (result already locked in) |
| `onSpinEnd` | `fn({index, name, removed})` | — | fired after the wheel settles |
| `ui` | `object` | English | label overrides for every UI string |

### Methods

| Method | Returns | Notes |
|---|---|---|
| `spin()` | — | start a spin (no-op while spinning or with < 2 entries) |
| `getEntries()` | `string[]` | copy of the current list |
| `setEntries(list)` | `this` | array or newline-joined string |
| `shuffle()` / `sort()` / `reset()` | `this` | reset() returns to the constructor list |
| `spinning` | `boolean` | getter |
| `destroy()` | — | removes DOM, listeners, timers |

### Localizing

```js
new SpinWheel('#wheel', {
  entries: ['Ana', 'Børge', 'Çelik'],
  ui: {
    spin: 'DREJ', winner: 'Vinder', entries: 'Navne',
    remove_after: 'Fjern vinderen', /* …every label is overridable */
  },
});
```

## Browser support

Chrome, Edge, Firefox, Safari — anything with WAAPI and `crypto.getRandomValues`
(≈2018+). No polyfills, no transpiled build needed. The library itself targets
ES2018 and is plain DOM/canvas.

## Used in production

- [spinwheelofnames.app](https://spinwheelofnames.app) — name picker with dozens of preset wheels, 34 languages
- [wheelpick.io](https://wheelpick.io) — spin wheels & random-picker tools

## License

MIT
