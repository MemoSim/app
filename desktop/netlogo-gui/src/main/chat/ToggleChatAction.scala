// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.awt.event.ActionEvent
import javax.swing.{ AbstractAction, Action }

import org.nlogo.swing.UserAction.*

/** Tools entry for the same dock used by the native Hide chat and Show chat buttons. */
class ToggleChatAction(dock: Option[ChatDock])
extends AbstractAction("MemoSim Assistant") with MenuAction {
  category = ToolsCategory
  group    = ToolsDialogsGroup

  setEnabled(dock.isDefined)
  dock.foreach { chat =>
    updateLabel(chat)
    mnemonic = 'C'
    chat.addPropertyChangeListener("collapsed", _ => updateLabel(chat))
  }

  private def updateLabel(chat: ChatDock): Unit =
    putValue(Action.NAME, if (chat.isCollapsed) "Show MemoSim Assistant Chat" else "Hide MemoSim Assistant Chat")

  override def actionPerformed(e: ActionEvent): Unit =
    dock.foreach(chat => chat.setCollapsed(!chat.isCollapsed))
}
