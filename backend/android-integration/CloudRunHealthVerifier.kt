package com.autoblogger.ai.setup

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * Drop-in verifier for the Android Setup Wizard.
 * Compatible with Cloudflare Workers (*.workers.dev) and any HTTPS backend URL.
 * Performs a real GET /health request and only reports success when HTTP 200
 * and JSON status == "ok" are returned.
 */
data class BackendVerificationResult(
    val verified: Boolean,
    val normalizedBaseUrl: String,
    val statusCode: Int? = null,
    val serviceName: String? = null,
    val runtime: String? = null,
    val timestamp: String? = null,
    val agentStatus: String? = null,
    val dbConnected: Boolean? = null,
    val queueConfigured: Boolean? = null,
    val errorMessage: String? = null
)

object CloudRunHealthVerifier {

    fun normalizeUrl(rawUrl: String): String {
        val trimmed = rawUrl.trim().trimEnd('/')
        require(trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
            "Backend URL must start with https://"
        }
        return trimmed
    }

    suspend fun verifyBackend(rawBaseUrl: String): BackendVerificationResult =
        withContext(Dispatchers.IO) {
            val baseUrl = try {
                normalizeUrl(rawBaseUrl)
            } catch (e: IllegalArgumentException) {
                return@withContext BackendVerificationResult(
                    verified = false,
                    normalizedBaseUrl = rawBaseUrl.trim(),
                    errorMessage = e.message ?: "Invalid URL format"
                )
            }

            var connection: HttpURLConnection? = null
            try {
                val healthUrl = URL("$baseUrl/health")
                connection = (healthUrl.openConnection() as HttpURLConnection).apply {
                    requestMethod = "GET"
                    connectTimeout = 10_000
                    readTimeout = 10_000
                    setRequestProperty("Accept", "application/json")
                }

                val code = connection.responseCode
                val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                val body = stream?.let {
                    BufferedReader(InputStreamReader(it)).use { reader -> reader.readText() }
                } ?: ""

                if (code != HttpURLConnection.HTTP_OK) {
                    return@withContext BackendVerificationResult(
                        verified = false,
                        normalizedBaseUrl = baseUrl,
                        statusCode = code,
                        errorMessage = "Backend returned HTTP $code"
                    )
                }

                val json = JSONObject(body)
                val status = json.optString("status", "")
                val service = json.optString("service", "")
                val runtime = json.optString("runtime", "cloudflare-workers")
                val timestamp = json.optString("timestamp", "")
                val agentStatus = json.optString("agentStatus", "unknown")
                val dbConnected = if (json.has("dbConnected")) {
                    json.optBoolean("dbConnected", false)
                } else {
                    json.optBoolean("firebaseConnected", false)
                }
                val queueConfigured = json.optBoolean("queueConfigured", false)

                if (status != "ok" || service.isBlank()) {
                    return@withContext BackendVerificationResult(
                        verified = false,
                        normalizedBaseUrl = baseUrl,
                        statusCode = code,
                        errorMessage = "Unexpected /health payload: status=$status"
                    )
                }

                BackendVerificationResult(
                    verified = true,
                    normalizedBaseUrl = baseUrl,
                    statusCode = code,
                    serviceName = service,
                    runtime = runtime,
                    timestamp = timestamp,
                    agentStatus = agentStatus,
                    dbConnected = dbConnected,
                    queueConfigured = queueConfigured
                )
            } catch (e: Exception) {
                BackendVerificationResult(
                    verified = false,
                    normalizedBaseUrl = baseUrl,
                    errorMessage = e.localizedMessage ?: "Network error contacting /health"
                )
            } finally {
                connection?.disconnect()
            }
        }
}
