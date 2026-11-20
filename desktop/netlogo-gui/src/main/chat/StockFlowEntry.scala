// MemoSim stock & flow editor entry point (fork addition). GPL-2.0, same as NetLogo.

package org.nlogo.chat

/**
 * Bridge between the native Interface-tab button and the chat pane's diagram modal.
 * `App` installs the opener once the chat panel exists; the button stays disabled when the
 * chat is unavailable (`-Dnetlogo.chat.url=off`) so no dead control is ever shown.
 */
object StockFlowEntry {
  private var opener: () => Unit = () => ()
  private var availabilityListener: () => Unit = () => ()
  @volatile private var installed: Boolean = false

  def install(open: () => Unit): Unit = synchronized {
    opener = open
    installed = true
    try availabilityListener()
    catch { case _: Exception => () }
  }

  /** The button registers here so it can enable itself whenever the chat pane becomes available. */
  def onAvailable(listener: () => Unit): Unit = synchronized {
    availabilityListener = listener
    if (installed) listener()
  }

  def available: Boolean = installed

  /** Shows the chat dock (if hidden) and opens the diagram editor in it. */
  def open(): Unit = {
    if (installed) opener()
  }
}
