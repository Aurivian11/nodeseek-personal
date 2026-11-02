const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('package.json version must use the numeric major.minor.patch format');
}
const metadata = `// ==UserScript==
// @name         NodeSeek 个人版
// @namespace    local.nodeseek.personal
// @version      ${version}
// @description  只提供自动签到、用户资料卡和聊天式私信；本地配置，无远程依赖。
// @homepageURL  https://github.com/Aurivian11/nodeseek-personal
// @supportURL   https://github.com/Aurivian11/nodeseek-personal/issues
// @updateURL    https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.meta.js
// @downloadURL  https://raw.githubusercontent.com/Aurivian11/nodeseek-personal/main/dist/nodeseek-personal.user.js
// @match        https://www.nodeseek.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==
`;
const files = ['00-core.js', '15-profile-model.js', '18-profile-actions.js', '20-account.js', '25-badges.js', '28-inbox-entry.js', '30-messages.js', '90-main.js'];
const source = metadata + `\n(function () {\n'use strict';\nconst NSP_VERSION = ${JSON.stringify(version)};\n` + files.map(file => `\n// Source: ${file}\n` + fs.readFileSync(path.join(root, 'src', file), 'utf8')).join('\n') + '\n})();\n';
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist', 'nodeseek-personal.user.js'), source);
fs.writeFileSync(path.join(root, 'dist', 'nodeseek-personal.meta.js'), metadata);
console.log(`Built NodeSeek Personal ${version}: user.js (${Buffer.byteLength(source)} bytes), meta.js (${Buffer.byteLength(metadata)} bytes)`);
