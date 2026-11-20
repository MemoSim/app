// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.awt.{ BorderLayout, Dimension, EventQueue, Frame }
import java.awt.event.{ WindowAdapter, WindowEvent }
import java.net.{ CookieHandler, CookieManager, HttpCookie, URI }
import java.nio.file.{ Files, Paths }
import java.util.UUID
import javax.swing.{ JButton, JFrame, JOptionPane, JPanel, WindowConstants }

import javafx.application.Platform
import javafx.concurrent.Worker
import javafx.embed.swing.JFXPanel
import javafx.scene.Scene
import javafx.scene.web.{ WebEngine, WebView }

import netscape.javascript.JSObject

import org.json.simple.JSONValue

import org.nlogo.app.App
import org.nlogo.window.Events as WindowEvents

/** Object exposed to the page as `window.nlDesktop`. Must be public with public methods (JavaFX reflection). */
class JsApi(bridge: ChatBridge, deliver: (String, String) => Unit, frame: () => Option[JFrame], ready: () => Unit = () => (),
            onExpandPane: Boolean => Unit = _ => ()) {
  /** `id` correlates the response, delivered later via `window.__nlDeliver(id, jsonString)`. */
  def call(id: String, method: String, argsJson: String): Unit =
    bridge.call(method, argsJson, result => deliver(id, result))

  /** Called by the modeler after its open-event listener has been installed. */
  def modelerReady(): Unit = ready()

  /** Called by the diagram modal to request native fullscreen of the enclosing frame. */
  def fullScreen(): Unit = frame().foreach(FullScreen.toggle)

  /** `true` gives the chat pane the whole window (the diagram needs the room); `false` restores the dock. */
  def expandPane(wide: Boolean): Unit = onExpandPane.apply(wide)
}


/**
 * Right-hand chat panel: a JavaFX WebView that loads the NetLogo Chat web UI (`<server>/desktop`).
 * The page controls NetLogo only through `window.nlDesktop`, which is attached ONLY while the page's origin
 * equals the configured chat server. Any other origin never gets the object (it can run code on this computer).
 */
class ChatPanel(app: App, serverUrl: String, pagePath: String = "/desktop",
                existingBridge: Option[ChatBridge] = None)
