// NetLogo Chat integration (fork addition). https://github.com/NetLogo/NetLogo is GPL-2.0; so is this file.

package org.nlogo.chat

import java.awt.EventQueue
import java.io.{ BufferedReader, InputStreamReader }
import java.nio.charset.StandardCharsets
import java.nio.file.{ Files, Path, Paths }
import java.util.concurrent.{ Executors, TimeUnit }

import scala.collection.mutable.ListBuffer
import scala.jdk.CollectionConverters.*

import org.json.simple.JSONValue

import org.nlogo.api.{ Dump, ModelType, SimpleJobOwner }
import org.nlogo.app.App
import org.nlogo.app.codetab.CodeTab
import org.nlogo.core.{ AgentKind, CompilerException }
import org.nlogo.nvm.EngineException
import org.nlogo.window.Events as WindowEvents

/** Errors raised by code run on behalf of the chat are captured here instead of popping up an error dialog. */
type Obj = java.util.LinkedHashMap[String, AnyRef]
type Arr = java.util.ArrayList[AnyRef]
type In  = java.util.Map[?, ?]

private def json(x: AnyRef): String = JSONValue.toJSONString(x)

class QuietJobOwner(app: App) extends SimpleJobOwner("Chat", app.workspace.world.mainRNG, AgentKind.Observer) {
  val errors = new ListBuffer[String]
}

/**
 * Executes the chat agent's requests inside NetLogo Desktop.
 *
 * Threading rules (violating them deadlocks or throws):
 *  - `App.command/report` must NOT run on the AWT event thread -> we run on a dedicated worker thread.
 *  - `App.openFromSource/getProcedures/setProcedures/compile` MUST run on the AWT event thread -> `onEdt`.
 *  - Runtime errors are reported asynchronously on the EDT; after a job we flush the EDT queue before reading them.
 */
class ChatBridge(app: App, emitToJs: String => Unit) {
  import ChatBridge.*

  private val worker = Executors.newSingleThreadExecutor { r =>
    val t = new Thread(r, "nl-chat-bridge")
    t.setDaemon(true)
    t
  }

  private val sessionDir: Path = Files.createTempDirectory("netlogo-chat-")
  @volatile private var collector: Option[ListBuffer[Obj]] = None
  @volatile private var runningProcess: Option[Process] = None
  /** Text printed (show/print/type/write) while a chat command runs; null when nothing is listening. */
  @volatile private var outputBuf: java.lang.StringBuilder = null

  // ---- hooks -------------------------------------------------------------------------------------------------

  /** Called by the CompiledEvent handler in ChatPanel (on the EDT). */
  def onCompiled(e: WindowEvents.CompiledEvent): Unit =
    for (list <- collector; err <- Option(e.error)) {
      val isCode = e.sourceOwner.isInstanceOf[CodeTab]
      val o = new Obj
      o.put("message", err.getMessage)
      o.put("kind", if (isCode) "compile" else "widget")
      if (isCode) { o.put("start", Long.box(err.start.toLong)); o.put("end", Long.box(err.end.toLong)) }
      list.synchronized { list += o }
    }

  /** Called for every line of output NetLogo prints. Only kept while a chat command is running. */
  def onOutput(text: String): Unit = {
    val b = outputBuf
    if (b != null) b.synchronized { if (b.length < MaxOutputChars) b.append(text) }
  }

  /** GUIWorkspace calls this for every runtime error; returning true suppresses the error dialog. */
  def onRuntimeError(owner: org.nlogo.api.JobOwner, e: Exception): Boolean =
    owner match {
      case q: QuietJobOwner =>
        q.errors += message(e)
        true
      case o if o.isButton || o.isCommandCenter =>
        val ev = new Obj
        ev.put("event", "runtime-error")
        val args = new Obj
        args.put("source", if (o.isButton) "button" else "console")
        args.put("exception", message(e))
        ev.put("eventArgs", args)
        emitToJs(json(ev))
        false
      case _ => false
    }

