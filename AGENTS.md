# NodeSeek personal userscript

Canonical repository: https://github.com/Aurivian11/nodeseek-personal

Keep scope to random attendance, profile enhancements and private messages. Preserve the script name and namespace so updates replace the installed script.

When releasing an update, bump package.json version, synchronize package-lock.json, run the build and offline tests, and commit both fixed dist artifacts with the source. Prefer a tested branch before merging main. The userscript manager reads the fixed raw GitHub URLs in build.cjs; do not introduce another update host or new permissions without a task need.

Use Node 24 (at least 24.15.0):

```
npm ci --ignore-scripts --no-audit --no-fund
npm run build
npm test
```

Never commit user cookies, private messages, settings, notes, real-page screenshots, node_modules, or old versioned artifacts. Use only synthetic data in tests and previews. Test forum writes with mocks; do not send real private messages as a test.
