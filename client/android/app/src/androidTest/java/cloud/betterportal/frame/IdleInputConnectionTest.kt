package cloud.betterportal.frame

import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class IdleInputConnectionTest {
    @Test fun keyboardEditsRenewActivityAndKeepNormalTextEditingWhileQueriesDoNot() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val editor = EditText(instrumentation.targetContext)
            val delegate = BaseInputConnection(editor, true)
            var activity = 0
            val connection = IdleInputConnection.wrap(delegate) { activity++ }
            assertTrue(connection.commitText("ab", 1))
            assertEquals("ab", delegate.editable.toString())
            assertTrue(activity > 0)
            var before = activity
            assertEquals("ab", connection.getTextBeforeCursor(10, 0).toString())
            connection.getTextAfterCursor(10, 0)
            connection.getSelectedText(0)
            assertEquals("Keyboard queries must not keep an idle page alive", before, activity)

            assertTrue(connection.setComposingText("c", 1))
            assertEquals("abc", delegate.editable.toString())
            assertTrue(activity > before)
            before = activity
            assertTrue(connection.finishComposingText())
            assertTrue(connection.deleteSurroundingTextInCodePoints(1, 0))
            assertEquals("ab", delegate.editable.toString())
            assertTrue(activity > before)
            before = activity
            assertTrue(connection.setSelection(0, 1))
            assertTrue(connection.commitText("Z", 1))
            assertEquals("Zb", delegate.editable.toString())
            assertTrue(activity > before)
        }
    }

    @Test fun rejectedEditsPreserveTheUnderlyingInputConnectionResult() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            var received = ""
            val delegate = object : InputConnectionWrapper(BaseInputConnection(EditText(instrumentation.targetContext), true), false) {
                override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                    received = "$text:$newCursorPosition"
                    return false
                }
            }
            var activity = 0
            val connection = IdleInputConnection.wrap(delegate) { activity++ }
            assertFalse(connection.commitText("fixture", 2))
            assertEquals("fixture:2", received)
            assertEquals(1, activity)
        }
    }
}
