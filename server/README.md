# NodeSeek 通知台（服务器组件）

普通 Google Chrome 在服务器上保持 NodeSeek 登录，Tampermonkey 中的私有桥接脚本读取通知，再由后台向你的 Telegram 发送私信、@我和主题回复提醒。支持文字摘要与链接、中文管理界面、远程桌面及推送日志。NodeSeek 页面需要保持打开；关闭管理后台或远程桌面网页不会关闭服务器 Chrome。

浏览器登录和安全验证由你手动完成。此组件不提供验证码绕过，也不保证站点始终允许访问。桥接脚本含部署专用配对密钥，必须在服务器生成，不能提交 GitHub、放到公开下载地址或分享。

## 环境与目录

适用于支持 systemd 的 Linux，例如 Debian 12。准备：

- Node.js **24，至少 24.15**，以及 npm；检查 `node --version`。
- 普通 Google Chrome、Tampermonkey 5.5.1 或更新版。
- `Xvfb`、`xauth`、`x11-utils`、`x11vnc`（需支持 `-unixsock`）、`openbox`、Debian `novnc`、中文字体（如 `fonts-noto-cjk`）。
- Caddy、nftables、Python 3，以及已指向服务器的域名。

从各软件的官方发行渠道安装依赖，不使用远程脚本直接执行安装。Debian 的 noVNC 静态资源应位于 `/usr/share/novnc`。Chrome 必须以非 root 用户运行，保留其沙箱；不要添加 `--no-sandbox`。

将仓库 **`server/` 的内容**部署到 `/opt/nodeseek-console`，代码由管理员持有且服务用户可读。在该目录运行：

```sh
sudo npm ci --ignore-scripts
```

样例使用 `/usr/bin/node`。如果 `command -v node` 返回不同路径，请同步修改 systemd 的 `ExecStart` 和下文命令，确保是 Node 24，而非系统遗留旧版本。

## 服务用户和配置

以下是首次部署示例；已有同名用户或目录时先核对，不重复创建：

```sh
sudo groupadd --system nodeseek-console
sudo useradd --system --gid nodeseek-console --home-dir /var/lib/nodeseek-console --create-home --shell /usr/sbin/nologin nodeseek-console
sudo useradd --system --gid nodeseek-console --home-dir /var/lib/nodeseek-desktop --create-home --shell /usr/sbin/nologin nodeseek-desktop
sudo install -d -o nodeseek-console -g nodeseek-console -m 0700 /var/lib/nodeseek-console
sudo install -d -o nodeseek-desktop -g nodeseek-console -m 0700 /var/lib/nodeseek-desktop
sudo install -d -m 0755 /etc/nodeseek-console
sudo install -m 0600 deploy/console.env.example /etc/nodeseek-console/console.env
```

编辑 `/etc/nodeseek-console/console.env`，将 `APP_ORIGIN` 改为你实际使用的 HTTPS 源，例如 `https://monitor.example.com`。它必须与访问后台的协议、域名和端口一致，不带页面路径。其余默认值：

```dotenv
APP_ORIGIN=https://monitor.example.com
SERVER_PORT=8767
DATA_DIR=/var/lib/nodeseek-console
MANUAL_DESKTOP=1
BROWSER_BRIDGE=1
```

`DATA_DIR` 存放管理认证、加密主密钥、桥接密钥、推送配置和监控状态。Chrome profile 单独保存在 `/var/lib/nodeseek-desktop/profile`。两个目录均为私有数据，不属于源码。备份时一并保护这些文件，尤其不要丢失加密主密钥。

首次初始化在交互终端执行：

```sh
sudo -u nodeseek-console env APP_ORIGIN=https://monitor.example.com DATA_DIR=/var/lib/nodeseek-console /usr/bin/node scripts/init.mjs
```

初始化脚本生成认证文件和密钥，仅在终端显示随机管理密码。妥善保存密码，不把该输出重定向到公开日志。已有部署不要覆盖数据目录。

## HTTPS 与服务

将 `deploy/Caddyfile.example` 的站点合并进你的 Caddy 配置，替换示例域名。Caddy 代理到 `127.0.0.1:8767`，自动处理 HTTPS 和 WebSocket。不要将后台端口直接暴露到公网。

