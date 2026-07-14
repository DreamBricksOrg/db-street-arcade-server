# Product

## Register

product

## Platform

web

## Users

Two distinct groups on the same real-time system. **Operators** are venue staff running the physical arcade cabinets — they register totems, watch live sessions and queues, and step in fast when a totem stalls or a player needs to be kicked. They work from a desktop/tablet dashboard and need state to be legible at a glance under event pressure. **Players** are arcade visitors who scan a QR code on a cabinet, wait in a live queue if the totem is busy, then use their own phone as a game controller. They're on mobile, often standing, sometimes in a queue of strangers, and need the path from scan to play to have zero friction or confusion.

## Product Purpose

Street Arcade turns a visitor's own phone into a real-time controller for a physical arcade cabinet, with no app install and no extra hardware — just a QR scan. It exists to let a DreamBricks installation serve a crowd fairly through live queueing, while giving venue staff the operational control to keep cabinets running. Success means both sides work under load: players move from scan to play without dead time or confusion, and operators can see and fix problems the instant they appear.

## Positioning

Any visitor's phone becomes a real-time controller for a physical arcade cabinet — no app install, no extra hardware, just a scan.

## Brand Personality

Fast, reliable, playful. Arcade energy comes through in motion and moments of delight, not in loud visual noise — the system's job is to feel dependable and quick first, fun second. The existing monospace/blue-accent technical texture (Fira Code for data, Fira Sans for UI) already carries the "reliable" half well; personality should show up more in interaction (queue movement, connection states, controller feedback) than in ornamentation.

## Anti-references

Not a generic enterprise/SaaS dashboard — avoid bland gray admin-panel monotony; this is an arcade, it should have some life in it. Not gamer/neon-cyberpunk either — no RGB gradients, glitch effects, or loud gamer-aesthetic cliches. Stay in the clean, playful middle the current UI already occupies: light surfaces, one confident accent color, technical precision without decoration for its own sake.

## Design Principles

- **Real-time state must be legible instantly** — operators and players both act on live state (queue position, session status, connection health); never let stale or ambiguous UI cost someone a turn or a recovery window.
- **Zero friction from scan to play** — every extra tap, load spinner, or unclear screen in the player flow is a cost paid by someone standing in a queue; default to removing steps over adding polish.
- **Reliable first, playful second** — motion and personality should reinforce that the system works (state changes, confirmations, queue movement), not decorate a system that might not.
- **One accent, used with intent** — the existing blue accent plus monospace data touches is the brand's visual signature; new UI should extend it, not compete with it.
- **Design for the room, not the desk** — player-facing surfaces are used one-handed, standing, in variable event lighting; assume less-than-ideal conditions as the default case, not the edge case.

## Accessibility & Inclusion

No formal WCAG level mandated. Use good judgment: maintain solid contrast and comfortably sized touch targets given players use this standing, one-handed, in variable venue lighting.
