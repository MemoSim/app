cask "memosim" do
  version "1.0.4"
  sha256 "3fdbdbbd17952b3bcf7974409f5fe113d2f0568164256a93e8714738d6e074d7"

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
