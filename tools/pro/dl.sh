#!/bin/bash
# usage: dl.sh <dir>; stdin lines: "<outname> <full url>"
mkdir -p "$1"; cd "$1"
while read -r name url; do
  [ -z "$name" ] && continue
  curl -sf -o "$name" "$url" || echo "FAIL $name"
done
