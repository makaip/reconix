#!/usr/bin/env bash
# install-scanners.sh — install the external pentest scanners Reconix can drive
# via run_tool / the dedicated MCP wrappers (nuclei, ffuf, nmap, subfinder,
# gobuster, sqlmap, arjun, testssl.sh).
#
# Designed to run WITHOUT sudo: binaries go to ~/.local/bin and Python tools to
# the user site-packages. System libraries (libpcap etc.) are pulled as .deb
# packages and extracted into a per-user lib dir, so no root is required.
#
# Usage:
#   ./scripts/install-scanners.sh            # install everything
#   ./scripts/install-scanners.sh --only nmap,nuclei
#   ./scripts/install-scanners.sh --list
set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
LIB_DIR="${HOME}/.local/lib/reconix-scanners"
TMP_DIR="${TMPDIR:-/tmp}/reconix-scanner-install"
mkdir -p "$BIN_DIR" "$LIB_DIR" "$TMP_DIR"

ALL_TOOLS="nmap nuclei ffuf subfinder gobuster sqlmap arjun testssl"
SELECTED="$ALL_TOOLS"

# Parse args
for arg in "$@"; do
  case "$arg" in
    --list) echo "Available: $ALL_TOOLS"; exit 0 ;;
    --only=*) SELECTED="${arg#--only=}" ;;
    --only) shift; SELECTED="$1" ;;
    -h|--help) echo "Usage: $0 [--only tool1,tool2] [--list]"; exit 0 ;;
  esac
done

has() { command -v "$1" >/dev/null 2>&1; }
want() { echo "$SELECTED" | tr ',' ' ' | grep -qw "$1"; }

install_go_tool() {
  # $1 name, $2 repo, $3 asset pattern (python regex-ish via grep)
  local name="$1" repo="$2" pattern="$3"
  if has "$name"; then echo "  $name already installed: $(command -v $name)"; return 0; fi
  echo "  installing $name from $repo ..."
  local url
  url=$(curl -sL "https://api.github.com/repos/$repo/releases/latest" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); [print(a['browser_download_url']) for a in d.get('assets',[]) if '$pattern' in a['name']]" | head -1)
  if [ -z "$url" ]; then echo "  !! could not resolve download URL for $name"; return 1; fi
  local tmp="$TMP_DIR/$name"
  mkdir -p "$tmp"
  curl -sL "$url" -o "$tmp/archive" || { echo "  !! download failed"; return 1; }
  case "$url" in
    *.zip) unzip -oq "$tmp/archive" -d "$tmp" ;;
    *.tar.gz) tar -xzf "$tmp/archive" -C "$tmp" ;;
  esac
  local bin
  bin=$(find "$tmp" -type f -name "$name" | head -1)
  if [ -z "$bin" ]; then echo "  !! binary not found in archive"; return 1; fi
  cp "$bin" "$BIN_DIR/$name"
  chmod +x "$BIN_DIR/$name"
  echo "  $name installed -> $BIN_DIR/$name"
}

install_python_tool() {
  local name="$1"
  if has "$name"; then echo "  $name already installed"; return 0; fi
  echo "  installing $name via pip (user) ..."
  pip3 install --user --break-system-packages "$name" 2>&1 | tail -2
}

install_nmap() {
  if has nmap; then echo "  nmap already installed: $(command -v nmap)"; return 0; fi
  echo "  installing nmap (deb extraction, no sudo) ..."
  local d="$TMP_DIR/nmap"
  mkdir -p "$d" "$LIB_DIR"
  cd "$d"
  # Resolve the full dependency set via apt's print-uris (no root needed).
  apt-get install --reinstall --print-uris -y nmap 2>/dev/null \
    | grep -o "http[^']*" | while read -r url; do
        f=$(basename "$url")
        [ -f "$f" ] || curl -sL -o "$f" "$url"
      done
  for deb in *.deb; do dpkg -x "$deb" "$d/extract" 2>/dev/null; done
  mkdir -p "$d/extract/usr/lib/x86_64-linux-gnu"
  find "$d/extract" -name 'lib*.so*' -exec cp -a {} "$LIB_DIR/" \;
  cp "$d/extract/usr/bin/nmap" "$BIN_DIR/nmap.real"
  chmod +x "$BIN_DIR/nmap.real"
  # nmap data files (services, scripts, protocols)
  if [ -d "$d/extract/usr/share/nmap" ]; then
    mkdir -p "$HOME/.local/share/nmap"
    cp -r "$d/extract/usr/share/nmap/"* "$HOME/.local/share/nmap/"
  fi
  cat > "$BIN_DIR/nmap" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH=$LIB_DIR:\${LD_LIBRARY_PATH}
export NMAPDIR=$HOME/.local/share/nmap
exec $BIN_DIR/nmap.real "\$@"
EOF
  chmod +x "$BIN_DIR/nmap"
  echo "  nmap installed -> $BIN_DIR/nmap"
}

install_testssl() {
  if [ -x "$BIN_DIR/testssl.sh" ]; then echo "  testssl.sh already installed"; return 0; fi
  echo "  installing testssl.sh ..."
  curl -sL "https://raw.githubusercontent.com/drwetter/testssl.sh/3.2/testssl.sh" -o "$BIN_DIR/testssl.sh"
  chmod +x "$BIN_DIR/testssl.sh"
  echo "  testssl.sh installed -> $BIN_DIR/testssl.sh"
}

echo "=== Reconix scanner installer ==="
echo "Bin dir: $BIN_DIR"
echo "Lib dir: $LIB_DIR"
echo ""

for tool in $ALL_TOOLS; do
  if ! want "$tool"; then continue; fi
  echo "[$tool]"
  case "$tool" in
    nmap)       install_nmap ;;
    nuclei)     install_go_tool nuclei projectdiscovery/nuclei 'linux_amd64.zip' ;;
    ffuf)       install_go_tool ffuf ffuf/ffuf 'linux_amd64.tar.gz' ;;
    subfinder)  install_go_tool subfinder projectdiscovery/subfinder 'linux_amd64.zip' ;;
    gobuster)   install_go_tool gobuster OJ/gobuster 'Linux_x86_64.tar.gz' ;;
    sqlmap)     install_python_tool sqlmap ;;
    arjun)      install_python_tool arjun ;;
    testssl)    install_testssl ;;
  esac
  echo ""
done

echo "=== Done ==="
echo "Ensure $BIN_DIR is on your PATH (add to ~/.bashrc if not):"
echo "  export PATH=\"$BIN_DIR:\$PATH\""
echo ""
echo "Then enable the binaries in Reconix: Settings -> External tools -> Scan for tools."
