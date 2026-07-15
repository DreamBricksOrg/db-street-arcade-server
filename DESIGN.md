---
name: Street Arcade
description: Real-time arcade control system — operator dashboard and phone gamepad, built on the DreamBricks Design System with arcade-color bursts.
colors:
  db-blue: "#42b0d5"
  db-blue-light: "#52cdef"
  db-blue-ink: "#034a5d"
  cta-orange: "#f97316"
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
    backgroundColor: "{colors.db-blue}"
    textColor: "#ffffff"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
  button-primary-hover:
    backgroundColor: "{colors.db-blue}"
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
    rounded: "{rounded.md}"
    padding: "20px"
  badge-status:
    backgroundColor: "{colors.success}"
    textColor: "{colors.success}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design System: Street Arcade

## 1. Overview

**Creative North Star: "The Control Room, on DreamBricks Blue"**

Street Arcade is built on the **DreamBricks Design System** — DreamBricks' own brand tokens (`/design-system/dreambricks-manager/DreamBricks-Design-System`) — merged with the arcade-specific signature this product depends on: monospace labels for anything that is live system data (IDs, timers, status codes), and the Xbox-style ABXY button palette on the gamepad. The base layer reads like an instrument panel wearing the DreamBricks brand: light, blue-tinted slate surfaces, thin 1px borders, and a single confident accent (DreamBricks Blue) doing all the "this is interactive" signaling. The playful half of the brand doesn't come from decoration; it comes from the Xbox-style button palette on the gamepad and the pulsing live dot in the operator header. Reliable first, playful second, exactly as PRODUCT.md states.

This system explicitly rejects both of PRODUCT.md's anti-references: it is not a gray enterprise SaaS panel (hence the IBM Plex Mono data-texture, the colored session badges, the arcade-controller color story), and it is not neon/cyberpunk gamer aesthetic (no RGB gradients, no glitch effects, no dark-mode-by-default — the base UI stays light and clean, and saturated color is spent deliberately on the few places it earns its keep: buttons, badges, the four gamepad face buttons).