  // ---- entry point from JavaScript ----------------------------------------------------------------------------

  def call(method: String, argsJson: String, deliver: String => Unit): Unit =
    worker.submit(new Runnable {
      def run(): Unit = {
        val result =
          try dispatch(method, JSONValue.parse(argsJson) match { case m: In => m; case _ => new java.util.HashMap[String, AnyRef]() })
          catch { case t: Throwable => fail(t.getClass.getSimpleName + ": " + t.getMessage) }
        deliver(json(result))
      }
    })

  private def dispatch(method: String, a: In): Obj = method match {
    case "init"          => init()
    case "loadModel"     => loadModel(str(a, "nlogox"), a.get("preservePath") == java.lang.Boolean.TRUE)
    case "runCode"       => runCode(str(a, "code"), num(a, "timeoutMs", 120000))
    case "report"        => report(str(a, "code"))
    case "getCode"       => ok("code" -> onEdt(app.getProcedures))
    // MemoSim: expose the existing generated SDM source for the modeler (2026-11-18).
    case "getSystemDynamicsCode" => ok("code" -> onEdt(app.workspace.aggregateManager.innerSource))
    case "getTicks"      => ticks()
    case "exportModel"   => exportModel()
    case "listFiles"     => listFiles(str(a, "path"), num(a, "max", 200).toInt)
    case "checkCompiles" => checkCompiles(str(a, "kind"), str(a, "code"))
    case "runExperiment" => runExperiment(str(a, "nlogox"), str(a, "experiment"), num(a, "maxRows", 500).toInt, num(a, "timeoutMs", 600000))
    case "abortExperiment" =>
      runningProcess.foreach(_.destroyForcibly())
      ok()
    case other => fail(s"unknown method $other")
  }

  // ---- methods ------------------------------------------------------------------------------------------------

  private def init(): Obj = {
    val extDir = Paths.get(System.getProperty("netlogo.extensions.dir", "extensions"))
    val exts =
      if (Files.isDirectory(extDir))
        Files.list(extDir).iterator.asScala.map(_.getFileName.toString).filter(n => Files.exists(extDir.resolve(n).resolve(s"$n.jar"))).toList.sorted
      else Nil
    val arr = new Arr; exts.foreach(x => arr.add(x))
    ok("kind" -> "desktop", "behaviorSpace" -> true, "systemDynamics" -> true, "fileIO" -> true, "extensions" -> arr,
       "version" -> org.nlogo.api.Version.version, "workDir" -> sessionDir.toString)
  }

  private def loadModel(nlogox: String, preservePath: Boolean): Obj = {
    val file = sessionDir.resolve("model.nlogox")
    Files.writeString(file, nlogox, StandardCharsets.UTF_8)
    val errs = new ListBuffer[Obj]
    collector = Some(errs)
    try {
      onEdt {
        // MemoSim modeler edits keep the document path; never write the user's file implicitly (2026-11-18).
        val path = if (preservePath) Option(app.workspace.getModelPath).filter(_.nonEmpty).getOrElse(file.toString) else file.toString
        app.openFromSource(nlogox, path, ModelType.Normal)
        app.compile()
        if (preservePath) new WindowEvents.DirtyEvent(None).raise(app.frame)
      }
      flushEdt()
    } finally collector = None
    val seen = scala.collection.mutable.Set[String]()
    val unique = errs.toList.filter(o => seen.add(o.get("message").toString + "@" + o.get("start")))
    if (unique.isEmpty) ok() else failList(unique)
  }

  /** The live model (with hand edits to widgets, world, info, code) as .nlogox, from NetLogo's own saver. */
  private def exportModel(): Obj = ok("nlogox" -> onEdt(app.fileManager.currentModelAsNlogox()))

