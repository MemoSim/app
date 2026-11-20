// MemoSim branding. GPL-2.0, same as NetLogo.
package org.nlogo.swing

object ProductBranding {
  def isMemoSim(productName: String): Boolean =
    productName == "MemoSim" || productName.startsWith("MemoSim ")

  def splashResource(productName: String, dark: Boolean): String =
    if (isMemoSim(productName)) "/images/memosim-splash.png"
    else if (dark) "/images/banner-dark.png"
    else "/images/banner.png"

  def windowIconResource(productName: String, is3D: Boolean): String =
    if (isMemoSim(productName)) "/images/memosim-icon.png"
    else if (is3D) "/images/netlogo3d.png"
    else "/images/netlogo.png"
}
