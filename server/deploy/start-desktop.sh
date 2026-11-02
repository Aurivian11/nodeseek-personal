#!/bin/sh
set -eu
umask 077
export DISPLAY=:91
export XAUTHORITY=/run/nodeseek-desktop/Xauthority
export XDG_CONFIG_HOME=/var/lib/nodeseek-desktop/config
export XDG_CACHE_HOME=/var/lib/nodeseek-desktop/cache
export XDG_RUNTIME_DIR=/run/nodeseek-desktop
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
touch "$XAUTHORITY"
xauth -f "$XAUTHORITY" add "$DISPLAY" . "$(mcookie)"
Xvfb "$DISPLAY" -screen 0 1100x760x24 -nolisten tcp -auth "$XAUTHORITY" &
xpid=$!
trap 'kill "$xpid" 2>/dev/null || true' EXIT TERM INT
n=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
 n=$((n+1)); [ "$n" -lt 40 ] || exit 1
 sleep 0.25
done
openbox >/dev/null 2>&1 &
google-chrome-stable --user-data-dir=/var/lib/nodeseek-desktop/profile --no-first-run --no-default-browser-check --disable-dev-shm-usage --window-size=1100,760 --start-maximized --restore-last-session >/dev/null 2>&1 &
chrome_pid=$!
x11vnc -display "$DISPLAY" -auth "$XAUTHORITY" -unixsock /run/nodeseek-desktop/vnc.sock -rfbport 0 -rfbportv6 0 -noipv6 -noipv4 -forever -shared -nopw -noxdamage -nolookup -logfile /var/lib/nodeseek-desktop/vnc.log >/dev/null 2>&1 &
vnc_pid=$!
n=0
until [ -S /run/nodeseek-desktop/vnc.sock ]; do
 n=$((n+1)); [ "$n" -lt 40 ] || exit 1
 sleep 0.25
done
chmod 0660 /run/nodeseek-desktop/vnc.sock
while kill -0 "$chrome_pid" 2>/dev/null && kill -0 "$vnc_pid" 2>/dev/null; do sleep 5; done
exit 1
