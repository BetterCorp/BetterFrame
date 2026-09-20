package cloud.betterportal.frame

import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Collections
import java.util.IdentityHashMap

/** Bounded, allowlisted details: never copy arbitrary exception messages or URLs. */
internal object CameraDiagnostics {
    fun identifier(value: String): String =
        value.takeIf { it.matches(Regex("[A-Za-z0-9_-]{1,64}")) } ?: "unknown"

    fun causes(error: Throwable): String {
        val seen = Collections.newSetFromMap(IdentityHashMap<Throwable, Boolean>())
        val details = mutableListOf<String>()
        var current: Throwable? = error
        while (current != null && details.size < 8 && seen.add(current)) {
            val cause = current
            val category = when (cause) {
                is UnknownHostException -> "dns_failure"
                is SocketTimeoutException -> "socket_timeout"
                is ConnectException -> "connection_failed"
                is java.io.EOFException -> "unexpected_eof"
                else -> null
            }
            // Media3 RTSP failures commonly use e.g. "DESCRIBE 401". Only retain
            // the method and status when the entire message matches this grammar.
            val status = cause.message?.let {
                Regex("^(OPTIONS|DESCRIBE|SETUP|PLAY|PAUSE|TEARDOWN|GET_PARAMETER|SET_PARAMETER) ([1-5][0-9]{2})$")
                    .matchEntire(it)?.value
            }
            val site = cause.stackTrace.firstOrNull()?.let {
                " at ${it.className}.${it.methodName}:${it.lineNumber}"
            }.orEmpty()
            details.add(cause.javaClass.simpleName +
                (category?.let { "[$it]" } ?: "") +
                (status?.let { "[$it]" } ?: "") + site)
            current = cause.cause
        }
        if (current != null) details.add("[cause chain truncated]")
        return details.joinToString(" <- ").take(4096)
    }
}
