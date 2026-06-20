#!/bin/sh
# Subset the web app's local fonts to the glyphs actually used by the UI.
# This keeps next/font/local bundles small; run it after upgrading font files.
# Requires fonttools (pip install fonttools) for pyftsubset.
set -e

WEB_FONTS="$(dirname "$0")/../apps/web/app/fonts"
IOSEVKA_CHARS="U+0020-007E,U+00A0-00FF,U+2010-2015,U+20AC,U+2212,U+00B1,U+00D7,U+00F7"

echo "Subsetting Iosevka to Latin-1 + common symbols..."
pyftsubset "$WEB_FONTS/iosevka-latin-400-normal.woff2" \
  --unicodes="$IOSEVKA_CHARS" \
  --flavor=woff2 \
  --output-file="$WEB_FONTS/iosevka-latin-400-normal.woff2"

pyftsubset "$WEB_FONTS/iosevka-latin-700-normal.woff2" \
  --unicodes="$IOSEVKA_CHARS" \
  --flavor=woff2 \
  --output-file="$WEB_FONTS/iosevka-latin-700-normal.woff2"

echo "Done. New sizes:"
ls -lh "$WEB_FONTS"/iosevka-*.woff2
