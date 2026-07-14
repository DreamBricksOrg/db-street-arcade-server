---
name: Street Arcade
description: Real-time arcade control system — operator dashboard and phone gamepad, built on control-room precision with arcade-color bursts.
colors:
  arcade-blue: "#3b82f6"
  arcade-blue-light: "#60a5fa"
  cta-orange: "#f97316"
  slate-bg: "#f8fafc"
  surface-white: "#ffffff"
  surface-slate: "#f1f5f9"
  border-slate: "#e2e8f0"
  ink: "#0f172a"
  ink-muted: "#64748b"
  success-emerald: "#10b981"
  success-emerald-deep: "#059669"
  danger-red: "#ef4444"
  danger-red-deep: "#dc2626"
  xbox-green: "#107c10"
  xbox-red: "#e23c28"
  xbox-blue: "#0078d4"
  xbox-yellow: "#ffb900"
typography:
  hero:
    fontFamily: "'Fira Code', monospace"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "normal"
  display:
    fontFamily: "'Fira Code', monospace"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.5px"
  subtitle:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  headline:
    fontFamily: "'Fira Code', monospace"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  caption:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.5px"
    textTransform: "uppercase"
  mono-label:
    fontFamily: "'Fira Code', monospace"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "1px"
    textTransform: "uppercase"
  micro:
    fontFamily: "'Fira Sans', sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
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
    backgroundColor: "{colors.arcade-blue}"
    textColor: "#ffffff"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "13px 18px"
  button-primary-hover:
    backgroundColor: "{colors.arcade-blue}"
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
    rounded: "{rounded.lg}"
    padding: "11px 14px"
  card:
    backgroundColor: "{colors.surface-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px"
  badge-status:
    backgroundColor: "{colors.success-emerald}"
    textColor: "{colors.success-emerald}"
    rounded: "{rounded.pill}"
    padding: "4px 12px"
---

# Design System: Street Arcade

## 1. Overview

**Creative North Star: "The Control Room"**

Street Arcade reads like an instrument panel wearing arcade colors. The base layer — layout, type, borders, status indicators — is control-room precision: light slate surfaces, thin 1px borders, monospace labels for anything that is data (IDs, timers, status codes), and a single confident accent (Arcade Blue) doing all the "this is interactive" signaling. The playful half of the brand doesn't come from decoration; it comes from the Xbox-style button palette on the gamepad and the pulsing live dot in the operator header. Reliable first, playful second, exactly as PRODUCT.md states.

This system explicitly rejects both of PRODUCT.md's anti-references: it is not a gray enterprise SaaS panel (hence the Fira Code data-texture, the colored session badges, the arcade-controller color story), and it is not neon/cyberpunk gamer aesthetic (no RGB gradients, no glitch effects, no dark-mode-by-default — the base UI stays light and clean, and saturated color is spent deliberately on the few places it earns its keep: buttons, badges, the four gamepad face buttons).

**Key Characteristics:**
- Light slate base (`#f8fafc`) with white surface cards, never dark-mode-by-default
- One accent color (Arcade Blue) carrying all primary CTAs, focus states, and active-tab indicators
- Fira Code reserved for anything that reads as data or a system label; Fira Sans for everything conversational
- Flat surfaces at rest; shadows and glow appear only as a response to hover, focus, or an open modal
- Saturated color bursts are scoped tightly: session status badges, the Xbox-palette gamepad buttons, the pulsing "live" dot — never the base chrome

## 2. Colors

Mostly neutral slate with one confident accent; saturated color is reserved for status and the gamepad's four action buttons.

### Primary
- **Arcade Blue** (`#3b82f6`): the one accent. Primary buttons, focus rings, active tab underline, links, and solid-color loading-screen titles.
- **Arcade Blue Light** (`#60a5fa`): secondary tint used in the loader-bar fill gradient and hover states. Never carries text.