  private def withOutput(o: Obj, buf: java.lang.StringBuilder): Obj = {
    val text = buf.synchronized(buf.toString)
    if (text.nonEmpty) o.put("output", if (text.length >= MaxOutputChars) text + "\n...[output truncated]" else text)
    o
  }

  /**
   * Folder listing for the model-building assistant, so it uses the real file names instead of guessing them
   * (a folder called Ostan_iran may hold Sotan_iran.shp). Names and sizes only, never contents.
   */
  private def listFiles(path: String, max: Int): Obj = {
    val home = Paths.get(System.getProperty("user.home"))
    val raw = path.trim
    val p =
      if (raw == "" || raw == "~") home
      else if (raw.startsWith("~/")) home.resolve(raw.drop(2))
      else Paths.get(raw)
    val dir = if (p.isAbsolute) p else sessionDir.resolve(p)
    if (!Files.exists(dir)) return fail(s"$dir does not exist. Check the spelling (names are case-sensitive) or list its parent folder first.")
    try {
      if (!Files.isDirectory(dir)) {
        val o = ok("path" -> dir.toString, "isFile" -> true, "size" -> Files.size(dir))
        return o
      }
      val stream = Files.list(dir)
      val entries =
        try stream.iterator.asScala.toList.filterNot(_.getFileName.toString.startsWith(".")).sortBy(x => (!Files.isDirectory(x), x.getFileName.toString.toLowerCase))
        finally stream.close()
      val arr = new Arr
      entries.take(max).foreach { e =>
        val o = new Obj
        o.put("name", e.getFileName.toString)
        val isDir = Files.isDirectory(e)
        o.put("dir", java.lang.Boolean.valueOf(isDir))
        if (!isDir) o.put("size", Long.box(scala.util.Try(Files.size(e)).getOrElse(0L)))
        arr.add(o)
      }
      ok("path" -> dir.toString, "entries" -> arr, "total" -> entries.size, "truncated" -> (entries.size > max))
    } catch {
      case _: java.nio.file.AccessDeniedException | _: java.nio.file.FileSystemException =>
        fail(s"Access to $dir was denied. On macOS, allow it in System Settings > Privacy & Security > Files and Folders (or Full Disk Access) for MemoSim (older installations may still appear as NetLogo Chat), then try again.")
    }
  }

  private def runCode(code: String, timeoutMs: Long): Obj = {
    val captured = new java.lang.StringBuilder
    outputBuf = captured
    try runCodeCapturing(code, timeoutMs, captured) finally outputBuf = null
  }

  private def runCodeCapturing(code: String, timeoutMs: Long, captured: java.lang.StringBuilder): Obj = {
    val owner = new QuietJobOwner(app)
    var compileError: Option[CompilerException] = None
    var unexpected: Option[Throwable] = None
    val t = new Thread(() =>
      try app.workspace.evaluateCommands(owner, code)
      catch {
        case c: CompilerException => compileError = Some(c)
        case x: Throwable         => unexpected = Some(x)
      }, "nl-chat-run")
    t.setDaemon(true)
    t.start()
    t.join(timeoutMs)
    if (t.isAlive) {
      app.workspace.halt()
      t.join(5000)
      return withOutput(failList(List(err("Timed out after " + timeoutMs / 1000 + "s (possible infinite loop); halted.", "runtime"))), captured)
    }
    flushEdt()
    withOutput(compileError.map(c => failList(List(compileErr(c)))).orElse(unexpected.map(x => fail(x.toString))).getOrElse {
      if (owner.errors.isEmpty) ok()
      else failList(owner.errors.toList.map(m => err(m, "runtime")))
    }, captured)
  }

