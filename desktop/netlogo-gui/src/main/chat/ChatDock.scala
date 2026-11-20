// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.awt.{ BorderLayout, Component, Dimension, Font, KeyboardFocusManager }
import javax.swing.{ BorderFactory, JLabel, JPanel, SwingUtilities }

import org.nlogo.swing.Button
import org.nlogo.theme.{ InterfaceColors, ThemeSync }

/** Swing controls around the live chat. Collapse only changes the visibility of its containing panel. */
final class ChatDock(content: Component, initiallyCollapsed: Boolean, saveCollapsed: Boolean => Unit)
extends JPanel(new BorderLayout) with ThemeSync {
  private val expandedWidth = 460
  private val railWidth = 38
  private var collapsed = initiallyCollapsed
  private var wide = false
  private var hiddenNeighbours: Seq[Component] = Nil

  private val title = new JLabel("MemoSim Assistant")
  title.setFont(title.getFont.deriveFont(Font.BOLD))

  private val hideButton = new Button("Hide chat", () => setCollapsed(true))
  hideButton.setToolTipText("Hide MemoSim Assistant chat")

  private val showButton = new Button("<html><center>Show<br>chat</center></html>", () => setCollapsed(false))
  showButton.setFont(showButton.getFont.deriveFont(11f))
  showButton.setBorder(BorderFactory.createEmptyBorder(6, 0, 6, 0))
  showButton.getAccessibleContext.setAccessibleName("Show chat")
  showButton.setToolTipText("Show MemoSim Assistant chat")

  private val header = new JPanel(new BorderLayout(8, 0))
  header.setOpaque(false)
  header.add(title, BorderLayout.CENTER)
  header.add(hideButton, BorderLayout.EAST)

  private val expanded = new JPanel(new BorderLayout)
  expanded.setOpaque(false)
  expanded.add(header, BorderLayout.NORTH)
  expanded.add(content, BorderLayout.CENTER)
  expanded.setVisible(!collapsed)

  private val rail = new JPanel(new BorderLayout)
  rail.setOpaque(false)
  rail.setBorder(BorderFactory.createEmptyBorder(6, 3, 0, 3))
  rail.add(showButton, BorderLayout.NORTH)
  rail.setVisible(collapsed)

  add(expanded, BorderLayout.CENTER)
  add(rail, BorderLayout.NORTH)
  content match {
    case panel: ChatPanel => panel.wideHandler = setWide
    case _                =>
  }
  syncTheme()

  def isCollapsed: Boolean = collapsed

  /** Called on the Swing event thread by both the native controls and the Tools action. */
  def setCollapsed(value: Boolean): Unit = {
    if (collapsed != value) {
      val focusOwner = KeyboardFocusManager.getCurrentKeyboardFocusManager.getFocusOwner
      val transferFocus = focusOwner != null && SwingUtilities.isDescendingFrom(focusOwner, this)

      val previous = collapsed
      collapsed = value
      expanded.setVisible(!collapsed)
      rail.setVisible(collapsed)
      revalidate()
      repaint()

      if (transferFocus) {
        val next = if (collapsed) showButton else hideButton
        next.requestFocusInWindow()
      }

      firePropertyChange("collapsed", previous, collapsed)
      saveCollapsed(collapsed)
    }
  }

  override def getPreferredSize: Dimension =
    new Dimension(
      if (wide) Option(getParent).map(_.getWidth).filter(_ > 0).getOrElse(expandedWidth)
      else if (collapsed) railWidth else expandedWidth,
      super.getPreferredSize.height)

  override def getMinimumSize: Dimension = {
    val minimum = super.getMinimumSize
    if (wide) new Dimension(0, minimum.height) else if (collapsed) new Dimension(railWidth, minimum.height) else minimum
  }

  /** The diagram editor needs more than the 460 px dock: hand it the whole window and restore the dock afterwards. */
  def setWide(value: Boolean): Unit = {
    if (wide == value) return
    wide = value
    if (value) {
      if (collapsed) setCollapsed(false)
      header.setVisible(false) // the page brings its own chat visibility control while the modeler owns the window
      Option(getParent).foreach { parent =>
        hiddenNeighbours = parent.getComponents.toSeq.filter(c => (c ne this) && c.isVisible)
        hiddenNeighbours.foreach(_.setVisible(false))
        parent.revalidate()
      }
      // Keyboard focus must land in the page, otherwise Esc never reaches its own handler.
      javax.swing.SwingUtilities.invokeLater(() => content.requestFocusInWindow())
    } else {
      header.setVisible(true)
      hiddenNeighbours.foreach(_.setVisible(true))
      hiddenNeighbours = Nil
    }
    syncEscape(value)
    revalidate()
    Option(getParent).foreach(_.revalidate())
    repaint()
  }

  /** Escape always leaves the modeler view, even if the page is busy and its own buttons do not react. */
  private val escapeAction = new javax.swing.AbstractAction("memosim-exit-modeler") {
    override def actionPerformed(e: java.awt.event.ActionEvent): Unit = {
      content match {
        case panel: ChatPanel => panel.closeDiagram()
        case _                =>
      }
      setWide(false)
    }
  }

  private def syncEscape(wide: Boolean): Unit =
    Option(javax.swing.SwingUtilities.getRootPane(this)).foreach { root =>
      val key = javax.swing.KeyStroke.getKeyStroke(java.awt.event.KeyEvent.VK_ESCAPE, 0)
      val map = root.getInputMap(javax.swing.JComponent.WHEN_IN_FOCUSED_WINDOW)
      if (wide) {
        map.put(key, "memosim-exit-modeler")
        root.getActionMap.put("memosim-exit-modeler", escapeAction)
      } else {
        map.remove(key)
        root.getActionMap.remove("memosim-exit-modeler")
      }
    }

  def isWide: Boolean = wide

  /** Called by the native stock & flow button: show the chat, then open the diagram in it. */
  def openDiagram(): Unit = {
    if (collapsed) setCollapsed(false)
    content match {
      case panel: ChatPanel => panel.wideHandler = setWide; panel.openDiagram()
      case _                =>
    }
  }

  override def syncTheme(): Unit = {
    val separator = InterfaceColors.toolbarSeparator()
    setBackground(InterfaceColors.toolbarBackground())
    setBorder(BorderFactory.createMatteBorder(0, 1, 0, 0, separator))
    header.setBorder(BorderFactory.createCompoundBorder(
      BorderFactory.createMatteBorder(0, 0, 1, 0, separator),
      BorderFactory.createEmptyBorder(6, 12, 6, 8)))
    title.setForeground(InterfaceColors.toolbarText())
    hideButton.syncTheme()
    showButton.syncTheme()
    repaint()
  }
}
