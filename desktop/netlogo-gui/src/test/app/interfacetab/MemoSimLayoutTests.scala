// MemoSim native presentation. GPL-2.0, same as NetLogo.
package org.nlogo.app.interfacetab

import java.awt.{ Dimension, Rectangle }
import javax.swing.SwingUtilities

import org.nlogo.core.{ TextBox, Widget => CoreWidget }
import org.nlogo.util.AnyFunSuiteEx
import org.nlogo.window.{ Editable, Widget }

class MemoSimLayoutTests extends AnyFunSuiteEx {
  test("dashboard palette distinguishes surfaces and section accents in both themes") {
    for (dark <- Seq(false, true)) {
      val palette = MemoSimTheme.palette(dark)
      assert(palette.canvas != palette.surface)
      assert(Set(palette.accent, palette.teal, palette.violet).size == 3)
    }
    assert(MemoSimTheme.palette(false).text != MemoSimTheme.palette(true).text)
  }

  test("dashboard shows simulation controls and analytics concurrently without overlap") {
    for (extent <- Seq(new Dimension(1600, 900), new Dimension(1000, 600), new Dimension(200, 100))) {
      val layout = MemoSimLayout.dashboard(extent, 260, 320, Seq(48, 60, 80), Seq(64, 260))
      val areas = Seq(layout.simulation, layout.controls, layout.analytics)
      assert(areas.forall(new Rectangle(0, 0, layout.size.width, layout.size.height).contains))
      assert(!layout.simulation.intersects(layout.controls))
      assert(!layout.controls.intersects(layout.analytics))
      assert(layout.controls.width >= 260)
      assert(layout.analytics.width >= 320)
      assert(layout.controls.y == layout.analytics.y)
    }
  }

  test("dashboard overflow retains the full height of oversized widgets") {
    val layout = MemoSimLayout.dashboard(new Dimension(300, 100), 400, 500, Seq(800), Seq(1200, 64))
    assert(layout.controls.height >= 800 + 70)
    assert(layout.analytics.height >= 1200 + 64 + 80)
    assert(layout.size.width > 300)
    assert(layout.size.height > 100)
  }

  test("collapsing chat frees space for a larger simulation and a compact parameter grid") {
    val heights = Seq.fill(8)(50)
    val expanded = MemoSimLayout.dashboard(new Dimension(1200, 800), 260, 320, heights, Seq(64, 220))
    val collapsed = MemoSimLayout.dashboard(new Dimension(1660, 800), 260, 320, heights, Seq(64, 220))
    assert(collapsed.simulation.width > expanded.simulation.width)
    assert(expanded.controlCells.map(_.x).distinct.size == 1)
    assert(collapsed.controlCells.map(_.x).distinct.size == 2)
    assert(collapsed.controlCells.map(_.y).distinct.size < expanded.controlCells.map(_.y).distinct.size)
    assert(collapsed.controlCells.forall(collapsed.controls.contains))
    for (cells <- Seq(expanded.controlCells, collapsed.controlCells); (a, i) <- cells.zipWithIndex;
         b <- cells.drop(i + 1)) assert(!a.intersects(b))
  }

  test("narrow windows stack the simulation above concurrently visible controls and analytics") {
    val narrow = MemoSimLayout.dashboard(new Dimension(800, 700), 260, 320, Seq(50, 70), Seq(64, 220))
    assert(narrow.compact)
    assert(narrow.size.width == 800)
    assert(narrow.controls.y >= narrow.simulation.y + narrow.simulation.height)
    assert(narrow.controls.y == narrow.analytics.y)
    assert(narrow.controlCells.head.height == 50)
    assert(narrow.analyticsCells.last.height == 220)
    val wide = MemoSimLayout.dashboard(new Dimension(1700, 700), 260, 320, Seq(50, 70), Seq(64, 220))
    assert(!wide.compact)
    assert(wide.simulation.y == wide.controls.y)
  }

  test("wide and tall worlds fit within the viewport without changing their aspect ratio") {
    val area = new Rectangle(12, 12, 600, 400)
    for ((width, height) <- Seq((100, 25), (25, 100), (33, 33))) {
      val fitted = MemoSimLayout.fitView(area, width, height, new Dimension(4, 4))
      assert(area.contains(fitted))
      assert(math.abs((fitted.width - 4).toDouble / width - (fitted.height - 4).toDouble / height) < 0.05)
      assert(math.abs(fitted.getCenterX - area.getCenterX) <= 1)
      assert(math.abs(fitted.getCenterY - area.getCenterY) <= 1)
    }
  }

  test("inspector pages retain every widget in model order, including oversized widgets") {
    assert(MemoSimLayout.pages(Seq(), 100).isEmpty)
    assert(MemoSimLayout.pages(Seq(40, 40, 40), 100) == Seq(Seq(0, 1), Seq(2)))
    assert(MemoSimLayout.pages(Seq(200, 40, 60), 100).flatten == Seq(0, 1, 2))
    assert(MemoSimLayout.pages(Seq(40, 40), 1) == Seq(Seq(0), Seq(1)))
  }

  test("presentation resizing retains widget identity, serialized bounds, and editable coordinates") {
    SwingUtilities.invokeAndWait(() => {
      val widget = new Widget {
        override def syncTheme(): Unit = {}
        override def getEditable: Option[Editable] = None
        override def load(model: CoreWidget): Unit = {}
        override def model: CoreWidget = {
          val b = getUnzoomedBounds
          TextBox(Some("note"), x = b.x, y = b.y, width = b.width, height = b.height, fontSize = 11)
        }
      }
      widget.setUnzoomedBounds(123, 456, 200, 80)
      val saved = widget.model
      val wrapper = new WidgetWrapper(widget, null)
      wrapper.setBounds(700, 48, 380, 60)
      assert(widget.model == saved)
      assert(widget.getParent eq wrapper)
      wrapper.setVisible(false)
      wrapper.setVisible(true)
      wrapper.zoomComponent()
      assert(wrapper.getBounds == wrapper.zoomBounds(new Rectangle(123, 456, 200, 80)))
      assert(widget.model == saved)
    })
  }
}
