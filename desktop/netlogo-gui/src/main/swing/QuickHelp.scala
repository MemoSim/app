// (C) Uri Wilensky. https://github.com/NetLogo/NetLogo
// Modified for MemoSim's bundled language dictionary, 2026-11-19. GPL-2.0-or-later.

package org.nlogo.swing

import java.awt.Component
import java.net.URI
import java.nio.file.{ Path, Paths }
import java.util.Locale

import org.nlogo.api.Version
import org.nlogo.core.I18N

object QuickHelp {
  /**
   * This action is to provide context-sensitive help in the procedures
   * tab.  Based on what their cursor is on, it should jump the user
   * to the proper documentation, found in docs/dict/
   * -- which is just a decomposed version of docs/dictionary.html
   * <p/>
   * Maybe it would be best to pull everything out of some new file,
   * maybe xml format, and we could autogenerate the primitives dictionary file
   * from that.
   * <p/>
   * ~Forrest (4/26/2007)
   */

  private val docsRoot: String = System.getProperty("netlogo.docs.dir")

  // if we're not in 3D don't load the 3d dictionary words
  // cause we don't need 'em and they'll override the 2d
  // dictionary ev 10/25/07
  private lazy val quickHelpWords: Map[String, Entry] =
    loadHelp(false)

  private lazy val quickHelpWords3d: Map[String, Entry] = {
    if (Version.is3D) {
      loadHelp(true)
    } else {
      Map()
    }
  }

  def docPath(page: String): Path =
    if (ProductBranding.isMemoSim(System.getProperty("netlogo.product.name", "NetLogo")))
      Paths.get(docsRoot, s"$page.html")
    else Paths.get(docsRoot, "docs", "static", s"$page.html")

  private[swing] def memoSimDictionaryPath(root: Path, docsUrl: String): Path = {
    val page = docsUrl.stripSuffix(".html").takeWhile(_ != '#')
    val candidate = root.resolve(s"$page.html")
    if (java.nio.file.Files.isRegularFile(candidate)) candidate else root.resolve("dictionary.html")
  }

  private def sitePath(entry: Entry): URI =
    new URI(s"https://docs.netlogo.org/${Version.versionNumberNo3D}/${entry.docsUrl}")

  private def loadHelp(threed: Boolean): Map[String, Entry] = {
    val local = Option(docsRoot).map(Paths.get(_, "dict", "quickhelp.csv"))
      .filter(java.nio.file.Files.isRegularFile(_))
    val stream = if (ProductBranding.isMemoSim(System.getProperty("netlogo.product.name", "NetLogo")))
      local.map(java.nio.file.Files.newInputStream(_)).orElse(Option(getClass.getResourceAsStream("/system/manual-links.csv")))
    else Option(getClass.getResourceAsStream("/system/manual-links.csv"))
    stream.fold(Map[String, Entry]()) { source =>
      val text = try new String(source.readAllBytes, java.nio.charset.StandardCharsets.UTF_8)
        finally source.close()
      text.split('\n').filter(_.nonEmpty).flatMap { line =>
        val split = line.split(',')

        Entry.parse(split.tail, threed).map((split.head, _))
      }.toMap
    }
  }

  private def openDictionary(comp: Component, word: String, words: Map[String, Entry]): Unit = {
    if (ProductBranding.isMemoSim(System.getProperty("netlogo.product.name", "NetLogo"))) {
      val entry = words(word).docsUrl.stripSuffix(".html")
      val parts = entry.split("#", 2)
      val page = memoSimDictionaryPath(Paths.get(docsRoot), parts(0))
      val target = page.toUri
      BrowserLauncher.openURI(comp, new URI(target.toString +
        (if (parts.length == 2) "#" + parts(1) else "")))
    } else BrowserLauncher.tryOpenURI(comp, sitePath(words(word)), docPath(words(word).docsUrl))
  }

  def doHelp(comp: Component, token: String): Unit = {
    if (token == null)
      return

    val tokenLower = token.toLowerCase

    // if there is an entry in the 3D dictionary then it overrides
    // the 2D entry ev 10/25/07
    if (quickHelpWords3d.contains(tokenLower)) {
      openDictionary(comp, tokenLower, quickHelpWords3d)
    } else if (quickHelpWords.contains(tokenLower)) {
      openDictionary(comp, tokenLower, quickHelpWords)
    } else {
      if (new OptionPane(comp, I18N.gui.get("common.netlogo"),
                         I18N.gui.getN("tabs.code.rightclick.quickhelp.notfound",
                         tokenLower.toUpperCase(Locale.ENGLISH)), OptionPane.Options.OkCancel,
                         OptionPane.Icons.error).getSelectedIndex == 0)
        if (ProductBranding.isMemoSim(System.getProperty("netlogo.product.name", "NetLogo")))
          BrowserLauncher.openPath(comp, docPath("dictionary"))
        else BrowserLauncher.tryOpenURI(comp,
          new URI(s"https://docs.netlogo.org/${Version.versionNumberNo3D}/dictionary.html"),
          docPath("dictionary"))
    }
  }

  private object Entry {
    def parse(els: Array[String], threed: Boolean): Option[Entry] = {
      if ((els.size == 2 || els.size == 3) && (els(0) == "3d") == threed) {
        Some(Entry(els(1)))
      } else {
        None
      }
    }
  }

  private case class Entry(docsUrl: String)
}
