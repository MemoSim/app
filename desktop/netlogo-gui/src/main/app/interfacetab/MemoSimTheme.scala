// MemoSim native presentation. GPL-2.0, same as NetLogo.
package org.nlogo.app.interfacetab

import java.awt.Color

private[interfacetab] object MemoSimTheme {
  case class Palette(canvas: Color, surface: Color, border: Color, text: Color, secondary: Color,
                     accent: Color, teal: Color, violet: Color)
  def palette(dark: Boolean): Palette =
    if (dark) Palette(new Color(0x0B1020), new Color(0x141E35), new Color(0x293A58),
                      new Color(0xF1F5FF), new Color(0x9BAECC),
                      new Color(0x60A5FA), new Color(0x2DD4BF), new Color(0xB79AFF))
    else Palette(new Color(0xEAF0FA), new Color(0xFCFDFF), new Color(0xD4DEF0),
                 new Color(0x142443), new Color(0x586D8B),
                 new Color(0x2563EB), new Color(0x0F8279), new Color(0x7C3AED))
}
