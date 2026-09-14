package cloud.betterportal.frame

import android.os.Build
import android.os.Bundle
import android.view.KeyEvent
import android.view.inputmethod.CompletionInfo
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import android.view.inputmethod.HandwritingGesture
import android.view.inputmethod.TextAttribute
import androidx.annotation.RequiresApi
import java.util.concurrent.Executor
import java.util.function.IntConsumer

/** IME edits bypass Activity touch/key dispatch. Queries must not renew idle. */
internal open class IdleInputConnection(target: InputConnection, private val onActivity: () -> Unit) :
    InputConnectionWrapper(target, false) {
    protected fun edit(action: () -> Boolean): Boolean { onActivity(); return action() }

    override fun commitText(text: CharSequence?, newCursorPosition: Int) = edit { super.commitText(text, newCursorPosition) }
    override fun setComposingText(text: CharSequence?, newCursorPosition: Int) = edit { super.setComposingText(text, newCursorPosition) }
    override fun setComposingRegion(start: Int, end: Int) = edit { super.setComposingRegion(start, end) }
    override fun finishComposingText() = edit { super.finishComposingText() }
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int) = edit { super.deleteSurroundingText(beforeLength, afterLength) }
    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int) = edit { super.deleteSurroundingTextInCodePoints(beforeLength, afterLength) }
    override fun setSelection(start: Int, end: Int) = edit { super.setSelection(start, end) }
    override fun sendKeyEvent(event: KeyEvent?) = edit { super.sendKeyEvent(event) }
    override fun performEditorAction(editorAction: Int) = edit { super.performEditorAction(editorAction) }
    override fun performContextMenuAction(id: Int) = edit { super.performContextMenuAction(id) }
    override fun commitCompletion(text: CompletionInfo?) = edit { super.commitCompletion(text) }
    override fun commitCorrection(correctionInfo: CorrectionInfo?) = edit { super.commitCorrection(correctionInfo) }
    override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?) =
        edit { super.commitContent(inputContentInfo, flags, opts) }

    companion object {
        fun wrap(target: InputConnection, onActivity: () -> Unit): InputConnection = when {
            Build.VERSION.SDK_INT >= 34 -> Api34(target, onActivity)
            Build.VERSION.SDK_INT >= 33 -> Api33(target, onActivity)
            else -> IdleInputConnection(target, onActivity)
        }
    }

    // Isolate newer signature types from class loading on older supported TVs.
    @RequiresApi(33)
    private open class Api33(target: InputConnection, onActivity: () -> Unit) : IdleInputConnection(target, onActivity) {
        override fun commitText(text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?) =
            edit { super.commitText(text, newCursorPosition, textAttribute) }
        override fun setComposingText(text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?) =
            edit { super.setComposingText(text, newCursorPosition, textAttribute) }
        override fun setComposingRegion(start: Int, end: Int, textAttribute: TextAttribute?) =
            edit { super.setComposingRegion(start, end, textAttribute) }
    }

    @RequiresApi(34)
    private class Api34(target: InputConnection, onActivity: () -> Unit) : Api33(target, onActivity) {
        override fun replaceText(start: Int, end: Int, text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?) =
            edit { super.replaceText(start, end, text, newCursorPosition, textAttribute) }
        override fun performHandwritingGesture(gesture: HandwritingGesture, executor: Executor?, consumer: IntConsumer?) {
            edit { super.performHandwritingGesture(gesture, executor, consumer); true }
        }
    }
}