**Merge rationale.** The DreamBricks brandbook is a generic "project dashboard" brand — a tight blue-only palette with no gamepad, real-time-queue, or mobile-controller guidance of its own (see the design system's own `readme.md`). Street Arcade adopts its color/type/radius tokens wholesale for the base chrome (this *is* the DreamBricks product family now), but keeps two elements the DreamBricks system has no answer for and PRODUCT.md treats as essential: the **Xbox gamepad palette** (the product's one signature, quarantined moment) and the **mono-for-live-data rule** (now carried by DreamBricks' own IBM Plex Mono token rather than Fira Code).

**Key Characteristics:**
- Light, blue-tinted slate base (`oklch(0.97 0.006 230)`) with white surface cards, never dark-mode-by-default
- One accent color (DreamBricks Blue `#42b0d5`) carrying all primary CTAs, focus states, and active-tab indicators
- IBM Plex Mono reserved for anything that reads as data or a system label; Poppins for everything conversational
- Flat surfaces at rest; shadows and glow appear only as a response to hover, focus, or an open modal — tinted with the brand's own deep ink blue, never pure black
- Saturated color bursts are scoped tightly: session status badges, the Xbox-palette gamepad buttons, the pulsing "live" dot — never the base chrome

## 2. Colors

Mostly neutral, blue-tinted slate with one confident accent; saturated color is reserved for status and the gamepad's four action buttons.

### Primary
- **DreamBricks Blue** (`#42b0d5`): the one accent. Primary buttons, focus rings, active tab underline, links, and solid-color loading-screen titles.
- **DreamBricks Blue Light** (`#52cdef`): secondary tint used in the loader-bar fill gradient and hover states. Never carries text.
- **DreamBricks Ink** (`#034a5d`): the brand's deepest blue. Reserved for high-emphasis moments that need more weight than the primary accent (not yet in active use in the shipped UI — available for a future "strong" CTA state).

### Secondary
- **CTA Orange** (`#f97316`): reserved as the `--cta` token for a secondary call-to-action distinct from the primary blue action. Not part of the DreamBricks brandbook (which is blue-only) — an intentional Street Arcade addition, kept because it doesn't compete with DreamBricks Blue and the brandbook itself defines no secondary-action color. Currently declared but sparingly used.

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
**The One Accent Rule.** DreamBricks Blue is the only color allowed to mean "primary action" or "focused/active." If a second action needs color, it borrows CTA Orange — never a second blue, never a gradient invented on the spot.

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

Flat-by-default, glow-on-response. Every surface sits flush against the page at rest — cards, headers, and tab bars use a 1px Border Slate line, not a shadow, to separate themselves from the background. Shadow and glow exist only as a reaction to state: a card lifts with a shadow when a modal opens over it, a primary button gains a DreamBricks Blue glow on hover, and a QR card slides up with a shadow as it animates into view. Depth is never used to imply static hierarchy — it always means "something just changed here." Following the DreamBricks system's own shadow tokens, every shadow in this system is tinted with Ink (`oklch(0.16 0.028 230)`), never pure black.

### Shadow Vocabulary
- **Hover Glow** (`box-shadow: 0 4px 14px oklch(from var(--accent) l c h / 0.4)`): appears on `.btn-primary:hover` — a response to the pointer being on an actionable element, not a resting state.
- **Card Lift** (`box-shadow: 0 10px 40px oklch(0.16 0.028 230 / 0.1)`): used on the QR card and similar single-focus panels as they animate into view (`revealIn`).
- **Modal Lift** (`box-shadow: 0 16px 64px oklch(0.16 0.028 230 / 0.4)`): the heaviest shadow in the system, reserved for `.modal-content` sitting over the dimmed/blurred overlay — the one moment depth is meant to feel dramatic.
- **Gamepad Button Press** (`box-shadow: 0 5px 0 oklch(0.16 0.028 230 / 0.15)` at rest, `0 2px 0` when pressed): a skeuomorphic key-press shadow unique to the face buttons — depth here simulates a physical button, not a UI card.

### Named Rules
**The Flat-Until-Touched Rule.** Nothing in the system has a resting shadow except the gamepad's face buttons (which are simulating physical keys, not UI chrome). If you're adding a shadow to something that isn't hovered, focused, pressed, or animating in, remove it.

## 5. Radius scale

Adopted directly from the DreamBricks Design System (`tokens/spacing.css`) — generous, consistent rounding, echoing the brandbook's own soft logo-plate corners:
- `sm`: 6px — small chips (e.g. `.totem-id-chip`)
- `md`: 10px — default for buttons, inputs, cards (`--radius`)
- `lg`: 16px — larger single-focus panels (QR image, modal corner treatments where a bigger radius reads better)
- `xl`: 24px — reserved for large marketing-scale surfaces, not yet used in the shipped product UI
- `pill`: 999px — badges, chips, pills

## 6. Components

### Buttons
- **Shape:** 10px radius (`--radius`, DreamBricks `md`) on primary/secondary buttons; fully round (999px) on icon chips and pills.
- **Primary:** DreamBricks Blue background, white text, 13px/18px padding, 700-weight Poppins label. Resting shadow: none. Hover: lifts 2px and gains the Hover Glow. Disabled: 0.4 opacity, no transform.
- **Secondary:** Surface Slate background, Ink Muted text, 1px Border Slate outline, smaller 9px/14px padding and 13px type. Hover fills to Border Slate and darkens text to Ink.
- **Icon buttons** (`.btn-icon`, `.btn-edit`, `.btn-delete`, `.btn-qr`): Surface White background, 1px border, compact 5px/10px padding, hover state recolors border+text to the semantic color (DreamBricks Blue for edit/QR, Danger for delete) with a matching tinted background wash.

### Chips / Badges
- **Style:** fully round (999px), 11px uppercase IBM Plex Mono or Poppins depending on context, thin tinted border matching the semantic color at ~20–30% opacity, background tint at ~8–12% opacity of the same color.
- **State variants:** `badge-active`/`badge-loading`/`badge-inactive` on session cards; `status-waiting`/`status-active`/`status-finished` on the QR panel; `queue-status` on queue rows. All follow the same tint-background + tint-border + solid-text formula, just swapping the semantic color (Success, Danger, Warning, or Ink Muted for neutral states).

### Cards / Containers
- **Corner Style:** 10px radius, matching buttons.
- **Background:** Surface White on Slate Background page, or Surface Slate for nested/recessed elements (totem cards inside the list).
- **Shadow Strategy:** none at rest; see Elevation. `.totem-card` and `.session-card` gain a border-color shift and, for session cards, a 2px lift on hover — motion communicates interactivity instead of shadow.
- **Border:** 1px Border Slate, always.
- **Internal Padding:** 20px for content cards (`.session-card`), 12–14px for compact list items (`.totem-card`).

### Inputs / Fields
- **Style:** Surface Slate background, 1px Border Slate outline, 10px radius, 11px/14px padding, Poppins body type.
- **Focus:** border shifts to DreamBricks Blue plus a 2px soft blue ring (`box-shadow: 0 0 0 2px oklch(from var(--accent) l c h / 0.18)`) — no glow, a ring, keeping focus distinct from the hover-glow vocabulary used on buttons.
- **Placeholder:** Ink Muted at 0.7 opacity.

### Navigation
- **Tab Nav:** two-column grid, uppercase 13px/700 Poppins labels, transparent background at rest, Surface Slate on hover. Active tab gets DreamBricks Blue text, a 2px DreamBricks Blue underline, and a faint 4%-opacity blue background wash — no pill, no icon-only compression.
- **Header:** Surface White bar, 1px bottom border, logo left / live-status pulse right. The pulsing dot (`.dot-pulse`, 2s ease-in-out scale+opacity loop) is the one ambient animation allowed to run at rest — it's a live-status signal, not decoration.

### Gamepad (signature component)
The gamepad is the product's signature surface and the one deliberate departure from the flat control-room language: circular face buttons rendered with a permanent skeuomorphic key-shadow (`0 5px 0 oklch(0.16 0.028 230 / 0.15)`) in the Xbox four-color palette, arranged in an ABXY cross. Pressing a button drops it 3px, compresses the shadow to `0 2px 0`, scales it to 0.87, and brightens it by 1.35× — a tactile, instant response tuned for thumbs, not cursors. The D-pad beside it stays in the neutral palette (Surface Slate cells, DreamBricks Blue border + glow only when pressed) so the four face buttons remain the only saturated, "arcade" moment on the entire play screen. This component is explicitly excluded from the DreamBricks brand migration — see the Xbox Quarantine Rule.

### Entrance motion
- **Reveal-in** (`animation: revealIn 0.5s cubic-bezier(0.16,1,0.3,1)`): the logo-mark entrance on loading/queue screens — an ease-out fade + scale from 0.5→1, not a bounce/elastic curve despite the visual energy. Named to avoid implying overshoot; the curve itself (`cubic-bezier(0.16,1,0.3,1)`) is a standard ease-out-quint.

## 7. Do's and Don'ts

### Do:
- **Do** keep the base UI light and flat — Slate Background, Surface White cards, 1px Border Slate dividers, no shadow at rest.
- **Do** reserve IBM Plex Mono for live/system data (IDs, timers, statuses, panel titles) and Poppins for everything else.
- **Do** let DreamBricks Blue carry every primary action and focus state; introduce a second color only through the semantic Success/Danger/Warning set or CTA Orange, never a new blue.
- **Do** confine the Xbox four-color palette to the gamepad's face buttons — it is the product's signature moment precisely because it doesn't appear anywhere else, and the one part of the UI the DreamBricks brand migration does not touch.
- **Do** tint every shadow with Ink (`oklch(0.16 0.028 230)`), matching the DreamBricks system's own shadow tokens — never pure black.
- **Do** use shadow and glow only as a response to interaction (hover, focus, press, modal-open) — never as static decoration.
- **Do** keep motion purposeful and quick (0.15–0.4s transitions, the 2s ambient pulse dot) — arcade energy shows up as responsiveness, not ornament.

### Don't:
- **Don't** build a gray, dense, enterprise-admin-panel screen — per PRODUCT.md, this should never read as generic SaaS.
- **Don't** reach for neon gradients, RGB glow, glitch effects, or a dark-mode-by-default theme — per PRODUCT.md, this should never read as gamer/cyberpunk aesthetic.
- **Don't** use `background-clip: text` gradients anywhere. Loading/hero titles render in solid DreamBricks Blue; emphasis comes from weight and size, not gradient fills.
- **Don't** add a resting shadow to a card, button, or badge that isn't hovered, focused, pressed, or animating in.
- **Don't** introduce a second accent blue, a new gradient, or an off-palette status color — Success, Danger, Warning, DreamBricks Blue, and CTA Orange are the complete semantic set.
- **Don't** let the Xbox button palette leak into dashboard badges, tabs, or any non-gamepad control.
- **Don't** reach for Fira Code or Fira Sans in new work — both fonts have been fully retired in favor of the DreamBricks IBM Plex Mono / Poppins pair.
