// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.awt.{ BorderLayout, Component, Container }
import javax.swing.{ Action, JButton, JMenuItem, JPanel, JTextField, SwingUtilities }

import scala.collection.mutable.ArrayBuffer

import org.nlogo.util.AnyFunSuiteEx

class ChatDockTests extends AnyFunSuiteEx {
  private def descendants(component: Component): Iterator[Component] =
    Iterator.single(component) ++ (component match {
      case container: Container => container.getComponents.iterator.flatMap(descendants)
      case _                     => Iterator.empty
    })

  test("native controls and Tools change one dock state and give the center its width back") {
    SwingUtilities.invokeAndWait(() => {
      val draft = new JTextField("Unsent draft")
      val changes = ArrayBuffer.empty[Boolean]
      val dock = new ChatDock(draft, false, collapsed => { changes += collapsed; () })
      val center = new JPanel
      val desktop = new JPanel(new BorderLayout)
      desktop.add(dock, BorderLayout.EAST)
      desktop.add(center, BorderLayout.CENTER)
      desktop.setSize(1200, 800)
      desktop.doLayout()

      def button(name: String): JButton = descendants(dock).collectFirst {
        case b: JButton if b.getAccessibleContext.getAccessibleName == name => b
      }.get

      val menuItem = new JMenuItem(new ToggleChatAction(Some(dock)))
      val originalParent = draft.getParent
      val expandedWidth = dock.getWidth
      val initialCenterWidth = center.getWidth
      assert(expandedWidth == 460)
      assert(menuItem.getText == "Hide MemoSim Assistant Chat")

      button("Hide chat").doClick(0)
      desktop.doLayout()
      assert(dock.isCollapsed)
      assert(dock.getWidth <= 40)
      assert(center.getWidth == initialCenterWidth + expandedWidth - dock.getWidth)
      assert(!originalParent.isVisible)
      assert(draft.getParent eq originalParent)
      assert(menuItem.getText == "Show MemoSim Assistant Chat")
      assert(button("Show chat").getToolTipText == "Show MemoSim Assistant chat")

      menuItem.doClick(0)
      desktop.doLayout()
      assert(!dock.isCollapsed)
      assert(center.getWidth == initialCenterWidth)
      assert(originalParent.isVisible)
      assert(draft.getParent eq originalParent)
      assert(draft.getText == "Unsent draft")

      menuItem.doClick(0)
      button("Show chat").doClick(0)
      assert(!dock.isCollapsed)
      assert(menuItem.getText == "Hide MemoSim Assistant Chat")
      assert(changes.toList == List(true, false, true, false))
    })
  }

  test("initial collapse applies without rewriting the preference, and absent chat disables Tools") {
    SwingUtilities.invokeAndWait(() => {
      val content = new JPanel
      var writes = 0
      val dock = new ChatDock(content, true, _ => writes += 1)
      val action = new ToggleChatAction(Some(dock))
      assert(dock.isCollapsed)
      assert(!content.getParent.isVisible)
      assert(dock.getPreferredSize.width <= 40)
      assert(action.getValue(Action.NAME) == "Show MemoSim Assistant Chat")
      dock.setCollapsed(true)
      assert(writes == 0)
      assert(!new ToggleChatAction(None).isEnabled)
    })
  }
}