extends JFXPanel with WindowEvents.CompiledEvent.Handler {
  private val allowedOrigin: String = ChatPanel.origin(serverUrl)
  private val pageUrl: String = serverUrl.stripSuffix("/") + pagePath
  private val primary: Boolean = existingBridge.isEmpty

  private var engine: Option[WebEngine] = None
  private var apiRef: JsApi = null // strong reference: JavaFX holds exposed Java objects weakly
  private var pageReady = false // JavaFX thread only
  private var pendingModelerOpen = false // JavaFX thread only
  @volatile private var modelerWindow: Option[(JFrame, ChatPanel)] = None // written on the AWT thread

  /** Set by `ChatDock`: widens the dock to the whole window while the diagram editor is open. */
  @volatile var wideHandler: Boolean => Unit = _ => ()

  val bridge: ChatBridge = existingBridge.getOrElse(
    new ChatBridge(app, json => runJs(s"window.__nlEvent && window.__nlEvent(${JSONValue.toJSONString(json)})")))

  if (primary && System.getProperty("netlogo.chat.noCookie") == null) ChatPanel.installIdentityCookie(serverUrl)

  setPreferredSize(new Dimension(460, 700))
  setMinimumSize(new Dimension(280, 200))

  if (primary) {
    app.workspace.runtimeErrorHook = (owner, e) => bridge.onRuntimeError(owner, e)
    app.workspace.outputHook = oo => bridge.onOutput(oo.get)
  }

  override def handle(e: WindowEvents.CompiledEvent): Unit = if (primary) bridge.onCompiled(e)

  private def runJs(script: String): Unit =
    Platform.runLater(() => engine.filter(en => ChatPanel.origin(en.getLocation) == allowedOrigin)
      .foreach(en => try en.executeScript(script) catch { case _: Exception => () }))

  private def dispatchModelerOpen(): Unit = {
    if (pageReady && pendingModelerOpen) {
      engine.filter(en => ChatPanel.origin(en.getLocation) == allowedOrigin).foreach { en =>
        en.executeScript("window.dispatchEvent(new CustomEvent('memosim-modeler-open'))")
        pendingModelerOpen = false
      }
    }
  }

  private def refreshModeler(): Unit = Platform.runLater(() => {
    pendingModelerOpen = true
    dispatchModelerOpen()
  })

  private def requestModelerClose(window: JFrame): Unit = Platform.runLater(() => {
    try {
      val canHide = engine.filter(en => ChatPanel.origin(en.getLocation) == allowedOrigin).forall { en =>
        java.lang.Boolean.TRUE == en.executeScript(
          """(function () {
            |  var state = window.memoModelerState || {};
            |  if (state.busy) return false;
            |  return !state.dirty || window.confirm('Hide the modeler with unapplied draft changes? Your draft will remain in this window.');
            |})()""".stripMargin)
      }
      if (canHide) EventQueue.invokeLater(() => window.setVisible(false))
    } catch { case _: Exception => () } // Keep the window and draft if page state cannot be checked.
  })

  /** The modern modeler uses the primary panel's bridge and compilation/error collectors. */
  def showModeler(): Unit = {
    if (!EventQueue.isDispatchThread) EventQueue.invokeLater(() => showModeler())
    else {
      val (window, panel) = modelerWindow.getOrElse {
        val child = new ChatPanel(app, serverUrl, "/modeler", Some(bridge))
        val frame = new JFrame("System Dynamics Modeler")
        frame.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE)
        val content = new JPanel(new BorderLayout)
        val controls = new JPanel(new java.awt.FlowLayout(java.awt.FlowLayout.RIGHT))
        val fullscreen = new JButton("Full screen")
        fullscreen.addActionListener(_ => FullScreen.toggle(frame))
        controls.add(fullscreen)
        content.add(controls, BorderLayout.NORTH)
        content.add(child, BorderLayout.CENTER)
        frame.setContentPane(content)
        FullScreen.install(frame)
        frame.setSize(1200, 850)
        frame.setExtendedState(Frame.MAXIMIZED_BOTH)
        frame.setLocationRelativeTo(app.frame)
        frame.addWindowListener(new WindowAdapter {
          override def windowClosing(e: WindowEvent): Unit = child.requestModelerClose(frame)
        })
        val entry = (frame, child)
        modelerWindow = Some(entry)
        entry
      }
      window.setExtendedState(window.getExtendedState & ~Frame.ICONIFIED)
      window.setVisible(true)
      window.setExtendedState(Frame.MAXIMIZED_BOTH)
      window.toFront()
      window.requestFocus()
      panel.refreshModeler()
    }
  }

  Platform.setImplicitExit(false)
  Platform.runLater(() => {
    val view = new WebView
    view.setContextMenuEnabled(false)
    val en = view.getEngine
    engine = Some(en)
    en.setCreatePopupHandler(_ => null) // no pop-up windows
    if (!primary) en.setConfirmHandler(message => {
      var confirmed = false
      EventQueue.invokeAndWait(() => {
        confirmed = JOptionPane.showConfirmDialog(ChatPanel.this, message, "System Dynamics Modeler",
          JOptionPane.YES_NO_OPTION, JOptionPane.WARNING_MESSAGE) == JOptionPane.YES_OPTION
      })
      confirmed
    })

    apiRef = new JsApi(bridge, (id, result) =>
      runJs(s"window.__nlDeliver(${JSONValue.toJSONString(id)}, ${JSONValue.toJSONString(result)})"),
      () => if (primary) Some(app.frame) else modelerWindow.map(_._1),
      () => Platform.runLater(() => {
        pageReady = true
        dispatchModelerOpen()
      }),
      wide => EventQueue.invokeLater(() => wideHandler(wide)))

    en.getLoadWorker.stateProperty.addListener((_, _, state) => {
      val loc = Option(en.getLocation).getOrElse("")
      if (ChatPanel.verbose)
        System.err.println(s"MemoSim: load state=$state location=$loc error=${Option(en.getLoadWorker.getException).map(_.toString).getOrElse("-")}")
      state match {
        case Worker.State.SCHEDULED | Worker.State.RUNNING => pageReady = false
        case Worker.State.SUCCEEDED if ChatPanel.origin(loc) == allowedOrigin =>
          en.executeScript("window") match {
            case w: JSObject => w.setMember("nlDesktop", apiRef)
            case _           =>
          }
          pageReady = true // the page itself is loaded; the modeler page may additionally call modelerReady()
        case Worker.State.SUCCEEDED => // navigated away from the chat server: never expose the bridge
        case Worker.State.FAILED if loc.isEmpty || ChatPanel.origin(loc) == allowedOrigin =>
          en.loadContent(ChatPanel.errorPage(pageUrl))
        case _ =>
      }
    })

    // Block navigation to other origins (the bridge could otherwise be reachable from untrusted pages).
    en.locationProperty.addListener((_, _, loc) => {
      if (loc != null && loc.startsWith("http") && ChatPanel.origin(loc) != allowedOrigin)
        Platform.runLater(() => en.load(pageUrl))
    })

    setScene(new Scene(view))
    // Wait for the chat server (the bundled one needs a few seconds to boot) instead of showing an error page.
    en.loadContent(ChatPanel.loadingPage)
    val waiter = new Thread(() => {
      val up = EmbeddedServer.awaitPort(pageUrl, 90000)
      Platform.runLater(() => if (up) en.load(pageUrl) else en.loadContent(ChatPanel.errorPage(pageUrl)))
    }, "nl-chat-wait")
    waiter.setDaemon(true)
    waiter.start()

    if (primary) Option(System.getProperty("netlogo.chat.debugPort")).flatMap(_.toIntOption).foreach { port =>
      ChatDebug.start(port, ChatPanel.this, () => engine)
    }
  })

  def reload(): Unit = runJs("location.reload()")

  /** Tells the page to leave the diagram view (used by the native Escape shortcut). */
  def closeDiagram(): Unit = runJs("window.dispatchEvent(new CustomEvent('memosim-close-diagram'))")

  /** Opens the stock & flow diagram modal in the page; waits for the page when it is still loading. */
  def openDiagram(): Unit = {
    if (!primary) return
    def dispatch(): Unit =
      engine.filter(en => ChatPanel.origin(en.getLocation) == allowedOrigin).foreach { en =>
        try en.executeScript("window.dispatchEvent(new CustomEvent('memosim-open-diagram'))")
        catch { case _: Exception => () }
      }
    Platform.runLater(() => {
      if (pageReady) dispatch()
      else {
        // Only a page that is still loading has to wait, and it is polled briefly: 100 ms is enough
        // for the load worker to finish, and 4 s bounds a slow start instead of stalling the click.
        val waiter = new Thread(() => {
          var tries = 0
          while (tries < 40 && !pageReady) { Thread.sleep(100); tries += 1 }
          Platform.runLater(() => dispatch())
        }, "nl-open-diagram")
        waiter.setDaemon(true)
        waiter.start()
      }
    })
  }

  private[chat] def modelerEngine: Option[WebEngine] = modelerWindow.flatMap(_._2.engine)

  def dispose(): Unit = if (primary) bridge.dispose()
}

