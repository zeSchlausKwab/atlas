# Atlas public data/API: Ethernet LAN only. Does not enable remote administration.
{ ... }:
{
  networking.firewall.extraCommands = ''
    iptables -A nixos-fw -i eno1 -s 192.168.0.0/24 -p tcp --dport 3100 -j nixos-fw-accept
  '';
  networking.firewall.extraStopCommands = ''
    iptables -D nixos-fw -i eno1 -s 192.168.0.0/24 -p tcp --dport 3100 -j nixos-fw-accept 2>/dev/null || true
  '';
}
