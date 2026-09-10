## DeepSeek Harness plugin development

Before changing plugin code, read https://dsh.pub/develop-plugin.md completely. Follow the pinned runtime contract and verification boundaries there; this repository's own security, testing, and release rules remain authoritative.

This package is a Host bundle (`dsh.bundle.patch` → `cordis.patch.yml`) with a zero-build ESM entry at `src/index.js`. The share FAB is injected through `webServer.tapIndex`, not `dsh.client`. Keep production dependencies at zero. Do not stack this gate with other dsh login plugins.
