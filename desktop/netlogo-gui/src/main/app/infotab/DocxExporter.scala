// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.app.infotab

import java.io.{ ByteArrayOutputStream, OutputStream }
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.{ Files, Path, StandardCopyOption }
import java.util.zip.{ ZipEntry, ZipOutputStream }
import java.util.{ ArrayList => JArrayList }

import scala.collection.mutable.ArrayBuffer

import com.vladsch.flexmark.Extension
import com.vladsch.flexmark.ast.{ AutoLink, BlockQuote, BulletList, Code, Emphasis, FencedCodeBlock, HardLineBreak,
                                  Heading, HtmlBlock, HtmlCommentBlock, HtmlEntity, HtmlInline, HtmlInlineComment,
                                  Image, IndentedCodeBlock, Link, ListItem, MailLink, Node, OrderedList, Paragraph,
                                  SoftLineBreak, StrongEmphasis, Text, TextBase, ThematicBreak }
import com.vladsch.flexmark.ext.autolink.AutolinkExtension
import com.vladsch.flexmark.ext.escaped.character.{ EscapedCharacter, EscapedCharacterExtension }
import com.vladsch.flexmark.parser.{ Parser, ParserEmulationProfile }
import com.vladsch.flexmark.util.options.MutableDataSet

/**
 * Writes the text of the Info tab (Markdown) as a Word document (.docx), with no dependency beyond flexmark,
 * which the Info tab already uses. A .docx is a zip of XML parts, so it is generated directly.
 *
 * Right-to-left text (Persian, Arabic, Hebrew) is supported: a paragraph whose first strong character is
 * right-to-left becomes a bidirectional paragraph, and its runs are marked as right-to-left with a complex-script font.
 * Supported: headings, paragraphs, bold, italic, inline code, code blocks, bullet and numbered lists (nested),
 * block quotes, horizontal rules and links. Images are replaced by their alt text.
 */
object DocxExporter {
  private val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  private val R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

  /** Same Markdown dialect as the Info tab display (InfoFormatter), minus the HTML-specific renderers. */
  private def parser: Parser = {
    val options = new MutableDataSet()
    options.setFrom(ParserEmulationProfile.PEGDOWN)
    val extensions = new JArrayList[Extension]()
    extensions.add(EscapedCharacterExtension.create())
    extensions.add(AutolinkExtension.create())
    options.set(Parser.EXTENSIONS, extensions)
    options.set(Parser.MATCH_CLOSING_FENCE_CHARACTERS, Boolean.box(false))
    Parser.builder(options.toImmutable).build()
  }

  // ---- public API ---------------------------------------------------------------------------------------------