  private def report(code: String): Obj = {
    val owner = new QuietJobOwner(app)
    var value: AnyRef = null
    var compileError: Option[CompilerException] = None
    val t = new Thread(() =>
      try value = app.workspace.evaluateReporter(owner, code, app.workspace.world.observers)
      catch { case c: CompilerException => compileError = Some(c); case _: Throwable => () }, "nl-chat-report")
    t.setDaemon(true)
    t.start()
    t.join(60000)
    if (t.isAlive) { app.workspace.halt(); return fail("reporter timed out") }
    flushEdt()
    compileError match {
      case Some(c) => fail(c.getMessage)
      case None if owner.errors.nonEmpty => fail(owner.errors.head)
      case None => ok("value" -> toJson(value))
    }
  }

  private def ticks(): Obj = {
    val t = report("ticks")
    if (t.get("ok") == java.lang.Boolean.TRUE) ok("ticks" -> t.get("value")) else ok("ticks" -> null)
  }

  private def checkCompiles(kind: String, code: String): Obj =
    try {
      if (kind == "reporter") app.workspace.compileReporter(code)
      else app.workspace.compileCommands(code, AgentKind.Observer)
      ok()
    } catch {
      case c: CompilerException => failList(List(compileErr(c)))
    }

  /** Runs a BehaviorSpace experiment headless in a separate JVM (same approach the GUI's BehaviorSpace uses). */
  private def runExperiment(nlogox: String, experiment: String, maxRows: Int, timeoutMs: Long): Obj = {
    val dir = Files.createTempDirectory(sessionDir, "bspace-")
    val model = dir.resolve("model.nlogox")
    val table = dir.resolve("table.csv")
    Files.writeString(model, nlogox, StandardCharsets.UTF_8)
    val java = Paths.get(System.getProperty("java.home"), "bin", if (System.getProperty("os.name").toLowerCase.startsWith("win")) "java.exe" else "java").toString
    val threads = math.max(1, Runtime.getRuntime.availableProcessors / 2).toString
    val cmd = Seq(java, "-Xmx2G", "-cp", System.getProperty("java.class.path"),
      s"-Dnetlogo.extensions.dir=${System.getProperty("netlogo.extensions.dir")}",
      s"-Djava.library.path=${System.getProperty("java.library.path")}",
      "-Djava.awt.headless=true", "-Dorg.nlogo.preferHeadless=true",
      "org.nlogo.headless.Main", "--model", model.toString, "--experiment", experiment,
      "--table", table.toString, "--threads", threads, "--error-behavior", "abortExperiment")
    val pb = new ProcessBuilder(cmd.asJava).directory(dir.toFile).redirectErrorStream(true)
    val proc = pb.start()
    runningProcess = Some(proc)
    val out = new StringBuilder
    val reader = new Thread(() => {
      val r = new BufferedReader(new InputStreamReader(proc.getInputStream, StandardCharsets.UTF_8))
      var line = r.readLine()
      while (line != null) { if (out.length < 8000) out.append(line).append('\n'); line = r.readLine() }
    }, "nl-chat-bspace-out")
    reader.setDaemon(true); reader.start()
    val finished = proc.waitFor(timeoutMs, TimeUnit.MILLISECONDS)
    runningProcess = None
    if (!finished) { proc.destroyForcibly(); return fail(s"experiment exceeded ${timeoutMs / 1000}s and was stopped") }
    reader.join(2000)
    if (proc.exitValue != 0 || !Files.exists(table))
      return failList(List(err(out.toString.trim.take(1500).ifEmpty("BehaviorSpace failed with exit code " + proc.exitValue), "runtime")))
    parseTable(table, maxRows)
  }

