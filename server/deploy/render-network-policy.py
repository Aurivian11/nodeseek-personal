#!/usr/bin/env python3
"""Render service-specific nftables rules; never apply them automatically."""
import argparse
import ipaddress
import os
from pathlib import Path
import pwd
import socket
from urllib.parse import urlsplit


def render(origin, console_uid, desktop_uid, addresses, resolvers):
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('APP_ORIGIN must be an HTTPS origin without credentials')
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('APP_ORIGIN must not include a path, query or fragment')
    port = parsed.port or 443
    if not 1 <= port <= 65535:
        raise ValueError('Invalid HTTPS port')
    if console_uid <= 0 or desktop_uid <= 0 or console_uid == desktop_uid:
        raise ValueError('Use two distinct non-root service users')
    origins = {ipaddress.ip_address(value) for value in addresses}
    dns = {ipaddress.ip_address(value) for value in resolvers}
    if not origins:
        raise ValueError('APP_ORIGIN hostname has no resolved addresses')
    lines = [
        '# Generated locally. Review before applying; do not commit this output.',
        'add table inet nodeseek_console',
        'flush table inet nodeseek_console',
        'table inet nodeseek_console {',
        '  chain service_output {',
        '    type filter hook output priority -5; policy accept;',
        f'    meta skuid {{ {console_uid}, {desktop_uid} }} ct state established,related accept',
    ]
    for family, version in [('ip', 4), ('ip6', 6)]:
        destinations = sorted(str(value) for value in origins if value.version == version)
        if destinations:
            joined = ', '.join(destinations)
            lines.append(f'    meta skuid {desktop_uid} {family} daddr {{ {joined} }} tcp dport {port} accept')
        for resolver in sorted(str(value) for value in dns if value.version == version):
            for protocol in ('udp', 'tcp'):
                lines.append(f'    meta skuid {{ {console_uid}, {desktop_uid} }} {family} daddr {resolver} {protocol} dport 53 accept')
    private4 = '0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4'
    private6 = '::/128, ::1/128, ::ffff:0:0/96, 100::/64, fc00::/7, fe80::/10, ff00::/8'
    for family, ranges in [('ip', private4), ('ip6', private6)]:
        lines.append(f'    meta skuid {{ {console_uid}, {desktop_uid} }} {family} daddr {{ {ranges} }} reject')
    lines.extend(['  }', '}', ''])
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Write generated rules here instead of stdout')
    args = parser.parse_args()
    origin = os.environ.get('APP_ORIGIN', '')
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        parser.error('Set APP_ORIGIN to the HTTPS management origin')
    console_uid = pwd.getpwnam('nodeseek-console').pw_uid
    desktop_uid = pwd.getpwnam('nodeseek-desktop').pw_uid
    addresses = {item[4][0] for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443, type=socket.SOCK_STREAM)}
    resolvers = []
    for line in Path('/etc/resolv.conf').read_text().splitlines():
        fields = line.split()
        if len(fields) > 1 and fields[0] == 'nameserver':
            resolvers.append(fields[1])
    rules = render(origin, console_uid, desktop_uid, addresses, resolvers)
    if args.output:
        args.output.write_text(rules)
        args.output.chmod(0o600)
    else:
        print(rules, end='')


if __name__ == '__main__':
    main()
