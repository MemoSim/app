// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.app.infotab

import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets.UTF_8
import java.util.zip.ZipInputStream

import scala.collection.mutable

import org.nlogo.util.AnyFunSuiteEx

class DocxExporterTests extends AnyFunSuiteEx {

  private def docx(markdown: String, title: String = "T"): Map[String, String] = {
    val out = new ByteArrayOutputStream
    DocxExporter.write(markdown, title, out)
    val zip = new ZipInputStream(new java.io.ByteArrayInputStream(out.toByteArray), UTF_8)
    val parts = mutable.LinkedHashMap[String, String]()
    var e = zip.getNextEntry
    while (e != null) {
      parts(e.getName) = new String(zip.readAllBytes, UTF_8)
      e = zip.getNextEntry
    }
    parts.toMap
  }

  private def xml(markdown: String) = DocxExporter.documentXmlFor(markdown, "")

  private def paragraphs(documentXml: String): Seq[String] =
    "(?s)<w:p>.*?</w:p>".r.findAllIn(documentXml).toSeq

  private def text(p: String): String =
    "<w:t[^>]*>([^<]*)</w:t>".r.findAllMatchIn(p).map(_.group(1)).mkString

  test("the package has every part Word needs and each part is well-formed XML") {
    val parts = docx("# Hi\n\ntext")
    assert(Set("[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml",
               "word/_rels/document.xml.rels", "docProps/core.xml", "docProps/app.xml").subsetOf(parts.keySet))
    val factory = javax.xml.parsers.DocumentBuilderFactory.newInstance
    for ((name, body) <- parts) {
      try factory.newDocumentBuilder.parse(new java.io.ByteArrayInputStream(body.getBytes(UTF_8)))
      catch { case t: Throwable => fail(s"$name is not well-formed XML: $t") }
    }
  }

  test("headings, bold, italic, inline code and links") {
    val x = xml("# Title\n\nSome **bold** and *italic* and `code` and [a link](https://example.org/x?a=1&b=2).")
    assert(x.contains("""<w:pStyle w:val="Heading1"/>"""))
    assert(x.contains("<w:b/>"))
    assert(x.contains("<w:i/>"))
    assert(x.contains("Courier New"))
    assert(x.contains("""<w:hyperlink r:id="rIdL1""""))
    val rels = docx("[a link](https://example.org/x?a=1&b=2)")("word/_rels/document.xml.rels")
    assert(rels.contains("""Target="https://example.org/x?a=1&amp;b=2" TargetMode="External""""))
  }

  test("XML special characters and characters XML 1.0 forbids never corrupt the document") {
    val parts = docx("a < b & c > d \"q\" \u0001\u0008 end \uD83D\uDE00")
    val body = parts("word/document.xml")
    assert(body.contains("a &lt; b &amp; c &gt; d &quot;q&quot;"))
    assert(!body.contains("\u0001"))
    assert(body.contains("\uD83D\uDE00"))
  }

  test("right-to-left paragraphs are marked as bidirectional, left-to-right ones are not") {
    val ps = paragraphs(xml("\u0627\u06CC\u0646 \u06CC\u06A9 **\u0645\u062A\u0646** \u0641\u0627\u0631\u0633\u06CC \u0627\u0633\u062A.\n\nThis is English text."))
    val fa = ps.find(p => text(p).contains("\u0641\u0627\u0631\u0633\u06CC")).get
    val en = ps.find(p => text(p).contains("English")).get
    assert(fa.contains("<w:bidi/>"))
    assert(fa.contains("<w:rtl/>"))
    assert(!en.contains("<w:bidi/>"))
    assert(!en.contains("<w:rtl/>"))
  }

  test("direction follows the first strong character, not the presence of a script") {
    assert(DocxExporter.isRtl("\u06F1. \u0634\u06A9\u0627\u0631\u0686\u06CC"))
    assert(DocxExporter.isRtl("(123) \u0633\u0644\u0627\u0645 NetLogo"))
    assert(!DocxExporter.isRtl("NetLogo \u0645\u062F\u0644"))
    assert(!DocxExporter.isRtl("12345"))
    assert(!DocxExporter.isRtl(""))
  }

  test("code blocks keep every line and are never right-to-left") {
    val ps = paragraphs(xml("```\nto go\n  fd 1\nend\n```"))
    val code = ps.filter(_.contains("""<w:pStyle w:val="Code"/>"""))
    assert(code.map(text) == Seq("to go", "  fd 1", "end"))
    assert(code.forall(!_.contains("<w:bidi/>")))
  }

  test("numbered lists keep their own start number and never merge with another numbered list") {
    // the second list is separated by a paragraph, as when a parser ends a list at unsupported indentation
    val md = "1. one\n2. two\n3. three\n\ntext\n\n4. four\n5. five"
    val parts = docx(md)
    val ids = "<w:numId w:val=\"(\\d+)\"/>".r.findAllMatchIn(parts("word/document.xml")).map(_.group(1)).toList
    assert(ids.distinct.size == 2, ids)
    val numbering = parts("word/numbering.xml")
    assert("""<w:start w:val="4"/>""".r.findFirstIn(numbering).isDefined, "second list should start at 4")
    val defs = "<w:abstractNum ".r.findAllIn(numbering).size
    val nums = "<w:num ".r.findAllIn(numbering).size
    assert(defs == nums, s"$defs definitions for $nums lists: lists that share a definition continue each other in Word")
  }

  test("nested lists use deeper levels and bullets vs numbers keep their own ids") {
    val ps = paragraphs(xml("1. top\n    - nested bullet\n        1. deep number\n2. next"))
    val lv = ps.map(p => "<w:ilvl w:val=\"(\\d)\"/>".r.findFirstMatchIn(p).map(_.group(1).toInt))
    assert(lv.flatten == Seq(0, 1, 2, 0))
  }

  test("block quotes, rules and tabs") {
    val x = xml("> quoted\n\n---\n\nA\tB")
    assert(x.contains("""<w:pStyle w:val="Quote"/>"""))
    assert(x.contains("<w:pBdr><w:bottom"))
    assert(x.contains("<w:tab/>"))
  }

  test("empty info still produces a valid, openable document") {
    val parts = docx("", "")
    assert(parts("word/document.xml").contains("<w:body>"))
    assert(parts("word/document.xml").contains("<w:sectPr>"))
  }

  test("the title becomes the Title paragraph and the document title") {
    val parts = docx("body", "My model")
    assert(parts("word/document.xml").contains("""<w:pStyle w:val="Title"/>"""))
    assert(parts("docProps/core.xml").contains("<dc:title>My model</dc:title>"))
  }

  test("save writes atomically and replaces an existing file") {
    val dir = java.nio.file.Files.createTempDirectory("docx-test")
    val f = dir.resolve("out.docx")
    java.nio.file.Files.writeString(f, "old")
    DocxExporter.save("# Hello", "T", f)
    val bytes = java.nio.file.Files.readAllBytes(f)
    assert(bytes.length > 1000 && bytes(0) == 'P'.toByte && bytes(1) == 'K'.toByte) // a zip, not the old text
    assert(java.nio.file.Files.list(dir).count == 1, "no temporary file left behind")
  }
}