配置好域名与证书所需网络后，验证配置并启用 Caddy；已有服务则重载配置：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
sudo systemctl reload caddy
```

```sh
sudo install -m 0644 deploy/nodeseek-console.service /etc/systemd/system/nodeseek-console.service
sudo install -m 0644 deploy/nodeseek-desktop.service /etc/systemd/system/nodeseek-desktop.service
sudo chmod 0755 /opt/nodeseek-console/deploy/start-desktop.sh
sudo install -d -m 0755 /etc/opt/chrome/policies/managed
sudo install -m 0644 deploy/chrome-policies.json /etc/opt/chrome/policies/managed/nodeseek-tampermonkey.json
sudo systemctl daemon-reload
```

先完成下面的网络隔离，再启用服务：

```sh
sudo systemctl enable --now nodeseek-console.service nodeseek-desktop.service
```

服务样例使用独立用户，Chrome 保留沙箱和持久 profile，桌面组内存上限为 **650M**，界面语言为 `LANGUAGE=zh_CN`。`LANG=C.UTF-8` 保留有效 UTF-8 环境，Chrome 自带中文界面资源，不需要为此生成系统中文 locale。X11 使用 Xauthority 和私有临时目录，不监听 TCP。

VNC 只监听 `/run/nodeseek-desktop/vnc.sock`：运行目录 `0750`，归属 `nodeseek-desktop:nodeseek-console`；socket 为 `0660`。后台通过该组访问 socket。**不开放 5900，不使用 socat 转发，不发布裸 VNC 服务。**远程桌面经后台登录、同源检查和 HTTPS WebSocket 访问。

## 网络隔离

允许公网出站，同时阻止两个服务用户新建到回环、内网或链路本地地址的连接。例外仅包括系统 DNS 解析器，以及桌面用户访问管理站点的 HTTPS 地址，以便私有桥接脚本联系后台。已建立连接的回包仍允许，保证 Caddy 到后台的请求可以正常响应。

`deploy/render-network-policy.py` **只生成规则，不执行 nftables**。它通过系统用户数据库获取两个服务的实际 UID，从 `APP_ORIGIN` 解析管理域名的 A/AAAA 地址和 HTTPS 端口，并读取 `/etc/resolv.conf` 的 DNS 地址；没有硬编码部署 UID 或服务器 IP。部署时以管理员身份执行并检查结果：

```sh
sudo install -d -m 0755 /etc/nftables.d
sudo env APP_ORIGIN=https://monitor.example.com python3 deploy/render-network-policy.py --output /etc/nftables.d/nodeseek-console.nft
sudo nft --check --file /etc/nftables.d/nodeseek-console.nft
sudo nft --file /etc/nftables.d/nodeseek-console.nft
```

将生成文件纳入现有 nftables 启动配置，确认重启后仍生效。此文件只替换自己的 `inet nodeseek_console` 表，不清空其他规则。域名解析、DNS 服务器或服务 UID 改变后，需要重新生成和检查。不要将生成文件提交仓库。

入站防火墙另行按现有运维方式保留必要的 SSH 管理入口及 HTTPS；使用 Caddy 自动证书时按其配置开放 HTTP 验证端口。不开放后台端口、VNC 端口或 X11 TCP 端口。上述出站规则不能替代入站防火墙。

## 连接 Chrome、安装桥接脚本

1. 访问 `https://monitor.example.com`，用初始化时显示的管理密码登录，点击“打开普通 Chrome”。远程桌面仅在点击连接后建立，按需手动登录 NodeSeek 并处理验证。
2. `deploy/chrome-policies.json` 使用官方 Tampermonkey 稳定版扩展 ID `dhdgffkkebhmkfjojejmpbldmpobfkfo`。若 Chrome 已运行，可在新标签打开 `chrome://policy` 并重新加载策略，无需重建 profile。检查 `chrome://extensions` 中扩展已安装。
3. Chrome 138 及更新版需要在 Tampermonkey 的扩展详情页启用 **Allow User Scripts / 允许用户脚本**。详情地址为 `chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo`。Tampermonkey 默认跟随浏览器界面语言。
4. 在服务器生成这次部署的私有脚本：

