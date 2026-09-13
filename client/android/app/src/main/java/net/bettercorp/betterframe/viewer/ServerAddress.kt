package net.bettercorp.betterframe.viewer

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

object ServerAddress {
    fun parse(value: String): HttpUrl {
        val url = value.trim().toHttpUrl()
        require(url.username.isEmpty() && url.password.isEmpty()) { "Server URL must not contain credentials" }
        require(url.encodedPath == "/" && url.query == null && url.fragment == null) { "Use the BF server origin without a path" }
        require(url.isHttps || isLocalHost(url.host)) { "HTTP is supported only for a local BF server; use HTTPS for remote servers" }
        return url
    }
    fun isLocalHost(host: String): Boolean {
        if (host == "localhost" || host == "::1" || host.endsWith(".local")) return true
        if (':' in host) {
            // Validate/canonicalize the literal without a DNS lookup. Accept ULA
            // fc00::/7 and link-local fe80::/10, but not public or multicast IPv6.
            val literal = "http://[$host]/".toHttpUrlOrNull()?.host ?: return false
            if (literal == "::1") return true
            val prefix = literal.substringBefore(':').toIntOrNull(16) ?: return false
            return (prefix and 0xfe00) == 0xfc00 || (prefix and 0xffc0) == 0xfe80
        }
        val parts = host.split('.').map { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it == null || it !in 0..255 }) return false
        return parts[0] == 10 || parts[0] == 127 || (parts[0] == 192 && parts[1] == 168) ||
            (parts[0] == 172 && parts[1]!! in 16..31) || (parts[0] == 169 && parts[1] == 254)
    }
}
