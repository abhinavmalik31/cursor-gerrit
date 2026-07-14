#!/usr/bin/env bash
set -euo pipefail

# Uranus filer upload.
# The SFTP session root is your public_html, so files land at:
#   http://uranus.corp.nutanix.com/~<username>/<remote path>
# We upload into the cursor-gerrit/ subfolder to match GERRIT_UPDATE_BASE_URL
# in src/lib/util/constants.ts.
#
# Multi-platform: `npm run package:platforms` writes one VSIX per target into
# dist/ (cursor--gerrit-<version>-<target>.vsix). Self-update needs every
# platform's VSIX present on the server, so we upload the whole set for a
# version at once.

USER=albin.saju
HOST=upload.uranus.corp.nutanix.com
REMOTE_DIR=cursor-gerrit
DIST_DIR="$(cd "$(dirname "$0")" && pwd)/dist"

if [ ! -d "$DIST_DIR" ]; then
	echo "No dist/ directory. Run 'npm run package:platforms' first." >&2
	exit 1
fi

# Distinct versions across all platform VSIXs in dist/.
mapfile -t VERSIONS < <(
	ls -1 "$DIST_DIR"/cursor--gerrit-*.vsix 2>/dev/null |
		sed -E 's#.*/cursor--gerrit-([0-9]+\.[0-9]+\.[0-9]+)-.*#\1#' |
		sort -Vu
)
if [ "${#VERSIONS[@]}" -eq 0 ]; then
	echo "No cursor--gerrit-*.vsix files in $DIST_DIR." >&2
	exit 1
fi

if [ "${#VERSIONS[@]}" -eq 1 ]; then
	VERSION="${VERSIONS[0]}"
else
	VERSION=$(printf '%s\n' "${VERSIONS[@]}" | fzf --prompt="version> ")
fi
if [ -z "${VERSION:-}" ]; then
	echo "No version selected." >&2
	exit 1
fi

mapfile -t FILES < <(ls -1 "$DIST_DIR"/cursor--gerrit-"$VERSION"-*.vsix)
if [ "${#FILES[@]}" -eq 0 ]; then
	echo "No VSIX files for version $VERSION in $DIST_DIR." >&2
	exit 1
fi

echo "Uploading ${#FILES[@]} file(s) for v$VERSION to ~/$USER/$REMOTE_DIR/ ..."
printf '  %s\n' "${FILES[@]##*/}"

# -mkdir ignores the error if the directory already exists.
# chmod values are octal: 755 for the dir, 644 for the file (web-readable).
{
	echo "-mkdir $REMOTE_DIR"
	echo "chmod 755 $REMOTE_DIR"
	echo "cd $REMOTE_DIR"
	for f in "${FILES[@]}"; do
		name=${f##*/}
		echo "put \"$f\" \"$name\""
		echo "chmod 644 \"$name\""
	done
	echo "bye"
} | sftp "$USER@$HOST"

echo "Done."
echo "Available at: http://uranus.corp.nutanix.com/~$USER/$REMOTE_DIR/"
