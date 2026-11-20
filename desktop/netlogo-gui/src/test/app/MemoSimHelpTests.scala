package org.nlogo.app

import javax.swing.Action

import org.nlogo.swing.QuickHelp
import org.nlogo.util.AnyFunSuiteEx

class MemoSimHelpTests extends AnyFunSuiteEx {
  private def withProperties(properties: (String, String)*)(body: => Unit): Unit = {
    val original = properties.map { case (key, _) => key -> Option(System.getProperty(key)) }
    try {
      properties.foreach { case (key, value) =>
        if (value == null) System.clearProperty(key) else System.setProperty(key, value)
      }
      body
    } finally {
      original.foreach { case (key, value) =>
        value match {
          case Some(previous) => System.setProperty(key, previous)
          case None => System.clearProperty(key)
        }
      }
    }
  }

  test("MemoSim never asks for NetLogo analytics consent") {
    assert(!App.shouldAskAnalyticsConsent("MemoSim", "$$$"))
    assert(!App.shouldAskAnalyticsConsent("MemoSim 1.0.4", "true"))
    assert(App.shouldAskAnalyticsConsent("NetLogo", "$$$"))
    assert(!App.shouldAskAnalyticsConsent("NetLogo", "false"))
  }

  test("MemoSim About uses the release version before the packaged or engine version") {
    withProperties("netlogo.product.name" -> "MemoSim 7.2.0-beta.3",
                   "memosim.release.version" -> "1.0.4", "jpackage.app-version" -> "1.0.3") {
      assert(AboutWindow.title == "About MemoSim 1.0.4")
      assert(new ShowAboutWindow(null).getValue(Action.NAME) == "About MemoSim 1.0.4")
      val citation = AboutWindow.memoSimCitation
      assert(citation.contains("Powered by NetLogo"))
      assert(citation.contains("Uri Wilensky, Northwestern University"))
      assert(citation.contains("modified fork"))
      assert(citation.contains("not an official NetLogo release"))
      assert(citation.contains("GPL-2.0-or-later"))
      assert(!citation.contains("memosim.com"))
    }
  }

  test("MemoSim About falls back to the packaged version and then the release default") {
    withProperties("memosim.release.version" -> null, "jpackage.app-version" -> "1.0.5") {
      assert(AboutWindow.memoSimNameVersion == "MemoSim 1.0.5")
    }
    withProperties("memosim.release.version" -> null, "jpackage.app-version" -> null) {
      assert(AboutWindow.memoSimNameVersion == "MemoSim 1.0.4")
    }
  }

  test("MemoSim Help actions point directly to bundled documentation") {
    withProperties("netlogo.product.name" -> "MemoSim") {
      val actions = HelpActions.apply
      assert(actions.forall(_.isInstanceOf[LocalBrowseAction]))
      val local = actions.map(_.asInstanceOf[LocalBrowseAction])
      assert(local.map(_.getValue(Action.NAME)) == Seq(
        "User Manual", "Beginner Tutorial", "MemoSim Dictionary", "PDF Manual", "Licenses and Attribution"))
      assert(local.map(_.path) == Seq(
        QuickHelp.docPath("index"), QuickHelp.docPath("tutorial"), QuickHelp.docPath("dictionary"),
        QuickHelp.docPath("index").resolveSibling("manual.pdf"), QuickHelp.docPath("legal")))
      assert(local.forall(_.path.toAbsolutePath.toUri.getScheme == "file"))
    }
  }

  test("other products retain the original online Help actions") {
    for (product <- Seq("NetLogo", "NetLogo 3D", "MemoSimulator")) {
      withProperties("netlogo.product.name" -> product) {
        assert(!AboutWindow.isMemoSim)
        assert(!HelpActions.apply.exists(_.isInstanceOf[LocalBrowseAction]))
        assert(HelpActions.apply.head.isInstanceOf[TryRemoteBrowseAction])
      }
    }
  }
}
