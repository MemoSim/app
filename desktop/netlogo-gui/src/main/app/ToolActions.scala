// (C) Uri Wilensky. https://github.com/NetLogo/NetLogo
// Modified for MemoSim, a modified fork of NetLogo: MemoSim tool menu integration. Changed 2026-11-19. Licensed GPL-2.0-or-later as part of MemoSim.

package org.nlogo.app

import java.awt.Frame
import java.awt.event.{ ActionEvent, KeyEvent }
import java.nio.file.Path
import javax.swing.{ AbstractAction, JDialog }

import org.nlogo.api.{ AggregateManagerInterface, LibraryManager }
import org.nlogo.app.common.AppTabsInterface
import org.nlogo.app.interfacetab.WidgetPanel
import org.nlogo.app.tools.{ LibrariesDialog, PreferencesDialog }
import org.nlogo.awt.Positioning
import org.nlogo.core.{ I18N, Token }
import org.nlogo.shape.ShapesManagerInterface
import org.nlogo.swing.{ OptionPane, UserAction }, UserAction._
import org.nlogo.theme.ThemeSync
import org.nlogo.window.{ AbstractWidgetPanel, CopyOnly, JFXColorPicker, LinkRoot, NLNumber }
import org.nlogo.workspace.AbstractWorkspaceScala

abstract class ShowDialogAction(name: String) extends AbstractAction(name) with ThemeSync {
  protected def createDialog(): JDialog & ThemeSync

  lazy protected val createdDialog = createDialog()

  override def actionPerformed(e: ActionEvent): Unit = {
    createdDialog.toFront()
    createdDialog.setVisible(true)
  }

  override def syncTheme(): Unit = {
    createdDialog.syncTheme()
  }
}

// MemoSim (2026-11-18): native fullscreen, independent of the embedded page.
class ToggleMemoSimFullScreen(frame: javax.swing.JFrame)
extends AbstractAction("Full Screen") with MenuAction {
  category = ToolsCategory
  group = ToolsSettingsGroup
  override def actionPerformed(e: ActionEvent): Unit = org.nlogo.chat.FullScreen.toggle(frame)
}

class ShowPreferencesDialog(frame: Frame & ThemeSync, tabs: AppTabsInterface, widgetPanel: AbstractWidgetPanel)
extends AbstractAction(I18N.gui.get("menu.tools.preferences")) with ThemeSync
with MenuAction {
  category = ToolsCategory
  group    = ToolsSettingsGroup
  mnemonic = 'P'

  private lazy val dialog = new PreferencesDialog(frame, tabs, widgetPanel)

  override def actionPerformed(e: ActionEvent): Unit = {
    openToTab(0)
  }

  override def syncTheme(): Unit = {
    dialog.syncTheme()
  }

  def openToTab(index: Int): Unit = {
    dialog.setSelectedIndex(index)
    dialog.toFront()
    dialog.setVisible(true)
  }
}

class OpenLibrariesDialog( frame:              Frame
                         , libManager:         LibraryManager
                         , recompile:          () => Unit
                         , tokenizeSource:     String => Iterator[Token]
                         , updateSource:       ((String) => String) => Unit
                         , getExtPathMappings: () => Map[String, Path]
                         ) extends ShowDialogAction(I18N.gui.get("menu.tools.extensions")) with MenuAction {

  category = ToolsCategory
  group    = ToolsSettingsGroup
  mnemonic = 'E'

  def createDialog() = new LibrariesDialog(frame, libManager, recompile, tokenizeSource, updateSource,
                                           getExtPathMappings())

}

class OpenRGBAColorDialog(frame: Frame) extends ShowDialogAction(I18N.gui.get("menu.tools.rgbaColorPicker"))
                                        with MenuAction {
  category = ToolsCategory
  group = ToolsDialogsGroup
  mnemonic = 'C'

  def createDialog() = new JFXColorPicker(frame, false, CopyOnly, Option(NLNumber(15)))

  override def actionPerformed(e: ActionEvent): Unit = {
    Positioning.center(createdDialog, frame)

    super.actionPerformed(e)
  }
}

class ShowShapeManager(key: String, shapeManager: => ShapesManagerInterface)
extends AbstractAction(I18N.gui.get(s"menu.tools.$key"))
with MenuAction {
  category = ToolsCategory
  group    = ToolsDialogsGroup

  override def actionPerformed(e: ActionEvent): Unit = {
    shapeManager.init(I18N.gui.get(s"menu.tools.$key"))
  }
}

class ShowSystemDynamicsModeler(aggregateManager: AggregateManagerInterface,
                               chatPanel: () => Option[org.nlogo.chat.ChatPanel] = () => None)
extends AbstractAction(I18N.gui.get("menu.tools.systemDynamicsModeler"))
with MenuAction {
  category    = ToolsCategory
  group       = ToolsDialogsGroup
  accelerator = KeyBindings.keystroke('D', withMenu = true, withShift = true)
  mnemonic    = KeyEvent.VK_D

  override def actionPerformed(e: ActionEvent): Unit = {
    // One modeler only: the chat pane's diagram view (it keeps the assistant beside the diagram).
    if (org.nlogo.chat.StockFlowEntry.available) org.nlogo.chat.StockFlowEntry.open()
    else chatPanel() match {
      case Some(panel) => panel.showModeler()
      case None => aggregateManager.showEditor()
    }
  }
}

class OpenHubNetClientEditor(workspace: AbstractWorkspaceScala, linkRoot: LinkRoot)
extends AbstractAction(I18N.gui.get("menu.tools.hubNetClientEditor"))
with MenuAction {
  category = ToolsCategory
  group    = ToolsHubNetGroup
  mnemonic = 'B'

  override def actionPerformed(e: ActionEvent): Unit = {
    workspace.getHubNetManager.foreach { mgr =>
      mgr.openClientEditor()
      linkRoot.addLinkComponent(mgr.clientEditor)
    }
  }
}

class ConvertWidgetSizes(frame: AppFrame, widgetPanel: WidgetPanel)
  extends AbstractAction(I18N.gui.get("menu.tools.convertWidgetSizes")) with MenuAction {

  category = ToolsCategory
  group    = ToolsWidgetGroup
  mnemonic = 'W'

  override def actionPerformed(e: ActionEvent): Unit = {
    if (new OptionPane(frame, I18N.gui.get("menu.tools.convertWidgetSizes"),
                       I18N.gui.get("menu.tools.convertWidgetSizes.prompt"),
                       Seq(I18N.gui.get("menu.tools.convertWidgetSizes.resizeAndAdjust"),
                           I18N.gui.get("common.buttons.cancel")),
                       OptionPane.Icons.info).getSelectedIndex == 0) {
      widgetPanel.convertWidgetSizes()

      frame.smartPack(frame.getPreferredSize, false)
    }
  }
}
