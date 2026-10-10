# Optional one-time integration. Import this from configuration.nix, then rebuild.
# Deployment itself uses SSH and systemd --user and never invokes sudo.
{ ... }:
{
  imports = [ ./lan.nix ];
  users.users.nixuser.linger = true;
}
