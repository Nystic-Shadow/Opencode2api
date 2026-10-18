#!/usr/bin/env bash
# ==============================================================================
# OpenCode2API - Cloudflare WARP SOCKS5 Auto-Installer
# Works on Debian, Ubuntu, CentOS, RHEL, Fedora, Rocky, AlmaLinux, Arch
# ==============================================================================
set -e

echo ""
echo "===================================================================="
echo "⚡ OpenCode2API - Cloudflare WARP Automatic Installer"
echo "===================================================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "❌ This installer requires root privileges. Please run with sudo:"
  echo "   sudo bash $0"
  exit 1
fi

# Detect Operating System
if [ -f /etc/os-release ]; then
  . /etc/os-release
  DISTRO=$ID
  VERSION_CODENAME=${VERSION_CODENAME:-$VERSION_ID}
else
  echo "❌ Unable to detect OS from /etc/os-release."
  exit 1
fi

echo "📦 Detected System: $NAME ($DISTRO, $VERSION_CODENAME)"

# 1. Install official Cloudflare WARP package
case "$DISTRO" in
  ubuntu|debian|pop|mint)
    echo "📥 Configuring Cloudflare APT repository..."
    apt-get update -y
    apt-get install -y curl gnupg lsb-release ca-certificates
    mkdir -p /usr/share/keyrings
    curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
    
    CODENAME=$VERSION_CODENAME
    if [ "$DISTRO" = "ubuntu" ]; then
      CODENAME=${UBUNTU_CODENAME:-jammy}
    elif [ -z "$CODENAME" ] || [ "$CODENAME" = "12" ]; then
      CODENAME="bookworm"
    fi

    echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $CODENAME main" > /etc/apt/sources.list.d/cloudflare-client.list
    apt-get update -y
    apt-get install -y cloudflare-warp
    ;;

  centos|rhel|fedora|rocky|almalinux)
    echo "📥 Configuring Cloudflare YUM/DNF repository..."
    curl -fsSL https://pkg.cloudflareclient.com/cloudflare-warp-ascii.repo | tee /etc/yum.repos.d/cloudflare-warp.repo
    yum install -y cloudflare-warp
    ;;

  arch|manjaro)
    echo "📥 Installing Cloudflare WARP on Arch..."
    pacman -Sy --noconfirm cloudflare-warp-bin || pacman -Sy --noconfirm cloudflare-warp || true
    ;;

  *)
    echo "⚠️ Distro $DISTRO not directly mapped, attempting standard Debian fallback..."
    apt-get update -y && apt-get install -y cloudflare-warp || true
    ;;
esac

# 2. Start and enable warp-svc via systemd if available
if command -v systemctl >/dev/null 2>&1; then
  echo "🚀 Enabling and starting warp-svc daemon..."
  systemctl enable --now warp-svc 2>/dev/null || systemctl restart warp-svc 2>/dev/null || true
  sleep 3
else
  # Non-systemd or container environment: run daemon directly
  echo "🚀 Starting warp-svc background process..."
  warp-svc >/dev/null 2>&1 &
  sleep 3
fi

# 3. Configure WARP in SOCKS5 proxy mode on port 40000
if command -v warp-cli >/dev/null 2>&1; then
  echo "⚙️ Initializing WARP device registration..."
  warp-cli --accept-tos registration new 2>/dev/null || true
  warp-cli --accept-tos tunnel protocol set MASQUE 2>/dev/null || true
  
  echo "⚙️ Switching to proxy mode on port 40000..."
  warp-cli --accept-tos mode proxy 2>/dev/null || warp-cli --accept-tos set-mode proxy 2>/dev/null || true
  warp-cli --accept-tos proxy port 40000 2>/dev/null || warp-cli --accept-tos set-proxy-port 40000 2>/dev/null || true
  warp-cli --accept-tos connect 2>/dev/null || true
  sleep 2

  echo ""
  echo "🧪 Verifying SOCKS5 proxy connectivity on 127.0.0.1:40000..."
  TRACE=$(curl -s -m 8 -x socks5h://127.0.0.1:40000 https://cloudflare.com/cdn-cgi/trace 2>/dev/null || true)
  if echo "$TRACE" | grep -q "warp=on\|warp=plus"; then
    echo "✅ SUCCESS: Cloudflare WARP is Connected and Active in Proxy Mode (127.0.0.1:40000)!"
    echo "   All requests routed through Cloudflare's global edge network."
  else
    echo "ℹ️ WARP configuration applied. Verify status with: warp-cli status"
  fi
else
  echo "❌ warp-cli binary not found after package installation. Check package manager logs."
  exit 1
fi

echo "===================================================================="
echo "🎉 Installation Complete! OpenCode2API will now auto-route via WARP."
echo "===================================================================="
