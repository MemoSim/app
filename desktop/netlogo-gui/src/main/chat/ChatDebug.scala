// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.awt.EventQueue
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.net.InetSocketAddress
import java.nio.charset.StandardCharsets
import java.util.concurrent.{ CompletableFuture, TimeUnit }
import javax.imageio.ImageIO
import javax.swing.SwingUtilities

import com.sun.net.httpserver.{ HttpExchange, HttpServer }

import javafx.application.Platform
import javafx.scene.web.WebEngine

/**
 * DEVELOPMENT ONLY. Enabled solely by `-Dnetlogo.chat.debugPort=<port>`; listens on 127.0.0.1.
 * It lets automated tests drive the chat WebView and the window:
 *   POST /js    body = JavaScript, returns its result as text (runs in the chat page)
 *   GET  /shot  PNG of the whole NetLogo window
 *   GET  /ping
 * Never enable this on a machine where untrusted local users or processes exist.
 */
object ChatDebug {
  def start(port: Int, panel: ChatPanel, engine: () => Option[WebEngine]): Unit = {
    val server = HttpServer.create(new InetSocketAddress("127.0.0.1", port), 0)

    def reply(ex: HttpExchange, code: Int, ctype: String, bytes: Array[Byte]): Unit = {
      ex.getResponseHeaders.add("Content-Type", ctype)
      ex.sendResponseHeaders(code, bytes.length.toLong)
      ex.getResponseBody.write(bytes)
      ex.close()
    }

    server.createContext("/ping", (ex: HttpExchange) => reply(ex, 200, "text/plain", "pong".getBytes))
    server.createContext("/modeler-open", (ex: HttpExchange) => {
      EventQueue.invokeLater(() => panel.showModeler())
      reply(ex, 200, "text/plain", "queued".getBytes)
    })
    server.createContext("/chat-layout", (ex: HttpExchange) => {
      val result = new CompletableFuture[String]
      EventQueue.invokeLater(() => {
        def findDock(component: java.awt.Component): Option[ChatDock] = component match {
          case dock: ChatDock => Some(dock)
          case container: java.awt.Container => container.getComponents.toSeq.flatMap(findDock).headOption
          case _ => None
        }
        val window = SwingUtilities.getWindowAncestor(panel)
        val dock = Option(window).flatMap(findDock)
        val query = Option(ex.getRequestURI.getQuery).getOrElse("")
        dock.foreach { d =>
          if (query == "collapsed=true") d.setCollapsed(true)
          else if (query == "collapsed=false") d.setCollapsed(false)
        }
        if (window != null) window.validate()
        result.complete(dock.map(d => s"collapsed=${d.isCollapsed};width=${d.getWidth};chatVisible=${panel.isVisible}")
          .getOrElse("no dock"))
      })
      reply(ex, 200, "text/plain; charset=utf-8", result.get(30, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8))
    })
    server.createContext("/help-state", (ex: HttpExchange) => {
      val result = new CompletableFuture[String]
      EventQueue.invokeLater(() => {
        val entries = org.nlogo.app.HelpActions.apply.collect {
          case action: org.nlogo.app.LocalBrowseAction =>
            s"${action.getValue(javax.swing.Action.NAME)}|${action.path}|exists=${java.nio.file.Files.isRegularFile(action.path)}"
        }
        if (Option(ex.getRequestURI.getQuery).contains("show=about"))
          new org.nlogo.app.ShowAboutWindow(SwingUtilities.getWindowAncestor(panel).asInstanceOf[java.awt.Frame])
            .actionPerformed(null)
        result.complete((Seq(new org.nlogo.app.ShowAboutWindow(null).getValue(javax.swing.Action.NAME).toString) ++ entries).mkString("\n"))
      })
      reply(ex, 200, "text/plain; charset=utf-8", result.get(30, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8))
    })
    server.createContext("/window-state", (ex: HttpExchange) => {
      val result = new CompletableFuture[String]
      EventQueue.invokeLater(() => {
        val frames = java.awt.Frame.getFrames.filter(_.isVisible).map { frame =>
          val bounds = frame.getBounds
          def controls(component: java.awt.Component): Seq[String] = component match {
            case button: javax.swing.AbstractButton => Seq(s"${button.getText}:${button.isSelected}")
            case tabs: javax.swing.JTabbedPane => (0 until tabs.getTabCount).map(tabs.getTitleAt) ++ tabs.getComponents.toSeq.flatMap(controls)
            case container: java.awt.Container =>
              val label = if (container.getClass.getSimpleName == "WidgetWrapper") {
                val child = container.getComponents.headOption.map(_.getClass.getSimpleName).getOrElse("unknown")
                Seq(s"$child@${container.getX},${container.getY}:${container.getWidth}x${container.getHeight}")
              } else Seq.empty
              label ++ container.getComponents.toSeq.filter(_.isVisible).flatMap(controls)
            case _ => Seq.empty
          }
          s"${frame.getTitle}|${bounds.width}x${bounds.height}|state=${frame.getExtendedState}|${controls(frame).mkString(",")}"
        }
        result.complete(frames.mkString("\n"))
      })
      reply(ex, 200, "text/plain; charset=utf-8", result.get(30, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8))
    })

    def executeJs(ex: HttpExchange, target: () => Option[WebEngine]): Unit = {
      val script = new String(ex.getRequestBody.readAllBytes, StandardCharsets.UTF_8)
      val result = new CompletableFuture[String]
      Platform.runLater(() => {
        try result.complete(target().map(e => String.valueOf(e.executeScript(script))).getOrElse("no engine"))
        catch { case t: Throwable => result.complete("JS-ERROR: " + t) }
      })
      val out = try result.get(30, TimeUnit.SECONDS) catch { case t: Throwable => "TIMEOUT: " + t }
      reply(ex, 200, "text/plain; charset=utf-8", out.getBytes(StandardCharsets.UTF_8))
    }

    server.createContext("/js", (ex: HttpExchange) => executeJs(ex, engine))
    server.createContext("/modeler-js", (ex: HttpExchange) => executeJs(ex, () => panel.modelerEngine))

    /** Every button/checkbox in the window with its screen rectangle: Swing widgets expose no accessibility names of their own. */
    server.createContext("/bounds", (ex: HttpExchange) => {
      val sb = new StringBuilder
      val done = new CompletableFuture[Unit]
      EventQueue.invokeLater(() => {
        try {
          def walk(c: java.awt.Component): Unit = {
            c match {
              case b: javax.swing.AbstractButton =>
                val loc = try c.getLocationOnScreen catch { case _: Throwable => new java.awt.Point(0, 0) }
                val text = Option(b.getText).getOrElse("").replace('\n', ' ')
                val tip = Option(b.getToolTipText).getOrElse("").replace('\n', ' ')
                sb.append(s"${c.getClass.getName}\t$text\t$tip\tenabled=${c.isEnabled} visible=${c.isShowing}\t${loc.x},${loc.y} ${c.getWidth}x${c.getHeight}\n")
              case _ =>
            }
            c match {
              case cont: java.awt.Container => cont.getComponents.foreach(walk)
              case _                        =>
            }
          }
          Option(SwingUtilities.getWindowAncestor(panel)).foreach(walk)
          done.complete(())
        } catch { case t: Throwable => done.completeExceptionally(t) }
      })
      try { done.get(15, TimeUnit.SECONDS); reply(ex, 200, "text/plain; charset=utf-8", sb.toString.getBytes(StandardCharsets.UTF_8)) }
      catch { case t: Throwable => reply(ex, 500, "text/plain", t.toString.getBytes(StandardCharsets.UTF_8)) }
    })

    server.createContext("/press", (ex: HttpExchange) => {
      val query = Option(ex.getRequestURI.getQuery).getOrElse("")
      val wanted = query.split("&").collectFirst { case q if q.startsWith("name=") => java.net.URLDecoder.decode(q.drop(5), "UTF-8") }.getOrElse("")
      val result = new CompletableFuture[String]
      EventQueue.invokeLater(() => {
        try {
          var hit: Option[javax.swing.AbstractButton] = None
          def walk(c: java.awt.Component): Unit = {
            c match {
              case b: javax.swing.AbstractButton if hit.isEmpty =>
                val label = Option(b.getToolTipText).orElse(Option(b.getText)).getOrElse("")
                if (label == wanted) hit = Some(b)
              case _ =>
            }
            c match { case cont: java.awt.Container => cont.getComponents.foreach(walk); case _ => }
          }
          Option(SwingUtilities.getWindowAncestor(panel)).foreach(walk)
          hit match {
            case Some(b) => b.doClick(); result.complete(s"pressed enabled=${b.isEnabled}")
            case None    => result.complete("not found")
          }
        } catch { case t: Throwable => result.completeExceptionally(t) }
      })
      try reply(ex, 200, "text/plain", result.get(15, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8))
      catch { case t: Throwable => reply(ex, 500, "text/plain", t.toString.getBytes(StandardCharsets.UTF_8)) }
    })

    server.createContext("/shot", (ex: HttpExchange) => {
      val png = new CompletableFuture[Array[Byte]]
      EventQueue.invokeLater(() => {
        try {
          val w = if (Option(ex.getRequestURI.getQuery).contains("window=modeler"))
            java.awt.Frame.getFrames.find(f => f.isVisible && f.getTitle == "System Dynamics Modeler")
              .getOrElse(throw new IllegalStateException("Modeler is not open"))
            else SwingUtilities.getWindowAncestor(panel)
          val img = new BufferedImage(w.getWidth, w.getHeight, BufferedImage.TYPE_INT_ARGB)
          val g = img.createGraphics()
          w.paint(g)
          g.dispose()
          val bos = new ByteArrayOutputStream
          ImageIO.write(img, "png", bos)
          png.complete(bos.toByteArray)
        } catch { case t: Throwable => png.completeExceptionally(t) }
      })
      try reply(ex, 200, "image/png", png.get(30, TimeUnit.SECONDS))
      catch { case t: Throwable => reply(ex, 500, "text/plain", t.toString.getBytes) }
    })

    server.setExecutor(java.util.concurrent.Executors.newCachedThreadPool { r =>
      val t = new Thread(r, "nl-chat-debug"); t.setDaemon(true); t
    })
    server.start()
    System.err.println(s"NetLogo Chat DEBUG server on http://127.0.0.1:$port (development only)")
  }
}
