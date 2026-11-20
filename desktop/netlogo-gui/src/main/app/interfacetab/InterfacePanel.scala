// (C) Uri Wilensky. https://github.com/NetLogo/NetLogo
// Modified for MemoSim, a modified fork of NetLogo: MemoSim interface layout. Changed 2026-11-18. Licensed GPL-2.0-or-later as part of MemoSim.

package org.nlogo.app.interfacetab

import java.awt.{ Dimension, Graphics, Graphics2D, Font, Point, Rectangle, RenderingHints }
import java.awt.event.{ ActionEvent, FocusEvent, FocusListener, KeyEvent }
import java.awt.image.BufferedImage
import javax.swing.{ AbstractAction, JViewport, Scrollable, SwingConstants }

import org.nlogo.api.{ Exceptions, Version }
import org.nlogo.app.common.{ FileActions, UndoRedoActions },
  FileActions.ExportInterfaceAction
import org.nlogo.awt.Images
import org.nlogo.core.{
  AgentKind, I18N, Button => CoreButton, Chooser => CoreChooser, InputBox => CoreInputBox, Monitor => CoreMonitor,
  Output => CoreOutput, Plot => CorePlot, Slider => CoreSlider, Switch => CoreSwitch, TextBox => CoreTextBox,
  View => CoreView, Widget => CoreWidget }
import org.nlogo.editor.EditorArea
import org.nlogo.log.LogManager
import org.nlogo.swing.{ ClipboardUtils, MenuItem, PopupMenu }
import org.nlogo.theme.{ DarkTheme, InterfaceColors }
import org.nlogo.window.{ AutoIndentHandler, ButtonWidget, ChooserWidget, Editable, EditDialogFactory,
                          Events => WindowEvents, GUIWorkspace, InputBoxWidget, InterfaceGlobalWidget, InterfaceMode,
                          MonitorWidget, PlotWidget, SliderWidget, SwitchWidget, ViewWidget, ViewWidgetInterface,
                          Widget, WidgetInfo, WidgetRegistry },
  WindowEvents.{ CompileAllEvent, LoadBeginEvent, LoadWidgetsEvent, RemoveConstraintEvent, WidgetRemovedEvent }
import org.nlogo.workspace.Evaluator