  /** Writes to a temporary file first, so a failure never leaves a half-written .docx in place of an existing file. */
  def save(markdown: String, title: String, file: Path): Unit = {
    val bytes = new ByteArrayOutputStream
    write(markdown, title, bytes)
    val tmp = Files.createTempFile(Option(file.toAbsolutePath.getParent).getOrElse(file.toAbsolutePath), ".info-export", ".tmp")
    try {
      Files.write(tmp, bytes.toByteArray)
      Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING)
    } finally Files.deleteIfExists(tmp)
  }

  def write(markdown: String, title: String, out: OutputStream): Unit = {
    val b = new Builder
    b.title(title)
    b.blocks(parser.parse(markdown.replace("\r\n", "\n").replace('\r', '\n')), Ctx())
    val zip = new ZipOutputStream(out, UTF_8)
    def part(name: String, content: String): Unit = {
      zip.putNextEntry(new ZipEntry(name))
      zip.write(content.getBytes(UTF_8))
      zip.closeEntry()
    }
    part("[Content_Types].xml", contentTypes)
    part("_rels/.rels", rootRels)
    part("word/document.xml", b.documentXml)
    part("word/styles.xml", styles)
    part("word/numbering.xml", numbering(b.orderedLists.toSeq))
    part("word/_rels/document.xml.rels", documentRels(b.links.toSeq))
    part("docProps/core.xml", core(title))
    part("docProps/app.xml", app)
    zip.finish()
    zip.flush()
  }

  /** Visible for testing. */
  def documentXmlFor(markdown: String, title: String): String = {
    val b = new Builder
    b.title(title)
    b.blocks(parser.parse(markdown.replace("\r\n", "\n").replace('\r', '\n')), Ctx())
    b.documentXml
  }

  // ---- text helpers -------------------------------------------------------------------------------------------

  /** Characters that are not allowed in XML 1.0 are dropped, the rest is escaped. */
  def esc(s: String): String = {
    val sb = new java.lang.StringBuilder(s.length + 16)
    var i = 0
    while (i < s.length) {
      val cp = s.codePointAt(i)
      i += Character.charCount(cp)
      cp match {
        case '&'                                  => sb.append("&amp;")
        case '<'                                  => sb.append("&lt;")
        case '>'                                  => sb.append("&gt;")
        case '"'                                  => sb.append("&quot;")
        case c if c == 0x9 || c == 0xA || c == 0xD => sb.appendCodePoint(c)
        case c if c < 0x20 || c == 0xFFFE || c == 0xFFFF || (c >= 0xD800 && c <= 0xDFFF) => ()
        case c                                    => sb.appendCodePoint(c)
      }
    }
    sb.toString
  }

  private def isRtlChar(cp: Int): Boolean = {
    val d = Character.getDirectionality(cp)
    d == Character.DIRECTIONALITY_RIGHT_TO_LEFT || d == Character.DIRECTIONALITY_RIGHT_TO_LEFT_ARABIC
  }

  private def isLtrChar(cp: Int): Boolean =
    Character.getDirectionality(cp) == Character.DIRECTIONALITY_LEFT_TO_RIGHT

  /** First strong character decides, like the Unicode bidi algorithm's paragraph direction. */
  def isRtl(text: String): Boolean = {
    var i = 0
    while (i < text.length) {
      val cp = text.codePointAt(i)
      if (isRtlChar(cp)) return true
      if (isLtrChar(cp)) return false
      i += Character.charCount(cp)
    }
    false
  }

  // ---- model of one paragraph ---------------------------------------------------------------------------------

  private case class Fmt(bold: Boolean = false, italic: Boolean = false, code: Boolean = false, link: Option[Int] = None)
  private sealed trait Piece
  private case class Txt(s: String, f: Fmt) extends Piece
  private case object Br extends Piece

  private case class Ctx(quote: Boolean = false, listLevel: Int = -1, numId: Int = 0)

  private class Builder {
    private val body = new StringBuilder
    val links = new ArrayBuffer[String]
    /**
     * One entry per ordered list: (start number, nesting level). Each gets its OWN numbering definition (numId = index + 2;
     * numId 1 = bullets), because Word continues the numbering of lists that share a definition. The start number matters:
     * the parser ends a list at indentation it does not accept as nesting, and the next item then begins a new list that
     * carries its own number ("4."), which the Info tab shows as 4 too.
     */
    val orderedLists = new ArrayBuffer[(Int, Int)]

    def documentXml: String =
      s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
         |<w:document xmlns:w="$W" xmlns:r="$R"><w:body>$body<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>""".stripMargin

    def title(t: String): Unit =
      if (t.trim.nonEmpty) paragraph(Seq(Txt(t.trim, Fmt())), "Title", Ctx())

    private def addLink(url: String): Int = {
      val i = links.indexOf(url)
      if (i >= 0) i else { links += url; links.size - 1 }
    }

    // ---- inline ----

    private def inlines(parent: Node, f: Fmt, out: ArrayBuffer[Piece]): Unit = {
      var n = parent.getFirstChild
      while (n != null) {
        n match {
          case t: Text                => out += Txt(t.getChars.toString, f)
          case e: EscapedCharacter    => out += Txt(e.getText.toString, f)
          case e: Emphasis            => inlines(e, f.copy(italic = true), out)
          case s: StrongEmphasis      => inlines(s, f.copy(bold = true), out)
          case c: Code                => out += Txt(c.getText.toString, f.copy(code = true))
          case _: SoftLineBreak       => out += Br // the Info tab renders soft breaks as line breaks too
          case _: HardLineBreak       => out += Br
          case l: Link                => inlines(l, f.copy(link = Some(addLink(l.getUrl.toString))), out)
          case a: AutoLink            => out += Txt(a.getText.toString, f.copy(link = Some(addLink(a.getText.toString))))
          case m: MailLink            => out += Txt(m.getText.toString, f.copy(link = Some(addLink("mailto:" + m.getText.toString))))
          case i: Image               => out += Txt(s"[${i.getText.toString}]", f)
          case h: HtmlInline          => if (h.getChars.toString.toLowerCase.matches("<br\\s*/?>")) out += Br
          case _: HtmlInlineComment   => ()
          case e: HtmlEntity          => out += Txt(e.getChars.unescape(), f)
          case other if other.hasChildren => inlines(other, f, out)
          case other                  => out += Txt(other.getChars.toString, f)
        }
        n = n.getNext
      }
    }

    private def run(text: String, f: Fmt, rtl: Boolean): String = {
      val props = new StringBuilder
      if (f.link.isDefined) props ++= """<w:rStyle w:val="Hyperlink"/>"""
      if (f.code) props ++= """<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>"""
      if (f.bold) props ++= "<w:b/><w:bCs/>"
      if (f.italic) props ++= "<w:i/><w:iCs/>"
      if (f.code) props ++= """<w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>"""
      if (rtl && !f.code) props ++= "<w:rtl/>"
      val rPr = if (props.isEmpty) "" else s"<w:rPr>$props</w:rPr>"
      // tabs become real tab stops; the text itself keeps its spaces
      val pieces = text.split("\t", -1).map(p => s"""<w:t xml:space="preserve">${esc(p)}</w:t>""").mkString("<w:tab/>")
      s"<w:r>$rPr$pieces</w:r>"
    }

    private def runs(pieces: Seq[Piece], rtl: Boolean): String = {
      val sb = new StringBuilder
      pieces.foreach {
        case Br => sb ++= "<w:r><w:br/></w:r>"
        case Txt(s, f) =>
          if (s.nonEmpty) {
            val r = run(s, f, rtl)
            sb ++= f.link.fold(r)(i => s"""<w:hyperlink r:id="rIdL${i + 1}" w:history="1">$r</w:hyperlink>""")
          }
      }
      sb.toString
    }

    // ---- paragraphs ----

    /** `style` is a paragraph style id; list/quote context adds numbering or indentation. */
    private def paragraph(pieces: Seq[Piece], style: String, ctx: Ctx, numbered: Boolean = false, extraPPr: String = ""): Unit = {
      val text = pieces.collect { case Txt(s, _) => s }.mkString
      val rtl = isRtl(text) && style != "Code"
      val pPr = new StringBuilder
      pPr ++= s"""<w:pStyle w:val="$style"/>"""
      if (numbered) pPr ++= s"""<w:numPr><w:ilvl w:val="${math.max(ctx.listLevel, 0)}"/><w:numId w:val="${ctx.numId}"/></w:numPr>"""
      pPr ++= extraPPr
      if (rtl) pPr ++= "<w:bidi/>"
      if (ctx.listLevel >= 0 && !numbered) {
        val left = 360 * (ctx.listLevel + 1) + 360
        pPr ++= s"""<w:ind w:left="$left"/>"""
      }
      body ++= s"<w:p><w:pPr>$pPr</w:pPr>${runs(pieces, rtl)}</w:p>"
    }

    private def inlinePieces(n: Node): Seq[Piece] = {
      val out = new ArrayBuffer[Piece]
      inlines(n, Fmt(), out)
      out.toSeq
    }

    private def plainText(html: String): String =
      html.replaceAll("(?s)<!--.*?-->", "").replaceAll("<[^>]+>", "").trim

    // ---- blocks ----

    def blocks(parent: Node, ctx: Ctx): Unit = {
      var n = parent.getFirstChild
      while (n != null) {
        block(n, ctx)
        n = n.getNext
      }
    }

    private def block(n: Node, ctx: Ctx): Unit = n match {
      case h: Heading =>
        paragraph(inlinePieces(h), s"Heading${math.min(math.max(h.getLevel, 1), 6)}", ctx.copy(listLevel = -1))
      case p: (Paragraph | TextBase) =>
        paragraph(inlinePieces(p), if (ctx.quote) "Quote" else "Normal", ctx)
      case l: BulletList =>
        list(l, ctx, 1)
      case l: OrderedList =>
        orderedLists += ((math.max(l.getStartNumber, 0), ctx.listLevel + 1))
        list(l, ctx, 1 + orderedLists.size)
      case c: FencedCodeBlock =>
        code(c.getContentChars.toString, ctx)
      case c: IndentedCodeBlock =>
        code(c.getContentChars.toString, ctx)
      case q: BlockQuote =>
        blocks(q, ctx.copy(quote = true))
      case _: ThematicBreak =>
        body ++= """<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>"""
      case h: HtmlBlock =>
        val t = plainText(h.getChars.toString)
        if (t.nonEmpty) paragraph(Seq(Txt(t, Fmt())), "Normal", ctx)
      case _: HtmlCommentBlock => ()
      case other if other.hasChildren => blocks(other, ctx)
      case other =>
        val t = other.getChars.toString.trim
        if (t.nonEmpty) paragraph(Seq(Txt(t, Fmt())), "Normal", ctx)
    }

    private def list(l: Node, ctx: Ctx, numId: Int): Unit = {
      val level = ctx.listLevel + 1
      var item = l.getFirstChild
      while (item != null) {
        item match {
          case li: ListItem =>
            var first = true
            var child = li.getFirstChild
            while (child != null) {
              child match {
                case p: (Paragraph | TextBase) =>
                  // numbering uses this list's own numId; continuation paragraphs are indented without a number
                  paragraph(inlinePieces(p), "ListParagraph", Ctx(ctx.quote, level, numId), numbered = first)
                  first = false
                case nested @ (_: BulletList | _: OrderedList) =>
                  block(nested, Ctx(ctx.quote, level, numId))
                case other =>
                  block(other, Ctx(ctx.quote, level, numId))
              }
              child = child.getNext
            }
          case other => block(other, ctx)
        }
        item = item.getNext
      }
    }

    private def code(text: String, ctx: Ctx): Unit = {
      val lines = text.stripSuffix("\n").split("\n", -1).toSeq
      lines.foreach(line => paragraph(Seq(Txt(line, Fmt(code = true))), "Code", ctx))
    }
  }

  // ---- package parts ------------------------------------------------------------------------------------------

  private val contentTypes: String =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      |<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>""".stripMargin

  private val rootRels: String =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      |<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>""".stripMargin

  private def documentRels(links: Seq[String]): String = {
    val ext = links.zipWithIndex.map { case (url, i) =>
      s"""<Relationship Id="rIdL${i + 1}" Type="$R/hyperlink" Target="${esc(url)}" TargetMode="External"/>"""
    }.mkString
    s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       |<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="$R/styles" Target="styles.xml"/><Relationship Id="rId2" Type="$R/numbering" Target="numbering.xml"/>$ext</Relationships>""".stripMargin
  }

  private def core(title: String): String =
    s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       |<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>NetLogo</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${java.time.Instant.now.toString.take(19)}Z</dcterms:created></cp:coreProperties>""".stripMargin

  private val app: String =
    """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      |<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>NetLogo</Application></Properties>""".stripMargin

  private def heading(id: Int, size: Int, color: String): String =
    s"""<w:style w:type="paragraph" w:styleId="Heading$id"><w:name w:val="heading $id"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${if (id == 1) 360 else 240}" w:after="120"/><w:outlineLvl w:val="${id - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="$color"/><w:sz w:val="$size"/><w:szCs w:val="$size"/></w:rPr></w:style>"""

  private val styles: String =
    s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       |<w:styles xmlns:w="$W"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="fa-IR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
       |<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
       |<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>
       |<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
       |${heading(1, 36, "1F3864")}${heading(2, 30, "2F5496")}${heading(3, 26, "2F5496")}${heading(4, 24, "404040")}${heading(5, 22, "404040")}${heading(6, 22, "595959")}
       |<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
       |<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="595959"/></w:rPr></w:style>
       |<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="284"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
       |<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
       |</w:styles>""".stripMargin

  /** numId 1 = bullets; numId 2.. = one decimal list each (abstractNum 1), restarting at 1. */
  private def numbering(orderedLists: Seq[(Int, Int)]): String = {
    val bullets = Seq("\u2022", "\u25E6", "\u25AA")
    val bulletLevels = (0 until 9).map { i =>
      s"""<w:lvl w:ilvl="$i"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bullets(i % 3)}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:hint="default"/></w:rPr></w:lvl>"""
    }.mkString
    val formats = Seq("decimal", "lowerLetter", "lowerRoman")
    def decimalLevels(startLevel: Int, start: Int): String = (0 until 9).map { i =>
      s"""<w:lvl w:ilvl="$i"><w:start w:val="${if (i == startLevel) start else 1}"/><w:numFmt w:val="${formats(i % 3)}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + 360 * i}" w:hanging="360"/></w:pPr></w:lvl>"""
    }.mkString
    // abstractNum 0 = bullets; abstractNum i+1 = the i-th ordered list
    val abstracts = orderedLists.zipWithIndex.map { case ((start, level), i) =>
      s"""<w:abstractNum w:abstractNumId="${i + 1}"><w:multiLevelType w:val="hybridMultilevel"/>${decimalLevels(level, start)}</w:abstractNum>"""
    }.mkString
    val nums = orderedLists.indices.map(i => s"""<w:num w:numId="${i + 2}"><w:abstractNumId w:val="${i + 1}"/></w:num>""").mkString
    s"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
       |<w:numbering xmlns:w="$W"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>$bulletLevels</w:abstractNum>$abstracts<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>$nums</w:numbering>""".stripMargin
  }
}
