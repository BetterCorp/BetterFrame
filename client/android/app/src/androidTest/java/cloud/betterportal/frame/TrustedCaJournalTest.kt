package cloud.betterportal.frame

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
    @Test fun obsoleteCleanupCannotRemoveTrustOrBrowserSessionsFromNewEnrollment() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext
        val store = ProtectedStore(app); val before = store.read()
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
        } finally { store.write(before) }
    }
}