class InterfacePanel(val viewWidget: ViewWidgetInterface, workspace: GUIWorkspace, dialogFactory: EditDialogFactory)
  extends WidgetPanel(workspace.getFrame, workspace, WidgetInfo.primaryInfos, dialogFactory)
  with FocusListener
  with LoadWidgetsEvent.Handler
  with UndoRedoActions
  with Scrollable {

  private var dashboardEnabled = true
  private var loadingDashboard = false
  private var observedViewport: Option[JViewport] = None
  private var viewportListener: Option[javax.swing.event.ChangeListener] = None

  def setDashboardEnabled(enabled: Boolean): Unit = {
    dashboardEnabled = enabled
    if (!dashboardActive) restoreWidgetBounds()
    revalidate()
    repaint()
  }

  private def dashboardActive: Boolean =
    dashboardEnabled && !loadingDashboard && interfaceMode == InterfaceMode.Interact && !Version.is3D

  private def wrappers: Seq[WidgetWrapper] =
    getComponents.collect { case w: WidgetWrapper => w }.toSeq

  private def restoreWidgetBounds(): Unit =
    wrappers.foreach { wrapper =>
      wrapper.setVisible(true)
      wrapper.zoomComponent()
      wrapper.widget match {
        case monitor: MonitorWidget => monitor.setNumericPresentation(false)
        case _ =>
      }
    }

  override def setInterfaceMode(mode: InterfaceMode, focus: Boolean): Unit = {
    if (dashboardActive && mode != InterfaceMode.Interact) restoreWidgetBounds()
    super.setInterfaceMode(mode, focus)
  }

  override def editWidget(widget: Editable): Unit = {
    if (dashboardActive) setInterfaceMode(InterfaceMode.Edit, false)
    super.editWidget(widget)
  }

  override def loadWidgets(widgets: Seq[CoreWidget], convertWidgetSizes: Boolean): Unit = {
    loadingDashboard = true
    try super.loadWidgets(widgets, convertWidgetSizes)
    finally {
      loadingDashboard = false
      revalidate()
      repaint()
    }
  }

  private def controls: Seq[WidgetWrapper] =
    wrappers.filter(w => w.widget != viewWidget && !isAnalytics(w))
      .sortBy(w => (if (w.widget.isButton) 0 else if (w.widget.isNote) 2 else 1,
        w.widget.getUnzoomedBounds.y, w.widget.getUnzoomedBounds.x))

  private def analytics: Seq[WidgetWrapper] =
    wrappers.filter(isAnalytics).sortBy(w => (if (w.widget.isInstanceOf[MonitorWidget]) 0 else 1,
      w.widget.getUnzoomedBounds.y, w.widget.getUnzoomedBounds.x))

  private def isAnalytics(w: WidgetWrapper): Boolean =
    w.widget.isInstanceOf[MonitorWidget] || w.widget.isInstanceOf[PlotWidget] ||
      w.widget.isInstanceOf[org.nlogo.window.OutputWidget]

  private def presentationHeight(w: WidgetWrapper): Int =
    zoom(w.widget.getUnzoomedBounds.height).max(w.getMinimumSize.height).max(
      if (w.widget.isInstanceOf[PlotWidget]) zoom(220) else zoom(48))

  private def columnWidth(widgets: Seq[WidgetWrapper], default: Int): Int =
    widgets.map(_.getMinimumSize.width + 24).foldLeft(zoom(default))(_.max(_))

  private def dashboardGeometry: MemoSimLayout.Dashboard = {
    val extent = getParent match {
      case viewport: JViewport => viewport.getExtentSize
      case _ => getSize
    }
    MemoSimLayout.dashboard(extent, columnWidth(controls, 260), columnWidth(analytics, 320),
      controls.map(presentationHeight), analytics.map(presentationHeight))
  }

  override def getPreferredSize: Dimension =
    if (dashboardActive) dashboardGeometry.size else super.getPreferredSize

  override def getPreferredScrollableViewportSize: Dimension = getPreferredSize
  override def getScrollableTracksViewportWidth: Boolean =
    dashboardActive && getParent != null && getParent.getWidth >= dashboardGeometry.size.width
  override def getScrollableTracksViewportHeight: Boolean =
    dashboardActive && getParent != null && getParent.getHeight >= dashboardGeometry.size.height
  override def getScrollableUnitIncrement(r: Rectangle, orientation: Int, direction: Int): Int = 20
  override def getScrollableBlockIncrement(r: Rectangle, orientation: Int, direction: Int): Int =
    if (orientation == SwingConstants.VERTICAL) r.height else r.width

  override def doLayout(): Unit = {
    super.doLayout()
    getParent match {
      case viewport: JViewport if !observedViewport.contains(viewport) =>
        for (oldViewport <- observedViewport; listener <- viewportListener)
          oldViewport.removeChangeListener(listener)
        val listener = new javax.swing.event.ChangeListener {
          override def stateChanged(e: javax.swing.event.ChangeEvent): Unit = {
            revalidate()
            repaint()
          }
        }
        viewport.addChangeListener(listener)
        observedViewport = Some(viewport)
        viewportListener = Some(listener)
      case _ =>
    }
    if (dashboardActive) {
      val geometry = dashboardGeometry
      wrappers.foreach(_.setVisible(true))
      def place(widgets: Seq[WidgetWrapper], cells: Seq[Rectangle]): Unit = {
        widgets.zip(cells).foreach { case (wrapper, cell) =>
          wrapper.widget match {
            case monitor: MonitorWidget => monitor.setNumericPresentation(true)
            case _ =>
          }
          wrapper.setBounds(cell)
        }
      }
      place(controls, geometry.controlCells)
      place(analytics, geometry.analyticsCells)
      val view = viewWidget.asInstanceOf[ViewWidget]
      val area = new Rectangle(geometry.simulation)
      getParent match {
        case viewport: JViewport if !geometry.compact => area.y += viewport.getViewPosition.y
        case _ =>
      }
      area.x += 12
      area.y += 58
      area.width -= 24
      area.height -= 70
      wrappers.find(_.widget == viewWidget).foreach(_.setBounds(MemoSimLayout.fitView(area,
        workspace.world.worldWidth, workspace.world.worldHeight, new Dimension(view.insetWidth, view.getExtraHeight))))
    }
  }

  override def paintComponent(g: Graphics): Unit = {
    super.paintComponent(g)
    if (dashboardActive) {
      val palette = MemoSimTheme.palette(InterfaceColors.getTheme == DarkTheme)
      val geometry = dashboardGeometry
      val g2 = g.create().asInstanceOf[Graphics2D]
      try {
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.setColor(palette.canvas)
        g2.fillRect(0, 0, getWidth, getHeight)
        val simulation = new Rectangle(geometry.simulation)
        getParent match {
          case viewport: JViewport if !geometry.compact => simulation.y += viewport.getViewPosition.y
          case _ =>
        }
        Seq((simulation, "SIMULATION", "Your model, in motion", palette.accent),
            (geometry.controls, "CONTROLS", "Adjust and explore", palette.teal),
            (geometry.analytics, "LIVE ANALYTICS", "Watch the response", palette.violet)).foreach {
          case (area, title, subtitle, accent) =>
            g2.setColor(palette.surface)
            g2.fillRoundRect(area.x, area.y, area.width, area.height, 18, 18)
            g2.setColor(palette.border)
            g2.drawRoundRect(area.x, area.y, area.width - 1, area.height - 1, 18, 18)
            g2.setColor(accent)
            g2.fillRoundRect(area.x + 14, area.y + 15, 4, 26, 4, 4)
            g2.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 12))
            g2.drawString(title, area.x + 28, area.y + 25)
            g2.setColor(palette.secondary)
            g2.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 11))
            g2.drawString(subtitle, area.x + 28, area.y + 42)
        }
        g2.setFont(new Font(Font.SANS_SERIF, Font.PLAIN, 12))
        g2.setColor(palette.secondary)
        if (controls.isEmpty) g2.drawString("This model has no controls yet.", geometry.controls.x + 16, 100)
        if (analytics.isEmpty) g2.drawString("Add a plot or monitor to see results.", geometry.analytics.x + 16, 100)
      } finally g2.dispose()
    }
  }

  // in 3d don't add the view widget since it's always
  // disabled there's no reason for it to take space 7/5/07
  if (!Version.is3D)
    addWidget(viewWidget.asInstanceOf[Widget], 0, 0, false, false)

  viewWidget.asInstanceOf[Widget].deleteable = false
  addFocusListener(this)

  ///

  override def focusGained(e: FocusEvent): Unit = {
    enableButtonKeys(true)
  }

  override def focusLost(e: FocusEvent): Unit = {
    enableButtonKeys(false)
  }

  ///

  override protected def doPopup(point: Point, focusTraversal: Boolean = false): Unit = {
    if (interfaceMode == InterfaceMode.Interact)
      interceptPane.disableIntercept()

    val menu = new PopupMenu(this)

    Seq(WidgetInfo.button,
      WidgetInfo.slider,
      WidgetInfo.switch,
      WidgetInfo.chooser,
      WidgetInfo.input,
      WidgetInfo.monitor,
      WidgetInfo.plot)
    .map(i => i.displayName -> i.widgetThunk)
    .foreach {
        case (displayName, widgetThunk) =>
          menu.add(new WidgetCreationMenuItemIP(displayName, widgetThunk(), focusTraversal))
    }

    // add all the widgets
    val outputItem = new WidgetCreationMenuItemIP(I18N.gui.get("tabs.run.widgets.output"), CoreOutput(0, 0, 0, 0, 11),
                                                  focusTraversal)
    if (getOutputWidget != null) {
      outputItem.setEnabled(false)
    }
    menu.add(outputItem)

    menu.add(new WidgetCreationMenuItemIP(I18N.gui.get("tabs.run.widgets.note"), CoreTextBox(None, fontSize = 11),
                                          focusTraversal))

    menu.addSeparator()

    menu.add(new MenuItem(new AbstractAction(I18N.gui.get("tabs.run.widget.copySelected")) {
      def actionPerformed(e: ActionEvent): Unit = {
        copySelectedWidgets()
      }
    })).setEnabled(selectedWrappers.nonEmpty)

    menu.add(new MenuItem(new AbstractAction(I18N.gui.get("tabs.run.widgets.paste")) {
      def actionPerformed(e: ActionEvent): Unit = {
        pasteWidgets()
      }
    })).setEnabled(ClipboardUtils.hasWidgets)

    // add extra stuff
    menu.addSeparator()
    menu.add(new MenuItem(new ExportInterfaceAction(workspace, this)))

    menu.show(this, point.x, point.y)
  }

  class WidgetCreationMenuItemIP(val displayName: String, val coreWidget: CoreWidget, focusTraversal: Boolean)
    extends MenuItem(new AbstractAction(displayName) {
      def actionPerformed(e: ActionEvent): Unit = {
        unselectWidgets()

        if (focusTraversal) {
          createShadowWidget(coreWidget, Some(new Point(50, 50)))
        } else {
          createShadowWidget(coreWidget)
        }
      }
    })

  // This is used both when loading a model and when the user is making
  // new widgets in the UI.  For most widget types, the same type string
  // is used in both places. - ST 3/17/04
  override def makeWidget(coreWidget: CoreWidget): Widget = {
    val fromRegistry = WidgetRegistry(coreWidget.getClass.getSimpleName)
    if (fromRegistry != null)
      fromRegistry
    else coreWidget match {
      case c: CoreChooser  => new ChooserWidget(workspace, dialogFactory.colorizer, workspace.getExtensionManager)
      case b: CoreButton   => new ButtonWidget(workspace.world.mainRNG, workspace, dialogFactory.colorizer)
      case p: CorePlot     => PlotWidget(workspace.plotManager, workspace, dialogFactory.colorizer)
      case m: CoreMonitor  => new MonitorWidget(workspace.world.auxRNG, workspace, dialogFactory.colorizer)
      case s: CoreSlider =>
        new SliderWidget(workspace.world.auxRNG, workspace, dialogFactory.colorizer, workspace.getExtensionManager) {
          override def sourceOffset: Int =
            Evaluator.sourceOffset(AgentKind.Observer, false)
        }
      case s: CoreSwitch => new SwitchWidget(workspace, workspace.getExtensionManager)
      case i: CoreInputBox =>
        val textArea       = new EditorArea(textEditorConfiguration) with AutoIndentHandler
        val dialogTextArea = new EditorArea(dialogEditorConfiguration) with AutoIndentHandler

        new InputBoxWidget(textArea, dialogTextArea, workspace, workspace.getExtensionManager, this)
      case v: CoreView => new ViewWidget(workspace)
      case _ =>
        throw new IllegalStateException("unknown widget type: " + coreWidget.getClass.getName)
    }
  }

  override private[app] def deleteWidgets(hitList: Seq[WidgetWrapper]): Unit = {
    var needsRecompile: Boolean = false
    for (wrapper <- hitList) {
      removeWidget(wrapper)
      wrapper.widget match {
        case _: InterfaceGlobalWidget => needsRecompile = true
        case _ =>
      }
    }
    setForegroundWrapper()
    revalidate()
    repaint() // you wouldn't think this'd be necessary, but without it
    // the widget didn't visually disappear - ST 6/23/03
    if (needsRecompile) {
      new CompileAllEvent().raise(this)
    }
  }

  override protected def removeWidget(wrapper: WidgetWrapper): Unit = {
    remove(wrapper)

    // if the compile that is associated with this removal (assuming there is one) fails
    // the observer variables and constraints might not get reallocated in which case
    // if we try to add a different widget with the same name we get a constraint violation
    // from the old constraint. yuck.  ev 11/27/07
    new RemoveConstraintEvent(wrapper.widget.displayName).raise(this)

    LogManager.widgetRemoved(true, wrapper.widget.classDisplayName, wrapper.widget.displayName)
  }

  /// loading and saving

  override def loadWidget(coreWidget: CoreWidget): Widget =
    loadWidget(coreWidget, 0, 0)

  // TODO: consider cleaning up this x and y business
  // it was added for copying/pasting widgets.
  // the regular loadWidget just uses the x and y from the string array
  // it passes in x=0, y=0 and we do a check. ugly, but works for now.
  // paste uses the x and y from the right click location.
  private def loadWidget(coreWidget: CoreWidget, _x: Int, _y: Int): Widget = {
    val x = if (_x == 0) coreWidget.x else _x
    val y = if (_y == 0) coreWidget.y  else _y
    coreWidget match {
      case view: CoreView =>
        // the graphics widget (and the command center) are special cases because
        // they are not recreated at load time, but reused
        viewWidget.load(view)
        viewWidget.setUnzoomedBounds(x, y, view.width, view.height)
        // in 3D we don't add the viewWidget to the interface panel
        // so don't worry about all the sizing junk ev 7/5/07
        val parent = viewWidget.getParent
        if (parent != null) {
          parent.setSize(zoomSize(viewWidget.getSize))
          enforceMinimumAndMaximumWidgetSizes(viewWidget)
          parent.setLocation(zoom(x), zoom(y))
        }
        viewWidget
      case _ =>
        makeAndLoadWidget(coreWidget, x, y)
    }
  }

  override def getWidgetsForSaving: Seq[CoreWidget] =
    // automatically add the view widget since it isn't in
    // the components list in 3D - ev 7/5/07
    (viewWidget.model +: getComponents.reverse.collect {
      case wrapper: WidgetWrapper => wrapper.widget.model
    }).distinct.toIndexedSeq

  override private[app] def contains(w: Editable): Boolean =
    if (viewWidget.getEditable.contains(w))
      true
    else
      super.contains(w)

  override def handle(e: WidgetRemovedEvent): Unit = {
    // We use `raiseLater` to ensure that the WidgetRemovedEvent
    // propagates to the Compiler.
    if (e.widget.getWidgetContainer.contains(this) && !unloading)
      new CompileAllEvent().raiseLater(this)
  }

  def interfaceImage: BufferedImage =
    Images.paintToImage(this)

  def handle(e: LoadWidgetsEvent): Unit = {
    loadWidgets(e.widgets, e.convertWidgetSizes)
  }

  private var unloading = false

  override def handle(e: LoadBeginEvent): Unit = {
    unloading = true
    super.handle(e)
    unloading = false
  }

  override def removeAllWidgets(): Unit = {
    try {
      setVisible(false)
      for (component <- getComponents) {
        component match {
          case w: WidgetWrapper if w.widget != viewWidget =>
            removeWidget(w)
          case _ =>
        }
      }
    } catch {
      case ex: RuntimeException => Exceptions.handle(ex)
    } finally {
      setVisible(false)
    }
  }

  /// buttons

  private def findActionButton(key: Char): ButtonWidget = {
    getComponents.collect {
      case w: WidgetWrapper => w.widget
    }.collect {
      case b: ButtonWidget if b.actionKey.toUpper == key.toUpper => b
    }.headOption.orNull
  }

  private def enableButtonKeys(enabled: Boolean): Unit =
    getComponents.collect {
      case w: WidgetWrapper => w.widget
    }.foreach {
      case b: ButtonWidget => b.keyEnabled(enabled)
      case _ =>
    }

  override def keyTyped(e: KeyEvent): Unit = {
    if (interfaceMode == InterfaceMode.Interact && e.getKeyChar() != KeyEvent.CHAR_UNDEFINED && !e.isActionKey &&
        (e.getModifiersEx & getToolkit.getMenuShortcutKeyMaskEx) == 0) {
      Option(findActionButton(e.getKeyChar)).foreach { button =>
        button.keyTriggered()
      }
    }
  }

  override def canAddWidget(widget: String): Boolean = {
    return (widget != "Output" || getOutputWidget == null)
  }
}
