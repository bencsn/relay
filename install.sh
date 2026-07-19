#!/bin/sh
set -eu

repo="${RELAY_GITHUB_REPO:-bencsn/relay}"
install_dir="${RELAY_INSTALL_DIR:-/usr/local/bin}"
version="${RELAY_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "relay-host supports macOS, Linux, and Windows." >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac

artifact="relay-host-${os}-${arch}.tar.gz"
if [ "$version" = "latest" ]; then
  release_url="https://github.com/${repo}/releases/latest/download"
else
  release_url="https://github.com/${repo}/releases/download/${version}"
fi

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT INT TERM
archive="$temporary_dir/$artifact"

curl -fL --proto '=https' --tlsv1.2 -o "$archive" "$release_url/$artifact"
curl -fL --proto '=https' --tlsv1.2 -o "$temporary_dir/SHA256SUMS" "$release_url/SHA256SUMS"

expected="$(awk -v name="$artifact" '$2 == name { print $1 }' "$temporary_dir/SHA256SUMS")"
if [ -z "$expected" ]; then
  echo "Release checksum is missing for $artifact." >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$archive" | awk '{ print $1 }')"
else
  actual="$(shasum -a 256 "$archive" | awk '{ print $1 }')"
fi
if [ "$actual" != "$expected" ]; then
  echo "Checksum verification failed for $artifact." >&2
  exit 1
fi

if command -v gh >/dev/null 2>&1; then
  gh attestation verify "$archive" --repo "$repo" >/dev/null
  echo "Verified GitHub build provenance."
else
  echo "Verified SHA-256. Install GitHub CLI to verify build provenance as well."
fi

tar -xzf "$archive" -C "$temporary_dir"
binary="$temporary_dir/relay-host-${os}-${arch}"
if [ -w "$install_dir" ]; then
  install -m 0755 "$binary" "$install_dir/relay-host"
else
  command -v sudo >/dev/null 2>&1 || {
    echo "$install_dir is not writable. Set RELAY_INSTALL_DIR to a writable directory." >&2
    exit 1
  }
  sudo install -m 0755 "$binary" "$install_dir/relay-host"
fi

echo "Installed relay-host to $install_dir/relay-host"
