# 0007. One GHL Marketplace app and one Slack app, owned by Tyler

Date: 2026-10-21. Decided by Tyler.

**Decision.**
- **GHL** is one private Marketplace app, installed per offer by OAuth. It replaces pasted private tokens and polling, as the
  GHL Marketplace App Spec describes.
  - Every client is in its own agency, and a private app installs into at most 5 agencies. Hair, PMU and Dating use 3, so the
    6th client hits the cap.
  - The Security Review is built for from the start: a scope rationale now, the demo video once the first offer runs on the
    app.
  - Past the cap, an offer runs in token-and-polling mode behind the same port.
- **Slack** is one distributed, unlisted app, installed per workspace by OAuth and routed by workspace and channel, as the
  Platform Slack App Spec describes.
  - Slash commands are simple names with no prefix (`/mtd`, `/cash`).
- Tyler owns both apps.
