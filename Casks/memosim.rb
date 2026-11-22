cask "memosim" do
  version "1.1.4"
  sha256 "35049a9c6db6f2a6d43b764752d3e55e5f1a055a09f8b7b594deb007fe5e687d"

  url "https://github.com/MemoSim/app/releases/download/v#{version}/MemoSim-#{version}-macOS.dmg"
  name "MemoSim"
  desc "Agent-based modeling studio with an AI assistant pane"
  homepage "https://github.com/MemoSim"

  depends_on macos: ">= :sonoma"

  app "MemoSim.app"

  zap trash: [
    "~/Library/Application Support/NetLogo Chat",
    "~/Library/Caches/org.netlogochat.desktop",
    "~/Library/Preferences/org.netlogochat.desktop.plist",
  ]
end