### Secondary
- **CTA Orange** (`#f97316`): reserved as the `--cta` token for a secondary call-to-action distinct from the primary blue action. Currently declared but sparingly used — treat as the fallback accent when a screen needs a second, non-competing action color.

### Neutral
- **Slate Background** (`#f8fafc`): the page background across every screen — dashboard, queue, gamepad.
- **Surface White** (`#ffffff`): cards, headers, modals, the QR panel.
- **Surface Slate** (`#f1f5f9`): recessed surfaces — input fields, totem-card backgrounds, tab hover states, secondary buttons.
- **Border Slate** (`#e2e8f0`): the only border color in the system, at 1px, everywhere a divider or outline is needed.
- **Ink** (`#0f172a`): primary text and headings.
- **Ink Muted** (`#64748b`): secondary text, labels, placeholders, meta text.

### Status colors
- **Success Emerald** (`#10b981` dashboard / `#059669` player screens): live badges, connected status dots, the "playing" queue row tint. Two close shades are in active use — treat `#10b981` as canonical for new work, `#059669` as an accepted variant on player-facing screens.
- **Danger Red** (`#ef4444` dashboard / `#dc2626` player screens): kick/delete actions, error banners, disconnected state. Same dual-shade pattern as Success.

### Gamepad palette (signature, scoped to `#gamepad`)
- **Xbox Green** (`#107c10`), **Xbox Red** (`#e23c28`), **Xbox Blue** (`#0078d4`), **Xbox Yellow** (`#ffb900`): the four face-button colors (A/B/X/Y). This is the one place in the system where a named, saturated, multi-color palette is not only allowed but the point — it's the arcade-controller reference the whole product is built around. Confined strictly to the four face buttons; never bleed into dashboard or status UI.

### Named Rules
**The One Accent Rule.** Arcade Blue is the only color allowed to mean "primary action" or "focused/active." If a second action needs color, it borrows CTA Orange — never a second blue, never a gradient invented on the spot.

**The Xbox Quarantine Rule.** The Xbox four-color palette exists only inside the gamepad's face buttons. It never appears on a badge, a button in the dashboard, or a status indicator — those stay inside Arcade Blue, Success, and Danger.

## 3. Typography

**Display Font:** 'Fira Code', monospace (with system monospace fallback)
**Body Font:** 'Fira Sans', sans-serif
**Label/Mono Font:** 'Fira Code', monospace (same family as Display, used at smaller sizes for meta labels)

**Character:** A single contrast pair rather than two families: Fira Sans carries every sentence a human reads, Fira Code marks anything that is system state — IDs, timers, panel titles, uppercase labels. The pairing itself is the "control room" read; switching fonts mid-UI is how the system tells you "this is a live value, not prose."

### Hierarchy

The system runs a fuller integer-px micro-scale than a strict 6-step ramp — deliberate, not drift: compact status/meta UI (badges, chips, device labels) needs finer steps than page-level headings do. Named roles below cover primary content; the Micro-scale row documents the smaller, equally-real steps used throughout the compact chrome.

- **Hero** (700, 26px, 1.1 line-height, Fira Code): The single largest text in the system — `play.html`'s in-game loading title only.
- **Display** (700, 24px, 1.1, Fira Code, -0.5px tracking): Loading-screen titles and hero panel titles ("Street Arcade", "Fila de Espera"), rendered in solid Arcade Blue.
- **Subtitle** (700, 20-22px, 1.2, Fira Sans or Fira Code): Sessions-header `<h2>`, error-screen titles.
- **Headline** (700, 18px, 1.2, Fira Code): Modal titles, section headers ("Sessões Ativas" secondary heads).
- **Title** (700, 14px, 1.3, Fira Sans): Card titles, totem names, button labels.
- **Body** (400, 15px, 1.5, Fira Sans): Form inputs, descriptions, hint text. Cap prose blocks at ~65–75ch even though most surfaces here are short-form.
- **Caption** (400-600, 13px, 1.4, Fira Sans): Secondary descriptive text — QR captions, form hints, session meta.
- **Label** (700, 12px, 1.3, Fira Sans, 0.5px tracking, uppercase): Field labels, tab labels.
- **Mono Label** (700, 11px, 1.3, Fira Code, 1px tracking, uppercase): Panel titles, queue headers, status-badge text.
- **Micro** (500-700, 10px, 1.3, Fira Sans or Fira Code): The floor of the scale — queue-row device meta, ETA text, timestamp chips. Never used for anything a user must read at a glance from a distance; always paired with an icon or adjacent larger text for context.

