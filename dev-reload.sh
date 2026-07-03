#!/bin/bash
# Quick reload script for extension development with nested GNOME Shell.
# Usage: ./dev-reload.sh
set -e

UUID="ai-usage-monitor@ahati"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

rm -rf "${EXT_DIR}"
mkdir -p "${EXT_DIR}/schemas" "${EXT_DIR}/providers"
cp extension.js prefs.js config.js stylesheet.css metadata.json "${EXT_DIR}/"
cp providers/*.js "${EXT_DIR}/providers/"
cp schemas/*.xml "${EXT_DIR}/schemas/"
cp -r media "${EXT_DIR}/" 2>/dev/null || true
glib-compile-schemas "${EXT_DIR}/schemas/"
chmod 664 "${EXT_DIR}/"*.{js,css,json} "${EXT_DIR}/providers/"*.js "${EXT_DIR}/schemas/"*

echo "Installed. Now restart nested shell and enable:"
echo "  gnome-extensions enable ${UUID}"