  private def parseTable(file: Path, maxRows: Int): Obj = {
    val lines = Files.readAllLines(file, StandardCharsets.UTF_8).asScala.toList
    val headerIdx = lines.indexWhere(_.startsWith("\"[run number]\""))
    if (headerIdx < 0) return fail("could not find the results header in the BehaviorSpace table")
    val cols = parseCsvLine(lines(headerIdx))
    val rows = lines.drop(headerIdx + 1).filter(_.nonEmpty).map(parseCsvLine)
    val shown = rows.take(maxRows)
    val rowsJson = new Arr
    shown.foreach { r =>
      val a = new Arr
      r.foreach(v => a.add(cell(v)))
      rowsJson.add(a)
    }
    val colsJson = new Arr; cols.foreach(c => colsJson.add(c))
    ok("runs" -> rows.map(_.headOption.getOrElse("")).distinct.size, "columns" -> colsJson, "rows" -> rowsJson, "truncated" -> (rows.size > maxRows),
       "totalRows" -> rows.size)
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  private def onEdt[T](f: => T): T = {
    if (EventQueue.isDispatchThread) f
    else {
      var result: Option[T] = None
      var failure: Option[Throwable] = None
      EventQueue.invokeAndWait(() => try result = Some(f) catch { case t: Throwable => failure = Some(t) })
      failure.foreach(throw _)
      result.get
    }
  }

  /** Everything posted to the EDT before this call (e.g. runtime error callbacks) has run when this returns. */
  private def flushEdt(): Unit = if (!EventQueue.isDispatchThread) EventQueue.invokeAndWait(() => ())

  def dispose(): Unit = {
    runningProcess.foreach(_.destroyForcibly())
    worker.shutdownNow()
  }
}

object ChatBridge {
  private val MaxOutputChars = 4000

  def message(e: Throwable): String = e match {
    case ee: EngineException => ee.runtimeErrorMessage
    case other               => Option(other.getMessage).getOrElse(other.toString)
  }

  private def str(a: In, k: String): String = Option(a.get(k)).map(_.toString).getOrElse("")
  private def num(a: In, k: String, d: Long): Long = a.get(k) match { case n: java.lang.Number => n.longValue; case _ => d }

  private def ok(kv: (String, Any)*): Obj = {
    val o = new Obj
    o.put("ok", java.lang.Boolean.TRUE)
    kv.foreach((k, v) => o.put(k, v.asInstanceOf[AnyRef]))
    o
  }

  private def fail(msg: String): Obj = failList(List(err(msg, "runtime")))

  private def err(msg: String, kind: String): Obj = {
    val o = new Obj; o.put("message", msg); o.put("kind", kind); o
  }

  private def compileErr(c: CompilerException): Obj = {
    val o = err(c.getMessage, "compile")
    o.put("start", Long.box(c.start.toLong)); o.put("end", Long.box(c.end.toLong))
    o
  }

  private def failList(errors: List[Obj]): Obj = {
    val arr = new Arr; errors.foreach(arr.add(_))
    val o = new Obj
    o.put("ok", java.lang.Boolean.FALSE); o.put("errors", arr)
    o
  }

  private def toJson(v: AnyRef): AnyRef = v match {
    case null                 => null
    case d: java.lang.Double  => if (d.isNaN || d.isInfinite) Dump.logoObject(d) else d
    case n: java.lang.Number  => n
    case b: java.lang.Boolean => b
    case s: String            => s
    case other                => Dump.logoObject(other, true, false)
  }

  private def cell(v: String): AnyRef =
    if (v == "true") java.lang.Boolean.TRUE
    else if (v == "false") java.lang.Boolean.FALSE
    else scala.util.Try(java.lang.Double.valueOf(v)).toOption.filter(d => !d.isNaN && !d.isInfinite).getOrElse(v)

  def parseCsvLine(line: String): List[String] = {
    val out = ListBuffer[String]()
    val sb = new StringBuilder
    var inQ = false
    var i = 0
    while (i < line.length) {
      val c = line.charAt(i)
      if (inQ) {
        if (c == '"') { if (i + 1 < line.length && line.charAt(i + 1) == '"') { sb.append('"'); i += 1 } else inQ = false }
        else sb.append(c)
      } else if (c == '"') inQ = true
      else if (c == ',') { out += sb.toString; sb.clear() }
      else sb.append(c)
      i += 1
    }
    out += sb.toString
    out.toList
  }

  extension (s: String) private def ifEmpty(d: => String): String = if (s.isEmpty) d else s
}