Icon-scale exceptions (64px empty-state icons, gamepad glyphs at `clamp()` sizes tuned to touch-target geometry) sit outside this ramp by design — they size to their container, not to a reading hierarchy.

### Named Rules
**The Data-Is-Mono Rule.** Any value that represents live or identifying system state — session IDs, player IDs, timers, IPs, ports, queue positions — renders in Fira Code, regardless of its surrounding context. If it's a fact about the system, it's mono; if it's a sentence to a human, it's Fira Sans.

## 4. Elevation

Flat-by-default, glow-on-response. Every surface sits flush against the page at rest — cards, headers, and tab bars use a 1px Border Slate line, not a shadow, to separate themselves from the background. Shadow and glow exist only as a reaction to state: a card lifts with a shadow when a modal opens over it, a primary button gains an Arcade Blue glow on hover, and a QR card slides up with a shadow as it animates into view. Depth is never used to imply static hierarchy — it always means "something just changed here."

### Shadow Vocabulary
- **Hover Glow** (`box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4)`): appears on `.btn-primary:hover` — a response to the pointer being on an actionable element, not a resting state.
- **Card Lift** (`box-shadow: 0 10px 40px rgba(0,0,0,0.1)`): used on the QR card and similar single-focus panels as they animate into view (`slideUp`).
- **Modal Lift** (`box-shadow: 0 16px 64px rgba(0,0,0,0.4)`): the heaviest shadow in the system, reserved for `.modal-content` sitting over the dimmed/blurred overlay — the one moment depth is meant to feel dramatic.
- **Gamepad Button Press** (`box-shadow: 0 5px 0 rgba(0,0,0,0.15)` at rest, `0 2px 0` when pressed): a skeuomorphic key-press shadow unique to the face buttons — depth here simulates a physical button, not a UI card.

### Named Rules
**The Flat-Until-Touched Rule.** Nothing in the system has a resting shadow except the gamepad's face buttons (which are simulating physical keys, not UI chrome). If you're adding a shadow to something that isn't hovered, focused, pressed, or animating in, remove it.

## 5. Components

### Buttons
- **Shape:** 8px radius (`--radius`) on primary/secondary buttons; fully round (999px) on icon chips and pills.
- **Primary:** Arcade Blue background, white text, 13px/18px padding, 700-weight Fira Sans label. Resting shadow: none. Hover: lifts 2px and gains the Hover Glow. Disabled: 0.4 opacity, no transform.
- **Secondary:** Surface Slate background, Ink Muted text, 1px Border Slate outline, smaller 9px/14px padding and 13px type. Hover fills to Border Slate and darkens text to Ink.
- **Icon buttons** (`.btn-icon`, `.btn-edit`, `.btn-delete`, `.btn-qr`): Surface White background, 1px border, compact 5px/10px padding, hover state recolors border+text to the semantic color (Arcade Blue for edit/QR, Danger Red for delete) with a matching tinted background wash.

### Chips / Badges
- **Style:** fully round (999px), 11px uppercase Fira Code or Fira Sans depending on context, thin tinted border matching the semantic color at ~20–30% opacity, background tint at ~8–12% opacity of the same color.
- **State variants:** `badge-active`/`badge-loading`/`badge-inactive` on session cards; `status-waiting`/`status-active`/`status-finished` on the QR panel; `queue-status` on queue rows. All follow the same tint-background + tint-border + solid-text formula, just swapping the semantic color (Success, Danger, or Ink Muted for neutral/waiting states).

