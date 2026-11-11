#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
: "${ANDROID_NDK_HOME:=$ANDROID_HOME/ndk/29.0.14206865}"
export ANDROID_HOME ANDROID_NDK_HOME
case "$(uname -s)" in Darwin) host_tag=darwin-x86_64;; Linux) host_tag=linux-x86_64;; *) echo 'Build on macOS or Linux' >&2; exit 1;; esac
toolchain="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$host_tag/bin"
export CC_aarch64_linux_android="$toolchain/aarch64-linux-android28-clang"
export AR_aarch64_linux_android="$toolchain/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384'
test -x "$CC_aarch64_linux_android" || { echo "Install Android NDK 29.0.14206865 or set ANDROID_NDK_HOME" >&2; exit 1; }
cargo build --manifest-path native/Cargo.toml --locked --release --lib --target aarch64-linux-android
mkdir -p app/build/native-libs/arm64-v8a
cp native/target/aarch64-linux-android/release/libsoy_fips_demo.so app/build/native-libs/arm64-v8a/
./gradlew --no-daemon assembleDebug lintDebug
mkdir -p output
cp app/build/outputs/apk/debug/app-debug.apk output/native-fips-demo.apk
echo "APK: $(pwd)/output/native-fips-demo.apk"
