package org.nlogo.swing

import javax.imageio.ImageIO
import org.nlogo.util.AnyFunSuiteEx

class ProductBrandingTests extends AnyFunSuiteEx {
  test("MemoSim releases always use MemoSim splash and native icons") {
    for (product <- Seq("MemoSim", "MemoSim 1.0.4", "MemoSim 7.2.0-beta.3");
         dark <- Seq(false, true); is3D <- Seq(false, true)) {
      assert(ProductBranding.splashResource(product, dark) == "/images/memosim-splash.png")
      assert(ProductBranding.windowIconResource(product, is3D) == "/images/memosim-icon.png")
    }
  }

  test("unrelated product names retain their original branding") {
    assert(!ProductBranding.isMemoSim("MemoSimulator"))
    assert(ProductBranding.splashResource("NetLogo", false) == "/images/banner.png")
    assert(ProductBranding.splashResource("NetLogo", true) == "/images/banner-dark.png")
    assert(ProductBranding.windowIconResource("NetLogo", true) == "/images/netlogo3d.png")
  }

  test("MemoSim splash and native icon are packaged readable image resources") {
    for (resource <- Seq("/images/memosim-splash.png", "/images/memosim-icon.png")) {
      val url = getClass.getResource(resource)
      assert(url != null, s"Missing branding resource: $resource")
      val image = ImageIO.read(url)
      assert(image != null && image.getWidth > 0 && image.getHeight > 0)
    }
  }
}
