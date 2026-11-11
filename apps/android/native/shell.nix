# Native Linux provider build environment. All C libraries must come from the
# same nixpkgs as Rust/libclang; mixing channels can cause GLIBC_PRIVATE errors.
{ pkgs ? import <nixpkgs> {} }:
pkgs.mkShell {
  nativeBuildInputs = [ pkgs.cargo pkgs.rustc pkgs.pkg-config ];
  buildInputs = [ pkgs.dbus pkgs.libmnl pkgs.libnftnl ];
  LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
  BINDGEN_EXTRA_CLANG_ARGS = "-I${pkgs.linuxHeaders}/include -I${pkgs.glibc.dev}/include";
}
