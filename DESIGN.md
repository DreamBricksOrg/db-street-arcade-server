---
name: Street Arcade
description: Real-time arcade control system — operator dashboard and phone gamepad, built on the DreamBricks Design System with arcade-color bursts.
colors:
  db-blue: "#42b0d5"
  db-blue-light: "#52cdef"
  db-blue-ink: "#034a5d"
  db-blue-700: "oklch(from #42b0d5 calc(l - 0.18) c h)"
  slate-bg: "oklch(0.97 0.006 230)"
  surface-white: "#ffffff"
  surface-slate: "oklch(0.94 0.010 230)"
  border-slate: "oklch(0.89 0.014 230)"
  ink: "oklch(0.16 0.028 230)"
  ink-muted: "oklch(0.52 0.022 230)"
  success: "oklch(0.62 0.14 155)"
  danger: "oklch(0.58 0.20 25)"
  warning: "oklch(0.78 0.15 80)"
  xbox-green: "#107c10"
  xbox-red: "#e23c28"
  xbox-blue: "#0078d4"
  xbox-yellow: "#ffb900"
typography:
  hero:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  display:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.5px"
  subtitle:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  headline:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.5px"
    textTransform: "uppercase"
  mono-label:
    fontFamily: "'IBM Plex Mono', monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "1px"
    textTransform: "uppercase"
  micro:
    fontFamily: "'Poppins', sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "10px"
  lg: "16px"
  xl: "24px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.db-blue-700}"
    textColor: "#ffffff"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
  button-primary-hover:
    backgroundColor: "{colors.db-blue-700}"
    textColor: "#ffffff"
  button-secondary:
    backgroundColor: "{colors.surface-slate}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "9px 14px"
  input-field:
    backgroundColor: "{colors.surface-slate}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "11px 14px"
  card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "24px"
  badge-status:
    backgroundColor: "{colors.success}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design System: Street Arcade

## 1. Overview

**Creative North Star: "The Control Room, on DreamBricks Blue"**

Street Arcade is built on the **DreamBricks Design System** — DreamBricks' own brand tokens (source: `docs/design_system/`; shipped as `public/css/tokens.css` + `public/css/components.css`) — merged with the arcade-specific signature this product depends on: monospace labels for anything that is live system data (IDs, timers, status codes), and the Xbox-style ABXY button palette on the gamepad. The base layer reads like an instrument panel wearing the DreamBricks brand: light, blue-tinted slate surfaces, thin 1px borders, and a single confident accent (DreamBricks Blue) doing all the "this is interactive" signaling. The playful half of the brand doesn't come from decoration; it comes from the Xbox-style button palette on the gamepad and the pulsing live dot in the operator header. Reliable first, playful second, exactly as PRODUCT.md states.

This system explicitly rejects both of PRODUCT.md's anti-references: it is not a gray enterprise SaaS panel (hence the IBM Plex Mono data-texture, the colored session badges, the arcade-controller color story), and it is not neon/cyberpunk gamer aesthetic (no RGB gradients, no glitch effects, no dark-mode-by-default — the base UI stays light and clean, and saturated color is spent deliberately on the few places it earns its keep: buttons, badges, the four gamepad face buttons).

