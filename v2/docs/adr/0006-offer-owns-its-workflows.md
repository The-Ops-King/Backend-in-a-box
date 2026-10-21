# 0006. An offer owns its workflows; sales processes are presets used once

Date: 2026-10-21. From the blueprint and Tyler's rule "every offer is its own offer".

**Decision.**
- Each offer's workflow is complete and self-contained: every step, word, timing, channel and condition.
- A template, or a sales-process preset made of modules (setter + closer first), is used once, when an offer's workflows are
  created. After that the offer owns them.
- A later template change reaches an offer only as an explicit edit to that one workflow, shown as a diff and simulated
  before it is approved.
- Step semantics are versioned (`wait@1`), so code changes cannot alter a live workflow.
- CI replays every live workflow version's scenarios and fails the build on any undeclared behavior difference.

**Consequences.** Nothing reaches an offer silently, whether by install, by code default or in bulk. This replaces
copy-on-install and playbook copies rebuilt from templates (old D170).
