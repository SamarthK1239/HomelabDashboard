# Aperture — the design language

This dashboard is wall-mounted, desk-glanced and phone-checked, often all three in
the same day, and it is looked at far more often than it is read. The interface is
built around that: it should be answerable in a second from across a room, and
still hold up when you lean in to debug something.

The name is the idea. An aperture controls how much light gets through; this UI
controls how much *attention* each thing gets through.

## Principles

**1. Calm by default, loud only when it matters.**
Severity buys salience, and nothing else does. A healthy card gets no tint, no
badge colour, no glow — `ok` is the absence of signal, not a green celebration.
If everything is fine the page should be close to monochrome, so that a single
amber card is visible from the far side of the room without being looked for.
The previous iteration coloured every status, which meant a healthy screen was
already noisy and a degraded one had nowhere left to go.

**2. One glance, three distances.**
Density is a first-class axis, not an accessibility afterthought. Compact for a
laptop, comfortable for a desktop, ambient for a wall. All sizing is authored in
`rem` and the whole interface scales from a single root font-size multiplier, so
"ambient" is one number, not a parallel stylesheet.

**3. The data is the interface.**
Charts, bars and the core heatmap carry the meaning; labels annotate them. Where a
number and its shape both exist, show both — a CPU figure with no trend behind it
is a fact without a story.

**4. Honesty is a feature, and it has to stay legible.**
The backend goes to real lengths not to lie (first samples read `—`, power names
every sensor it could not reach, stale data says it is stale). That honesty is
wasted if it is rendered in 3:1 grey. Every state the backend can express has a
visual treatment that survives being read from four metres away.

## The token system

`src/styles/tokens.css` is the foundation; nothing else defines a colour, a
duration or a radius.

**Colour is OKLCH**, with neutrals at hue 265. Perceptual lightness is the only
thing that varies through the neutral ramp, so dark and light themes are the same
design at two lightness polarities rather than two separately tuned palettes.
Contrast was computed rather than eyeballed: the old faint-text token sat at
3.3:1 and failed WCAG AA; `--fg-tertiary` is 5.8:1 in dark and 4.6:1 in light.

**Severity resolution is centralized.** A component writes `data-status="warn"`
and reads `--sev-fg`, `--sev-solid`, `--sev-tint`, `--sev-line`. The mapping from
status to colour lives in exactly one block at the bottom of `tokens.css`. No
component contains a four-way status switch, which is why adding a tenth collector
needs no colour decisions at all.

**Density** is `--density-scale`: `0.875` compact, `1` comfortable, `1.25`
ambient, applied as `html { font-size: calc(16px * var(--density-scale)) }`.

**Elevation** is `--elev-1` through `--elev-4`; **motion** is `--dur-fast`
through `--dur-slower` paired with `--ease-standard` / `--ease-emphasized` /
`--ease-decelerate` / `--ease-accelerate`. Every animation in the app respects
`prefers-reduced-motion`.

The theme is applied as `data-theme` on `<html>`. `index.html` carries a small
inline script that duplicates the theme-resolution logic from `preferences.ts`;
that duplication is deliberate and commented, because a module import cannot run
before first paint and a flash of the wrong theme on a wall display is worse than
fifteen duplicated lines.

## The glance layer

Above the cards sit two components that did not exist before, and they are the
main reason the dashboard is now answerable without reading it.

**SummaryBar** states a verdict in a sentence — "All systems nominal", or what is
wrong — then a severity tally, then up to six KPI tiles. The tiles are derived
(`src/summary.ts`), not configured: degraded metrics are promoted forward, so the
glance layer rearranges itself around whatever is currently interesting. Each tile
carries a micro-sparkline and focuses its card when clicked.

The KPI selections encode judgement about *this* machine. The GPU tile headlines
temperature rather than VRAM, because llama.cpp preallocates its KV cache and VRAM
sits pinned near 98% by design — the conventional metric is the uninformative one
here. Similarly a stopped container is usually deliberate, so only `unhealthy` and
`restarting` can colour the containers tile; counting `exited` as a warning made
the tile contradict the verdict sentence sitting next to it.

**AttentionStrip** appears only when something is degraded, and writes one plain
sentence per affected collector. It is the "what do I do about it" layer.

## Interaction depth

The card grid is the overview; three overlays carry the depth, all built on native
`<dialog>` so that focus trapping, the top layer and Escape come from the platform
rather than from code that approximates them.

- **DetailSheet** — a card's full payload, with per-collector charts and no
  truncation. The recursive renderer is shared with the card body; the two differ
  only in a limits context (`CARD_LIMITS` vs `DETAIL_LIMITS`).
- **EventDrawer** — the `/api/events` log, so a transition that happened at 04:00
  is still discoverable at 09:00.
- **ShortcutsOverlay** — bound to `?`, because discoverability of keyboard
  shortcuts is otherwise zero.

Charts share a cursor: hovering one sparkline draws a synchronized crosshair
across every chart in the same group, which is how you tell "the GPU spiked"
apart from "everything spiked".

Toasts fire on *deterioration only*. A dashboard that announces recoveries as
loudly as failures teaches you to dismiss it.

## Kiosk mode

For the wall display: fullscreen, a screen wake lock, chrome that fades out when
the pointer has been idle, and a condensed topbar on scroll. Ambient density is
the intended pairing.

## Accessibility notes

Beyond contrast, two decisions are worth calling out because the obvious
implementation is the wrong one.

The **88-core heatmap** is a single `role="img"` with a spoken summary — thread
count, how many are busy, the average, and the busiest core. Labelling each cell
individually, which is what it did first, forces a screen-reader user through 88
list items to learn one fact. The grid's purpose is pre-attentive; the sentence is
the equivalent of that, not a transcription of it.

**Bounded sparklines** (anything on a fixed 0–100 axis) draw top and bottom
hairlines. Without them, a series resting near the axis floor reads as a chart
that failed to render rather than as a system with headroom.

## Deliberate non-goals

**No drag-to-reorder.** The masonry layout sets `grid-row-end: span N` from
measured heights, which fights every drag library's transform-based reordering.
Pin, hide and registry order already cover personalization, and the trade — a
fragile layout for a feature used once — is a bad one.

**No command palette.** With nine cards, KPI click-to-focus and the `?` sheet
cover the navigation need. A palette here would be ceremony.

**No alert thresholds in the UI.** Thresholds live in `config.toml`, on the
machine, where they are version-controlled and survive a browser profile reset.
The dashboard stays read-only; that is the whole security posture.
