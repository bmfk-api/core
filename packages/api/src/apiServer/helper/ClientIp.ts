// The real client address behind nginx.
//
// X-Real-IP / X-Forwarded-For are trusted ONLY when the TCP peer is one of our own proxies
// (loopback by default — nginx on the same host). From anyone else these headers are just text the
// client typed: honouring them would let an attacker hide behind, or frame, any address.
//
// With `proxy_set_header X-Real-IP $remote_addr` nginx overwrites whatever the client sent, and
// `$proxy_add_x_forwarded_for` APPENDS the peer it saw — so the LAST X-Forwarded-For entry is
// nginx's own observation, while earlier ones are client-supplied.

export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1"];

const norm = (a: unknown): string => {
    let s = String(a ?? "").trim();
    if (s.startsWith("::ffff:")) s = s.slice(7);   // IPv4-mapped IPv6
    return s;
};

/** True when the request came straight from one of the trusted proxies (so its headers can be believed). */
export function fromTrustedProxy(req: any, trustedProxies: Set<string> = new Set(DEFAULT_TRUSTED_PROXIES)): boolean {
    const peer = norm(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress);
    return !!peer && trustedProxies.has(peer);
}

export function clientIp(req: any, trustedProxies: Set<string> = new Set(DEFAULT_TRUSTED_PROXIES)): string {
    const peer = norm(req?.socket?.remoteAddress ?? req?.connection?.remoteAddress);
    if (!peer) return "unknown";
    if (!trustedProxies.has(peer)) return peer;

    const real = req?.headers?.["x-real-ip"];
    if (typeof real === "string" && real.trim()) return norm(real.split(",")[0]);

    const xff = req?.headers?.["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
        const parts = xff.split(",").map(s => s.trim()).filter(Boolean);
        if (parts.length) return norm(parts[parts.length - 1]);
    }
    return peer;
}
