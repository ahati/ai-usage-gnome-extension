#!/bin/bash
# Install Z.AI Usage Monitor GNOME Shell Extension
set -e

UUID="zai-usage-monitor@cowork.user"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

echo "Installing Z.AI Usage Monitor extension..."
echo "Target: ${EXT_DIR}"

# Create directory
mkdir -p "${EXT_DIR}/schemas"

# Copy files
cp extension.js "${EXT_DIR}/"
cp prefs.js "${EXT_DIR}/"
cp stylesheet.css "${EXT_DIR}/"
cp metadata.json "${EXT_DIR}/"
cp schemas/org.gnome.shell.extensions.zai-usage.gschema.xml "${EXT_DIR}/schemas/"

# Compile GSettings schema
glib-compile-schemas "${EXT_DIR}/schemas/"

echo ""
echo "Installation complete!"
echo ""
echo "Next steps:"
echo "  1. Restart GNOME Shell:"
echo "     - X11: Alt+F2, type 'r', press Enter"
echo "     - Wayland: Log out and back in"
echo "  2. Enable the extension:"
echo "     gnome-extensions enable ${UUID}"
echo "  3. Open Z.AI Usage Monitor preferences to configure authentication"
