package org.nlogo.app.interfacetab

import java.awt.{ Component, Container, Font, Point, Rectangle }
import javax.swing.{ JLabel, JPanel, JScrollPane, SwingUtilities }

import org.nlogo.app.App
import org.nlogo.core.{ Slider, Monitor }
import org.nlogo.swing.{ Zoomable, ZoomHelpers }
import org.nlogo.util.AnyFunSuiteEx
import org.nlogo.window.{ Editable, EditDialogFactory, EditorColorizer, InterfaceMode, MonitorWidget }

class MemoSimLifecycleTests extends AnyFunSuiteEx {
  test("real placement, concurrent dashboard, overflow and monitor zoom transitions") {
    App.reset()
    val app = App.createInstance(Array("--testing"))
    SwingUtilities.invokeAndWait(() => {
      val workspace = app.workspace
      val panel = new InterfacePanel(workspace.viewWidget, workspace, new EditDialogFactory(new EditorColorizer(workspace))) {
        override def editWidget(widget: Editable): Unit = {
          setInterfaceMode(InterfaceMode.Edit, false)
          editWidgetFinished(widget, false)
        }
      }
      try {
        panel.createShadowWidget(Slider(Some("test-slider")), Some(new Point(120, 160)))
        val wrapper = panel.getComponents.collectFirst {
          case w: WidgetWrapper if w.isPlacing => w
        }.get
        wrapper.setLocation(240, 280)
        val placed = new Rectangle(wrapper.widgetBounds)
        panel.placeSingleShadowWidget(wrapper)
        assert(wrapper.widget.getUnzoomedBounds == panel.unzoomBounds(placed))
        assert(wrapper.widget.getUnzoomedBounds.width > 0)

        panel.setInterfaceMode(InterfaceMode.Interact, false)
        val scroll = new JScrollPane(panel)
        scroll.setSize(200, 100)
        scroll.doLayout()
        panel.setSize(panel.getPreferredSize)
        panel.doLayout()
        assert(!panel.getScrollableTracksViewportWidth)
        assert(!panel.getScrollableTracksViewportHeight)
        assert(wrapper.getWidth >= wrapper.getMinimumSize.width)
        assert(wrapper.getHeight >= wrapper.getMinimumSize.height)
        assert(wrapper.widget.getUnzoomedBounds == panel.unzoomBounds(placed))

        val monitorWidget = panel.loadWidget(Monitor(Some("test"), 20, 30, 100, 60, false, Some("ticks"), 2))
        val monitorWrapper = panel.getComponents.collectFirst {
          case w: WidgetWrapper if w.widget == monitorWidget => w
        }.get
        val savedWidgets = panel.getWidgetsForSaving
        panel.doLayout()
        assert(wrapper.isVisible && monitorWrapper.isVisible)
        assert(!wrapper.getBounds.intersects(monitorWrapper.getBounds))
        assert(wrapper.getX < monitorWrapper.getX)
        assert(panel.getWidgetsForSaving == savedWidgets)
        monitorWrapper.setVisible(false)
        val order = panel.getFocusOrder
        assert(!order.contains(monitorWrapper))
        assert(!order.values.exists { case (before, after) => before == monitorWrapper || after == monitorWrapper })
        panel.doLayout()
        assert(monitorWrapper.isVisible)
        panel.setDashboardEnabled(false)
        assert(wrapper.widget.getUnzoomedBounds == panel.unzoomBounds(placed))
        assert(panel.getWidgetsForSaving == savedWidgets)

        val monitor = panel.makeWidget(Monitor(Some("test"), 0, 0, 100, 60, false, Some("ticks"), 2))
          .asInstanceOf[MonitorWidget]
        var factor = 1f
        val zoomRoot = new JPanel with ZoomHelpers {
          override def getZoomFactor: Float = factor
        }
        zoomRoot.add(monitor)
        zoomRoot.addNotify()
        def descendants(c: Container): Seq[Component] = c.getComponents.toSeq.flatMap {
          case child: Container => child +: descendants(child)
          case child => Seq(child)
        }
        val labels = descendants(monitor).collect { case label: (JLabel & Zoomable) => label }
        monitor.setNumericPresentation(true)
        val value = labels.find(_.getFont.getFamily == Font.MONOSPACED).get
        val base = value.getBaseFont
        value.setBaseFont(base.deriveFont(17f))
        value.zoom()
        assert(value.getFont.getFamily == Font.MONOSPACED)
        assert(value.getFont.getSize == 17)
        factor = 2f
        value.zoom()
        assert(value.getFont.getFamily == Font.MONOSPACED)
        assert(value.getFont.getSize == 34)
        monitor.setNumericPresentation(false)
        assert(value.getFont == value.getBaseFont.deriveFont(value.zoom(value.getBaseFont.getSize2D)))
        assert(value.getFont.getSize == 34)
        monitor.setNumericPresentation(true)
        factor = 1f
        value.zoom()
        monitor.setNumericPresentation(false)
        assert(value.getFont.getSize == 17)
        assert(monitor.fontSize == 17)
        zoomRoot.removeNotify()
      } finally {
        app.frame.dispose()
      }
    })
  }
}