```sh
sudo -u nodeseek-console env APP_ORIGIN=https://monitor.example.com DATA_DIR=/var/lib/nodeseek-console /usr/bin/node scripts/render-bridge.mjs
sudo install -d -o nodeseek-desktop -g nodeseek-console -m 0700 /var/lib/nodeseek-desktop/imports
sudo install -o nodeseek-desktop -g nodeseek-console -m 0600 /var/lib/nodeseek-console/nodeseek-monitor-bridge.user.js /var/lib/nodeseek-desktop/imports/nodeseek-monitor-bridge.user.js
```

生成器要求 HTTPS `APP_ORIGIN`，默认输出 `$DATA_DIR/nodeseek-monitor-bridge.user.js`，权限 `0600`，也支持 `--output 路径`。复制到桌面用户私有目录是为了让 Chrome 文件选择器可读，不应放宽为公开文件。

5. 在服务器 Chrome 的 Tampermonkey 管理面板 → 实用工具 → 从文件导入，选择私有脚本。文件选择器关闭后，检查新开的安装确认标签并明确确认；回到脚本列表核对仅有一份桥接脚本。也可在已确认的新建脚本编辑器中本机粘贴并保存，避免把脚本内容经远程剪贴板传到其他机器。不要上传此文件、使用公开 URL 导入或通过云同步分享它。
6. 回到 NodeSeek 页面并刷新一次，保持该标签打开。在后台确认桥接已连接、账号正确，再填写 Telegram Bot Token、私人 Chat ID 和通知类型。先在 Telegram 中向你的机器人发送 `/start`，然后由你自行决定是否点击“发送测试”和“开始监控”。

首次开始会建立通知基线，后续检测新通知。“立即检查”只在监控运行时可用。Token 不回显到页面；此仓库不含你的 Token、管理密码、配对密钥或登录会话。

## 自动恢复的边界

恢复由服务器保留的监控意图决定：只有你已经开启监控、仍希望继续，且确认是**同一论坛账号**时，暂时的网络或桥接连接故障才会自动重试，退避从 **5 秒逐步增加到 300 秒**。页面显示恢复原因及下次尝试时间。等待连接或登录时仍可点击“暂停监控”，立即取消自动恢复意图。

以下情况不会自动重新启动或重发：手动暂停、账号变化、通知分页或数据结构异常、检查窗口出现缺口、Telegram 拒绝发送，以及发送结果 `UNKNOWN`。后台会保留阻塞原因，等待人工处理。`UNKNOWN` 必须先去 Telegram 核对，再明确选择“核对后恢复”；该操作跳过结果未确认的一条，避免重复发送。

遇到登录或安全验证页面时，需要手动完成。仅在监控意图仍开启、桥接重新确认同一账号后，才允许继续恢复。不要为恢复监控自动切换账号或绕过验证。恢复保证不等于历史通知无遗漏，遇到窗口缺口应先核对日志。

## 验证与维护

```sh
node --test test/*.test.js
sudo systemctl status nodeseek-console.service nodeseek-desktop.service
```

仓库测试使用模拟论坛响应、Telegram 请求、认证与桌面连接，不代表已经向真实 Telegram 发送过测试消息。生产端到端检查需要你在部署后自行完成。

更新前备份私有数据和 Chrome profile。将新源码放到相同安装目录，运行 `npm ci --ignore-scripts` 和测试，再按需重启后台服务；不要删除 profile。浏览器更新或语言变更若需重启，应优雅停止桌面服务，保留 profile 后再启动。不要将整个运行目录作为发布包上传。

公开仓库只应包含源码、测试、依赖锁文件及通用部署样例。排除 `DATA_DIR`、Chrome profile、生成的桥接脚本、真实 `.env`、证书、日志、截图、备份和生成的防火墙规则。

官方参考：[Tampermonkey 扩展版本](https://www.tampermonkey.net/faq.php?q=Q406)、[Chrome 用户脚本权限](https://developer.chrome.com/docs/extensions/reference/api/userScripts)、[Tampermonkey 安装脚本说明](https://www.tampermonkey.net/faq.php?q=Q102)。
