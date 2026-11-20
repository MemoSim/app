// (C) Uri Wilensky. https://github.com/NetLogo/NetLogo
// Modified for MemoSim, a modified fork of NetLogo: MemoSim splash branding. Changed 2026-11-18. Licensed GPL-2.0-or-later as part of MemoSim.

package org.nlogo.app

import javax.swing.{ JLabel, JWindow }

import org.nlogo.swing.{ DummyZoomable, ProductBranding, Utils }
import org.nlogo.theme.{ DarkTheme, InterfaceColors }

object Splash {
  private var splashWindow: JWindow = null

  def beginSplash(): Unit = {
    splashWindow = new JWindow
    splashWindow.getContentPane.add(splash)
    splashWindow.pack()
    org.nlogo.awt.Positioning.center(splashWindow, null)
    splashWindow.setVisible(true)
  }

  def endSplash(): Unit = {
    splashWindow.setVisible(false)
    splashWindow.dispose()
    splashWindow = null
  }

  private def scale(x: Int) = (x / 7.2).toInt

  val splash = new JLabel(Utils.iconScaled(new DummyZoomable,
    ProductBranding.splashResource(System.getProperty("netlogo.product.name", "NetLogo"),
      InterfaceColors.getTheme == DarkTheme), scale(3680), scale(2008)))
}
