{ pkgs ? import <nixpkgs> { } }:
# Each release keeps the resulting immutable store closure as a GC root.
# The host's NixOS channel supplies the package versions; no global install.
pkgs.buildEnv {
  name = "atlas-runtime";
  paths = with pkgs; [ bun cargo rustc gcc osmium-tool pkg-config curl git coreutils ];
}
