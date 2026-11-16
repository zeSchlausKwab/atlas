# Optional NixOS module for the demo LAN. Adjust interface/subnet for another host.
# Import this into configuration.nix during the next approved system update.
# It does not restart Atlas or grant access to its administration API.
{ ... }:
{
  networking.firewall.extraCommands = ''
    iptables -I nixos-fw 1 -i eno1 -s 192.168.0.0/24 -p tcp --dport 42131 -j nixos-fw-accept
    iptables -I nixos-fw 1 -i eno1 -s 192.168.0.0/24 -p udp --dport 42132 -j nixos-fw-accept
  '';
  networking.firewall.extraStopCommands = ''
    iptables -D nixos-fw -i eno1 -s 192.168.0.0/24 -p tcp --dport 42131 -j nixos-fw-accept 2>/dev/null || true
    iptables -D nixos-fw -i eno1 -s 192.168.0.0/24 -p udp --dport 42132 -j nixos-fw-accept 2>/dev/null || true
  '';
}
