package org.nlogo.swing

import java.nio.file.{ Files, Paths }
import org.nlogo.util.AnyFunSuiteEx

class MemoSimQuickHelpTests extends AnyFunSuiteEx {
  test("MemoSim offline Help pages and shared assets are present") {
    val docs = Paths.get("chat-dev", "manual").toAbsolutePath
    Seq("index.html", "tutorial.html", "dictionary.html", "legal.html", "manual.pdf", "docs.css", "docs.js",
      "dict/quickhelp.csv", "assets/memosim-icon.png").foreach { relative =>
      assert(Files.isRegularFile(docs.resolve(relative)), s"Missing offline Help asset: $relative")
    }
  }

  test("MemoSim dictionary maps primitive help to real offline pages") {
    val docs = Paths.get("chat-dev", "manual").toAbsolutePath
    val dictionary = docs.resolve("dict/quickhelp.csv")
    assert(Files.isRegularFile(dictionary))
    val rows = Files.readString(dictionary).linesIterator.filter(_.nonEmpty).map(_.split(',')).toSeq
    assert(rows.size > 400)
    assert(rows.exists(row => row(0) == "ask" && row(2) == "dict/ask"))
    assert(rows.forall(row => row.length >= 3 && Set("2d", "3d").contains(row(1))))
    rows.foreach { row =>
      assert(Files.isRegularFile(QuickHelp.memoSimDictionaryPath(docs, row(2))), s"Missing offline dictionary fallback for ${row(0)}")
    }
  }
}
