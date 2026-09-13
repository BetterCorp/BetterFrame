#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to an installed Android NDK 27 or newer}"
output="${1:?JNI output directory required}"
case "$(uname -s)" in
  Linux) host=linux-x86_64 ;;
  Darwin) host=darwin-x86_64 ;;
  *) echo 'Build the Android Rust libraries on Linux or macOS.' >&2; exit 1 ;;
esac
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$host/bin"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$toolchain/aarch64-linux-android28-clang"
export CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER="$toolchain/x86_64-linux-android28-clang"
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"
for target in aarch64-linux-android x86_64-linux-android; do
  cargo build --manifest-path ../Cargo.toml -p betterframe-android-bridge --release --locked --target "$target"
  case "$target" in aarch64*) abi=arm64-v8a ;; *) abi=x86_64 ;; esac
  mkdir -p "$output/$abi"
  cp "../target/$target/release/libbetterframe_android_bridge.so" "$output/$abi/"
done
