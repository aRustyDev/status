#!/bin/sh
set -eu
umask 077
dir="$HOME/Library/Application Support/Status Preview Browser"
helper="$dir/status-preview-vault"
if [ ! -x "$helper" ]; then
    mkdir -p "$dir"
    build=$(mktemp -d "$dir/build.XXXXXX")
    trap 'rm -rf "$build"' EXIT
    /usr/bin/swiftc -O -module-cache-path "$build/modules" \
        "$(dirname "$0")/StatusPreviewVault.swift" -o "$build/status-preview-vault"
    /usr/bin/codesign --force --sign - --options runtime \
        --identifier dev.arusty.status.preview-vault "$build/status-preview-vault"
    chmod 700 "$build/status-preview-vault"
    # Publish once. The Keychain ACL identifies this signed executable.
    ln "$build/status-preview-vault" "$helper"
fi
"$helper" provision
"$helper" verify
