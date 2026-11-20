// NetLogo Chat integration (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

import java.net.{ InetSocketAddress, ServerSocket, Socket }
import java.nio.file.{ Files, Path, Paths }

import scala.jdk.CollectionConverters.*

/**
 * Packaged app only (`-Dnetlogo.chat.server.dir=...`): starts the bundled NetLogo Chat web server (Node, Next.js standalone build)
 * on a free loopback port and stops it when NetLogo quits. User data lives in the per-user app data folder (see dataDir).
 *   netlogo.chat.server.dir  folder containing server.js
 *   netlogo.chat.node        node executable
 *   netlogo.chat.data.dir    data folder (database, config.env, logs)
 * `config.env` (KEY=VALUE lines) is passed to the server, e.g. LLM_BASE_URL / LLM_API_KEY / LLM_MODEL.
 */
object EmbeddedServer {
  @volatile private var process: Option[Process] = None

  def serverDir: Option[Path] = Option(System.getProperty("netlogo.chat.server.dir")).map(Paths.get(_)).filter(d => Files.exists(d.resolve("server.js")))

  /** Preserve the legacy NetLogo Chat data folder across the MemoSim rename so projects and settings remain available. */
  def dataDir: Path = {
    val p = Option(System.getProperty("netlogo.chat.data.dir")).map(Paths.get(_)).getOrElse {
      val os = System.getProperty("os.name").toLowerCase
      val home = Paths.get(System.getProperty("user.home"))
      if (os.startsWith("win"))
        Option(System.getenv("APPDATA")).map(Paths.get(_)).getOrElse(home.resolve("AppData").resolve("Roaming")).resolve("NetLogo Chat")
      else if (os.startsWith("mac"))
        home.resolve("Library").resolve("Application Support").resolve("NetLogo Chat")
      else
        Option(System.getenv("XDG_CONFIG_HOME")).map(Paths.get(_)).getOrElse(home.resolve(".config")).resolve("NetLogo Chat")
    }
    Files.createDirectories(p)
    p
  }

  private def freePort(): Int = {
    val s = new ServerSocket(0, 0, java.net.InetAddress.getLoopbackAddress)
    try s.getLocalPort finally s.close()
  }

  private def readEnvFile(file: Path): Map[String, String] =
    if (!Files.exists(file)) Map()
    else Files.readAllLines(file).asScala.map(_.trim).filter(l => l.nonEmpty && !l.startsWith("#") && l.contains("=")).map { l =>
      val i = l.indexOf('=')
      l.substring(0, i).trim -> l.substring(i + 1).trim.stripPrefix("\"").stripSuffix("\"")
    }.toMap

  /** Starts the server (once) and returns its URL. */
  def start(): Option[String] = synchronized {
    serverDir.map { dir =>
      val data = dataDir
      val cfg = data.resolve("config.env")
      if (!Files.exists(cfg)) {
        Files.writeString(cfg,
          """# MemoSim server settings. Optional: you can also set your LLM in the app (Settings button).
            |# LLM_BASE_URL=https://api.openai.com/v1
            |# LLM_API_KEY=sk-...
            |# LLM_MODEL=gpt-4.1
            |""".stripMargin)
      }
      val port = freePort()
      val node = Option(System.getProperty("netlogo.chat.node")).getOrElse("node")
      val pb = new ProcessBuilder(node, "server.js").directory(dir.toFile)
      val env = pb.environment()
      readEnvFile(cfg).foreach((k, v) => env.put(k, v))
      env.put("PORT", port.toString)
      env.put("HOSTNAME", "127.0.0.1")
      env.put("NODE_ENV", "production")
      env.put("NEXT_TELEMETRY_DISABLED", "1")
      env.putIfAbsent("DATABASE_PATH", data.resolve("app.db").toString)
      // one local user: the WebView does not persist cookies, so a cookie identity would lose settings and models on every start
      env.put("NLCHAT_SINGLE_USER", "true")
      val log = data.resolve("server.log").toFile
      pb.redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(log))
      val p = pb.start()
      process = Some(p)
      Runtime.getRuntime.addShutdownHook(new Thread(() => stop(), "nl-chat-server-stop"))
      s"http://127.0.0.1:$port"
    }
  }

  def stop(): Unit = synchronized {
    process.foreach { p =>
      p.descendants.forEach(_.destroy())
      p.destroy()
      if (!p.waitFor(3, java.util.concurrent.TimeUnit.SECONDS)) p.destroyForcibly()
    }
    process = None
  }

  /** Blocks until `host:port` accepts connections (or `timeoutMs` passes). */
  def awaitPort(url: String, timeoutMs: Long): Boolean = {
    val u = new java.net.URI(url)
    val port = if (u.getPort >= 0) u.getPort else if (u.getScheme == "https") 443 else 80
    val deadline = System.currentTimeMillis + timeoutMs
    while (System.currentTimeMillis < deadline) {
      val s = new Socket
      try { s.connect(new InetSocketAddress(u.getHost, port), 500); return true }
      catch { case _: Exception => Thread.sleep(250) }
      finally try s.close() catch { case _: Exception => () }
    }
    false
  }
}
