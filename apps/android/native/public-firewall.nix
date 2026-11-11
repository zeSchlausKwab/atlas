# Optional: expose only the native Atlas FIPS entry on Ethernet.
# Router forwarding/public IPv6 reachability is separate. Import only when
# deliberately making this entry public. Never open Atlas admin port 3100 here.
{ ... }:
{
  networking.firewall.interfaces.eno1.allowedTCPPorts = [ 42131 ];
  networking.firewall.interfaces.eno1.allowedUDPPorts = [ 42132 ];
}
