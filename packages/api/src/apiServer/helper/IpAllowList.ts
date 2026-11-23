import net from "net";

// Address allow-lists: single IPs and CIDR subnets, IPv4 and IPv6 —
// e.g. ["203.0.113.7", "10.8.0.0/24", "2001:db8::/48"]. An empty list means "no restriction".
export class IpAllowList {

    static build(entries: readonly string[] | undefined | null): { list: net.BlockList | null, error?: string } {
        const items = (entries ?? []).map(e => String(e).trim()).filter(e => e.length > 0);
        if (items.length === 0) return { list: null };
        const list = new net.BlockList();
        for (const item of items) {
            const [addr, prefix, extra] = item.split("/");
            const family = net.isIP(addr);
            if (!family || extra !== undefined) return { list: null, error: `"${item}" is not an IP address or subnet` };
            const type = family === 6 ? "ipv6" : "ipv4";
            if (prefix === undefined) { list.addAddress(addr, type); continue; }
            const bits = Number(prefix), max = family === 6 ? 128 : 32;
            if (!/^\d+$/.test(prefix) || bits > max) return { list: null, error: `"${item}" has an invalid prefix (0–${max})` };
            list.addSubnet(addr, bits, type);
        }
        return { list };
    }

    // No list → allowed. With a list, an unknown or malformed address is refused.
    static allows(list: net.BlockList | null, ip: string | undefined | null): boolean {
        if (!list) return true;
        const family = net.isIP(String(ip ?? ""));
        if (!family) return false;
        return list.check(String(ip), family === 6 ? "ipv6" : "ipv4");
    }
}