**Merge rationale.** The DreamBricks brandbook is a generic "project dashboard" brand — a tight blue-only palette with no gamepad, real-time-queue, or mobile-controller guidance of its own (see the design system's own `readme.md`). Street Arcade adopts its color/type/radius tokens wholesale for the base chrome (this *is* the DreamBricks product family now), but keeps two elements the DreamBricks system has no answer for and PRODUCT.md treats as essential: the **Xbox gamepad palette** (the product's one signature, quarantined moment) and the **mono-for-live-data rule** (now carried by DreamBricks' own IBM Plex Mono token rather than Fira Code).

**Key Characteristics:**
- Light, blue-tinted slate base (`oklch(0.97 0.006 230)`) with white surface cards, never dark-mode-by-default
- One accent color (DreamBricks Blue `#42b0d5`) carrying all primary CTAs, focus states, and active-tab indicators
- IBM Plex Mono reserved for anything that reads as data or a system label; Poppins for everything conversational
- Quiet depth: cards carry the DS `--shadow-sm` at rest, everything else is flat; more depth only on hover, toasts and dialogs — always ink-tinted, never pure black
- Saturated color bursts are scoped tightly: session status badges, the Xbox-palette gamepad buttons, the pulsing "live" dot — never the base chrome

## 2. Colors

Mostly neutral, blue-tinted slate with one confident accent; saturated color is reserved for status and the gamepad's four action buttons.

### Primary
- **DreamBricks Blue** (`#42b0d5`): the one accent. Focus rings, active tab underline, borders, links, highlights. Never a fill under white text: white on `#42b0d5` is ~2.6:1.
- **DreamBricks Blue 700** (`--db-blue-700`, the DS ramp step 0.18 darker): the fill of every primary button and switch-on state — same hue, readable under white text.
- **DreamBricks Blue Light** (`#52cdef`): secondary tint used in the loader-bar fill gradient and hover states. Never carries text.
- **DreamBricks Ink** (`#034a5d`): the brand's deepest blue. Reserved for high-emphasis moments that need more weight than the primary accent Player-facing titles, the queue position number, the collapsed embed pill..

### Secondary
None. The former CTA Orange (`--cta`, `#f97316`) was retired when the shared DreamBricks tokens landed: it was never used meaningfully and the brandbook is blue-only. Secondary actions use the secondary/ghost button styles.

### Neutral
All neutrals are the DreamBricks slate ramp — tinted 0.01–0.028 chroma toward the brand's own blue hue (230), not a generic gray.
- **Slate Background** (`oklch(0.97 0.006 230)`): the page background across every screen — dashboard, queue, gamepad.
- **Surface White** (`#ffffff`): cards, headers, modals, the QR panel.
- **Surface Slate** (`oklch(0.94 0.010 230)`): recessed surfaces — input fields, totem-card backgrounds, tab hover states, secondary buttons.
- **Border Slate** (`oklch(0.89 0.014 230)`): the only border color in the system, at 1px, everywhere a divider or outline is needed.
- **Ink** (`oklch(0.16 0.028 230)`): primary text and headings; also the tint used for every shadow in the system (see Elevation).
- **Ink Muted** (`oklch(0.52 0.022 230)`): secondary text, labels, placeholders, meta text.

### Status colors
- **Success** (`oklch(0.62 0.14 155)`): live badges, connected status dots, the "playing" queue row tint.
- **Danger** (`oklch(0.58 0.20 25)`): kick/delete actions, error banners, disconnected state.
- **Warning** (`oklch(0.78 0.15 80)`): queue "waiting" status badge.

All three are DreamBricks' own semantic tokens (`--db-success-500` / `--db-danger-500` / `--db-warning-500`), harmonized in oklch against the brand blue rather than borrowed from an unrelated palette.

### Gamepad palette (signature, scoped to `#gamepad`)
- **Xbox Green** (`#107c10`), **Xbox Red** (`#e23c28`), **Xbox Blue** (`#0078d4`), **Xbox Yellow** (`#ffb900`): the four face-button colors (A/B/X/Y). This is the one place in the system where a named, saturated, multi-color palette is not only allowed but the point — it's the arcade-controller reference the whole product is built around, and the one element the DreamBricks brand tokens don't (and shouldn't) cover. Confined strictly to the four face buttons; never bleed into dashboard or status UI.

### Named Rules
**The One Accent Rule.** DreamBricks Blue is the only color allowed to mean "primary action" or "focused/active." A second action is a secondary/ghost button, never a second hue — the brandbook is blue-only, so there is no orange CTA (retired 2026-10-06).

**The Xbox Quarantine Rule.** The Xbox four-color palette exists only inside the gamepad's face buttons. It never appears on a badge, a button in the dashboard, or a status indicator — those stay inside DreamBricks Blue, Success, and Danger.

## 3. Typography

**Display Font:** 'IBM Plex Mono', monospace (with system monospace fallback)
**Body Font:** 'Poppins', sans-serif
**Label/Mono Font:** 'IBM Plex Mono', monospace (same family as Display, used at smaller sizes for meta labels)

Both are the DreamBricks Design System's own font tokens (`--font-body` / `--font-mono`) — Poppins substitutes for the brandbook's proprietary Araboto (see the design system's `readme.md`), IBM Plex Mono is DreamBricks' own data/label font, adopted here for exactly the role Fira Code used to play.

**Character:** A single contrast pair rather than two families: Poppins carries every sentence a human reads, IBM Plex Mono marks anything that is system state — IDs, timers, panel titles, uppercase labels. The pairing itself is the "control room" read; switching fonts mid-UI is how the system tells you "this is a live value, not prose."

### Hierarchy

The system runs a fuller integer-px micro-scale than a strict 6-step ramp — deliberate, not drift: compact status/meta UI (badges, chips, device labels) needs finer steps than page-level headings do. Named roles below cover primary content; the Micro-scale row documents the smaller, equally-real steps used throughout the compact chrome.

- **Hero** (700, 26px, 1.1 line-height, IBM Plex Mono): The single largest text in the system — `play.html`'s in-game loading title only.
- **Display** (700, 24px, 1.1, IBM Plex Mono, -0.5px tracking): Loading-screen titles and hero panel titles ("Street Arcade", "Fila de Espera"), rendered in solid DreamBricks Blue.
- **Subtitle** (700, 20-22px, 1.2, Poppins or IBM Plex Mono): Sessions-header `<h2>`, error-screen titles.
- **Headline** (700, 18px, 1.2, IBM Plex Mono): Modal titles, section headers ("Sessões Ativas" secondary heads).
- **Title** (700, 14px, 1.3, Poppins): Card titles, totem names, button labels.
- **Body** (400, 15px, 1.5, Poppins): Form inputs, descriptions, hint text. Cap prose blocks at ~65–75ch even though most surfaces here are short-form.
- **Caption** (400-600, 13px, 1.4, Poppins): Secondary descriptive text — QR captions, form hints, session meta.
- **Label** (700, 12px, 1.3, Poppins, 0.5px tracking, uppercase): Field labels, tab labels.
- **Mono Label** (700, 11px, 1.3, IBM Plex Mono, 1px tracking, uppercase): Panel titles, queue headers, status-badge text.
- **Micro** (500-700, 10px, 1.3, Poppins or IBM Plex Mono): The floor of the scale — queue-row device meta, ETA text, timestamp chips. Never used for anything a user must read at a glance from a distance; always paired with an icon or adjacent larger text for context.

Icon-scale exceptions (64px empty-state icons, gamepad glyphs at `clamp()` sizes tuned to touch-target geometry) sit outside this ramp by design — they size to their container, not to a reading hierarchy.

### Named Rules
**The Data-Is-Mono Rule.** Any value that represents live or identifying system state — session IDs, player IDs, timers, IPs, ports, queue positions — renders in IBM Plex Mono, regardless of its surrounding context. If it's a fact about the system, it's mono; if it's a sentence to a human, it's Poppins.

## 4. Elevation

Follows the DreamBricks Design System's own Card: **a whisper of depth at rest, more on response.** Cards sit on the slate page with a 1px Border Slate line plus `--shadow-sm` (two tiny ink-tinted layers — barely there, it reads as paper on a desk, not a floating panel). Everything else — the top bar, tab bar, sidebar, inputs, badges — is flat. Depth grows only as a reaction: a hoverable card lifts 2px to `--shadow-md`, a toast and the open dialog sit on `--shadow-lg`. Every shadow is tinted with Ink (`oklch(0.16 0.028 230)`), never pure black.

### Shadow Vocabulary (DS tokens, `tokens.css`)
- **`--shadow-sm`**: resting cards (`.db-card`) and the checked segment of `.db-seg`. The only resting shadow in the chrome.
- **`--shadow-md`**: hovered cards (`.db-card--hover`), hovered primary buttons, tooltips.
- **`--shadow-lg`**: toasts.
- **Dialog Lift** (`0 24px 64px oklch(0.16 0.028 230 / 0.28)`): `.db-dialog` over the ink overlay — the one moment depth is meant to feel dramatic.
- **`--shadow-focus`**: the 3px soft blue ring on every focusable control.
- **Gamepad Button Press** (`0 5px 0 oklch(0.16 0.028 230 / 0.15)` at rest, `0 2px 0` when pressed): skeuomorphic key-press, unique to the face buttons.

### Named Rules
**The Quiet-Card Rule.** `--shadow-sm` belongs to cards only. Bars, inputs, badges, buttons at rest and list rows never carry a shadow; if a surface needs separation and isn't a card, use the 1px Border Slate line.

## 5. Radius scale

Adopted directly from the DreamBricks Design System (`tokens/spacing.css`) — generous, consistent rounding, echoing the brandbook's own soft logo-plate corners:
- `sm`: 6px — small chips (`.id-chip`, `.db-tag`), tooltips, inline code
- `md`: 10px — buttons, inputs, list rows, toasts, recessed blocks (`.entry`)
- `lg`: 16px — cards (`.db-card`), dialogs, the large QR
- `xl`: 24px — reserved for large marketing-scale surfaces, not yet used in the shipped product UI
- `pill`: 999px — badges, tab counts

**The Plate Motif.** The brandbook's panels are a rectangle with ONE fully-rounded corner (pages 1, 9, 10, 22). It is used once in the product, on the embed QR card (`16px 16px 16px clamp(40px, 6vmin, 64px)`, mirrored when the card sits on the left) — the one surface a stranger sees on a third-party site, where the brand must read instantly. Don't spread it onto dashboard chrome.

## 6. Components

### Where they live
- `public/css/tokens.css` — the DreamBricks tokens copied verbatim from `docs/design_system/tokens/`, plus the text-on-tint steps (`--db-success-ink`, `--db-warning-ink`, `--db-warning-ink-strong`, `--db-danger-ink`) and short Street Arcade aliases (`--accent`, `--surface`…) kept for older page CSS. New code uses the semantic names (`--surface-*`, `--text-*`, `--border-*`).
- `public/css/components.css` — the DS React components ported to CSS: `db-btn` (`--primary|--secondary|--ghost|--danger`, `--sm|--lg|--block`), `db-icon-btn` (`--danger`), `db-badge` (`--brand|--success|--warning|--danger`, `--dot`, `--live`), `db-tag`, `db-card` (`--hover`), `db-tabs/db-tab` (+ `db-tab__count`), `[data-tip]` tooltip, `db-callout`, `db-field/db-label/db-hint`, `db-input/db-select/db-textarea`, `db-seg`, `db-switch`, `db-code`, `db-dialog` (native `<dialog>`), `db-toast` (in a `db-toast-stack`); plus `sa-*` player-screen compositions (`sa-screen`, `sa-mark`, `sa-mascot`, `sa-title`, `sa-sub`, `sa-loader`, `sa-actions`) shared by the queue entry and the gamepad.
- `public/css/dashboard.css` — the operator shell, a port of `docs/design_system/ui_kits/dashboard` (sidebar, top bar, stat cards, totem grid, dialog contents).
- `public/embed-assets/overlay.{css,js}` — the QR card injected over embedded games. Self-contained (`.dbx` scope with its own few tokens) because the game page doesn't load `tokens.css`.
- `public/assets/brand/` — DreamBricks mark, horizontal wordmark on blue (sidebar), J0Bson mascot (`jobson-wave.webp` on player end/error screens, `jobson-with-cat.webp` on the dashboard empty state, `jobson-and-cat-small.webp` at the foot of the sidebar). Never use the mascot reference sheet (`jobson-mascot-standing`): it carries handwritten labels.
- **Icons:** one inline SVG sprite at the top of `index.html` (`<svg class="ico"><use href="#i-name"/></svg>`), Lucide-style 2px round strokes as the DS readme prescribes. No emoji or Unicode glyphs as icons anywhere, games included.

### Operator shell (DS UI kit)
- **Sidebar:** 232px, DreamBricks Ink (`--db-blue-900`) panel, horizontal on-blue wordmark + "Street Arcade", nav items at 72% white (active: white on a 14% white wash), J0Bson + cat at the foot, then the live pill ("Operador · ao vivo", pulsing Success dot; Danger and "sem conexão" when `/health` fails). Below 900px it collapses into a slim ink top bar (logo + live pill).
- **Top bar:** white, 1px bottom border, page title (`--text-lg`, 700) left; search field and the one primary action ("Adicionar totem") right.
- **Stat cards:** four `db-card`s — Totens, Jogando agora (Success ink), Na fila (Warning ink when > 0), Telas abertas. Value 32px/800 Poppins with tabular numerals, label and sub-line in secondary text. Fed by the same `/instances` polls as the cards — no extra requests.
- **Tabs:** DS underline tabs with count pills (Todos / Totem físico / Web), filtering the grid together with the search field.

### Buttons
- **Shape:** 10px radius (`--radius-md`).
- **Primary:** `--db-blue-700` fill (white on `#42b0d5` is ~2.6:1 — see Colors), white 600 label. Hover deepens to Blue 800 with `--shadow-md`. One per view.
- **Secondary:** Surface Sunken fill, 1px Border Subtle; the default for card actions ("Incorporar", "Fila").
- **Ghost:** transparent, Blue 600 text — inline actions such as "Copiar link", "Abrir em nova aba".
- **Danger:** outlined (danger text + 35% danger border, `--db-danger-100` wash on hover). Destructive actions always go through the confirm dialog first.
- **Icon buttons** (`db-icon-btn`): 36px square, ghost, with a `data-tip` tooltip; `--danger` recolors to danger ink on hover.

### Badges / Tags
- **Badge:** DS formula — tone-100 fill, tone text, 12px/600 Poppins, pill, no border, optional leading dot (`--dot`) that can pulse (`--live`) for "people are playing right now". Text uses the `*-ink` steps so 12px labels clear 4.5:1.
- **Tag** (`db-tag`): mono 11px on Surface Sunken, `--radius-sm` — for addresses (`127.0.0.1:9001`). The totem ID uses the clickable `.id-chip` (same look, copies the full id).

### Cards / Containers
- **Card** (`db-card`): white, 1px Border Subtle, `--radius-lg`, `--shadow-sm`; `--hover` lifts 2px to `--shadow-md`. 24px padding (20px on totem cards).
- **Totem card:** name + status badge; ID chip, UDP tag and web badge; meta row (players at once, duration, queue, open screens — queue/screens turn Blue 700 when non-zero); for physical totems a recessed "Entrada do totem" block (QR thumbnail → enlarge dialog, "Copiar link", "Encerrar todas" when someone is playing); footer with secondary actions left and icon tools (edit, clear queue, delete) right.
- **Empty state:** a card with `jobson-with-cat`, a title, one sentence, and the primary action.

### Inputs / Fields
- **Style:** white fill, 1px Border Default, `--radius-md`, 9px/12px padding, 14px Poppins. Addresses and JSON use the mono face.
- **Focus:** Border Brand + `--shadow-focus` ring.
- **Errors:** a `db-callout--danger` at the end of the form body (icon + sentence naming the problem and the fix), and focus moves to the offending field.

### Feedback
- **Dialogs** are native `<dialog class="db-dialog">` (focus trap and Escape from the browser; backdrop click closes). Close/cancel buttons are `type="button" data-close` so Enter in a field never dismisses the form.
- **Confirm** (`db-dialog--confirm`): danger icon, a question title naming the object, one sentence of consequence, Cancel (focused) + danger action. Replaces SweetAlert2, which is gone.
- **Toast:** the DS card toast — white, 3px tone edge on the left, title + optional message, close button, bottom-right stack, 3.2s.

### Gamepad (signature component)
The gamepad is the product's signature surface and the one deliberate departure from the flat control-room language: circular face buttons rendered with a permanent skeuomorphic key-shadow (`0 5px 0 oklch(0.16 0.028 230 / 0.15)`) in the Xbox four-color palette, arranged in an ABXY cross. Pressing a button drops it 3px, compresses the shadow to `0 2px 0`, scales it to 0.87, and brightens it by 1.35× — a tactile, instant response tuned for thumbs, not cursors. The D-pad beside it stays in the neutral palette (Surface Slate cells, DreamBricks Blue border + glow only when pressed) so the four face buttons remain the only saturated, "arcade" moment on the entire play screen. This component is explicitly excluded from the DreamBricks brand migration — see the Xbox Quarantine Rule.

### Embed QR card (n→n)
Floats over an embedded game in a corner (`qrpos=br|bl|tr|tl`), sized in `vmin` so it scales with the iframe. Mark + "Jogue pelo celular" + QR (clickable, opens the entry in a new tab) + a mono status line ("2 vagas livres" in Success with a slow pulse, "3 na fila" in Warning). Collapses to an ink pill ("Jogar pelo celular") so it never has to cover the game. On touch screens the QR is hidden — nobody scans their own phone — and a "Jogar neste celular" button takes its place.

### Game frames (games/)
The games keep their own playfield art (Brick Rush tiles/minifigs/golden brick, Snake colors). Only the frame is DreamBricks: Brick Rush HUD and phase screens (`render.js` `FRAME`) use Poppins for words, IBM Plex Mono for numbers and ids, `--db-blue-300` for titles and ink-blue scrims instead of black; Snake's page chrome uses the mark, Poppins header in Ink, mono uppercase panel labels and a CSS status dot. No emoji in either.

### Player screens
Loading, queue, error and game-over share one composition: centered column, DreamBricks mark (or the waving J0Bson on error/end), a Poppins title in Ink, a short sub-line capped at ~30ch, and one large full-width primary action. The queue screen's whole point is the position number: IBM Plex Mono, `clamp(72px, 26vw, 120px)`, Ink, with a short bump animation each time it changes.

### Entrance motion
- **Reveal-in** (`animation: revealIn 0.5s cubic-bezier(0.16,1,0.3,1)`): the logo-mark entrance on loading/queue screens — an ease-out fade + scale from 0.5→1, not a bounce/elastic curve despite the visual energy. Named to avoid implying overshoot; the curve itself (`cubic-bezier(0.16,1,0.3,1)`) is a standard ease-out-quint.

## 7. Do's and Don'ts

### Do:
- **Do** keep the base UI light and quiet — Slate Background, Surface White cards with the DS `--shadow-sm`, 1px Border Slate dividers, an ink sidebar as the one dark surface.
- **Do** reserve IBM Plex Mono for live/system data (IDs, timers, statuses, panel titles) and Poppins for everything else.
- **Do** let DreamBricks Blue carry every primary action and focus state; introduce a second color only through the semantic Success/Danger/Warning set, never a new hue.
- **Do** confine the Xbox four-color palette to the gamepad's face buttons — it is the product's signature moment precisely because it doesn't appear anywhere else, and the one part of the UI the DreamBricks brand migration does not touch.
- **Do** tint every shadow with Ink (`oklch(0.16 0.028 230)`), matching the DreamBricks system's own shadow tokens — never pure black.
- **Do** grow depth only as a response (hover, toast, open dialog); the resting `--shadow-sm` is for cards alone.
- **Do** keep motion purposeful and quick (0.15–0.4s transitions, the 2s ambient pulse dot) — arcade energy shows up as responsiveness, not ornament.

### Don't:
- **Don't** build a gray, dense, enterprise-admin-panel screen — per PRODUCT.md, this should never read as generic SaaS.
- **Don't** reach for neon gradients, RGB glow, glitch effects, or a dark-mode-by-default theme — per PRODUCT.md, this should never read as gamer/cyberpunk aesthetic.
- **Don't** use `background-clip: text` gradients anywhere. Loading/hero titles render in solid DreamBricks Blue; emphasis comes from weight and size, not gradient fills.
- **Don't** add a resting shadow to anything that isn't a card, and never a zero-offset colored glow.
- **Don't** use emoji or Unicode glyphs as icons — the SVG sprite covers the dashboard; game frames use words and numbers.
- **Don't** reach for SweetAlert or `window.confirm`; use the confirm `db-dialog` and the DS toast.
- **Don't** introduce a second accent blue, a new gradient, or an off-palette status color — Success, Danger, Warning and the DreamBricks blue ramp are the complete semantic set.
- **Don't** let the Xbox button palette leak into dashboard badges, tabs, or any non-gamepad control.
- **Don't** reach for Fira Code or Fira Sans in new work — both fonts have been fully retired in favor of the DreamBricks IBM Plex Mono / Poppins pair.
