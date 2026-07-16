#!/bin/bash
# launch-nested.sh — start a nested devkit GNOME Shell and enable the extension,
# all inside one private D-Bus session (so gnome-extensions enable targets it).
# Run as:  dbus-run-session bash launch-nested.sh
UUID="ai-usage-monitor@ahati"

echo "[launch] starting nested gnome-shell (devkit/wayland)…"
gnome-shell --devkit --wayland &
SHELL_PID=$!

# Wait for the Extensions D-Bus interface to appear (shell to be ready).
ready=0
for i in $(seq 1 40); do
    if gnome-extensions list 2>/dev/null | grep -q "$UUID"; then
        ready=1
        echo "[launch] shell ready after ${i}s"
        break
    fi
    sleep 1
done

if [ "$ready" != "1" ]; then
    echo "[launch] shell did not become ready in 40s; aborting"
    kill "$SHELL_PID" 2>/dev/null || true
    exit 1
fi

echo "[launch] enabling $UUID …"
gnome-extensions enable "$UUID" 2>&1 || echo "[launch] enable returned $?"

echo "[launch] extension enabled — shell running (pid $SHELL_PID). Logs follow via journalctl."
wait "$SHELL_PID"
