// MemoSim fullscreen controls (2026-11-18). GPL v2 or later.
package org.nlogo.chat

import java.awt.Frame
import java.awt.event.{ ActionEvent, InputEvent, KeyEvent }
import javax.swing.{ AbstractAction, JComponent, JFrame, KeyStroke }

object FullScreen {
  def toggle(frame: JFrame): Unit = {
    val native = try {
      val utilities = Class.forName("com.apple.eawt.FullScreenUtilities")
      utilities.getMethod("setWindowCanFullScreen", classOf[java.awt.Window], java.lang.Boolean.TYPE)
        .invoke(null, frame, java.lang.Boolean.TRUE)
      val application = Class.forName("com.apple.eawt.Application")
      val instance = application.getMethod("getApplication").invoke(null)
      application.getMethod("requestToggleFullScreen", classOf[java.awt.Window]).invoke(instance, frame)
      true
    } catch { case _: ReflectiveOperationException => false }
    if (!native) {
      val maximized = (frame.getExtendedState & Frame.MAXIMIZED_BOTH) != 0
      frame.setExtendedState(if (maximized) Frame.NORMAL else Frame.MAXIMIZED_BOTH)
    }
  }

  def install(frame: JFrame): Unit = {
    try Class.forName("com.apple.eawt.FullScreenUtilities")
      .getMethod("setWindowCanFullScreen", classOf[java.awt.Window], java.lang.Boolean.TYPE)
      .invoke(null, frame, java.lang.Boolean.TRUE)
    catch { case _: ReflectiveOperationException => () }
    val root = frame.getRootPane
    root.getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(KeyStroke.getKeyStroke(KeyEvent.VK_F11, 0), "memosim-fullscreen")
    root.getInputMap(JComponent.WHEN_IN_FOCUSED_WINDOW).put(
      KeyStroke.getKeyStroke(KeyEvent.VK_F, InputEvent.CTRL_DOWN_MASK | InputEvent.META_DOWN_MASK), "memosim-fullscreen")
    root.getActionMap.put("memosim-fullscreen", new AbstractAction {
      override def actionPerformed(e: ActionEvent): Unit = toggle(frame)
    })
  }
}
