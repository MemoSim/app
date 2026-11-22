cask "memosim" do
  version "1.1.4"
  sha256 "e01bba2a2391baf5921a1d4e879580fa4a884c8c77b2963d79f0d5a1d5957c3b"

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
