# Optional one-time integration. Import this from configuration.nix, then rebuild.
# Deployment itself uses SSH and systemd --user and never invokes sudo.
{ ... }:
{
  users.users.nixuser.linger = true;
  networking.firewall.extraCommands = ''
    iptables -A nixos-fw -s 192.168.0.0/24 -p tcp --dport 3100 -j nixos-fw-accept
  '';
  networking.firewall.extraStopCommands = ''
    iptables -D nixos-fw -s 192.168.0.0/24 -p tcp --dport 3100 -j nixos-fw-accept 2>/dev/null || true
  '';
}