object ChatPanel {
  // JavaFX 21's WebView tries an HTTP/2 cleartext upgrade (`Upgrade: h2c`) on every http:// request, and Node servers
  // such as Next.js destroy the socket on unknown Upgrade requests, so the page never loads. Use the HTTP/1.1 loader.
  // Must be set before the first WebView is created (read once by com.sun.webkit.network.NetworkContext).
  if (System.getProperty("com.sun.webkit.useHTTP2Loader") == null) System.setProperty("com.sun.webkit.useHTTP2Loader", "false")

  val verbose: Boolean = System.getProperty("netlogo.chat.debugPort") != null || System.getProperty("netlogo.chat.verbose") != null

  /** Check without starting the bundled server (also used to suppress the legacy SDM window). */
  def isEnabled: Boolean =
    Option(System.getProperty("netlogo.chat.url")).orElse(sys.env.get("NETLOGO_CHAT_URL"))
      .forall(raw => raw.trim.nonEmpty && !raw.trim.equalsIgnoreCase("off"))

  /** Configured chat server, or None when disabled (`-Dnetlogo.chat.url=off`). */
  def configuredUrl: Option[String] = {
    // packaged app: start the bundled server unless a URL was configured explicitly
    val explicit = Option(System.getProperty("netlogo.chat.url")).orElse(sys.env.get("NETLOGO_CHAT_URL"))
    val raw = explicit.orElse(EmbeddedServer.start()).getOrElse("http://127.0.0.1:3000")
    if (raw.trim.isEmpty || raw.trim.equalsIgnoreCase("off")) None else Some(raw.trim)
  }

  /**
   * The WebView has no cookie jar by default, and an in-memory one would forget the user at every launch.
   * Keep a random id in the user's home folder and present it as the server's `nlchat_uid` cookie.
   * (Interim identity until real accounts exist; never reuse for anything security sensitive.)
   */
  def installIdentityCookie(serverUrl: String): Unit =
    try {
      val file = Paths.get(System.getProperty("user.home"), ".netlogo-chat-id")
      val uid =
        if (Files.exists(file)) Files.readString(file).trim
        else { val u = UUID.randomUUID.toString; Files.writeString(file, u); u }
      val manager = new CookieManager
      CookieHandler.setDefault(manager)
      val uri = new URI(serverUrl)
      val cookie = new HttpCookie("nlchat_uid", uid)
      cookie.setPath("/")
      cookie.setHttpOnly(true)
      cookie.setMaxAge(60L * 60 * 24 * 365)
      manager.getCookieStore.add(uri, cookie)
    } catch { case e: Exception => System.err.println("MemoSim: could not set identity cookie: " + e) }

  def origin(url: String): String =
    try {
      val u = new URI(url)
      val port = if (u.getPort >= 0) u.getPort else if (u.getScheme == "https") 443 else 80
      s"${u.getScheme}://${u.getHost}:$port"
    } catch { case _: Exception => "" }

  val loadingPage: String =
    """<html><body style="font-family:-apple-system,sans-serif;color:#666;padding:24px"><p>Starting MemoSim&hellip;</p></body></html>"""

  def errorPage(url: String): String =
    s"""<html><body style="font-family:sans-serif;padding:16px">
       |<h3>MemoSim server not reachable</h3>
       |<p>Could not load <code>$url</code>.</p>
       |<p>Start the MemoSim server, or set <code>NETLOGO_CHAT_URL</code>.</p>
       |<p><a href="$url">Retry</a></p></body></html>""".stripMargin
}
