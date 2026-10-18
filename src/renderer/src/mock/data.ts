// Placeholder dev data. Findings (Phase A) and scope (Phase B) are now real —
// served by the main process over IPC. This file shrinks to whatever still has
// no real source; today that's only the egress proxy (Phase C), which has no
// runtime status surface yet.

// placeholder until the proxy status surface exists
export const proxy = { label: ':8080', address: '127.0.0.1:8080' }
