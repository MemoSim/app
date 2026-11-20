// MemoSim native presentation. GPL-2.0, same as NetLogo.
package org.nlogo.app.interfacetab

import java.awt.{ Dimension, Rectangle }

private[interfacetab] object MemoSimLayout {
  case class Dashboard(size: Dimension, simulation: Rectangle, controls: Rectangle, analytics: Rectangle,
                       controlCells: Seq[Rectangle], analyticsCells: Seq[Rectangle], compact: Boolean)

  def dashboard(extent: Dimension, controlWidth: Int, analyticsWidth: Int,
                controlHeights: Seq[Int], analyticsHeights: Seq[Int]): Dashboard = {
    val gap = 12
    val compact = extent.width < 300 + controlWidth + analyticsWidth + gap * 4
    val columns = if (!compact && extent.width >= 1440 &&
      extent.width >= 300 + controlWidth * 2 + analyticsWidth + gap * 4 + 10 && controlHeights.size >= 4) 2 else 1
    val desiredControls = controlWidth * columns + (columns - 1) * 10
    val minWidth = if (compact) controlWidth + analyticsWidth + gap * 3
      else 300 + desiredControls + analyticsWidth + gap * 4
    val width = extent.width.max(minWidth)
    val spare = width - minWidth
    val simulationWidth = if (compact) width - gap * 2 else 300 + (spare * 0.65).toInt
    val controlsWidth = if (compact) controlWidth + spare / 2 else desiredControls
    val plotsWidth = if (compact) width - controlsWidth - gap * 3
      else width - simulationWidth - controlsWidth - gap * 4
    def contentHeight(heights: Seq[Int], count: Int): Int =
      70 + heights.grouped(count).map(_.max).sum + (heights.grouped(count).size - 1).max(0) * 10
    val viewportHeight = extent.height.max(340)
    val bodyTop = if (compact) gap * 2 + (viewportHeight * 0.45).toInt.max(240) else gap
    val bodyHeight = (viewportHeight - bodyTop - gap).max(contentHeight(controlHeights, columns))
      .max(contentHeight(analyticsHeights, 1))
    val height = bodyTop + bodyHeight + gap
    val simulation = new Rectangle(gap, gap, simulationWidth,
      if (compact) bodyTop - gap * 2 else viewportHeight - gap * 2)
    val controls = new Rectangle(if (compact) gap else gap * 2 + simulationWidth,
      bodyTop, controlsWidth, bodyHeight)
    val analytics = new Rectangle(controls.x + controlsWidth + gap, bodyTop, plotsWidth, bodyHeight)
    Dashboard(new Dimension(width, height), simulation, controls, analytics,
      gridCells(controls, controlHeights, columns), gridCells(analytics, analyticsHeights, 1), compact)
  }

  private def gridCells(area: Rectangle, heights: Seq[Int], columns: Int): Seq[Rectangle] = {
    val gap = 10
    val available = area.width - 24 - gap * (columns - 1)
    val cellWidth = available / columns
    var y = area.y + 58
    heights.grouped(columns).flatMap { row =>
      val cells = row.zipWithIndex.map { case (height, column) =>
        new Rectangle(area.x + 12 + column * (cellWidth + gap), y,
          if (column == columns - 1) available - cellWidth * (columns - 1) else cellWidth, height)
      }
      y += row.max + gap
      cells
    }.toSeq
  }

  def fitView(area: Rectangle, worldWidth: Int, worldHeight: Int, inset: Dimension): Rectangle = {
    val scale = math.min((area.width - inset.width).max(0).toDouble / worldWidth.max(1),
                         (area.height - inset.height).max(0).toDouble / worldHeight.max(1))
    val width = (scale * worldWidth).toInt + inset.width
    val height = (scale * worldHeight).toInt + inset.height
    new Rectangle(area.x + (area.width - width) / 2, area.y + (area.height - height) / 2, width, height)
  }

  def pages(heights: Seq[Int], available: Int): Seq[Seq[Int]] = {
    val result = scala.collection.mutable.ArrayBuffer[Seq[Int]]()
    var page = Vector[Int]()
    var used = 0
    heights.zipWithIndex.foreach { (height, index) =>
      if (page.nonEmpty && used + height + 8 > available) {
        result += page
        page = Vector()
        used = 0
      }
      page :+= index
      used += height + 8
    }
    if (page.nonEmpty) result += page
    result.toSeq
  }
}
