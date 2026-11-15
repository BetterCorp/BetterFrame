package cloud.betterportal.frame

import android.content.Context
import android.content.ContextWrapper
import android.util.AtomicFile
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class TrustedCaJournalTest {
    private fun isolatedContext(): Pair<Context, File> {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "trust-cleanup-${UUID.randomUUID()}").apply { mkdirs() }
        return object : ContextWrapper(context) {
            override fun getApplicationContext(): Context = this
            override fun getNoBackupFilesDir(): File = directory
        } to directory
    }

    @Test fun backupOnlyJournalRecoversOwnershipBeforeTheNextWrite() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val base = File(app.cacheDir, "trust-journal-${UUID.randomUUID()}")
        val backup = File(base.path + ".bak")
        try {
            backup.writeText("{\"owned\":{\"root\":\"certificate\"}}")
            val recovered = readTrustJournal(AtomicFile(base))
            assertEquals("certificate", recovered.getJSONObject("owned").getString("root"))
            assertTrue(base.exists()); assertFalse(backup.exists())
            base.writeText("broken JSON")
            try { readTrustJournal(AtomicFile(base)); fail("Corruption must not erase ownership") } catch (_: org.json.JSONException) { }
        } finally { base.delete(); backup.delete() }
        assertEquals(0, readTrustJournal(AtomicFile(base)).length())
    }
    @Test fun incompleteTrustCleanupRetainsItsMarkerAndGuidanceUntilRetried() {
        val (app, directory) = isolatedContext()
        val store = ProtectedStore(app)
        val token = "trust-cleanup-${UUID.randomUUID()}"; val browser = AtomicInteger()
        try {
            store.write(JSONObject().put(EnrollmentCleanup.MARKER, token))
            val failed = CountDownLatch(1)
            EnrollmentCleanup.request(app, token, { _, callback -> browser.incrementAndGet(); callback(true) },
                { TrustedCaPolicy.requireRemovalApplied(JSONObject().put("state", "manual_action")) },
                { failed.countDown() })
            assertTrue(failed.await(10, TimeUnit.SECONDS))
            assertEquals(token, store.read().getString(EnrollmentCleanup.MARKER)); assertEquals(0, browser.get())
            assertTrue(EnrollmentCleanup.failureReason(app)!!.contains("Android Settings"))
            val completed = CountDownLatch(1)
            EnrollmentCleanup.request(app, token, { _, callback -> browser.incrementAndGet(); callback(true) },
                { TrustedCaPolicy.requireRemovalApplied(JSONObject().put("state", "applied")) },
                { completed.countDown() })
            assertTrue(completed.await(10, TimeUnit.SECONDS))
            assertFalse(store.read().has(EnrollmentCleanup.MARKER)); assertEquals(1, browser.get())
            assertNull(EnrollmentCleanup.failureReason(app))
        } finally { directory.deleteRecursively() }
    }
    @Test fun obsoleteCleanupCannotRemoveTrustOrBrowserSessionsFromNewEnrollment() {
        val (app, directory) = isolatedContext()
        val store = ProtectedStore(app)
        val trust = AtomicInteger(); val browser = AtomicInteger(); val done = CountDownLatch(1)
        try {
            val next = JSONObject().put("server", "https://new-enrollment.test")
            store.write(next)
            EnrollmentCleanup.request(app, "obsolete-${UUID.randomUUID()}",
                { _, callback -> browser.incrementAndGet(); callback(true) },
                { trust.incrementAndGet() }, { done.countDown() })
            assertTrue(done.await(10, TimeUnit.SECONDS))
            assertEquals(0, trust.get()); assertEquals(0, browser.get())
            assertEquals(next.toString(), store.read().toString())
        } finally { directory.deleteRecursively() }
    }
}
