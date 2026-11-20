// (C) Uri Wilensky. https://github.com/NetLogo/NetLogo
// Modified for MemoSim, a modified fork of NetLogo: MemoSim application icon. Changed 2026-11-18. Licensed GPL-2.0-or-later as part of MemoSim.

package org.nlogo.swing

import java.awt.Window

import org.nlogo.api.Version
import org.nlogo.awt.Images

trait NetLogoIcon extends Window {
  setIconImage(Images.loadImageResource(ProductBranding.windowIconResource(
    System.getProperty("netlogo.product.name", "NetLogo"), Version.is3D)))
}