### Cards / Containers
- **Corner Style:** 8px radius, matching buttons.
- **Background:** Surface White on Slate Background page, or Surface Slate for nested/recessed elements (totem cards inside the list).
- **Shadow Strategy:** none at rest; see Elevation. `.totem-card` and `.session-card` gain a border-color shift and, for session cards, a 2px lift on hover — motion communicates interactivity instead of shadow.
- **Border:** 1px Border Slate, always.
- **Internal Padding:** 20px for content cards (`.session-card`), 12–14px for compact list items (`.totem-card`).

### Inputs / Fields
- **Style:** Surface Slate background, 1px Border Slate outline, 10–12px radius (slightly rounder than buttons/cards), 11px/14px padding, Fira Sans body type.
- **Focus:** border shifts to Arcade Blue plus a 2px soft blue ring (`box-shadow: 0 0 0 2px rgba(59,130,246,0.18)`) — no glow, a ring, keeping focus distinct from the hover-glow vocabulary used on buttons.
- **Placeholder:** Ink Muted at 0.7 opacity.

### Navigation
- **Tab Nav:** two-column grid, uppercase 13px/700 Fira Sans labels, transparent background at rest, Surface Slate on hover. Active tab gets Arcade Blue text, a 2px Arcade Blue underline, and a faint 4%-opacity blue background wash — no pill, no icon-only compression.
- **Header:** Surface White bar, 1px bottom border, logo left / live-status pulse right. The pulsing dot (`.dot-pulse`, 2s ease-in-out scale+opacity loop) is the one ambient animation allowed to run at rest — it's a live-status signal, not decoration.

### Gamepad (signature component)
The gamepad is the product's signature surface and the one deliberate departure from the flat control-room language: circular face buttons rendered with a permanent skeuomorphic key-shadow (`0 5px 0 rgba(0,0,0,0.15)`) in the Xbox four-color palette, arranged in an ABXY cross. Pressing a button drops it 3px, compresses the shadow to `0 2px 0`, scales it to 0.87, and brightens it by 1.35× — a tactile, instant response tuned for thumbs, not cursors. The D-pad beside it stays in the neutral palette (Surface Slate cells, Arcade Blue border + glow only when pressed) so the four face buttons remain the only saturated, "arcade" moment on the entire play screen.

## 6. Do's and Don'ts

### Do:
- **Do** keep the base UI light and flat — Slate Background, Surface White cards, 1px Border Slate dividers, no shadow at rest.
- **Do** reserve Fira Code for live/system data (IDs, timers, statuses, panel titles) and Fira Sans for everything else.
- **Do** let Arcade Blue carry every primary action and focus state; introduce a second color only through the semantic Success/Danger pair or CTA Orange, never a new blue.
- **Do** confine the Xbox four-color palette to the gamepad's face buttons — it is the product's signature moment precisely because it doesn't appear anywhere else.
- **Do** use shadow and glow only as a response to interaction (hover, focus, press, modal-open) — never as static decoration.
- **Do** keep motion purposeful and quick (0.15–0.4s transitions, the 2s ambient pulse dot) — arcade energy shows up as responsiveness, not ornament.

### Don't:
- **Don't** build a gray, dense, enterprise-admin-panel screen — per PRODUCT.md, this should never read as generic SaaS.
- **Don't** reach for neon gradients, RGB glow, glitch effects, or a dark-mode-by-default theme — per PRODUCT.md, this should never read as gamer/cyberpunk aesthetic.
- **Don't** use `background-clip: text` gradients anywhere. Loading/hero titles render in solid Arcade Blue; emphasis comes from weight and size, not gradient fills.
- **Don't** add a resting shadow to a card, button, or badge that isn't hovered, focused, pressed, or animating in.
- **Don't** introduce a second accent blue, a new gradient, or an off-palette status color — Success, Danger, Arcade Blue, and CTA Orange are the complete semantic set.
- **Don't** let the Xbox button palette leak into dashboard badges, tabs, or any non-gamepad control.
